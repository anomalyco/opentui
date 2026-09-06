const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const ansi = @import("../ansi.zig");
const grapheme = @import("../grapheme.zig");
const scene = @import("../scene.zig");
const abi = @import("../context-abi.zig");
const c = @import("context_abi_c");

const border = [_]u32{ '+', '+', '+', '+', '-', '|', '+', '+', '+', '+', '+' };
const columns = [_]i32{ 0, 3, 6 };
const rows = [_]i32{ 0, 2, 4 };
const red = ansi.rgbColor(200, 0, 0, 255);
const black = ansi.rgbColor(0, 0, 0, 255);

test "Grid primitive clips and blends every border write path" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createBuffer(7, 5, .{});
    const target = try owner.getBuffer(id);
    try target.pushScissorRect(1, 1, 4, 3);
    for ([_]f32{ 1, 0.5 }) |opacity| {
        target.clear(black, null);
        try target.pushOpacity(opacity);
        defer target.popOpacity();
        target.drawGrid(&border, red, red, &columns, 2, &rows, 2, true, true);
        for (target.buffer.char, 0..) |char, index| {
            const x = index % 7;
            const y = index / 7;
            const visible = x >= 1 and x < 5 and y >= 1 and y < 4;
            const expected: u32 = if (!visible) ' ' else if (x == 3 and y == 2) '+' else if (x == 3) '|' else if (y == 2) '-' else ' ';
            try testing.expectEqual(expected, char);
            if (expected != ' ' and opacity < 1) {
                try testing.expect(target.buffer.bg[index][0] > 0);
                try testing.expect(target.buffer.bg[index][0] < 200);
            }
        }
    }
}

test "Grid primitive retires overwritten grapheme and link references" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createBuffer(7, 5, .{});
    const target = try owner.getBuffer(id);
    const link = try owner.links.alloc("https://grid.test");
    const attributes = ansi.TextAttributes.setLinkId(0, link);
    try target.drawText("e\xcc\x81e\xcc\x81", 0, 0, red, black, attributes);
    try target.drawText("e\xcc\x81", 0, 1, red, black, attributes);
    const glyph = grapheme.graphemeIdFromChar(target.buffer.char[0]);
    target.drawGrid(&border, red, black, &columns, 2, &rows, 2, true, true);
    try testing.expect(!target.grapheme_tracker.hasAny());
    try testing.expect(!target.link_tracker.hasAny());
    try testing.expectError(error.InvalidId, owner.graphemes.getRefcount(glyph));
    try testing.expectEqual(@as(u32, 0), try owner.links.getRefcount(link));
}

test "Context grid validates all input before drawing and bounds offscreen work" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{ .render_cells_max = 64 });
    defer owner.deinit() catch unreachable;
    const id = try owner.createBuffer(7, 5, .{});
    const target = try owner.getBuffer(id);
    target.clear(black, null);
    const options: context.BufferGrid = .{ .border_chars = border, .foreground = red, .background = black, .draw_inner = true, .draw_outer = true };
    for ([_][]const i32{ &.{ 1, 0 }, &.{ 0, 0 }, &(@as([66]i32, @splat(0))) }) |offsets| {
        try testing.expectError(error.InvalidOptions, owner.drawGrid(id, null, options, offsets, &rows));
        try testing.expectError(error.InvalidOptions, owner.drawGrid(id, null, options, &columns, offsets));
    }
    for ([_]u32{ 27, 0xd800, 0x110000, 0x80000000, 0x754c, 0x301 }) |char| {
        var invalid = options;
        invalid.border_chars[0] = char;
        try testing.expectError(error.InvalidOptions, owner.drawGrid(id, null, invalid, &columns, &rows));
    }
    var invalid = options;
    invalid.foreground[0] = 256;
    try testing.expectError(error.InvalidOptions, owner.drawGrid(id, null, invalid, &columns, &rows));
    for (target.buffer.char) |char| try testing.expectEqual(@as(u32, ' '), char);
    try owner.drawGrid(id, null, options, &.{}, &rows);
    try owner.drawGrid(id, null, options, &columns, &.{0});
    try owner.drawGrid(id, null, options, &.{ std.math.minInt(i32), 3, std.math.maxInt(i32) }, &.{ std.math.minInt(i32), 2, std.math.maxInt(i32) });
    try testing.expectEqual(@as(u32, '|'), target.buffer.char[3]);
    try testing.expectEqual(@as(u32, '+'), target.buffer.char[17]);
    try testing.expectEqual(@as(u32, '-'), target.buffer.char[14]);
    owner.mutating = true;
    const busy = owner.drawGrid(id, null, options, &columns, &rows);
    owner.mutating = false;
    try testing.expectError(error.ContextBusy, busy);
    try owner.destroy(id);
    try testing.expectError(error.StaleHandle, owner.drawGrid(id, null, options, &columns, &rows));
}

