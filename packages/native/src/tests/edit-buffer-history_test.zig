const std = @import("std");
const edit_buffer = @import("../edit-buffer.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");

const EditBuffer = edit_buffer.EditBuffer;
const EditState = @import("edit-buffer-atomicity_test.zig").EditState;

comptime {
    _ = @import("edit-buffer-atomicity_test.zig");
}

test "EditBuffer - borrowed replacements retain sources and cursor undo metadata" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const eb = try EditBuffer.init(std.testing.allocator, &pool, &links, .unicode, null);
    defer eb.deinit();
    const original = "old\nabcdef";
    const clean_id = try eb.setTextBorrowed(original, null);
    try eb.setCursor(1, 6);
    try eb.insertText("!");
    eb.moveUp();
    const cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 3), cursor.col);
    try std.testing.expectEqual(@as(u32, 7), cursor.desired_col);
    const add_len = eb.add_buffer.len;
    const replacement = "\u{754c}\r\nx";
    const first_id = try eb.replaceTextBorrowed(replacement);
    const second_id = try eb.replaceTextBorrowed(replacement);
    try std.testing.expect(clean_id != first_id and first_id != second_id);
    try std.testing.expectEqual(original.ptr, eb.tb.getMemBuffer(clean_id).?.ptr);
    try std.testing.expectEqual(replacement.ptr, eb.tb.getMemBuffer(first_id).?.ptr);
    try std.testing.expectEqual(replacement.ptr, eb.tb.getMemBuffer(second_id).?.ptr);
    try std.testing.expectEqual(add_len, eb.add_buffer.len);
    var actual: [32]u8 = undefined;
    _ = try eb.undo();
    try std.testing.expectEqualStrings("\u{754c}\nx", actual[0..eb.getText(&actual)]);
    _ = try eb.undo();
    try std.testing.expectEqualStrings("old\nabcdef!", actual[0..eb.getText(&actual)]);
    try std.testing.expectEqualDeep(cursor, eb.getPrimaryCursor());
    _ = try eb.redo();
    _ = try eb.redo();
    try std.testing.expectEqualStrings("\u{754c}\nx", actual[0..eb.getText(&actual)]);
    try std.testing.expectEqualDeep(edit_buffer.Cursor{ .row = 0, .col = 0 }, eb.getPrimaryCursor());
    try std.testing.expectEqual(clean_id, try eb.setTextBorrowed("new", clean_id));
    try std.testing.expectEqualStrings(replacement, eb.tb.getMemBuffer(first_id).?);
    try std.testing.expectEqualStrings(replacement, eb.tb.getMemBuffer(second_id).?);
    try std.testing.expectEqual(@as(usize, 0), eb.add_buffer.len);
    try std.testing.expect(!eb.canUndo());
    try std.testing.expect(!eb.canRedo());
    try eb.insertText("X");
    _ = try eb.undo();
    try std.testing.expectEqualStrings("new", actual[0..eb.getText(&actual)]);
    _ = try eb.redo();
    try std.testing.expectEqualStrings("Xnew", actual[0..eb.getText(&actual)]);
}

