const std = @import("std");
const repaint = @import("scene_fixture_test.zig").repaint;
const testing = std.testing;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const ansi = @import("../ansi.zig");
const MousePointerStyle = @import("../terminal.zig").MousePointerStyle;

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

test "Scene editor custom self destruction never retains cursor resources" {
    for ([_]bool{ false, true }) |destroy_node| {
        const owner = try context.Context.init(testing.allocator, testing.io, .{});
        defer owner.deinit() catch unreachable;
        const fixture = try setup(owner, 4, 2);
        try owner.editSetText(fixture.edit, "abc", false);
        try owner.sceneSetFocus(fixture.node, true);
        try repaint(owner, fixture.session, background, true, 0);
        try testing.expect((try owner.sceneGetCursorState(fixture.session)).visible);
        try owner.sceneSetHooks(fixture.node, 48, 1, 4, 2);
        try owner.sceneFrameCancel(fixture.session, (try owner.raw().getSession(fixture.session)).scene.?.last_frame_id);
        var request = try owner.sceneFrameStep(fixture.session, null, frame_options);
        try testing.expectEqual(@as(u32, @import("context_abi_c").OT_SCENE_FRAME_RECORD), request.kind);
        try testing.expect(!(try owner.sceneGetCursorState(fixture.session)).visible);
        if (destroy_node) try owner.sceneDestroyNode(fixture.node);
        try owner.destroy(fixture.view);
        try owner.destroy(fixture.edit);
        request = try owner.sceneFrameStepWithRecording(fixture.session, request, frame_options, &.{});
        try testing.expectEqual(@as(u32, 0), request.kind);
        try testing.expect(!(try owner.sceneGetCursorState(fixture.session)).visible);
        try owner.sceneFrameCancel(fixture.session, request.frame_id);
    }
}

test "Scene editor sets the mouse pointer only when its options select one" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner, 4, 2);
    const terminal = &(try owner.raw().getSession(fixture.session)).renderer.?.terminal;
    try owner.sceneSetFocus(fixture.node, true);
    terminal.setMousePointerStyle(.crosshair);
    try repaint(owner, fixture.session, background, true, 0);
    try testing.expectEqual(.crosshair, terminal.getMousePointer());
    try owner.sceneSetEditorOptions(fixture.node, .{ .mouse_pointer = @intFromEnum(MousePointerStyle.zoom_out) });
    try repaint(owner, fixture.session, background, true, 0);
    try testing.expectEqual(.zoom_out, terminal.getMousePointer());
}

test "Scene editor clamps cursor coordinates to terminal storage" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner, 4, 2);
    try owner.sceneSetFocus(fixture.node, true);
    for ([_][2]f64{ .{ -1e9, 1 }, .{ 65534, 65535 }, .{ 65535, 65536 }, .{ 1e9, 65536 } }) |row| {
        try owner.sceneSetPaint(fixture.node, .{ .translateX = row[0], .translateY = row[0] });
        try repaint(owner, fixture.session, background, true, 0);
        const cursor = try owner.sceneGetCursorState(fixture.session);
        try testing.expectEqual([2]f64{ row[1], row[1] }, [2]f64{ @floatFromInt(cursor.x), @floatFromInt(cursor.y) });
    }
}

test "Scene editor checked preparation reports allocation failure and retries without a stale cursor" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner, 4, 2);
    try owner.editSetText(fixture.edit, "native", false);
    const editor = try owner.raw().getEditorView(fixture.view);
    editor.view.setWrapMode(.char);
    try owner.sceneSetFocus(fixture.node, true);
    try repaint(owner, fixture.session, background, true, 0);
    try testing.expect((try owner.sceneGetCursorState(fixture.session)).visible);

    const state = (try owner.raw().getSession(fixture.session)).scene.?;
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
    const cli = try owner.raw().getSessionRenderer(fixture.session);
    try testing.expectError(error.OutOfMemory, cli.getNextBuffer().drawEditorViewChecked(editor.view, 0, 0));
    try testing.expectError(error.OutOfMemory, repaint(owner, fixture.session, background, true, 0));
    try testing.expect(failing.has_induced_failure);
    try testing.expect(!(try owner.sceneGetCursorState(fixture.session)).visible);
    try testing.expect(state.attempt == null and state.work.items.len == 0);
    try testing.expectEqual(@as(usize, 0), cli.getNextBuffer().scissor_stack.items.len);
    try testing.expectEqual(@as(usize, 0), cli.getNextBuffer().opacity_stack.items.len);

    arena.child_allocator = allocator;
    try repaint(owner, fixture.session, background, true, 0);
    try testing.expectEqual(@as(u32, 'n'), cli.getNextBuffer().get(0, 0).?.char);
    try testing.expect((try owner.sceneGetCursorState(fixture.session)).visible);
}

