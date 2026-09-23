const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const ansi = @import("../ansi.zig");

const red = ansi.rgbColor(200, 0, 0, 255);
const black = ansi.rgbColor(0, 0, 0, 255);

test "Context checked stacks intersect clips and multiply opacity without changing source glyphs" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const destination = try owner.createBuffer(6, 1, .{});
    const source = try owner.createBuffer(6, 1, .{});
    try owner.clearBuffer(destination, black);
    try owner.drawBufferText(source, "A\u{754c}BCD", 0, 0, red, red, 0);
    const target = try owner.raw().getBuffer(destination);
    const source_buffer = try owner.raw().getBuffer(source);
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
    const target = try owner.raw().getBuffer(id);
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