test "EditBuffer - replacement failures preserve valid history at each phase" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    inline for (.{ .memory, .owned, .borrowed }) |source| {
        inline for (.{ false, true }) |history| {
            for ([_]bool{ false, true }) |fail_rope| {
                var succeeded = false;
                for (0..64) |offset| {
                    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
                    const eb = try EditBuffer.init(failing.allocator(), &pool, &links, .unicode, null);
                    defer eb.deinit();
                    try eb.insertText("old");
                    try eb.insertText("X");
                    _ = try eb.undo();
                    const mem_id = try eb.tb.registerMemBuffer("replacement", false);
                    const before = EditState.capture(eb);
                    const allocator = eb.tb.rope().allocator;
                    var rope_failing = std.testing.FailingAllocator.init(allocator, .{});
                    eb.tb.rope().allocator = rope_failing.allocator();
                    const fault = if (fail_rope) &rope_failing else &failing;
                    fault.fail_index = fault.alloc_index + offset;
                    fault.resize_fail_index = fault.resize_index;
                    const result = switch (source) {
                        .memory => if (history) eb.replaceTextFromMemId(mem_id) else eb.setTextFromMemId(mem_id),
                        .owned => if (history) eb.replaceText("replacement") else eb.setText("replacement"),
                        .borrowed => if (history) eb.replaceTextBorrowed("replacement") else eb.setTextBorrowed("replacement", mem_id),
                        else => unreachable,
                    };
                    eb.tb.rope().allocator = allocator;
                    fault.fail_index = std.math.maxInt(usize);
                    fault.resize_fail_index = std.math.maxInt(usize);
                    var actual: [32]u8 = undefined;
                    if (result) |_| {
                        try std.testing.expectEqualStrings("replacement", actual[0..eb.getText(&actual)]);
                        if (history) {
                            _ = try eb.undo();
                            try std.testing.expectEqualStrings("old", actual[0..eb.getText(&actual)]);
                            try std.testing.expectEqualDeep(before.cursor, eb.getPrimaryCursor());
                        } else {
                            try std.testing.expect(!eb.canUndo() and !eb.canRedo());
                            try std.testing.expectEqual(@as(usize, 0), eb.add_buffer.len);
                        }
                        succeeded = true;
                        break;
                    } else |err| {
                        try std.testing.expectEqual(error.OutOfMemory, err);
                        try std.testing.expectEqualDeep(before, EditState.capture(eb));
                        try std.testing.expectEqualStrings("replacement", eb.tb.getMemBuffer(mem_id).?);
                        _ = try eb.redo();
                        try std.testing.expectEqualStrings("oldX", actual[0..eb.getText(&actual)]);
                    }
                }
                try std.testing.expect(succeeded);
            }
        }
    }
}

test "EditBuffer - reused storage retirement keeps failed replacement history safe" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const eb = try EditBuffer.init(std.testing.allocator, &pool, &links, .wcwidth, null);
    defer eb.deinit();
    const mem_id = try eb.tb.registerMemBuffer("old", false);
    try eb.setTextFromMemId(mem_id);
    try eb.setCursor(0, 3);
    try eb.insertText("!");

    const allocator = eb.tb.rope().allocator;
    var clear_failure = std.testing.FailingAllocator.init(allocator, .{ .fail_index = 0 });
    eb.tb.rope().allocator = clear_failure.allocator();
    const clear_result = eb.tb.clear();
    eb.tb.rope().allocator = allocator;
    try std.testing.expectError(error.OutOfMemory, clear_result);
    var actual: [32]u8 = undefined;
    _ = try eb.undo();
    try std.testing.expectEqualStrings("old", actual[0..eb.getText(&actual)]);
    _ = try eb.redo();
    try std.testing.expectEqualStrings("old!", actual[0..eb.getText(&actual)]);

    // Raw callers must retire these ranges before reusing mem_id.
    try eb.tb.clear();
    eb.clearHistory();
    try eb.tb.replaceMemBuffer(mem_id, "n", false);
    const global_allocator = eb.tb.global_allocator;
    var parse_failure = std.testing.FailingAllocator.init(global_allocator, .{ .fail_index = 0 });
    eb.tb.global_allocator = parse_failure.allocator();
    const result = eb.setTextFromMemId(mem_id);
    eb.tb.global_allocator = global_allocator;
    try std.testing.expectError(error.OutOfMemory, result);
    try std.testing.expectError(error.Stop, eb.undo());
    try std.testing.expectEqual(@as(usize, 0), eb.getText(&actual));
    try eb.insertText("X");
    try std.testing.expectEqualStrings("X", actual[0..eb.getText(&actual)]);
    _ = try eb.undo();
    try std.testing.expectEqual(@as(usize, 0), eb.getText(&actual));
    _ = try eb.redo();
    try std.testing.expectEqualStrings("X", actual[0..eb.getText(&actual)]);
}

