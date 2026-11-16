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

test "Scene text and following editors take their session's new width method" {
    const WidthMethod = @import("../utf8.zig").WidthMethod;
    const cells = struct {
        fn of(method: WidthMethod) u32 {
            return if (method == .wcwidth) 4 else 2;
        }
    }.of;
    for ([_][2]WidthMethod{ .{ .unicode, .wcwidth }, .{ .wcwidth, .unicode }, .{ .unicode, .unicode_wide } }) |pair| {
        errdefer std.debug.print("from={t} to={t}\n", .{ pair[0], pair[1] });
        const owner = try context.Context.init(testing.allocator, testing.io, .{});
        defer owner.deinit() catch unreachable;
        const parent = try owner.createSession(.{ .chunk_size = 4096 });
        try owner.attachSessionRenderer(parent, 12, 6, .{ .remote_mode = .remote });
        const source = (try owner.raw().getSession(parent)).renderer.?;
        source.terminal.caps.unicode = pair[0];
        source.syncWidthMethod();
        const fixture = try setup(owner, 8, 2);
        const child = try owner.raw().getSession(fixture.session);
        try child.syncDetached(try owner.raw().getSession(parent));
        // The editor of `setup` was created before the sync with the startup method.
        (try owner.raw().getEditBuffer(fixture.edit)).follow_width = true;
        try owner.sceneSetEditorView(fixture.node, fixture.view);
        const explicit = try owner.createEditBuffer(pair[0]);
        try owner.sceneSetEditorView(try owner.sceneCreateNode(fixture.session, 5, 5), try owner.createEditorView(explicit, 1, 1));
        const text = try owner.sceneCreateNode(fixture.session, 2, 3);
        try owner.sceneSetText(text, "\u{1f44d}\u{1f3fd}x");
        const shared = try owner.createTextBuffer(pair[0]);
        (try owner.raw().getTextBuffer(shared)).follow_width = true;
        try owner.textBufferSetText(shared, "\u{1f44d}\u{1f3fd}x");
        const text_view = try owner.sceneCreateNode(fixture.session, 7, 6);
        try owner.sceneSetTextView(text_view, try owner.createTextBufferView(shared));
        // Laid out at their text's width, before and after the change.
        const c = @import("context_abi_c");
        try owner.sceneSetStyle(fixture.root, c.OT_STYLE_ENUM, c.OT_STYLE_ENUM_ALIGN_ITEMS, 0, 0, c.OT_ALIGN_FLEX_START, 0);
        for ([_]context.Handle{ text, text_view }, 1..) |node, index| try owner.sceneMoveNode(node, fixture.root, @intCast(index));
        const laid = struct {
            fn out(o: *context.Context, session: context.Handle, nodes: [2]context.Handle) ![2]f32 {
                try repaint(o, session, background, true, 0);
                try o.sceneFrameCancel(session, (try o.raw().getSession(session)).scene.?.last_frame_id);
                return .{ (try o.sceneGetPaintLayout(nodes[0], false)).width, (try o.sceneGetPaintLayout(nodes[1], false)).width };
            }
        }.out;
        try testing.expectEqual(@as(f32, @floatFromInt(cells(pair[0]) + 1)), (try laid(owner, fixture.session, .{ text, text_view }))[0]);
        for ([_]context.Handle{ fixture.edit, explicit }) |edit| try owner.editInsertText(edit, "\u{1f44d}\u{1f3fd}");
        source.terminal.caps.unicode = pair[1];
        source.syncWidthMethod();
        try child.syncDetached(try owner.raw().getSession(parent));
        const late = try owner.createEditBuffer(pair[0]);
        (try owner.raw().getEditBuffer(late)).follow_width = true;
        try owner.editInsertText(late, "\u{1f44d}\u{1f3fd}");
        const late_node = try owner.sceneCreateNode(fixture.session, 5, 4);
        try owner.sceneSetEditorView(late_node, try owner.createEditorView(late, 1, 1));
        for ([_]context.Handle{ fixture.edit, late, explicit }, [_]WidthMethod{ pair[1], pair[1], pair[0] }) |edit, method| {
            try testing.expectEqual(cells(method), (try owner.raw().getEditBuffer(edit)).buffer.getPrimaryCursor().offset);
        }
        try testing.expectEqual(@as([2]f32, @splat(@floatFromInt(cells(pair[1]) + 1))), try laid(owner, fixture.session, .{ text, text_view }));
        for ([_]*@import("../text-buffer.zig").UnifiedTextBuffer{ (try owner.raw().getRenderable(text)).scene_node.?.text.?.buffer, (try owner.raw().getTextBuffer(shared)).buffer }) |shown| {
            try testing.expectEqual(cells(pair[1]) + 1, shown.lineWidthAt(0));
        }
    }
}

