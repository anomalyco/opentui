const std = @import("std");
const repaint = @import("scene_fixture_test.zig").repaint;
const testing = std.testing;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const ansi = @import("../ansi.zig");

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

test "Scene editor rejects cursor coordinates beyond terminal storage" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner, 4, 2);
    try owner.sceneSetFocus(fixture.node, true);
    try repaint(owner, fixture.session, background, true, 0);
    try owner.sceneSetPaint(fixture.node, .{ .translateX = 65536 });
    try testing.expectError(error.InvalidDimensions, repaint(owner, fixture.session, background, true, 0));
    try testing.expect(!(try owner.sceneGetCursorState(fixture.session)).visible);
    try owner.sceneSetPaint(fixture.node, .{ .translateX = 65535 });
    try repaint(owner, fixture.session, background, true, 0);
    try testing.expectEqual(@as(u32, 65536), (try owner.sceneGetCursorState(fixture.session)).x);
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