test "EditBuffer - owned replacement registration rejection frees the copy" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    inline for (.{ .set, .replace }) |operation| {
        inline for (.{ .full, .allocation }) |admission| {
            const eb = try EditBuffer.init(std.testing.allocator, &pool, &links, .wcwidth, null);
            defer eb.deinit();
            try eb.insertText("old");
            const registry = &eb.tb.mem_registry;
            const limit = if (admission == .full) 255 else registry.buffers.capacity;
            while (registry.buffers.items.len < limit) {
                _ = try registry.register("spare", false);
            }
            const before = eb.tb.rope().*;
            const cursor = eb.getPrimaryCursor();
            const add_len = eb.add_buffer.len;
            const epoch = eb.tb.getContentEpoch();
            const allocator = registry.allocator;
            var failing = std.testing.FailingAllocator.init(allocator, .{
                .fail_index = 0,
                .resize_fail_index = 0,
            });
            registry.allocator = failing.allocator();
            const result = if (operation == .set) eb.setText("replacement") else eb.replaceText("replacement");
            registry.allocator = allocator;
            try std.testing.expectError(error.OutOfMemory, result);
            try std.testing.expectEqual(admission == .allocation, failing.has_induced_failure);
            try std.testing.expectEqual(limit, registry.buffers.items.len);
            try std.testing.expectEqual(@as(usize, 0), registry.free_slots.items.len);
            try std.testing.expectEqual(before.root, eb.tb.rope().root);
            try std.testing.expectEqual(before.version, eb.tb.rope().version);
            try std.testing.expectEqual(before.undo_history, eb.tb.rope().undo_history);
            try std.testing.expectEqual(before.undo_depth, eb.tb.rope().undo_depth);
            try std.testing.expectEqualDeep(cursor, eb.getPrimaryCursor());
            try std.testing.expectEqual(add_len, eb.add_buffer.len);
            try std.testing.expectEqual(epoch, eb.tb.getContentEpoch());
            var actual: [32]u8 = undefined;
            try std.testing.expectEqualStrings("old", actual[0..eb.getText(&actual)]);
            if (admission == .full) try registry.unregister(254);
            if (operation == .set) {
                try eb.setText("replacement");
                try std.testing.expect(!eb.canUndo());
                try std.testing.expectEqual(@as(usize, 0), eb.add_buffer.len);
            } else {
                try eb.replaceText("replacement");
                try std.testing.expectEqual(add_len, eb.add_buffer.len);
                _ = try eb.undo();
                try std.testing.expectEqualStrings("old", actual[0..eb.getText(&actual)]);
                _ = try eb.redo();
            }
            try std.testing.expectEqualStrings("replacement", actual[0..eb.getText(&actual)]);
        }
    }
}

test "EditBuffer - failed precleared replacement keeps cursor editable" {
    var pool = gp.GraphemePool.init(std.testing.allocator);
    defer pool.deinit();
    var links = link.LinkPool.init(std.testing.allocator);
    defer links.deinit();
    const eb = try EditBuffer.init(std.testing.allocator, &pool, &links, .wcwidth, null);
    defer eb.deinit();
    try eb.insertText("old");
    const replacement = try eb.tb.registerMemBuffer("replacement", false);
    try eb.tb.clear();
    const allocator = eb.tb.rope().allocator;
    var failing = std.testing.FailingAllocator.init(allocator, .{ .fail_index = 0 });
    eb.tb.rope().allocator = failing.allocator();
    const result = eb.setTextFromMemId(replacement);
    eb.tb.rope().allocator = allocator;
    try std.testing.expectError(error.OutOfMemory, result);
    try eb.insertText("X");
    var actual: [32]u8 = undefined;
    try std.testing.expectEqualStrings("X", actual[0..eb.getText(&actual)]);
}

test "EditBuffer - basic undo/redo with insertText" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello");

    try eb.insertText(" World");
    var out_buffer: [100]u8 = undefined;
    var written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello World", out_buffer[0..written]);

    const meta = try eb.undo();
    try std.testing.expectEqualStrings("cursor:0:5:5", meta);
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello", out_buffer[0..written]);

    const meta2 = try eb.redo();
    try std.testing.expectEqualStrings("cursor:0:11:11", meta2);
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello World", out_buffer[0..written]);
}

test "EditBuffer - undo and redo restore cursor for mid-line edits" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.setText("hello world");
    try eb.setCursor(0, 8);

    try eb.insertText("X");
    var cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 9), cursor.col);

    _ = try eb.undo();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 8), cursor.col);

    _ = try eb.redo();
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 0), cursor.row);
    try std.testing.expectEqual(@as(u32, 9), cursor.col);
}

