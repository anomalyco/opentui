const std = @import("std");
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
    for ([_][]const u8{ "\xff", "a\n", "\x1b", "\xc2\x80" }) |invalid| {
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
    const oversized = "a" ** (buffer.text_bytes_max + 1);
    try testing.expectError(error.TextLimit, owner.sceneSetBoxDetails(fixture.box, .{ .title = oversized }));
    try owner.scenePaint(fixture.session, options.background, true, 0);
    try expectRow((try owner.getSessionRenderer(fixture.session)).getNextBuffer(), 0, "A-old------B");
}

test "Scene box details allocation failure preserves old titles and releases replacements" {
    var failures: usize = 0;
    for (0..8) |offset| {
        var failing = testing.FailingAllocator.init(testing.allocator, .{});
        const owner = try context.Context.init(failing.allocator(), testing.io, .{});
        defer owner.deinit() catch unreachable;
        const fixture = try setup(owner);
        try owner.sceneSetBoxDetails(fixture.box, .{ .title = "old", .bottom_title = "old", .custom_border_chars = custom });
        failing.fail_index = failing.alloc_index + offset;
        const result = owner.sceneSetBoxDetails(fixture.box, .{ .title = "new", .bottom_title = "new", .custom_border_chars = custom });
        failing.fail_index = std.math.maxInt(usize);
        if (result) |_| break else |err| {
            try testing.expectEqual(error.OutOfMemory, err);
            failures += 1;
            try owner.scenePaint(fixture.session, options.background, true, 0);
            const target = (try owner.getSessionRenderer(fixture.session)).getNextBuffer();
            try expectRow(target, 0, "A-old------B");
            try expectRow(target, 2, "C-old------D");
        }
        failing.fail_index = failing.alloc_index;
        try owner.sceneSetBoxDetails(fixture.box, .{});
        try owner.sceneDestroyNode(fixture.box);
    }
    try testing.expect(failures > 0 and failures < 8);
}

test "Scene box details prefix replacement destruction cancellation and teardown own titles" {
    for (0..4) |exit| {
        const owner = try context.Context.init(testing.allocator, testing.io, .{});
        defer owner.deinit() catch unreachable;
        const fixture = try setup(owner);
        try owner.sceneSetBoxDetails(fixture.box, .{ .title = "old", .custom_border_chars = custom });
        try owner.sceneSetHooks(fixture.box, 24, 1, 12, 3);
        const before = try owner.sceneFrameStep(fixture.session, null, options);
        try testing.expectEqual(@as(u32, 4), before.kind);
        var top = "new".*;
        var bottom = "end".*;
        try owner.sceneSetBoxDetails(fixture.box, .{ .title = &top, .bottom_title = &bottom, .custom_border_chars = custom });
        @memset(&top, 'x');
        @memset(&bottom, 'x');
        try owner.sceneDestroyNode(fixture.box);
        if (exit == 0) {
            try owner.sceneFrameCancel(fixture.session, before.frame_id);
            continue;
        }
        if (exit == 1) continue;
        if (exit == 2) {
            try owner.sceneDestroyNode(fixture.root);
            try testing.expectError(error.StaleFrame, owner.sceneFrameStep(fixture.session, before, options));
            continue;
        }
        const after = try owner.sceneFrameStep(fixture.session, before, options);
        try testing.expectEqual(@as(u32, 5), after.kind);
        const target = (try owner.getSessionRenderer(fixture.session)).getNextBuffer();
        try expectRow(target, 0, "A-new------B");
        try expectRow(target, 2, "C-end------D");
        try testing.expectEqual(@as(u32, 0), (try owner.sceneFrameStep(fixture.session, after, options)).kind);
    }
}

test "Scene box details checked title draw reports allocation failure and default boxes allocate nothing" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner);
    try owner.resizeSessionRenderer(fixture.session, 5000, 5);
    try owner.sceneSetStyle(fixture.box, 4, 0, 0, 1, 5000, 1);
    try owner.scenePaint(fixture.session, options.background, true, 0);
    const state = (try owner.getSession(fixture.session)).scene.?;
    const target = (try owner.getSessionRenderer(fixture.session)).getNextBuffer();
    var failing = testing.FailingAllocator.init(testing.allocator, .{ .fail_index = 0 });
    const allocator = target.allocator;
    target.allocator = failing.allocator();
    defer target.allocator = allocator;
    const scene_allocator = state.allocator;
    state.allocator = failing.allocator();
    defer state.allocator = scene_allocator;
    try owner.scenePaint(fixture.session, options.background, true, 0);
    try testing.expect(!failing.has_induced_failure);
    state.allocator = scene_allocator;
    // Keep a visible title large enough to exercise heap fallback, not the stack path.
    const title = [_]u8{'x'} ** 4097;
    try owner.sceneSetBoxDetails(fixture.box, .{ .title = &title });
    try testing.expectError(error.OutOfMemory, owner.scenePaint(fixture.session, options.background, true, 0));
    try testing.expect(failing.has_induced_failure);
    try testing.expect(state.attempt == null and state.prefix == null);
    for (target.buffer.char) |char| try testing.expectEqual(@as(u32, ' '), char);
    target.allocator = allocator;
    try owner.scenePaint(fixture.session, options.background, true, 0);
    try testing.expectEqual(@as(u32, 'x'), target.get(2, 0).?.char);
}

test "Scene box details checked drawing allocation failures release title graphemes and retired bytes" {
    for ([_]bool{ false, true }) |prefix| {
        var failures: usize = 0;
        for (0..64) |offset| {
            var failing = testing.FailingAllocator.init(testing.allocator, .{});
            const owner = try context.Context.init(failing.allocator(), testing.io, .{});
            defer owner.deinit() catch unreachable;
            const fixture = try setup(owner);
            try owner.scenePaint(fixture.session, options.background, true, 0);
            try owner.sceneSetBoxDetails(fixture.box, .{ .title = "e\u{301}", .bottom_title = "\u{4e16}" });
            var before: ?scene.FrameRequest = null;
            if (prefix) {
                try owner.sceneSetHooks(fixture.box, 8, 1, 12, 3);
                before = try owner.sceneFrameStep(fixture.session, null, options);
                try owner.sceneDestroyNode(fixture.box);
            }
            failing.fail_index = failing.alloc_index + offset;
            failing.resize_fail_index = failing.resize_index;
            const result = owner.sceneFrameStep(fixture.session, before, options);
            failing.fail_index = std.math.maxInt(usize);
            failing.resize_fail_index = std.math.maxInt(usize);
            if (result) |_| break else |err| {
                try testing.expectEqual(error.OutOfMemory, err);
                const state = (try owner.getSession(fixture.session)).scene.?;
                try testing.expect(state.attempt == null and state.prefix == null);
                failures += 1;
            }
        }
        try testing.expect(failures > 0 and failures < 64);
    }
}
