const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const ansi = @import("../ansi.zig");
const abi = @import("../context-abi.zig");
const c = @import("context_abi_c");

const red = ansi.rgbColor(200, 0, 0, 255);
const black = ansi.rgbColor(0, 0, 0, 255);
const options: scene.FrameOptions = .{
    .background = .{ 0, 0, 0, 255 },
    .use_mouse = false,
    .excluded_hit_num = 0,
    .max_layout_rounds = 8,
    .max_host_requests = 64,
};

test "Context checked stacks intersect clips and multiply opacity without changing source glyphs" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const destination = try owner.createBuffer(6, 1, .{});
    const source = try owner.createBuffer(6, 1, .{});
    try owner.clearBuffer(destination, black);
    try owner.drawBufferText(source, "A\u{754c}BCD", 0, 0, red, red, 0);
    const target = try owner.getBuffer(destination);
    const source_buffer = try owner.getBuffer(source);
    const source_chars = source_buffer.buffer.char[0..6].*;
    _ = try owner.bufferStack(destination, null, .{ .operation = .push_scissor, .x = 1, .width = 4, .height = 1 });
    _ = try owner.bufferStack(destination, null, .{ .operation = .push_scissor, .x = 2, .width = 4, .height = 1 });
    _ = try owner.bufferStack(destination, null, .{ .operation = .push_opacity, .opacity = 0.5 });
    try testing.expectEqual(@as(f32, 0.25), try owner.bufferStack(destination, null, .{ .operation = .push_opacity, .opacity = 0.5 }));
    try owner.drawBuffer(destination, null, .{ .operation = .compose, .source = source }, "", "");
    try testing.expectEqualSlices(u32, &.{ ' ', ' ', ' ', 'B', 'C', ' ' }, target.buffer.char);
    for (0..6) |x| try testing.expectEqual(@as(u8, if (x >= 2 and x < 5) 50 else 0), ansi.red(target.buffer.bg[x]));
    _ = try owner.bufferStack(destination, null, .{ .operation = .pop_scissor });
    try testing.expectEqual(@as(f32, 0.5), try owner.bufferStack(destination, null, .{ .operation = .pop_opacity }));
    try owner.drawBuffer(destination, null, .{ .operation = .compose, .source = source, .crop = .{ .width = 3 } }, "", "");
    try testing.expectEqualSlices(u32, source_chars[1..3], target.buffer.char[1..3]);
    try owner.clearBuffer(destination, black);
    _ = try owner.bufferStack(destination, null, .{ .operation = .push_scissor, .x = 1, .width = 1, .height = 1 });
    try owner.drawBuffer(destination, null, .{ .operation = .compose, .source = source }, "", "");
    try testing.expectEqualSlices(u32, &.{ ' ', ' ', ' ', ' ', ' ', ' ' }, target.buffer.char);
    for (0..6) |x| try testing.expectEqual(@as(u8, if (x == 1) 100 else 0), ansi.red(target.buffer.bg[x]));
    _ = try owner.bufferStack(destination, null, .{ .operation = .clear_scissors });
    _ = try owner.bufferStack(destination, null, .{ .operation = .clear_opacity });
    _ = try owner.bufferStack(destination, null, .{ .operation = .pop_scissor });
    try testing.expectEqual(@as(f32, 1), try owner.bufferStack(destination, null, .{ .operation = .pop_opacity }));
    try testing.expectEqualSlices(u32, &source_chars, source_buffer.buffer.char);
}