test "Scene a following buffer is shown by one session at a time" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    // Session A measures with unicode, B with wcwidth.
    var nodes: [2]context.Handle = undefined;
    for (&nodes, [_]@import("../utf8.zig").WidthMethod{ .unicode, .wcwidth }) |*node, method| {
        const id = try owner.createSession(.{ .chunk_size = 4096 });
        try owner.attachSessionRenderer(id, 12, 6, .{ .remote_mode = .remote });
        const value = (try owner.raw().getSession(id)).renderer.?;
        value.terminal.caps.unicode = method;
        value.syncWidthMethod();
        _ = try owner.sceneCreateNode(id, 0, 1);
        node.* = try owner.sceneCreateNode(id, 5, 2);
    }
    const edit = try owner.createEditBuffer(.unicode);
    (try owner.raw().getEditBuffer(edit)).follow_width = true;
    const views = [2]context.Handle{ try owner.createEditorView(edit, 1, 1), try owner.createEditorView(edit, 1, 1) };
    try owner.sceneSetEditorView(nodes[0], views[0]);
    try owner.editInsertText(edit, "\u{1f44d}\u{1f3fd}");
    const cursor = &(try owner.raw().getEditBuffer(edit)).buffer.cursor;
    // A second view in B is rejected; A keeps its binding and its cursor.
    try testing.expectError(error.WrongSession, owner.sceneSetEditorView(nodes[1], views[1]));
    try testing.expectEqual(@as(u32, 2), cursor.offset);
    try testing.expectEqual(try owner.raw().getEditorView(views[0]), (try owner.raw().getRenderable(nodes[0])).scene_node.?.editor.?);
    try testing.expect((try owner.raw().getRenderable(nodes[1])).scene_node.?.editor == null);
    // Unbound from A, it moves to B and measures with B's method.
    try owner.sceneSetEditorView(nodes[0], null);
    try owner.sceneSetEditorView(nodes[1], views[1]);
    try testing.expectEqual(@as(u32, 4), cursor.offset);
    // The same view, shown in B, is refused in A with the same status; an explicit buffer keeps the one-node status.
    try testing.expectError(error.WrongSession, owner.sceneSetEditorView(nodes[0], views[1]));
    const session_b = (try owner.raw().getRenderable(nodes[1])).scene_node.?.owner.session;
    const explicit = try owner.createEditorView(try owner.createEditBuffer(.unicode), 1, 1);
    try owner.sceneSetEditorView(try owner.sceneCreateNode(session_b, 5, 9), explicit);
    try testing.expectError(error.ContextBusy, owner.sceneSetEditorView(nodes[0], explicit));
    // Text views follow the same rule: B shows the shared text, so A cannot.
    const shared = try owner.createTextBuffer(.unicode);
    (try owner.raw().getTextBuffer(shared)).follow_width = true;
    var text_nodes: [2]context.Handle = undefined;
    for (&text_nodes, nodes) |*node, editor| node.* = try owner.sceneCreateNode((try owner.raw().getRenderable(editor)).scene_node.?.owner.session, 7, 3);
    const shown = try owner.createTextBufferView(shared);
    try owner.sceneSetTextView(text_nodes[1], shown);
    try testing.expectError(error.WrongSession, owner.sceneSetTextView(text_nodes[0], try owner.createTextBufferView(shared)));
    try testing.expectError(error.WrongSession, owner.sceneSetTextView(text_nodes[0], shown));
    // A following buffer's width method belongs to its session.
    try testing.expectError(error.InvalidOptions, owner.textBufferSetWidthMethod(shared, .wcwidth));
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
    try owner.sceneSetEditorOptions(fixture.node, .{ .mouse_pointer = @backingInt(MousePointerStyle.zoom_out) });
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
    const retained_count = state.candidates.items.len;
    try testing.expect(retained_count != 0);
    try owner.editorSetTabColor(fixture.view, .{ 10, 20, 30, 255 });
    try testing.expect(!state.preparation_dirty);
    try testing.expectEqual(retained_count, state.candidates.items.len);
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
    try testing.expect(state.attempt == null and state.candidates.items.len == 0);
    try testing.expectEqual(@as(usize, 0), cli.getNextBuffer().scissor_stack.items.len);
    try testing.expectEqual(@as(usize, 0), cli.getNextBuffer().opacity_stack.items.len);

    arena.child_allocator = allocator;
    try repaint(owner, fixture.session, background, true, 0);
    try testing.expectEqual(@as(u32, 'n'), cli.getNextBuffer().get(0, 0).?.char);
    try testing.expect((try owner.sceneGetCursorState(fixture.session)).visible);
}