test "Context grid ABI validates borrowed array lengths and options" {
    const config: c.ot_context_options = .{
        .struct_size = @sizeOf(c.ot_context_options),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .object_capacity = 4,
        .render_cells_max = 64,
    };
    var owner: ?*abi.ContextHandle = null;
    try testing.expectEqual(c.OT_OK, abi.ot_context_create(&config, &owner));
    defer testing.expectEqual(c.OT_OK, abi.ot_context_destroy(owner)) catch unreachable;
    const id = abi.handleToC(try owner.?.core.createBuffer(7, 5, .{}));
    const options: c.ot_buffer_grid_options = .{
        .struct_size = @sizeOf(c.ot_buffer_grid_options),
        .abi_version = c.OT_CONTEXT_ABI_VERSION,
        .flags = c.OT_BUFFER_GRID_INNER | c.OT_BUFFER_GRID_OUTER,
        .foreground = red,
        .background = black,
        .border_chars = border,
    };
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_buffer_draw_grid(owner, &id, null, &options, null, 3, &rows, 3));
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_buffer_draw_grid(owner, &id, null, &options, &columns, 3, null, 3));
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_buffer_draw_grid(owner, &id, null, &options, &columns, std.math.maxInt(u32), &rows, 3));
    try testing.expectEqual(c.OT_OK, abi.ot_buffer_draw_grid(owner, &id, null, &options, null, 0, null, 0));
    try testing.expectEqual(c.OT_OK, abi.ot_buffer_draw_grid(owner, &id, null, &options, &columns, 3, &rows, 3));
    const target = try owner.?.core.getBuffer(abi.handleFromC(id));
    try testing.expectEqualSlices(u32, &.{ '+', '-', '-' }, target.buffer.char[0..3]);
}

const PackedCell = extern struct {
    bg: [4]f32 = .{ 0, 0, 0, 1 },
    fg: [4]f32 = .{ 1, 0, 0, 1 },
    char: u32,
    padding: [3]u32 = .{ 0, 0, 0 },
};

test "GPU primitive packed offsets describe a source rectangle not destination bounds" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createBuffer(4, 3, .{});
    const target = try owner.getBuffer(id);
    target.clear(black, null);
    const cells = [_]PackedCell{ .{ .char = 'A' }, .{ .char = 'B' }, .{ .char = 'C' }, .{ .char = 'D' } };
    const bytes = std.mem.asBytes(&cells);
    target.drawPackedBuffer(bytes.ptr, bytes.len, 1, 1, 2, 2);
    try testing.expectEqualSlices(u32, &.{ ' ', ' ', ' ', ' ', ' ', 'A', 'B', ' ', ' ', 'C', 'D', ' ' }, target.buffer.char);
}

test "GPU primitive supersampling never samples the next row as a right neighbor" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const target = try owner.getBuffer(try owner.createBuffer(1, 1, .{}));
    const expected = try owner.getBuffer(try owner.createBuffer(1, 1, .{}));
    target.clear(black, null);
    expected.clear(black, null);
    const narrow = [_]u8{ 255, 255, 255, 255, 0, 0, 0, 255 };
    const padded = [_]u8{ 255, 255, 255, 255, 255, 0, 255, 0, 0, 0, 0, 255, 255, 0, 255, 0 };
    target.drawSuperSampleBuffer(0, 0, &narrow, narrow.len, 1, 4);
    expected.drawSuperSampleBuffer(0, 0, &padded, padded.len, 1, 8);
    try testing.expectEqualDeep(expected.get(0, 0).?, target.get(0, 0).?);
}

