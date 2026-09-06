const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const ansi = @import("../ansi.zig");
const yoga = @import("../yoga.zig");

const background: ansi.RGBA = .{ 0, 0, 0, 255 };
const frame_options: scene.FrameOptions = .{
    .background = background,
    .use_mouse = true,
    .excluded_hit_num = 0,
    .max_layout_rounds = 8,
    .max_host_requests = 64,
};

const Fixture = struct {
    session: context.Handle,
    root: context.Handle,
    node: context.Handle,
    edit: context.Handle,
    view: context.Handle,
};

fn setup(owner: *context.Context, width: f32, height: f32) !Fixture {
    const id = try owner.createSession(.{ .chunk_size = 4096 });
    try owner.attachSessionRenderer(id, 12, 6, .{ .remote_mode = .remote });
    const root = try owner.sceneCreateNode(id, 0, 1);
    const node = try owner.sceneCreateNode(id, 5, 2);
    const edit = try owner.createEditBuffer(.unicode);
    const view = try owner.createEditorView(edit, 1, 1);
    try owner.sceneSetEditorView(node, view);
    try dimensions(owner, node, width, height);
    try owner.sceneMoveNode(node, root, 0);
    return .{ .session = id, .root = root, .node = node, .edit = edit, .view = view };
}

fn dimensions(owner: *context.Context, node: context.Handle, width: f32, height: f32) !void {
    try owner.sceneSetStyle(node, 4, 0, 0, 1, width, 1);
    try owner.sceneSetStyle(node, 4, 1, 0, 1, height, 1);
}

fn expectLayoutDirty(owner: *context.Context, node: context.Handle, expected: u32) !void {
    var dirty: u32 = undefined;
    try yoga.check(yoga.yogaNodeIsDirtyChecked((try owner.getRenderable(node)).yoga_node, &dirty));
    try testing.expectEqual(expected, dirty);
}

test "Scene editor paint-only updates preserve intrinsic layout" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner, 4, 2);
    try owner.editSetText(fixture.edit, "abc\ndef", false);
    const dependent = try owner.sceneCreateNode(fixture.session, 1, 3);
    try (try owner.getRenderable(dependent)).setMeasureTarget(.{ .editor_view = (try owner.getEditorView(fixture.view)).view });
    try owner.sceneMoveNode(dependent, fixture.root, 1);
    try owner.scenePaint(fixture.session, background, true, 0);
    try expectLayoutDirty(owner, fixture.node, 0);
    try expectLayoutDirty(owner, dependent, 0);
    const state = (try owner.getRenderable(fixture.node)).scene_node.?.owner;
    const layout_epoch = state.layout_epoch;
    const work_count = state.work.items.len;
    try testing.expect(work_count != 0);

    try owner.editorCommand(fixture.view, .{ .cursor_offset = 1 });
    try testing.expectEqual(@as(u32, 1), (try owner.getEditorView(fixture.view)).view.getPrimaryCursor().offset);
    try expectLayoutDirty(owner, fixture.node, 0);
    try expectLayoutDirty(owner, dependent, 0);
    try testing.expect(!state.preparation_dirty);
    try testing.expectEqual(work_count, state.work.items.len);

    _ = try owner.editorSelect(fixture.view, .{
        .operation = .local,
        .anchor_x = 0,
        .anchor_y = 0,
        .focus_x = 1,
        .focus_y = 0,
        .background = .{ 120, 40, 20, 255 },
    });
    try expectLayoutDirty(owner, fixture.node, 0);
    try expectLayoutDirty(owner, dependent, 0);
    try owner.editorSetTabColor(fixture.view, .{ 10, 20, 30, 255 });
    try expectLayoutDirty(owner, fixture.node, 0);
    try expectLayoutDirty(owner, dependent, 0);
    try testing.expect(!state.preparation_dirty);
    try testing.expectEqual(work_count, state.work.items.len);

    try owner.scenePaint(fixture.session, background, true, 0);
    try testing.expectEqual(layout_epoch, state.layout_epoch);
    const target = (try owner.getSessionRenderer(fixture.session)).getNextBuffer();
    try testing.expectEqual(ansi.rgbColor(120, 40, 20, 255), target.get(0, 0).?.bg);
    try testing.expectEqual(@as(u32, 'a'), target.get(0, 0).?.char);
    try testing.expectEqual(@as(u32, 'f'), target.get(2, 1).?.char);
}