test "Scene editor cursor is maintained once per frame for the focused editor member" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner, 4, 1);
    // Editors in rows 0 to 2, then a box in row 3. Editor 1 can carry a paint hook.
    var nodes: [4]context.Handle = .{ fixture.node, undefined, undefined, undefined };
    for (nodes[1..3], 1..) |*node, index| {
        node.* = try owner.sceneCreateNode(fixture.session, 5, @intCast(2 + index));
        try owner.sceneSetEditorView(node.*, try owner.createEditorView(try owner.createEditBuffer(.unicode), 1, 1));
    }
    nodes[3] = try owner.sceneCreateNode(fixture.session, 1, 5);
    for (nodes[1..], 1..) |node, index| {
        try dimensions(owner, node, 4, 1);
        try owner.sceneMoveNode(node, fixture.root, @intCast(index));
    }
    // The first editor draws a red line cursor, the last a green underline.
    try owner.sceneSetEditorOptions(nodes[0], .{ .style = 1, .color = .{ 255, 0, 0, 255 } });
    const rows = [_]struct {
        // Index of the focused node, if any.
        focus: ?usize,
        show_cursor: bool = true,
        hidden: bool = false,
        hooked: bool = false,
        host: bool = false,
        // Cursor x, y, visible, style, and red channel after each of the row's two frames.
        cursor: [5]u32,
        // Cursor steps on the row's first frame (after the change) and its second.
        steps: [2]u64,
    }{
        .{ .focus = null, .cursor = .{ 1, 1, 0, 3, 255 }, .steps = .{ 0, 0 } },
        .{ .focus = 0, .cursor = .{ 1, 1, 1, 1, 255 }, .steps = .{ 1, 1 } },
        .{ .focus = 2, .cursor = .{ 1, 3, 1, 2, 0 }, .steps = .{ 1, 1 } },
        // Hiding the focused editor releases the cursor once, even while it stays in reused work.
        .{ .focus = 2, .hidden = true, .cursor = .{ 1, 1, 0, 2, 0 }, .steps = .{ 1, 0 } },
        .{ .focus = 2, .cursor = .{ 1, 3, 1, 2, 0 }, .steps = .{ 1, 1 } },
        // Hiding the focused editor's cursor releases it once.
        .{ .focus = 2, .show_cursor = false, .cursor = .{ 1, 1, 0, 2, 0 }, .steps = .{ 2, 1 } },
        .{ .focus = 0, .cursor = .{ 1, 1, 1, 1, 255 }, .steps = .{ 1, 1 } },
        // Focus moving off every editor releases the cursor once.
        .{ .focus = 3, .cursor = .{ 1, 1, 0, 1, 255 }, .steps = .{ 1, 0 } },
        .{ .focus = 0, .hooked = true, .cursor = .{ 1, 1, 1, 1, 255 }, .steps = .{ 1, 2 } },
        // A host cursor survives frames without a focused editor; a focused editor wins.
        .{ .focus = null, .host = true, .cursor = .{ 9, 5, 1, 1, 255 }, .steps = .{ 0, 0 } },
        .{ .focus = 0, .host = true, .cursor = .{ 1, 1, 1, 1, 255 }, .steps = .{ 1, 1 } },
    };
    const state = (try owner.raw().getSession(fixture.session)).scene.?;
    for (rows) |row| {
        for (nodes, 0..) |node, index| try owner.sceneSetFocus(node, row.focus == index);
        try owner.sceneSetEditorOptions(nodes[2], .{ .show_cursor = row.show_cursor, .style = 2, .color = .{ 0, 255, 0, 255 } });
        try owner.sceneSetStyle(nodes[2], 0, 9, 0, 0, if (row.hidden) 1 else 0, 0);
        // A hidden node placed in this frame stays in the reused work list, marked hidden.
        if (row.hidden) try owner.sceneMoveNode(nodes[2], fixture.root, 2);
        try owner.sceneSetHooks(nodes[1], if (row.hooked) 16 else 0, state.last_frame_id + 1, 4, 1);
        for (row.steps, 0..) |steps, frame| {
            errdefer std.debug.print("row {any} frame {d}\n", .{ row.focus, frame });
            if (row.host) try owner.controlSession(fixture.session, .{ .cursor = .{ .position = .{ .x = 9, .y = 5, .visible = true } } });
            const before = state.test_cursor_steps;
            if (state.painted) |painted| try owner.sceneFrameCancel(fixture.session, painted.ticket.frame_id);
            var request = try owner.sceneFrameStep(fixture.session, null, frame_options);
            if (request.kind != 0) request = try owner.sceneFrameStepWithRecording(fixture.session, request, frame_options, &.{});
            try testing.expectEqual(@as(u32, 0), request.kind);
            const cursor = try owner.sceneGetCursorState(fixture.session);
            try testing.expectEqual(row.cursor, [5]u32{ cursor.x, cursor.y, @intFromBool(cursor.visible), cursor.style, @intFromFloat(cursor.color[0] * 255) });
            try testing.expectEqual(steps, state.test_cursor_steps - before);
        }
    }
}
