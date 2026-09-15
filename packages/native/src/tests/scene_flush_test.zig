const std = @import("std");
const testing = std.testing;
const c = @import("context_abi_c");
const abi = @import("../context-abi.zig");
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const yoga = @import("../yoga.zig");

comptime {
    std.debug.assert(@sizeOf(c.ot_scene_property_update) == 24);
    std.debug.assert(@alignOf(c.ot_scene_property_update) == 8);
    std.debug.assert(@sizeOf(c.ot_scene_style_property) == 16);
    std.debug.assert(c.OT_SCENE_PROPERTY_RECORD_MAX == 88);
}

const Fixture = struct {
    owner: abi.ContextHandle = .{
        .gpa = .init,
        .io_threaded = .init_single_threaded,
        .core = undefined,
        .owner_thread = undefined,
    },
    session: context.Handle = undefined,
    node: context.Handle = undefined,

    fn init(self: *Fixture, allocator: std.mem.Allocator) !void {
        self.owner.owner_thread = std.Thread.getCurrentId();
        self.owner.core = try context.Context.init(allocator, self.owner.io_threaded.io(), .{ .object_capacity = 3 });
        self.session = try self.owner.core.createSession(.{ .chunk_size = 4096 });
        try self.owner.core.attachSessionRenderer(self.session, 16, 4, .{ .remote_mode = .remote });
        const root = try self.owner.core.sceneCreateNode(self.session, 0, 1);
        self.node = try self.owner.core.sceneCreateNode(self.session, 1, 2);
        try self.owner.core.sceneMoveNode(self.node, root, 0);
    }

    fn deinit(self: *Fixture) void {
        self.owner.core.deinit() catch unreachable;
        self.owner.io_threaded.deinit();
    }

    fn flush(self: *Fixture, bytes: []const u8, applied: *u32) c.ot_status {
        return abi.ot_scene_flush(&self.owner, if (bytes.len == 0) null else bytes.ptr, @intCast(bytes.len), applied);
    }

    fn paint(self: *Fixture) !scene.Paint {
        return (try self.owner.core.raw().getRenderable(self.node)).scene_node.?.paint;
    }
};

// Build the actual wire format without depending on the production encoder.
fn append(list: *std.Io.Writer.Allocating, node: context.Handle, fields: u32, payload: []const u8) !void {
    const size = std.mem.alignForward(u32, 24 + @as(u32, @intCast(payload.len)), 8);
    const header: c.ot_scene_property_update = .{ .node = abi.handleToC(node), .fields = fields, .size_bytes = size };
    try list.writer.writeAll(std.mem.asBytes(&header));
    try list.writer.writeAll(payload);
    try list.writer.splatByteAll(0, size - 24 - payload.len);
}

fn background(list: *std.Io.Writer.Allocating, node: context.Handle, red: u16) !void {
    const color = [_]u16{ red, 0, 0, 255 };
    try append(list, node, c.OT_SCENE_PROPERTY_BACKGROUND, std.mem.asBytes(&color));
}

fn width(list: *std.Io.Writer.Allocating, node: context.Handle, value: f32) !void {
    const property: c.ot_scene_style_property = .{ .group = 4, .kind = 0, .edge = 0, .unit = 1, .flags = 1, .value = value, .reserved = 0 };
    try append(list, node, c.OT_SCENE_PROPERTY_STYLE, std.mem.asBytes(&property));
}

test "Scene flush mixed partial properties preserve exact ordered prefix and retry" {
    var fixture: Fixture = .{};
    try fixture.init(testing.allocator);
    defer fixture.deinit();
    for (0..4) |failure_index| {
        try fixture.owner.core.sceneSetPaint(fixture.node, .{});
        try fixture.owner.core.sceneSetStyle(fixture.node, 4, 0, 0, 1, 1, 0);
        var input: std.Io.Writer.Allocating = .init(testing.allocator);
        defer input.deinit();
        for (0..3) |index| {
            var node = fixture.node;
            if (index == failure_index) node.generation += 1;
            if (index == 1) try width(&input, node, 7) else try background(&input, node, @intCast(index + 1));
        }
        var applied: u32 = 99;
        try testing.expectEqual(if (failure_index == 3) c.OT_OK else c.OT_STALE_HANDLE, fixture.flush(input.written(), &applied));
        try testing.expectEqual(failure_index, applied);
        try testing.expectEqual(@as(u16, if (failure_index == 3) 3 else if (failure_index > 0) 1 else 0), (try fixture.paint()).background[0]);
        try testing.expectEqual(@as(f32, if (failure_index > 1) 7 else 1), (try fixture.owner.core.sceneGetStyle(fixture.node, 4, 0, 0)).value);
        try testing.expect(!fixture.owner.core.mutating);
        if (failure_index < 3) {
            const offset: usize = if (failure_index == 2) 72 else failure_index * 32;
            // Repair only the rejected handle and resubmit only the unconsumed suffix.
            const handle = abi.handleToC(fixture.node);
            @memcpy(input.written()[offset..][0..16], std.mem.asBytes(&handle));
            try testing.expectEqual(c.OT_OK, fixture.flush(input.written()[offset..], &applied));
            try testing.expectEqual(3 - failure_index, applied);
            try testing.expectEqual(@as(u16, 3), (try fixture.paint()).background[0]);
        }
    }
}

