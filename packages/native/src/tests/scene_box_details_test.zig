const std = @import("std");
const repaint = @import("scene_fixture_test.zig").repaint;
const testing = std.testing;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const buffer = @import("../buffer.zig");

const options: scene.FrameOptions = .{
    .background = .{ 0, 0, 0, 255 },
    .use_mouse = true,
    .excluded_hit_num = 0,
    .max_layout_rounds = 8,
    .max_host_requests = 64,
};
const custom = [11]u32{ 'A', 'B', 'C', 'D', '-', '|', '+', '+', '+', '+', '+' };
const indexed = @import("../ansi.zig").indexedColor(42, 0, 200, 0);
const utils = @import("../utils.zig");

const Fixture = struct { session: context.Handle, root: context.Handle, box: context.Handle };

fn setup(owner: *context.Context) !Fixture {
    const id = try owner.createSession(.{ .chunk_size = 4096 });
    try owner.attachSessionRenderer(id, 16, 5, .{ .remote_mode = .remote });
    const root = try owner.sceneCreateNode(id, 0, 1);
    const box = try owner.sceneCreateNode(id, 1, 2);
    try owner.sceneSetStyle(box, 4, 0, 0, 1, 12, 1);
    try owner.sceneSetStyle(box, 4, 1, 0, 1, 3, 1);
    try owner.sceneSetPaint(box, .{ .borderSides = 15 });
    try owner.sceneMoveNode(box, root, 0);
    return .{ .session = id, .root = root, .box = box };
}

fn expectRow(target: *buffer.OptimizedBuffer, y: u32, text: []const u8) !void {
    for (text, 0..) |char, x| try testing.expectEqual(@as(u32, char), target.get(@intCast(x), y).?.char);
}

test "Scene box details rejects invalid replacement before publication" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner);
    try owner.sceneSetBoxDetails(fixture.box, .{ .title = "old", .custom_border_chars = custom });
    try testing.expectError(error.WrongKind, owner.sceneSetBoxDetails(fixture.root, .{ .title = "bad" }));
    for ([_][]const u8{ "\xff", "a\xc0\xaf", "\xc2" }) |invalid| {
        try testing.expectError(error.InvalidUnicode, owner.sceneSetBoxDetails(fixture.box, .{ .title = invalid }));
        try testing.expectError(error.InvalidUnicode, owner.sceneSetBoxDetails(fixture.box, .{ .bottom_title = invalid }));
    }
    try testing.expectError(error.InvalidOptions, owner.sceneSetBoxDetails(fixture.box, .{ .title_alignment = 3 }));
    try testing.expectError(error.InvalidOptions, owner.sceneSetBoxDetails(fixture.box, .{ .bottom_title_alignment = 3 }));
    for ([_]u32{ 0, 0x0301, 0x4e16, 0xd800, 0x110000, 0xffffffff }) |invalid| {
        var chars = custom;
        chars[4] = invalid;
        try testing.expectError(error.InvalidUnicode, owner.sceneSetBoxDetails(fixture.box, .{ .custom_border_chars = chars }));
    }
    const oversized = utils.repeat(u8, "a", buffer.text_bytes_max + 1);
    try testing.expectError(error.TextLimit, owner.sceneSetBoxDetails(fixture.box, .{ .title = oversized }));
    try repaint(owner, fixture.session, options.background, true, 0);
    try expectRow((try owner.raw().getSessionRenderer(fixture.session)).getNextBuffer(), 0, "A-old------B");
    // Titles keep controls; checked text gives them zero width when it draws the title.
    try owner.sceneSetBoxDetails(fixture.box, .{ .title = "o\nl\x1b\u{85}d", .custom_border_chars = custom });
    try repaint(owner, fixture.session, options.background, true, 0);
    try expectRow((try owner.raw().getSessionRenderer(fixture.session)).getNextBuffer(), 0, "A-old------B");
}

fn replaceTitles(allocator: std.mem.Allocator) !void {
    const owner = try context.Context.init(allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner);
    try owner.sceneSetBoxDetails(fixture.box, .{ .title = "old", .bottom_title = "old", .custom_border_chars = custom });
    const details = (try owner.raw().getRenderable(fixture.box)).scene_node.?.control.box.?;
    owner.sceneSetBoxDetails(fixture.box, .{ .title = "new", .bottom_title = "new", .custom_border_chars = custom }) catch |err| {
        try testing.expectEqualStrings("old", details.title);
        try testing.expectEqualStrings("old", details.bottom_title);
        return err;
    };
}