test "Scene editor retained geometry refreshes cursor following and shared buffer views" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner, 4, 2);
    const editor = try owner.getEditorView(fixture.view);
    const peer = try owner.createEditorView(fixture.edit, 4, 2);
    try owner.editSetText(fixture.edit, "0000\n1111\n2222\n3333", false);
    try owner.sceneSetFocus(fixture.node, true);
    try owner.scenePaint(fixture.session, background, true, 0);
    const state = (try owner.getSession(fixture.session)).scene.?;
    const epoch = state.layout_epoch;
    const count = state.work.items.len;
    try testing.expect(count != 0);
    _ = try owner.editorSelect(fixture.view, .{ .operation = .set, .start = 0, .end = 1 });
    try owner.editSetCursor(fixture.edit, 3, 2);
    try testing.expectEqual(@as(u32, 0), editor.view.getViewport().?.y);
    try testing.expectEqual(@as(u32, 2), (try owner.getEditorView(peer)).view.getViewport().?.y);
    try testing.expect(!state.preparation_dirty);
    try testing.expectEqual(count, state.work.items.len);
    try owner.scenePaint(fixture.session, background, true, 0);
    const target = (try owner.getSessionRenderer(fixture.session)).getNextBuffer();
    try testing.expectEqual(@as(u32, '0'), target.get(0, 0).?.char);

    _ = try owner.editorSelect(fixture.view, .{ .operation = .local_reset });
    try testing.expectEqual(@as(u32, 0), editor.view.getViewport().?.y);
    try testing.expectEqual(count, state.work.items.len);
    try owner.scenePaint(fixture.session, background, true, 0);
    try testing.expectEqual(@as(u32, 2), editor.view.getViewport().?.y);
    try testing.expectEqual(epoch, state.layout_epoch);
    try testing.expectEqual(@as(u32, '2'), target.get(0, 0).?.char);
    try testing.expectEqual(@as(u32, '3'), target.get(0, 1).?.char);
    const cursor = try owner.sceneGetCursorState(fixture.session);
    try testing.expect(cursor.visible);
    try testing.expectEqual(@as(u32, 3), cursor.x);
    try testing.expectEqual(@as(u32, 2), cursor.y);

    try owner.editSetCursor(fixture.edit, 0, 0);
    _ = try owner.editorSelect(fixture.view, .{ .operation = .local, .anchor_x = 0, .anchor_y = 0, .focus_x = 2, .focus_y = 3, .update_cursor = true, .follow_cursor = true });
    try testing.expectEqual(count, state.work.items.len);
    try owner.scenePaint(fixture.session, background, true, 0);
    try testing.expectEqual(@as(u32, 2), editor.view.getViewport().?.y);
    try testing.expectEqual(epoch, state.layout_epoch);
    try testing.expectEqual(@as(u32, '2'), target.get(0, 0).?.char);
    _ = try owner.editorSelect(fixture.view, .{ .operation = .reset });

    try owner.editSetText(fixture.edit, "", false);
    try testing.expect(state.preparation_dirty and state.work.items.len == 0);
    try owner.scenePaint(fixture.session, background, true, 0);
    try owner.editorSetPlaceholder(fixture.view, "hint", &.{.{ .byte_count = 4 }});
    try testing.expect(state.preparation_dirty and state.work.items.len == 0);
    try owner.scenePaint(fixture.session, background, true, 0);
    try testing.expectEqual(@as(u32, 'h'), target.get(0, 0).?.char);
    try owner.editSetText(fixture.edit, "x", false);
    try testing.expect(state.preparation_dirty and state.work.items.len == 0);
    try owner.scenePaint(fixture.session, background, true, 0);
    try testing.expectEqual(@as(u32, 'x'), target.get(0, 0).?.char);
}