test "Scene flush rejects invalid record envelopes and preserves admission" {
    var fixture: Fixture = .{};
    try fixture.init(testing.allocator);
    defer fixture.deinit();
    var applied: u32 = 99;
    try testing.expectEqual(c.OT_OK, fixture.flush(&.{}, &applied));
    try testing.expectEqual(@as(u32, 0), applied);
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_scene_flush(&fixture.owner, null, 1, &applied));
    var header: c.ot_scene_property_update = .{ .node = abi.handleToC(fixture.node), .fields = 0, .size_bytes = 24 };
    for ([_]u32{ 0, 4096, c.OT_SCENE_PROPERTY_STYLE | c.OT_SCENE_PROPERTY_BACKGROUND }) |fields| {
        header.fields = fields;
        try testing.expectEqual(c.OT_INVALID_ARGUMENT, fixture.flush(std.mem.asBytes(&header), &applied));
        try testing.expectEqual(@as(u32, 0), applied);
    }
    header.fields = c.OT_SCENE_PROPERTY_OPACITY;
    for ([_]u32{ 0, 23, 24, 31, 32, 0xfffffff8 }) |size| {
        header.size_bytes = size;
        try testing.expectEqual(c.OT_INVALID_ARGUMENT, fixture.flush(std.mem.asBytes(&header), &applied));
        try testing.expectEqual(@as(u32, 0), applied);
    }
    try testing.expectEqual(c.OT_OBJECT_LIMIT, abi.ot_scene_flush(&fixture.owner, std.mem.asBytes(&header), c.OT_SCENE_PROPERTY_BYTES_MAX + 1, &applied));
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_scene_flush(&fixture.owner, null, 0, null));
    fixture.owner.core.mutating = true;
    try testing.expectEqual(c.OT_CONTEXT_BUSY, fixture.flush(std.mem.asBytes(&header), &applied));
    try testing.expect(fixture.owner.core.mutating);
    fixture.owner.core.mutating = false;
    try testing.expectEqual(@as(u32, 0), applied);
}

test "Scene flush border appearance and Yoga widths publish atomically on allocation failure" {
    var fixture: Fixture = .{};
    try fixture.init(testing.allocator);
    defer fixture.deinit();
    const core = fixture.owner.core;
    for (2..7) |kind| try core.sceneSetStyle(fixture.node, 2, @intCast(kind), 0, 1, 3.25, 0);
    var input: std.Io.Writer.Allocating = .init(testing.allocator);
    defer input.deinit();
    try background(&input, fixture.node, 17);
    const payload = [_]u32{ 15, 1 };
    try append(&input, fixture.node, c.OT_SCENE_PROPERTY_BORDER | c.OT_SCENE_PROPERTY_BORDER_STYLE, std.mem.asBytes(&payload));
    var applied: u32 = 99;
    yoga.testFailAfter(0);
    defer yoga.testFailAfter(-1);
    const status = fixture.flush(input.written(), &applied);
    yoga.testFailAfter(-1);
    try testing.expectEqual(c.OT_OUT_OF_MEMORY, status);
    try testing.expectEqual(@as(u32, 1), applied);
    try testing.expectEqual(@as(u16, 17), (try fixture.paint()).background[0]);
    try testing.expectEqual(@as(u32, 0), (try fixture.paint()).borderSides);
    try testing.expectEqual(@as(u32, 0), (try fixture.paint()).borderStyle);
    for (0..4) |edge| try testing.expectEqual(@as(f32, 0), (try core.sceneGetStyle(fixture.node, 3, 0, @intCast(edge))).value);
    try testing.expectEqual(c.OT_OK, fixture.flush(input.written()[32..], &applied));
    try testing.expectEqual(@as(u32, 1), applied);
    try testing.expectEqual(@as(u32, 15), (try fixture.paint()).borderSides);
    try testing.expectEqual(@as(u32, 1), (try fixture.paint()).borderStyle);
    for (0..4) |edge| try testing.expectEqual(@as(f32, 1), (try core.sceneGetStyle(fixture.node, 3, 0, @intCast(edge))).value);
}