test "Context checked stacks reject invalid bounds and preserve state on depth and allocation failure" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createBuffer(2, 1, .{});
    const target = try owner.getBuffer(id);
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    try testing.expectError(error.OutOfMemory, owner.bufferStack(id, null, .{ .operation = .push_opacity, .opacity = 0.5 }));
    try testing.expectError(error.OutOfMemory, owner.bufferStack(id, null, .{ .operation = .push_scissor, .width = 1, .height = 1 }));
    try testing.expectEqual(@as(f32, 1), target.getCurrentOpacity());
    try testing.expectEqual(@as(usize, 0), target.scissor_stack.items.len);
    failing.fail_index = std.math.maxInt(usize);
    failing.resize_fail_index = std.math.maxInt(usize);
    for ([_]f32{ std.math.nan(f32), std.math.inf(f32), -std.math.inf(f32) }) |opacity| {
        try testing.expectError(error.InvalidOptions, owner.bufferStack(id, null, .{ .operation = .push_opacity, .opacity = opacity }));
    }
    for ([_]context.BufferStack{
        .{ .operation = .push_scissor, .x = std.math.maxInt(i32), .width = 1 },
        .{ .operation = .push_scissor, .y = std.math.maxInt(i32), .height = 1 },
        .{ .operation = .push_scissor, .width = std.math.maxInt(u32) },
        .{ .operation = .push_scissor, .height = std.math.maxInt(u32) },
    }) |invalid| try testing.expectError(error.InvalidDimensions, owner.bufferStack(id, null, invalid));
    for (0..context.BufferStack.depth_max) |_| {
        _ = try owner.bufferStack(id, null, .{ .operation = .push_scissor, .width = 1, .height = 1 });
        _ = try owner.bufferStack(id, null, .{ .operation = .push_opacity, .opacity = 1 });
    }
    try testing.expectError(error.ObjectLimit, owner.bufferStack(id, null, .{ .operation = .push_scissor }));
    try testing.expectError(error.ObjectLimit, owner.bufferStack(id, null, .{ .operation = .push_opacity, .opacity = 0 }));
    try testing.expectEqual(@as(f32, 1), target.getCurrentOpacity());
    try owner.clearBuffer(id, black);
    try owner.fillBufferRect(id, 0, 0, 2, 1, red);
    try testing.expectEqual(red, target.buffer.bg[0]);
    try testing.expectEqual(black, target.buffer.bg[1]);
    _ = try owner.bufferStack(id, null, .{ .operation = .clear_scissors });
    _ = try owner.bufferStack(id, null, .{ .operation = .clear_opacity });
    _ = try owner.bufferStack(id, null, .{ .operation = .push_scissor, .x = std.math.minInt(i32), .width = std.math.maxInt(i32), .height = 1 });
    _ = try owner.bufferStack(id, null, .{ .operation = .push_scissor, .x = std.math.maxInt(i32) });
    try testing.expectEqual(@as(u32, 0), target.getCurrentScissorRect().?.width);
    try testing.expectEqual(@as(f32, 1), try owner.bufferStack(id, null, .{ .operation = .push_opacity, .opacity = 2 }));
    try testing.expectEqual(@as(f32, 0), try owner.bufferStack(id, null, .{ .operation = .push_opacity, .opacity = -1 }));
    try testing.expect(!owner.mutating);
    try owner.destroy(id);
    try testing.expectError(error.StaleHandle, owner.bufferStack(id, null, .{ .operation = .get_opacity }));
}

test "Context checked frame stacks keep inherited floors and restore after acknowledgement and cancellation" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(.{});
    try owner.attachSessionRenderer(id, 6, 1, .{ .remote_mode = .remote });
    const root = try owner.sceneCreateNode(id, 0, 1);
    const child = try owner.sceneCreateNode(id, 6, 2);
    try owner.sceneSetStyle(child, 4, 0, 0, 1, 3, 1);
    try owner.sceneSetStyle(child, 4, 1, 0, 1, 1, 1);
    try owner.sceneSetPaint(child, .{ .shouldFill = 0, .opacity = 0.5 });
    try owner.sceneSetHooks(child, 56, 1, 3, 1);
    try owner.sceneMoveNode(child, root, 0);
    const target = (try owner.getSessionRenderer(id)).getNextBuffer();
    const before = try owner.sceneFrameStep(id, null, options);
    const inherited = target.getCurrentScissorRect().?;
    for ([_]context.BufferStack.Operation{ .pop_scissor, .clear_scissors, .pop_opacity, .clear_opacity }) |operation| {
        try testing.expectEqual(@as(f32, 0.5), try owner.bufferStack(id, before, .{ .operation = operation }));
    }
    try testing.expectEqualDeep(inherited, target.getCurrentScissorRect().?);
    for (0..context.BufferStack.depth_max) |_| {
        _ = try owner.bufferStack(id, before, .{ .operation = .push_scissor, .width = 1, .height = 1 });
        _ = try owner.bufferStack(id, before, .{ .operation = .push_opacity, .opacity = 1 });
    }
    try testing.expectError(error.ObjectLimit, owner.bufferStack(id, before, .{ .operation = .push_opacity }));
    try testing.expectError(error.ObjectLimit, owner.bufferStack(id, before, .{ .operation = .push_scissor }));
    const self = try owner.sceneFrameStep(id, before, options);
    try testing.expectEqual(@as(u32, 7), self.kind);
    try testing.expectEqual(@as(usize, 1), target.scissor_stack.items.len);
    try testing.expectEqual(@as(usize, 1), target.opacity_stack.items.len);
    try testing.expectEqual(@as(f32, 0.5), try owner.bufferStack(id, self, .{ .operation = .get_opacity }));
    try testing.expectError(error.StaleFrame, owner.bufferStack(id, before, .{ .operation = .clear_opacity }));
    _ = try owner.bufferStack(id, self, .{ .operation = .push_scissor, .width = 1, .height = 1 });
    _ = try owner.bufferStack(id, self, .{ .operation = .push_opacity, .opacity = 0 });
    try owner.sceneFrameCancel(id, self.frame_id);
    try testing.expectEqual(@as(usize, 0), target.scissor_stack.items.len);
    try testing.expectEqual(@as(usize, 0), target.opacity_stack.items.len);
    try testing.expectError(error.StaleFrame, owner.bufferStack(id, self, .{ .operation = .get_opacity }));
    try testing.expectError(error.WrongKind, owner.bufferStack(id, null, .{ .operation = .get_opacity }));
    var frame = try owner.sceneFrameStep(id, null, options);
    while (frame.kind != 0) frame = try owner.sceneFrameStep(id, frame, options);
    try testing.expectEqual(@as(f32, 1), try owner.bufferStack(id, frame, .{ .operation = .get_opacity }));
    _ = try owner.bufferStack(id, frame, .{ .operation = .push_opacity, .opacity = 0.5 });
    _ = try owner.bufferStack(id, frame, .{ .operation = .clear_opacity });
    try testing.expectEqual(@as(f32, 1), target.getCurrentOpacity());
    try owner.sceneFrameCancel(id, frame.frame_id);
}