test "Scene editor custom self preserves cursor maintenance through hook replacement and completion" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner, 4, 3);
    (try owner.getEditorView(fixture.view)).view.setWrapMode(.char);
    try owner.editSetText(fixture.edit, "abcdef", false);
    try owner.editSetCursor(fixture.edit, 0, 1);
    try owner.sceneSetPaint(fixture.node, .{ .translateX = 2, .translateY = 1 });
    try owner.sceneSetFocus(fixture.node, true);
    try owner.scenePaint(fixture.session, background, true, 0);
    const initial = try owner.sceneGetCursorState(fixture.session);
    try testing.expect(initial.visible);
    try testing.expectEqual(@as(u32, 4), initial.x);
    try testing.expectEqual(@as(u32, 2), initial.y);

    for ([_][2]u32{ .{ 32, 32 }, .{ 48, 16 }, .{ 48, 48 } }, 0..) |hooks, index| {
        try owner.editSetCursor(fixture.edit, 0, 1);
        try owner.sceneSetHooks(fixture.node, hooks[0], index * 2 + 1, 4, 3);
        var request = try owner.sceneFrameStep(fixture.session, null, frame_options);
        try testing.expectEqual(@as(u32, 7), request.kind);
        try owner.editSetCursor(fixture.edit, 0, 5);
        try testing.expect((try owner.getSession(fixture.session)).scene.?.preparation_dirty);
        _ = try owner.editorSelect(fixture.view, .{ .operation = .set, .start = 0, .end = 1 });
        try owner.editorSetTabColor(fixture.view, .{ 10, 20, 30, 255 });
        try testing.expect((try owner.getSession(fixture.session)).scene.?.preparation_dirty);
        try owner.sceneSetEditorOptions(fixture.node, .{ .style = 2, .blinking = false, .color = .{ 255, 0, 0, 255 } });
        try owner.sceneSetHooks(fixture.node, hooks[1], index * 2 + 2, 4, 3);
        try owner.drawBuffer(fixture.session, request, .{ .operation = .cell, .char = 'X' }, "", "");
        request = try owner.sceneFrameStep(fixture.session, request, frame_options);
        try testing.expectEqual(@as(u32, if (hooks[1] & 16 != 0) 5 else 0), request.kind);
        const cursor = try owner.sceneGetCursorState(fixture.session);
        try testing.expect(cursor.visible);
        try testing.expectEqual(@as(u32, 4), cursor.x);
        try testing.expectEqual(@as(u32, 3), cursor.y);
        try testing.expectEqual(@as(u32, 2), cursor.style);
        try testing.expect(!cursor.blinking);
        try testing.expectEqual([4]f32{ 1, 0, 0, 1 }, cursor.color);
        const target = (try owner.getSessionRenderer(fixture.session)).getNextBuffer();
        try testing.expectEqual(@as(u32, 'X'), target.get(0, 0).?.char);
        try testing.expectEqual(@as(u32, ' '), target.get(2, 1).?.char);
        if (request.kind == 5) request = try owner.sceneFrameStep(fixture.session, request, frame_options);
        try testing.expectEqual(@as(u32, 0), request.kind);
        try testing.expectEqualDeep(cursor, try owner.sceneGetCursorState(fixture.session));
        try owner.sceneFrameCancel(fixture.session, request.frame_id);
        request = try owner.sceneFrameStep(fixture.session, null, frame_options);
        try testing.expectEqual(@as(u32, if (hooks[1] & 32 != 0) 7 else 5), request.kind);
        try owner.sceneFrameCancel(fixture.session, request.frame_id);
    }
}

test "Scene editor custom self destruction never retains cursor resources" {
    for ([_]bool{ false, true }) |destroy_node| {
        const owner = try context.Context.init(testing.allocator, testing.io, .{});
        defer owner.deinit() catch unreachable;
        const fixture = try setup(owner, 4, 2);
        try owner.editSetText(fixture.edit, "abc", false);
        try owner.sceneSetFocus(fixture.node, true);
        try owner.scenePaint(fixture.session, background, true, 0);
        try testing.expect((try owner.sceneGetCursorState(fixture.session)).visible);
        try owner.sceneSetHooks(fixture.node, 48, 1, 4, 2);
        var request = try owner.sceneFrameStep(fixture.session, null, frame_options);
        try testing.expectEqual(@as(u32, 7), request.kind);
        if (destroy_node) try owner.sceneDestroyNode(fixture.node);
        try owner.destroy(fixture.view);
        try owner.destroy(fixture.edit);
        request = try owner.sceneFrameStep(fixture.session, request, frame_options);
        try testing.expectEqual(@as(u32, 5), request.kind);
        try testing.expect(!(try owner.sceneGetCursorState(fixture.session)).visible);
        request = try owner.sceneFrameStep(fixture.session, request, frame_options);
        try testing.expectEqual(@as(u32, 0), request.kind);
        try testing.expect(!(try owner.sceneGetCursorState(fixture.session)).visible);
        try owner.sceneFrameCancel(fixture.session, request.frame_id);
    }
}