test "Scene box details allocation failure preserves old titles and releases replacements" {
    try testing.checkAllAllocationFailures(testing.allocator, replaceTitles, .{});
}

test "Scene box details and paint replaced during a record batch paint live and destroyed boxes own nothing" {
    for (0..4) |exit| {
        const owner = try context.Context.init(testing.allocator, testing.io, .{});
        defer owner.deinit() catch unreachable;
        const fixture = try setup(owner);
        try owner.sceneSetBoxDetails(fixture.box, .{ .title = "old", .custom_border_chars = custom });
        try owner.sceneSetHooks(fixture.box, 24, 1, 12, 3);
        const request = try owner.sceneFrameStep(fixture.session, null, options);
        try testing.expectEqual(@as(u32, @import("context_abi_c").OT_SCENE_FRAME_RECORD), request.kind);
        var top = "new".*;
        var bottom = "end".*;
        try owner.sceneSetBoxDetails(fixture.box, .{ .title = &top, .bottom_title = &bottom, .custom_border_chars = custom });
        try owner.scenePatchPaint(fixture.box, @import("context_abi_c").OT_SCENE_PROPERTY_BACKGROUND, .{ .background = indexed });
        @memset(&top, 'x');
        @memset(&bottom, 'x');
        if (exit != 3) try owner.sceneDestroyNode(fixture.box);
        if (exit == 0) {
            try owner.sceneFrameCancel(fixture.session, request.frame_id);
            continue;
        }
        if (exit == 1) continue;
        if (exit == 2) {
            try owner.sceneDestroyNode(fixture.root);
            try testing.expectError(error.StaleFrame, owner.sceneFrameStepWithRecording(fixture.session, request, options, std.math.maxInt(u32), &.{}));
            continue;
        }
        const done = try owner.sceneFrameStepWithRecording(fixture.session, request, options, std.math.maxInt(u32), &.{});
        try testing.expectEqual(@as(u32, 0), done.kind);
        const target = (try owner.raw().getSessionRenderer(fixture.session)).getNextBuffer();
        try expectRow(target, 0, "A-new------B");
        try expectRow(target, 2, "C-end------D");
        try testing.expectEqual(indexed, target.get(1, 1).?.bg);
    }
}

test "Scene box details checked title draw reports allocation failure and default boxes allocate nothing" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner);
    try owner.resizeSessionRenderer(fixture.session, 5000, 5);
    try owner.sceneSetStyle(fixture.box, 4, 0, 0, 1, 5000, 1);
    try repaint(owner, fixture.session, options.background, true, 0);
    const state = (try owner.raw().getSession(fixture.session)).scene.?;
    const target = (try owner.raw().getSessionRenderer(fixture.session)).getNextBuffer();
    var failing = testing.FailingAllocator.init(testing.allocator, .{ .fail_index = 0 });
    const allocator = target.allocator;
    target.allocator = failing.allocator();
    defer target.allocator = allocator;
    const scene_allocator = state.allocator;
    state.allocator = failing.allocator();
    defer state.allocator = scene_allocator;
    try repaint(owner, fixture.session, options.background, true, 0);
    try testing.expect(!failing.has_induced_failure);
    state.allocator = scene_allocator;
    // Keep a visible title large enough to exercise heap fallback, not the stack path.
    const title: [4097]u8 = @splat('x');
    try owner.sceneSetBoxDetails(fixture.box, .{ .title = &title });
    try testing.expectError(error.OutOfMemory, repaint(owner, fixture.session, options.background, true, 0));
    try testing.expect(failing.has_induced_failure);
    try testing.expect(state.attempt == null);
    for (target.buffer.char) |char| try testing.expectEqual(@as(u32, ' '), char);
    target.allocator = allocator;
    try repaint(owner, fixture.session, options.background, true, 0);
    try testing.expectEqual(@as(u32, 'x'), target.get(2, 0).?.char);
}