test "Context checked stacks ABI rejects invalid calls without writing output or changing state" {
    var config = std.mem.zeroes(c.ot_context_options);
    config.struct_size = @sizeOf(c.ot_context_options);
    config.abi_version = c.OT_CONTEXT_ABI_VERSION;
    config.object_capacity = 8;
    config.render_cells_max = 16;
    var owner: ?*abi.ContextHandle = null;
    try testing.expectEqual(c.OT_OK, abi.ot_context_create(&config, &owner));
    defer testing.expectEqual(c.OT_OK, abi.ot_context_destroy(owner)) catch unreachable;
    const handle = try owner.?.core.createBuffer(2, 1, .{});
    const id = abi.handleToC(handle);
    var output: f32 = -1;
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_buffer_stack(null, &id, null, 0, 0, 0, 0, 0, 0, &output));
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_buffer_stack(owner, null, null, 0, 0, 0, 0, 0, 0, &output));
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_buffer_stack(owner, &id, null, 0, 0, 0, 0, 0, 0, null));
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_buffer_stack(owner, &id, null, 7, 0, 0, 0, 0, 0, &output));
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_buffer_stack(owner, &id, null, c.OT_BUFFER_STACK_PUSH_OPACITY, 0, 0, 0, 0, std.math.nan(f32), &output));
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_buffer_stack(owner, &id, null, c.OT_BUFFER_STACK_PUSH_SCISSOR, std.math.maxInt(i32), 0, 1, 1, 0, &output));
    try testing.expectEqual(@as(f32, -1), output);
    try testing.expectEqual(c.OT_OK, abi.ot_buffer_stack(owner, &id, null, c.OT_BUFFER_STACK_PUSH_OPACITY, 0, 0, 0, 0, 0.5, &output));
    try testing.expectEqual(@as(f32, 0.5), output);
    owner.?.core.mutating = true;
    try testing.expectEqual(c.OT_CONTEXT_BUSY, abi.ot_buffer_stack(owner, &id, null, c.OT_BUFFER_STACK_CLEAR_OPACITY, 0, 0, 0, 0, 0, &output));
    owner.?.core.mutating = false;
    try testing.expectEqual(@as(f32, 0.5), (try owner.?.core.getBuffer(handle)).getCurrentOpacity());
    var foreign = id;
    foreign.context_id += 1;
    try testing.expectEqual(c.OT_WRONG_CONTEXT, abi.ot_buffer_stack(owner, &foreign, null, 0, 0, 0, 0, 0, 0, &output));
    try owner.?.core.destroy(handle);
    try testing.expectEqual(c.OT_STALE_HANDLE, abi.ot_buffer_stack(owner, &id, null, 0, 0, 0, 0, 0, 0, &output));
    try testing.expectEqual(context.BufferStack.depth_max, c.OT_BUFFER_STACK_DEPTH_MAX);
}