test "GPU primitive grayscale applies inherited opacity once" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const target = try owner.getBuffer(try owner.createBuffer(1, 1, .{}));
    const expected = try owner.getBuffer(try owner.createBuffer(1, 1, .{}));
    try target.pushOpacity(0.5);
    try expected.pushOpacity(0.5);
    const intensities = [_]f32{ 1, 1, 1, 1 };
    inline for (.{ false, true }) |supersampled| {
        target.clear(black, null);
        expected.clear(black, null);
        if (supersampled) target.drawGrayscaleBufferSupersampled(0, 0, &intensities, 2, 2, red, black) else target.drawGrayscaleBuffer(0, 0, &intensities, 1, 1, red, black);
        expected.setCellWithAlphaBlending(0, 0, '$', red, black, 0);
        try testing.expectEqualDeep(expected.get(0, 0).?, target.get(0, 0).?);
    }
}

test "GPU checked packed drawing accepts unaligned bytes and rejects incomplete or nonfinite cells atomically" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const target = try owner.getBuffer(try owner.createBuffer(2, 1, .{}));
    target.clear(black, null);
    var cells = [_]PackedCell{ .{ .char = 'A' }, .{ .char = 'B' } };
    const bytes = std.mem.asBytes(&cells);
    try testing.expectError(error.InvalidOptions, target.drawPackedBufferChecked(bytes[0..95], 0, 0, 2, 1));
    try testing.expectError(error.InvalidDimensions, target.drawPackedBufferChecked(bytes, 0, 0, std.math.maxInt(u32), std.math.maxInt(u32)));
    for ([_]f32{ std.math.nan(f32), std.math.inf(f32), -std.math.inf(f32) }) |invalid| {
        cells[1].fg[2] = invalid;
        try testing.expectError(error.InvalidOptions, target.drawPackedBufferChecked(bytes, 0, 0, 2, 1));
        try testing.expectEqualSlices(u32, &.{ ' ', ' ' }, target.buffer.char);
    }
    cells[1].fg[2] = 0;
    var unaligned: [97]u8 align(4) = undefined;
    @memcpy(unaligned[1..], bytes);
    try target.drawPackedBufferChecked(unaligned[1..], 0, 0, 2, 1);
    try testing.expectEqualSlices(u32, &.{ 'A', 'B' }, target.buffer.char);
    try target.drawPackedBufferChecked(&.{}, 0, 0, 0, 1);
    try target.drawPackedBufferChecked(bytes, std.math.maxInt(u32), std.math.maxInt(u32), 2, 1);
    cells[0].char = 0xd800;
    cells[1].char = 0x754c;
    try target.drawPackedBufferChecked(bytes, 0, 0, 2, 1);
    try testing.expectEqualSlices(u32, &.{ ' ', 0x2588 }, target.buffer.char);
}

test "GPU checked supersampling validates strides lengths and formats before touching pixels" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const target = try owner.getBuffer(try owner.createBuffer(2, 2, .{}));
    target.clear(black, null);
    const pixels = [_]u8{ 255, 0, 0, 255 } ** 4;
    for ([_]u32{ 0, 1, 6 }) |stride| {
        try testing.expectError(error.InvalidOptions, target.drawSuperSampleBufferChecked(0, 0, &pixels, 1, stride));
    }
    try testing.expectError(error.InvalidOptions, target.drawSuperSampleBufferChecked(0, 0, pixels[0..15], 1, 8));
    try testing.expectError(error.InvalidOptions, target.drawSuperSampleBufferChecked(0, 0, &pixels, 2, 8));
    for (target.buffer.char) |char| try testing.expectEqual(@as(u32, ' '), char);
    try target.drawSuperSampleBufferChecked(0, 0, &.{}, 1, 8);
    try target.drawSuperSampleBufferChecked(std.math.maxInt(u32), 0, &pixels, 1, 8);
    try target.drawSuperSampleBufferChecked(0, 0, &pixels, 1, 8);
    try testing.expectEqual(ansi.rgbColor(255, 0, 0, 255), target.buffer.fg[0]);
    try testing.expectEqual(@as(u32, ' '), target.buffer.char[1]);
    try testing.expectEqual(@as(u32, ' '), target.buffer.char[2]);
    try target.drawSuperSampleBufferChecked(0, 0, &pixels, 0, 8);
    try testing.expectEqual(ansi.rgbColor(0, 0, 255, 255), target.buffer.fg[0]);
}