test "EditBuffer - unchanged normalized tab width preserves cursor" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .unicode, null);
    defer eb.deinit();

    try eb.setText("a\tb");
    try eb.setCursor(0, 2);
    const cursor = eb.getPrimaryCursor();
    eb.setTabWidth(0);
    try std.testing.expectEqualDeep(cursor, eb.getPrimaryCursor());
}

test "EditBuffer - tab width remaps multi-chunk history under each checkpoint policy" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();
    const eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .unicode, null);
    defer eb.deinit();

    try eb.setText("head\n\u{754c}\tb");
    try eb.setCursor(1, 2);
    eb.setTabWidth(8);
    try std.testing.expectEqualDeep(edit_buffer.Cursor{ .row = 1, .col = 2, .desired_col = 2, .offset = 7 }, eb.getPrimaryCursor());
    eb.setTabWidth(2);
    try eb.setCursor(1, 4);
    try eb.insertText("e\u{301}\t");
    eb.setTabWidth(8);
    try std.testing.expectEqualDeep(edit_buffer.Cursor{ .row = 1, .col = 19, .desired_col = 19, .offset = 24 }, eb.getPrimaryCursor());
    try std.testing.expectEqualStrings("cursor:1:4:4", try eb.undo());
    try std.testing.expectEqualDeep(edit_buffer.Cursor{ .row = 1, .col = 10, .desired_col = 10, .offset = 15 }, eb.getPrimaryCursor());
    try std.testing.expectEqualStrings("cursor:1:19:19", try eb.redo());
    try std.testing.expectEqual(@as(u32, 19), eb.getPrimaryCursor().col);
    eb.setTabWidth(4);
    try std.testing.expectEqualStrings("cursor:1:4:4", try eb.undo());
    try std.testing.expectEqual(@as(u32, 6), eb.getPrimaryCursor().col);
    try std.testing.expectEqualStrings("cursor:1:19:19", try eb.redo());
    try std.testing.expectEqual(@as(u32, 11), eb.getPrimaryCursor().col);
    try eb.insertText("y");
    var out: [64]u8 = undefined;
    try std.testing.expectEqualStrings("head\n\u{754c}\te\u{301}\tyb", out[0..eb.getText(&out)]);

    try eb.setText("abcdefghijklmnop\na\tb");
    try eb.setCursor(0, 16);
    eb.moveDown();
    eb.setTabWidth(8);
    try std.testing.expectEqual(@as(u32, 10), eb.getPrimaryCursor().col);
    try std.testing.expectEqual(@as(u32, 16), eb.getPrimaryCursor().desired_col);
    try eb.insertText("x");
    eb.setTabWidth(2);
    _ = try eb.undo();
    try std.testing.expectEqual(@as(u32, 4), eb.getPrimaryCursor().col);
    try std.testing.expectEqual(@as(u32, 16), eb.getPrimaryCursor().desired_col);

    eb.clearHistory();
    try eb.getTextBuffer().rope().store_undo("cursor:1:1:9");
    try std.testing.expectEqualStrings("cursor:1:1:9", try eb.undo());
    try std.testing.expectEqualDeep(edit_buffer.Cursor{ .row = 1, .col = 1, .desired_col = 9, .offset = 18 }, eb.getPrimaryCursor());
}

test "EditBuffer - tab width changes preserve live and undo cursor text boundaries" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .unicode, null);
    defer eb.deinit();

    try eb.setText("a\tb");
    try eb.setCursor(0, 4);
    try eb.insertText("x");

    eb.setTabWidth(8);
    try std.testing.expectEqual(@as(u32, 11), eb.getPrimaryCursor().col);

    _ = try eb.undo();

    try std.testing.expectEqual(@as(u32, 10), eb.getPrimaryCursor().col);
    try eb.insertText("y");

    var out_buffer: [16]u8 = undefined;
    const written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("a\tby", out_buffer[0..written]);
}