/// Paints a fresh draft, answering a RECORD request with an empty recording.
fn paintFrame(owner: *context.Context, id: context.Handle) !void {
    const state = (try owner.raw().getSession(id)).scene.?;
    if (state.painted) |painted| try owner.sceneFrameCancel(id, painted.ticket.frame_id);
    var request = try owner.sceneFrameStep(id, null, frame_options);
    if (request.kind == @import("context_abi_c").OT_SCENE_FRAME_RECORD) request = try owner.sceneFrameStepWithRecording(id, request, frame_options, &.{});
    try testing.expectEqual(@as(u32, 0), request.kind);
}

test "Scene editor cursor is maintained once per frame for the focused editor member" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner, 4, 1);
    // Three editors in rows 0 to 2, then a box in row 3. Editor 1 can carry a paint hook.
    var editors: [3]context.Handle = .{ fixture.node, undefined, undefined };
    for (editors[1..], 1..) |*node, index| {
        node.* = try owner.sceneCreateNode(fixture.session, 5, @intCast(2 + index));
        try owner.sceneSetEditorView(node.*, try owner.createEditorView(try owner.createEditBuffer(.unicode), 1, 1));
        try dimensions(owner, node.*, 4, 1);
        try owner.sceneMoveNode(node.*, fixture.root, @intCast(index));
    }
    const box = try owner.sceneCreateNode(fixture.session, 1, 5);
    try dimensions(owner, box, 4, 1);
    try owner.sceneMoveNode(box, fixture.root, 3);
    const Focus = enum { none, first, last, box };
    const rows = [_]struct {
        focus: Focus,
        show_cursor: bool = true,
        hidden: bool = false,
        hooked: bool = false,
        host: bool = false,
        // Cursor x, y, visible after each of the row's two frames.
        cursor: [3]u32,
        // Cursor steps on the row's first frame (after the change) and its second.
        steps: [2]u64,
    }{
        .{ .focus = .none, .cursor = .{ 1, 1, 0 }, .steps = .{ 0, 0 } },
        .{ .focus = .first, .cursor = .{ 1, 1, 1 }, .steps = .{ 1, 1 } },
        .{ .focus = .last, .cursor = .{ 1, 3, 1 }, .steps = .{ 1, 1 } },
        // Hiding the focused editor's cursor releases it once.
        .{ .focus = .last, .show_cursor = false, .cursor = .{ 1, 1, 0 }, .steps = .{ 2, 1 } },
        .{ .focus = .first, .cursor = .{ 1, 1, 1 }, .steps = .{ 1, 1 } },
        // Focus moving off every editor releases the cursor once.
        .{ .focus = .box, .cursor = .{ 1, 1, 0 }, .steps = .{ 1, 0 } },
        .{ .focus = .last, .hidden = true, .cursor = .{ 1, 1, 0 }, .steps = .{ 0, 0 } },
        .{ .focus = .first, .hooked = true, .cursor = .{ 1, 1, 1 }, .steps = .{ 1, 2 } },
        // A host cursor survives frames without a focused editor; a focused editor wins.
        .{ .focus = .none, .host = true, .cursor = .{ 9, 5, 1 }, .steps = .{ 0, 0 } },
        .{ .focus = .first, .host = true, .cursor = .{ 1, 1, 1 }, .steps = .{ 1, 1 } },
    };
    const state = (try owner.raw().getSession(fixture.session)).scene.?;
    for (rows) |row| {
        const focused: ?context.Handle = switch (row.focus) {
            .none => null,
            .first => editors[0],
            .last => editors[2],
            .box => box,
        };
        for (editors ++ [_]context.Handle{box}) |node| try owner.sceneSetFocus(node, if (focused) |target| std.meta.eql(target, node) else false);
        try owner.sceneSetEditorOptions(editors[2], .{ .show_cursor = row.show_cursor });
        try owner.sceneSetStyle(editors[2], 0, 9, 0, 0, if (row.hidden) 1 else 0, 0);
        try owner.sceneSetHooks(editors[1], if (row.hooked) 16 else 0, state.last_frame_id + 1, 4, 1);
        for (row.steps, 0..) |steps, frame| {
            if (row.host) try owner.controlSession(fixture.session, .{ .cursor = .{ .position = .{ .x = 9, .y = 5, .visible = true } } });
            const before = state.test_cursor_steps;
            try paintFrame(owner, fixture.session);
            const cursor = try owner.sceneGetCursorState(fixture.session);
            try testing.expectEqual(row.cursor, [3]u32{ cursor.x, cursor.y, @intFromBool(cursor.visible) });
            testing.expectEqual(steps, state.test_cursor_steps - before) catch |err| {
                std.debug.print("row {any} frame {d}\n", .{ row.focus, frame });
                return err;
            };
        }
    }
}