test "GPU checked grayscale validates lengths finite samples colors and signed clipping" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const target = try owner.getBuffer(try owner.createBuffer(2, 1, .{}));
    inline for (.{ false, true }) |supersampled| {
        const width: u32 = if (supersampled) 4 else 2;
        const height: u32 = if (supersampled) 2 else 1;
        var intensities: [8]f32 = @splat(1);
        const input = intensities[0 .. width * height];
        target.clear(black, null);
        try testing.expectError(error.InvalidOptions, target.drawGrayscaleBufferChecked(0, 0, input[0 .. input.len - 1], width, height, null, null, supersampled));
        try testing.expectError(error.InvalidDimensions, target.drawGrayscaleBufferChecked(0, 0, input, std.math.maxInt(u32), 2, null, null, supersampled));
        try testing.expectError(error.InvalidOptions, target.drawGrayscaleBufferChecked(0, 0, input, width, height, .{ 256, 0, 0, 255 }, null, supersampled));
        for ([_]f32{ std.math.nan(f32), std.math.inf(f32), -std.math.inf(f32) }) |invalid| {
            input[input.len - 1] = invalid;
            try testing.expectError(error.InvalidOptions, target.drawGrayscaleBufferChecked(0, 0, input, width, height, null, null, supersampled));
            try testing.expectEqualSlices(u32, &.{ ' ', ' ' }, target.buffer.char);
        }
        @memset(input, 1);
        try target.drawGrayscaleBufferChecked(std.math.minInt(i32), std.math.minInt(i32), input, width, height, null, null, supersampled);
        try testing.expectEqualSlices(u32, &.{ ' ', ' ' }, target.buffer.char);
        try target.drawGrayscaleBufferChecked(-1, 0, input, width, height, null, null, supersampled);
        try testing.expectEqualSlices(u32, &.{ '$', ' ' }, target.buffer.char);
        @memset(input, std.math.floatMax(f32));
        try target.drawGrayscaleBufferChecked(0, 0, input, width, height, null, null, supersampled);
        try testing.expectEqualSlices(u32, &.{ '$', '$' }, target.buffer.char);
    }
}

test "GPU checked drawing clips opacity and retires overwritten pooled cells" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const target = try owner.getBuffer(try owner.createBuffer(2, 2, .{}));
    try target.pushScissorRect(0, 0, 1, 1);
    try target.pushOpacity(0.5);
    const cells = [_]PackedCell{.{ .char = 'A', .bg = .{ 1, 0, 0, 1 } }} ** 4;
    const pixels = [_]u8{ 255, 0, 0, 255 } ** 16;
    const gray: [16]f32 = @splat(1);
    inline for (0..4) |mode| {
        target.clear(black, 'Z');
        const link = try owner.links.alloc("https://pixels.test");
        try target.drawText("e\xcc\x81", 0, 0, red, black, ansi.TextAttributes.setLinkId(0, link));
        const glyph = grapheme.graphemeIdFromChar(target.buffer.char[0]);
        switch (mode) {
            0 => try target.drawPackedBufferChecked(std.mem.asBytes(&cells), 0, 0, 2, 2),
            1 => try target.drawSuperSampleBufferChecked(0, 0, &pixels, 1, 16),
            2, 3 => try target.drawGrayscaleBufferChecked(0, 0, &gray, if (mode == 2) 2 else 4, if (mode == 2) 2 else 4, red, red, mode == 3),
            else => unreachable,
        }
        try testing.expectEqualSlices(u32, &.{ 'Z', 'Z', 'Z' }, target.buffer.char[1..]);
        try testing.expect(target.buffer.bg[0][0] > 0 and target.buffer.bg[0][0] < 200);
        try testing.expect(!target.grapheme_tracker.hasAny());
        try testing.expect(!target.link_tracker.hasAny());
        try testing.expectError(error.InvalidId, owner.graphemes.getRefcount(glyph));
        try testing.expectEqual(@as(u32, 0), try owner.links.getRefcount(link));
    }
}