test "Scene flush requires no Context allocation for maximal background and full paint batches" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    var fixture: Fixture = .{};
    try fixture.init(failing.allocator());
    defer fixture.deinit();
    try testing.expectError(error.ObjectLimit, fixture.owner.core.sceneCreateNode(fixture.session, 1, 4));
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    for ([_]bool{ false, true }) |full| {
        var input: std.Io.Writer.Allocating = .init(testing.allocator);
        defer input.deinit();
        // The complete visual payload is 64 bytes, with no embedded ABI header.
        const payload = [_]u32{ 0, @bitCast(@as(f32, 1)), 0, 0, 0, 0, 0, 1, 19, 255 << 16, 255 | (255 << 16), 255 | (255 << 16), 0, 0, 0 | (170 << 16), 255 | (255 << 16) };
        for (0..c.OT_SCENE_MUTATIONS_MAX) |_| {
            if (full) try append(&input, fixture.node, 2047, std.mem.asBytes(&payload)) else try background(&input, fixture.node, 19);
        }
        try testing.expectEqual(@as(usize, if (full) 88 else 32) * c.OT_SCENE_MUTATIONS_MAX, input.written().len);
        var applied: u32 = 99;
        try testing.expectEqual(c.OT_OK, fixture.flush(input.written(), &applied));
        try testing.expectEqual(@as(u32, c.OT_SCENE_MUTATIONS_MAX), applied);
        try testing.expectEqual(@as(u16, 19), (try fixture.paint()).background[0]);
        try testing.expect(!failing.has_induced_failure);
        try testing.expect(!fixture.owner.core.mutating);
        if (!full) {
            try background(&input, fixture.node, 20);
            try testing.expectEqual(c.OT_OBJECT_LIMIT, fixture.flush(input.written(), &applied));
            try testing.expectEqual(@as(u32, c.OT_SCENE_MUTATIONS_MAX), applied);
        }
    }
}

test "Scene flush partial masks preserve omitted values and reject invalid payloads atomically" {
    var fixture: Fixture = .{};
    try fixture.init(testing.allocator);
    defer fixture.deinit();
    var input: std.Io.Writer.Allocating = .init(testing.allocator);
    defer input.deinit();
    const accepted: scene.Paint = .{ .zIndex = 9, .background = .{ 17, 0, 0, 255 }, .focusable = true };
    try fixture.owner.core.sceneSetPaint(fixture.node, accepted);
    // The double begins four bytes into the payload, deliberately unaligned.
    var payload: [12]u8 = undefined;
    const opacity: f32 = 0.5;
    const translation: f64 = 2.75;
    @memcpy(payload[0..4], std.mem.asBytes(&opacity));
    @memcpy(payload[4..12], std.mem.asBytes(&translation));
    try append(&input, fixture.node, c.OT_SCENE_PROPERTY_OPACITY | c.OT_SCENE_PROPERTY_TRANSLATE_X, &payload);
    var applied: u32 = 99;
    // Padding is observable wire input and must be zero before any field publishes.
    input.written()[39] = 1;
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, fixture.flush(input.written(), &applied));
    try testing.expectEqual(@as(u32, 0), applied);
    try testing.expectEqualDeep(accepted, try fixture.paint());
    input.written()[39] = 0;
    try testing.expectEqual(c.OT_OK, fixture.flush(input.written(), &applied));
    var expected = accepted;
    expected.opacity = opacity;
    expected.translateX = translation;
    try testing.expectEqualDeep(expected, try fixture.paint());
    for ([_]u32{ c.OT_SCENE_PROPERTY_SHOULD_FILL, c.OT_SCENE_PROPERTY_FOCUSABLE, c.OT_SCENE_PROPERTY_BORDER_STYLE }) |field| {
        var invalid: std.Io.Writer.Allocating = .init(testing.allocator);
        defer invalid.deinit();
        const value: u32 = 99;
        try append(&invalid, fixture.node, field, std.mem.asBytes(&value));
        try testing.expectEqual(c.OT_INVALID_ARGUMENT, fixture.flush(invalid.written(), &applied));
        try testing.expectEqual(@as(u32, 0), applied);
        try testing.expectEqualDeep(expected, try fixture.paint());
    }
}