test "EditBuffer - canUndo/canRedo" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try std.testing.expect(!eb.canUndo());
    try std.testing.expect(!eb.canRedo());

    try eb.insertText("Test");

    try std.testing.expect(eb.canUndo());
    try std.testing.expect(!eb.canRedo());

    _ = try eb.undo();

    try std.testing.expect(!eb.canUndo());
    try std.testing.expect(eb.canRedo());

    _ = try eb.redo();

    try std.testing.expect(eb.canUndo());
    try std.testing.expect(!eb.canRedo());
}

test "EditBuffer - undo/redo with deleteRange" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello World");

    try eb.deleteRange(.{ .row = 0, .col = 5 }, .{ .row = 0, .col = 11 });
    var out_buffer: [100]u8 = undefined;
    var written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello", out_buffer[0..written]);

    _ = try eb.undo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello World", out_buffer[0..written]);

    _ = try eb.redo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello", out_buffer[0..written]);
}

test "EditBuffer - undo/redo with backspace" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello");

    try eb.backspace();
    var out_buffer: [100]u8 = undefined;
    var written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hell", out_buffer[0..written]);

    _ = try eb.undo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello", out_buffer[0..written]);
}

test "EditBuffer - undo/redo with deleteForward" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello");
    try eb.setCursor(0, 0);

    try eb.deleteForward();
    var out_buffer: [100]u8 = undefined;
    var written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("ello", out_buffer[0..written]);

    _ = try eb.undo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("Hello", out_buffer[0..written]);
}

test "EditBuffer - cursor position after undo" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Line 1\nLine 2");
    var cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 1), cursor.row);
    try std.testing.expectEqual(@as(u32, 6), cursor.col);

    try eb.insertText("\nLine 3");
    cursor = eb.getPrimaryCursor();
    try std.testing.expectEqual(@as(u32, 2), cursor.row);

    // Undo - cursor should be clamped to valid position
    _ = try eb.undo();
    cursor = eb.getPrimaryCursor();
    // Cursor should be clamped to end of line 1
    try std.testing.expectEqual(@as(u32, 1), cursor.row);
    try std.testing.expectEqual(@as(u32, 6), cursor.col);
}

test "EditBuffer - lineCount after undo/redo" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Line 1");
    try std.testing.expectEqual(@as(u32, 1), eb.getTextBuffer().lineCount());

    try eb.insertText("\nLine 2\nLine 3");
    try std.testing.expectEqual(@as(u32, 3), eb.getTextBuffer().lineCount());

    _ = try eb.undo();
    try std.testing.expectEqual(@as(u32, 1), eb.getTextBuffer().lineCount());

    _ = try eb.redo();
    try std.testing.expectEqual(@as(u32, 3), eb.getTextBuffer().lineCount());
}

test "EditBuffer - clearHistory" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("Hello");
    try eb.insertText(" World");

    try std.testing.expect(eb.canUndo());

    eb.clearHistory();

    try std.testing.expect(!eb.canUndo());
    try std.testing.expect(!eb.canRedo());
}

test "EditBuffer - undo history branching" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    try eb.insertText("State A");

    try eb.insertText(" -> B");

    var out_buffer: [100]u8 = undefined;
    var written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("State A -> B", out_buffer[0..written]);

    _ = try eb.undo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("State A", out_buffer[0..written]);

    // Create new branch by editing after undo
    try eb.insertText(" -> C");

    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("State A -> C", out_buffer[0..written]);

    _ = try eb.undo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("State A", out_buffer[0..written]);

    // Redo should go to state C (the new branch)
    _ = try eb.redo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("State A -> C", out_buffer[0..written]);
}

test "EditBuffer - multiple undo/redo operations" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var eb = try EditBuffer.init(std.testing.allocator, pool, link_pool, .wcwidth, null);
    defer eb.deinit();

    var out_buffer: [100]u8 = undefined;

    try eb.insertText("A");

    try eb.insertText("B");

    try eb.insertText("C");

    var written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("ABC", out_buffer[0..written]);

    _ = try eb.undo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("AB", out_buffer[0..written]);

    _ = try eb.undo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("A", out_buffer[0..written]);

    _ = try eb.redo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("AB", out_buffer[0..written]);

    _ = try eb.redo();
    written = eb.getText(&out_buffer);
    try std.testing.expectEqualStrings("ABC", out_buffer[0..written]);
}