test "Scene editor cursor follows focus visibility options and resource lifetime" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner, 4, 2);
    try testing.expect(!(try owner.sceneGetCursorState(fixture.session)).visible);
    try owner.scenePaint(fixture.session, background, true, 0);
    try testing.expect(!(try owner.sceneGetCursorState(fixture.session)).visible);
    try owner.sceneSetEditorOptions(fixture.node, .{ .show_cursor = false });
    try owner.sceneSetFocus(fixture.node, true);
    try owner.scenePaint(fixture.session, background, true, 0);
    try testing.expect(!(try owner.sceneGetCursorState(fixture.session)).visible);
    try owner.sceneSetEditorOptions(fixture.node, .{});
    try owner.editSetText(fixture.edit, "abc", false);
    try owner.sceneSetFocus(fixture.node, true);
    try owner.sceneSetPaint(fixture.node, .{ .translateX = -0.5, .translateY = 1.75 });
    try (try owner.getEditBuffer(fixture.edit)).buffer.setCursor(0, 1);
    try owner.scenePaint(fixture.session, background, true, 0);
    var cursor = try owner.sceneGetCursorState(fixture.session);
    try testing.expect(cursor.visible);
    try testing.expectEqual(@as(u32, 1), cursor.x);
    try testing.expectEqual(@as(u32, 2), cursor.y);

    try owner.sceneSetEditorOptions(fixture.node, .{ .show_cursor = false });
    try owner.scenePaint(fixture.session, background, true, 0);
    try testing.expect(!(try owner.sceneGetCursorState(fixture.session)).visible);
    try owner.sceneSetEditorOptions(fixture.node, .{});
    try owner.sceneSetFocus(fixture.node, false);
    try owner.scenePaint(fixture.session, background, true, 0);
    try testing.expect(!(try owner.sceneGetCursorState(fixture.session)).visible);
    try owner.sceneSetFocus(fixture.node, true);
    try owner.scenePaint(fixture.session, background, true, 0);
    try testing.expect((try owner.sceneGetCursorState(fixture.session)).visible);

    try owner.sceneSetStyle(fixture.node, 0, 9, 0, 0, 1, 0);
    try owner.scenePaint(fixture.session, background, true, 0);
    try testing.expect(!(try owner.sceneGetCursorState(fixture.session)).visible);
    try owner.sceneSetStyle(fixture.node, 0, 9, 0, 0, 0, 0);
    try owner.scenePaint(fixture.session, background, true, 0);
    try testing.expect((try owner.sceneGetCursorState(fixture.session)).visible);
    try owner.sceneSetEditorView(fixture.node, null);
    try owner.sceneSetPaint(fixture.node, .{ .background = .{ 200, 0, 0, 255 } });
    try owner.scenePaint(fixture.session, background, true, 0);
    try testing.expect(!(try owner.sceneGetCursorState(fixture.session)).visible);
    const empty = (try owner.getSessionRenderer(fixture.session)).getNextBuffer().get(0, 0).?;
    try testing.expectEqual(ansi.rgbColor(0, 0, 0, 255), empty.bg);
    try testing.expectEqual(@as(u32, ' '), empty.char);
    try owner.sceneSetEditorView(fixture.node, fixture.view);
    try owner.scenePaint(fixture.session, background, true, 0);
    try owner.destroy(fixture.view);
    try owner.scenePaint(fixture.session, background, true, 0);
    cursor = try owner.sceneGetCursorState(fixture.session);
    try testing.expect(!cursor.visible);
    try testing.expect((try owner.getRenderable(fixture.node)).scene_node.?.editor == null);
}