test "GPU Context drawing uses exact frame tickets and bounded visible preflight" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createBuffer(2, 1, .{});
    const target = try owner.getBuffer(id);
    try target.pushScissorRect(0, 0, 1, 1);
    const cells = [_]PackedCell{ .{ .char = 'A' }, .{ .char = 'B', .fg = .{ 1, 0, 0, std.math.nan(f32) } } };
    const data = std.mem.asBytes(&cells);
    try owner.drawPackedBuffer(id, null, data, 0, 0, 2, 1);
    try owner.drawGrayscaleBuffer(id, null, &.{ 1, std.math.nan(f32) }, 0, 0, 2, 1, null, null, false);
    target.popScissorRect();
    try testing.expectError(error.InvalidOptions, owner.drawPackedBuffer(id, null, data, 0, 0, 2, 1));
    const session = try owner.createSession(.{});
    try owner.attachSessionRenderer(session, 2, 1, .{ .remote_mode = .remote });
    _ = try owner.sceneCreateNode(session, 0, 1);
    const frame = try owner.sceneFrameStep(session, null, .{ .background = .{ 0, 0, 0, 255 }, .use_mouse = false, .excluded_hit_num = 0, .max_layout_rounds = 8, .max_host_requests = 64 });
    const pixels = [_]u8{ 255, 0, 0, 255 } ** 4;
    try testing.expectError(error.WrongKind, owner.drawPackedBuffer(session, null, data[0..48], 0, 0, 1, 1));
    try owner.drawPackedBuffer(session, frame, data[0..48], 0, 0, 1, 1);
    try owner.drawSuperSampleBuffer(session, frame, &pixels, 0, 0, 1, 8);
    try owner.drawGrayscaleBuffer(session, frame, &.{ 1, 1, 1, 1 }, 0, 0, 2, 2, null, null, true);
    try owner.sceneFrameCancel(session, frame.frame_id);
    try testing.expectError(error.StaleFrame, owner.drawPackedBuffer(session, frame, data, 0, 0, 2, 1));
    try testing.expectError(error.StaleFrame, owner.drawSuperSampleBuffer(session, frame, &pixels, 0, 0, 1, 8));
    try testing.expectError(error.StaleFrame, owner.drawGrayscaleBuffer(session, frame, &.{1}, 0, 0, 1, 1, null, null, false));
}

test "GPU ABI rejects missing inputs invalid flags and dimensions before writes" {
    const config: c.ot_context_options = .{ .struct_size = @sizeOf(c.ot_context_options), .abi_version = c.OT_CONTEXT_ABI_VERSION, .flags = 0, .object_capacity = 4, .render_cells_max = 64, .reserved = .{ 0, 0, 0 } };
    var owner: ?*abi.ContextHandle = null;
    try testing.expectEqual(c.OT_OK, abi.ot_context_create(&config, &owner));
    defer testing.expectEqual(c.OT_OK, abi.ot_context_destroy(owner)) catch unreachable;
    const handle = abi.handleToC(try owner.?.core.createBuffer(2, 1, .{}));
    const cells = [_]PackedCell{.{ .char = 'A' }} ** 2;
    const bytes = std.mem.asBytes(&cells);
    const pixels = [_]u8{ 255, 0, 0, 255 } ** 4;
    const samples = [_]f32{ 1, 1 };
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_buffer_draw_packed(owner, &handle, null, null, 96, 0, 0, 2, 1));
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_buffer_draw_supersample(owner, &handle, null, null, 16, 0, 0, 1, 8));
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_buffer_draw_grayscale(owner, &handle, null, null, 2, 0, 0, 2, 1, null, null, 0));
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_buffer_draw_grayscale(owner, &handle, null, &samples, 2, 0, 0, 2, 1, null, null, 2));
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_buffer_draw_supersample(owner, &handle, null, &pixels, 16, 0, 0, 256, 8));
    try testing.expectEqual(c.OT_INVALID_ARGUMENT, abi.ot_buffer_draw_packed(owner, &handle, null, bytes, 96, 0, 0, std.math.maxInt(u32), std.math.maxInt(u32)));
    try testing.expectEqual(c.OT_OK, abi.ot_buffer_draw_packed(owner, &handle, null, bytes, 96, 0, 0, 2, 1));
    try testing.expectEqual(c.OT_OK, abi.ot_buffer_draw_supersample(owner, &handle, null, &pixels, 16, 0, 0, 1, 8));
    try testing.expectEqual(c.OT_OK, abi.ot_buffer_draw_grayscale(owner, &handle, null, &samples, 2, 0, 0, 2, 1, null, null, 0));
    try testing.expectEqualSlices(u32, &.{ '$', '$' }, (try owner.?.core.getBuffer(abi.handleFromC(handle))).buffer.char);
}