test "Scene editor budgeted paint prepares a rebound view without host drawing" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner, 4, 2);
    const box = try owner.sceneCreateNode(fixture.session, 1, 3);
    try dimensions(owner, box, 4, 1);
    try owner.sceneSetPaint(box, .{ .zIndex = -1 });
    try owner.sceneMoveNode(box, fixture.root, 0);
    try owner.editSetText(fixture.edit, "native", false);
    (try owner.getEditorView(fixture.view)).view.setWrapMode(.char);
    try owner.sceneSetFocus(fixture.node, true);
    const initial_cursor = try owner.sceneGetCursorState(fixture.session);
    const first = try owner.sceneFrameStepBudgeted(fixture.session, null, frame_options, 1);
    try testing.expectEqual(@as(u32, 6), first.kind);
    try testing.expectEqualDeep(initial_cursor, try owner.sceneGetCursorState(fixture.session));
    const replacement = try owner.createEditorView(fixture.edit, 1, 1);
    (try owner.getEditorView(replacement)).view.setWrapMode(.char);
    try owner.sceneSetEditorView(fixture.node, replacement);
    const done = try owner.sceneFrameStepBudgeted(fixture.session, first, frame_options, 1);
    try testing.expectEqual(@as(u32, 0), done.kind);
    const target = (try owner.getSessionRenderer(fixture.session)).getNextBuffer();
    try testing.expectEqual(@as(u32, 'n'), target.get(0, 1).?.char);
    try testing.expectEqual(@as(u32, 'v'), target.get(0, 2).?.char);
    try testing.expectEqual(@as(u32, 2), (try owner.sceneGetCursorState(fixture.session)).y);
}

test "Scene editor rejects cursor coordinates beyond terminal storage" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner, 4, 2);
    try owner.sceneSetFocus(fixture.node, true);
    try owner.scenePaint(fixture.session, background, true, 0);
    try owner.sceneSetPaint(fixture.node, .{ .translateX = 65536 });
    try testing.expectError(error.InvalidDimensions, owner.scenePaint(fixture.session, background, true, 0));
    try testing.expect(!(try owner.sceneGetCursorState(fixture.session)).visible);
    try owner.sceneSetPaint(fixture.node, .{ .translateX = 65535 });
    try owner.scenePaint(fixture.session, background, true, 0);
    try testing.expectEqual(@as(u32, 65536), (try owner.sceneGetCursorState(fixture.session)).x);
}

test "Scene editor checked preparation reports allocation failure and retries without a stale cursor" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner, 4, 2);
    try owner.editSetText(fixture.edit, "native", false);
    const editor = try owner.getEditorView(fixture.view);
    editor.view.setWrapMode(.char);
    try owner.sceneSetFocus(fixture.node, true);
    try owner.scenePaint(fixture.session, background, true, 0);
    try testing.expect((try owner.sceneGetCursorState(fixture.session)).visible);

    const state = (try owner.getSession(fixture.session)).scene.?;
    const retained_count = state.work.items.len;
    try testing.expect(retained_count != 0);
    try owner.editorSetTabColor(fixture.view, .{ 10, 20, 30, 255 });
    try testing.expect(!state.preparation_dirty);
    try testing.expectEqual(retained_count, state.work.items.len);
    const layout_view = editor.view.getTextBufferView();
    const arena = layout_view.virtual_lines_arena;
    _ = arena.reset(.free_all);
    const allocator = arena.child_allocator;
    var failing = testing.FailingAllocator.init(allocator, .{ .fail_index = 0 });
    arena.child_allocator = failing.allocator();
    defer arena.child_allocator = allocator;
    layout_view.virtual_lines_dirty = true;
    const cli = try owner.getSessionRenderer(fixture.session);
    try testing.expectError(error.OutOfMemory, cli.getNextBuffer().drawEditorViewChecked(editor.view, 0, 0));
    try testing.expectError(error.OutOfMemory, owner.scenePaint(fixture.session, background, true, 0));
    try testing.expect(failing.has_induced_failure);
    try testing.expect(!(try owner.sceneGetCursorState(fixture.session)).visible);
    try testing.expect(state.attempt == null and state.work.items.len == 0);
    try testing.expectEqual(@as(usize, 0), cli.getNextBuffer().scissor_stack.items.len);
    try testing.expectEqual(@as(usize, 0), cli.getNextBuffer().opacity_stack.items.len);

    arena.child_allocator = allocator;
    try owner.scenePaint(fixture.session, background, true, 0);
    try testing.expectEqual(@as(u32, 'n'), cli.getNextBuffer().get(0, 0).?.char);
    try testing.expect((try owner.sceneGetCursorState(fixture.session)).visible);
}
