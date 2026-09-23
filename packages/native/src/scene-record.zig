//! Paint recordings: the byte stream a host submits to acknowledge a RECORD request.
const std = @import("std");
const c = @import("context_abi_c");
const context = @import("context.zig");
const buffer = @import("buffer.zig");
const handles = @import("context-handles.zig");
const PaintSlot = @import("scene.zig").PaintSlot;

const Context = context.Context;

const phase_hooks = [3]u32{ c.OT_SCENE_HOOK_RENDER_BEFORE, c.OT_SCENE_HOOK_RENDER_SELF, c.OT_SCENE_HOOK_RENDER_AFTER };

/// Byte offsets of the command records that follow one SLOT record.
pub const Segment = struct { start: u32 = 0, end: u32 = 0 };

/// Before, self, and after commands of one slot.
pub const Segments = [3]Segment;

pub fn handleFromC(value: c.ot_handle) handles.Handle {
    return .{ .context_id = value.context_id, .slot = value.slot, .generation = value.generation };
}

fn bufferDrawRecord(comptime T: type, header: *const c.ot_buffer_draw_header, flags: u32) !*const T {
    if (header.struct_size != @sizeOf(T) or header.flags & ~flags != 0) return error.InvalidOptions;
    return @ptrCast(header);
}

pub fn bufferDrawFromC(header: *const c.ot_buffer_draw_header) !context.BufferDraw {
    if (header.struct_size < @sizeOf(c.ot_buffer_draw_header)) return error.InvalidOptions;
    if (header.abi_version != c.OT_CONTEXT_ABI_VERSION) return error.UnsupportedVersion;
    if (header.operation > c.OT_BUFFER_DRAW_RESPECT_ALPHA) return error.InvalidOptions;
    var draw: context.BufferDraw = .{ .operation = @enumFromInt(header.operation) };
    switch (draw.operation) {
        .clear => {
            const record = try bufferDrawRecord(c.ot_buffer_draw_clear, header, 0);
            draw.background = record.background;
        },
        .fill => {
            const record = try bufferDrawRecord(c.ot_buffer_draw_fill, header, 0);
            draw.x = record.x;
            draw.y = record.y;
            draw.width = record.width;
            draw.height = record.height;
            draw.background = record.background;
        },
        .text => {
            const record = try bufferDrawRecord(c.ot_buffer_draw_text_record, header, c.OT_BUFFER_DRAW_HAS_BACKGROUND);
            draw.x = record.x;
            draw.y = record.y;
            draw.attributes = record.attributes;
            draw.foreground = record.foreground;
            if (header.flags & c.OT_BUFFER_DRAW_HAS_BACKGROUND != 0) draw.background = record.background;
        },
        .cell, .cell_blend, .char => {
            const record = try bufferDrawRecord(c.ot_buffer_draw_cell, header, 0);
            draw.x = record.x;
            draw.y = record.y;
            draw.char = record.character;
            draw.attributes = record.attributes;
            draw.foreground = record.foreground;
            draw.background = record.background;
        },
        .box => {
            const record = try bufferDrawRecord(c.ot_buffer_draw_box, header, 0);
            draw.x = record.x;
            draw.y = record.y;
            draw.width = record.width;
            draw.height = record.height;
            draw.packed_options = record.packed_options;
            draw.foreground = record.foreground;
            draw.background = record.background;
            draw.title_color = record.title_color;
            draw.border_chars = record.border_chars;
        },
        .compose => {
            const record = try bufferDrawRecord(c.ot_buffer_draw_compose, header, c.OT_BUFFER_DRAW_HAS_SOURCE_WIDTH | c.OT_BUFFER_DRAW_HAS_SOURCE_HEIGHT);
            draw.x = record.x;
            draw.y = record.y;
            draw.crop = .{
                .x = record.source_x,
                .y = record.source_y,
                .width = if (header.flags & c.OT_BUFFER_DRAW_HAS_SOURCE_WIDTH != 0) record.source_width else null,
                .height = if (header.flags & c.OT_BUFFER_DRAW_HAS_SOURCE_HEIGHT != 0) record.source_height else null,
            };
        },
        .respect_alpha => {
            const record = try bufferDrawRecord(c.ot_buffer_draw_alpha, header, 0);
            draw.packed_options = record.enabled;
        },
    }
    return draw;
}

pub fn gridFromC(options: *const c.ot_buffer_grid_options) !context.BufferGrid {
    if (options.struct_size != @sizeOf(c.ot_buffer_grid_options) or options.reserved != 0 or
        options.flags & ~@as(u32, c.OT_BUFFER_GRID_INNER | c.OT_BUFFER_GRID_OUTER) != 0) return error.InvalidOptions;
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return error.UnsupportedVersion;
    return .{
        .border_chars = options.border_chars,
        .foreground = options.foreground,
        .background = options.background,
        .draw_inner = options.flags & c.OT_BUFFER_GRID_INNER != 0,
        .draw_outer = options.flags & c.OT_BUFFER_GRID_OUTER != 0,
    };
}

pub fn imageDrawFromC(options: *const c.ot_image_draw_options) !context.ImageDraw {
    if (options.struct_size != @sizeOf(c.ot_image_draw_options)) return error.InvalidOptions;
    if (options.abi_version != c.OT_CONTEXT_ABI_VERSION) return error.UnsupportedVersion;
    if (options.flags & ~@as(u32, c.OT_IMAGE_DRAW_SOURCE_WIDTH | c.OT_IMAGE_DRAW_SOURCE_HEIGHT) != 0 or
        options.protocol > c.OT_IMAGE_PROTOCOL_BLOCKS or options.reserved[0] != 0 or options.reserved[1] != 0 or
        (options.flags & c.OT_IMAGE_DRAW_SOURCE_WIDTH == 0 and options.source_width != 0) or
        (options.flags & c.OT_IMAGE_DRAW_SOURCE_HEIGHT == 0 and options.source_height != 0)) return error.InvalidOptions;
    return .{
        .x = options.x,
        .y = options.y,
        .width = options.width,
        .height = options.height,
        .pixel_width = options.pixel_width,
        .pixel_height = options.pixel_height,
        .source_x = options.source_x,
        .source_y = options.source_y,
        .source_width = if (options.flags & c.OT_IMAGE_DRAW_SOURCE_WIDTH != 0) options.source_width else null,
        .source_height = if (options.flags & c.OT_IMAGE_DRAW_SOURCE_HEIGHT != 0) options.source_height else null,
        .protocol = @enumFromInt(options.protocol),
    };
}

fn fixed(comptime T: type, body: []const u8) !*const T {
    if (body.len < @sizeOf(T)) return error.InvalidOptions;
    return @ptrCast(@alignCast(body.ptr));
}

fn zeroHandle(value: c.ot_handle) bool {
    return value.context_id == 0 and value.slot == 0 and value.generation == 0;
}

/// Unpadded byte count of a command record, after checking its fixed fields.
fn commandSize(operation: u32, body: []const u8) !usize {
    switch (operation) {
        c.OT_SCENE_RECORD_DRAW => {
            const value = try fixed(c.ot_scene_record_draw, body);
            const draw = try fixed(c.ot_buffer_draw_header, body[@sizeOf(c.ot_scene_record_draw)..]);
            if (value.text_length > c.OT_BUFFER_TEXT_BYTES_MAX or value.bottom_length > c.OT_BUFFER_TEXT_BYTES_MAX or
                (draw.operation != c.OT_BUFFER_DRAW_COMPOSE and !zeroHandle(value.source))) return error.InvalidOptions;
            return @sizeOf(c.ot_scene_record_draw) + @as(usize, draw.struct_size) + value.text_length + value.bottom_length;
        },
        c.OT_SCENE_RECORD_STACK => return @sizeOf(c.ot_scene_record_stack),
        c.OT_SCENE_RECORD_GRID => {
            const value = try fixed(c.ot_scene_record_grid, body);
            return @sizeOf(c.ot_scene_record_grid) + (@as(usize, value.column_count) + value.row_count) * @sizeOf(i32);
        },
        c.OT_SCENE_RECORD_PACKED => {
            const value = try fixed(c.ot_scene_record_packed, body);
            if (value.reserved != 0) return error.InvalidOptions;
            return @sizeOf(c.ot_scene_record_packed) + @as(usize, value.byte_count);
        },
        c.OT_SCENE_RECORD_SUPERSAMPLE => {
            const value = try fixed(c.ot_scene_record_supersample, body);
            if (value.reserved != 0) return error.InvalidOptions;
            return @sizeOf(c.ot_scene_record_supersample) + @as(usize, value.byte_count);
        },
        c.OT_SCENE_RECORD_GRAYSCALE => {
            const value = try fixed(c.ot_scene_record_grayscale, body);
            const flags = c.OT_SCENE_RECORD_GRAYSCALE_FOREGROUND | c.OT_SCENE_RECORD_GRAYSCALE_BACKGROUND | c.OT_SCENE_RECORD_GRAYSCALE_SUPERSAMPLED;
            if (value.flags & ~@as(u32, flags) != 0) return error.InvalidOptions;
            return @sizeOf(c.ot_scene_record_grayscale) + @as(usize, value.sample_count) * @sizeOf(f32);
        },
        c.OT_SCENE_RECORD_COLOR_MATRIX => {
            const value = try fixed(c.ot_scene_record_color_matrix, body);
            if (value.has_mask > 1 or (value.has_mask == 0 and value.mask_count != 0)) return error.InvalidOptions;
            return @sizeOf(c.ot_scene_record_color_matrix) + @as(usize, value.mask_count) * @sizeOf(f32);
        },
        c.OT_SCENE_RECORD_TEXT_VIEW, c.OT_SCENE_RECORD_EDITOR_VIEW, c.OT_SCENE_RECORD_SCENE_TEXT => return @sizeOf(c.ot_scene_record_view),
        c.OT_SCENE_RECORD_IMAGE => return @sizeOf(c.ot_scene_record_image),
        c.OT_SCENE_RECORD_UNICODE => return @sizeOf(c.ot_scene_record_unicode),
        else => return error.InvalidOptions,
    }
}

/// Validate the stream's framing and slot order, then map each recorded slot phase to
/// its commands. Command contents are validated when played.
pub fn index(bytes: []const u8, slots: []const PaintSlot, segments: []Segments) !void {
    std.debug.assert(slots.len == segments.len);
    @memset(segments, .{ .{}, .{}, .{} });
    if (bytes.len > c.OT_SCENE_RECORD_BYTES_MAX) return error.ObjectLimit;
    if (bytes.len != 0 and @intFromPtr(bytes.ptr) % 8 != 0) return error.InvalidOptions;
    var offset: usize = 0;
    var current: ?*Segment = null;
    var next_position: usize = 0;
    while (offset < bytes.len) {
        const header = try fixed(c.ot_scene_record_header, bytes[offset..]);
        const size: usize = header.size;
        if (size < @sizeOf(c.ot_scene_record_header) or size % 8 != 0 or size > bytes.len - offset) return error.InvalidOptions;
        const body = bytes[offset..][0..size];
        if (header.operation == c.OT_SCENE_RECORD_SLOT) {
            const value = try fixed(c.ot_scene_record_slot, body);
            if (size != std.mem.alignForward(usize, @sizeOf(c.ot_scene_record_slot), 8)) return error.InvalidOptions;
            if (value.slot >= slots.len or value.phase > c.OT_SCENE_RECORD_PHASE_AFTER) return error.InvalidOptions;
            const position = @as(usize, value.slot) * 3 + value.phase;
            if (position < next_position or slots[value.slot].hooks & phase_hooks[value.phase] == 0) return error.InvalidOptions;
            next_position = position + 1;
            current = &segments[value.slot][value.phase];
            current.?.* = .{ .start = @intCast(offset + size), .end = @intCast(offset + size) };
        } else {
            const segment = current orelse return error.InvalidOptions;
            if (std.mem.alignForward(usize, try commandSize(header.operation, body), 8) != size) return error.InvalidOptions;
            segment.end = @intCast(offset + size);
        }
        offset += size;
    }
}

/// Play one indexed segment. The caller owns the first floor entries of the
/// target's clip and opacity stacks.
pub fn play(owner: *Context, target: *buffer.OptimizedBuffer, floor: usize, bytes: []const u8, segment: Segment) !void {
    var offset: usize = segment.start;
    while (offset < segment.end) {
        const header = try fixed(c.ot_scene_record_header, bytes[offset..]);
        const body = bytes[offset..][0..header.size];
        run(owner, target, floor, header.operation, body) catch |err| switch (err) {
            error.StaleHandle => {},
            else => return err,
        };
        offset += header.size;
    }
}

fn run(owner: *Context, target: *buffer.OptimizedBuffer, floor: usize, operation: u32, body: []const u8) !void {
    switch (operation) {
        c.OT_SCENE_RECORD_DRAW => {
            const value = try fixed(c.ot_scene_record_draw, body);
            const record = body[@sizeOf(c.ot_scene_record_draw)..];
            const header = try fixed(c.ot_buffer_draw_header, record);
            var draw = try bufferDrawFromC(header);
            const text = record[header.struct_size..][0..value.text_length];
            const bottom = record[header.struct_size + value.text_length ..][0..value.bottom_length];
            if ((text.len != 0 and draw.operation != .text and draw.operation != .box) or
                (bottom.len != 0 and draw.operation != .box)) return error.InvalidOptions;
            if (draw.operation == .compose) draw.source = handleFromC(value.source);
            try owner.drawBufferOn(target, true, draw, text, bottom);
        },
        c.OT_SCENE_RECORD_STACK => {
            const value = try fixed(c.ot_scene_record_stack, body);
            if (value.operation > c.OT_BUFFER_STACK_CLEAR_OPACITY) return error.InvalidOptions;
            _ = try Context.bufferStackOn(target, floor, .{
                .operation = @enumFromInt(value.operation),
                .x = value.x,
                .y = value.y,
                .width = value.width,
                .height = value.height,
                .opacity = value.opacity,
            });
        },
        c.OT_SCENE_RECORD_GRID => {
            const value = try fixed(c.ot_scene_record_grid, body);
            const offsets: [*]const i32 = @ptrCast(@alignCast(body[@sizeOf(c.ot_scene_record_grid)..].ptr));
            try owner.drawGridOn(target, try gridFromC(&value.options), offsets[0..value.column_count], offsets[value.column_count..][0..value.row_count]);
        },
        c.OT_SCENE_RECORD_PACKED => {
            const value = try fixed(c.ot_scene_record_packed, body);
            const data = body[@sizeOf(c.ot_scene_record_packed)..][0..value.byte_count];
            try target.drawPackedBufferChecked(data, value.x, value.y, value.width, value.height);
        },
        c.OT_SCENE_RECORD_SUPERSAMPLE => {
            const value = try fixed(c.ot_scene_record_supersample, body);
            const data = body[@sizeOf(c.ot_scene_record_supersample)..][0..value.byte_count];
            try Context.drawSuperSampleOn(target, data, value.x, value.y, value.format, value.stride);
        },
        c.OT_SCENE_RECORD_GRAYSCALE => {
            const value = try fixed(c.ot_scene_record_grayscale, body);
            const samples: [*]align(1) const f32 = @ptrCast(body[@sizeOf(c.ot_scene_record_grayscale)..].ptr);
            try target.drawGrayscaleBufferChecked(
                value.x,
                value.y,
                samples[0..value.sample_count],
                value.width,
                value.height,
                if (value.flags & c.OT_SCENE_RECORD_GRAYSCALE_FOREGROUND != 0) value.foreground else null,
                if (value.flags & c.OT_SCENE_RECORD_GRAYSCALE_BACKGROUND != 0) value.background else null,
                value.flags & c.OT_SCENE_RECORD_GRAYSCALE_SUPERSAMPLED != 0,
            );
        },
        c.OT_SCENE_RECORD_COLOR_MATRIX => {
            const value = try fixed(c.ot_scene_record_color_matrix, body);
            const mask: [*]align(1) const f32 = @ptrCast(body[@sizeOf(c.ot_scene_record_color_matrix)..].ptr);
            try owner.colorMatrixOn(target, &value.matrix, if (value.has_mask != 0) mask[0..value.mask_count] else null, value.strength, value.channel);
        },
        c.OT_SCENE_RECORD_TEXT_VIEW => {
            const value = try fixed(c.ot_scene_record_view, body);
            try owner.drawTextViewOn(target, handleFromC(value.source), value.x, value.y);
        },
        c.OT_SCENE_RECORD_EDITOR_VIEW => {
            const value = try fixed(c.ot_scene_record_view, body);
            try owner.drawEditorViewOn(target, handleFromC(value.source), value.x, value.y);
        },
        c.OT_SCENE_RECORD_SCENE_TEXT => {
            const value = try fixed(c.ot_scene_record_view, body);
            try owner.drawSceneTextOn(target, handleFromC(value.source), value.x, value.y);
        },
        c.OT_SCENE_RECORD_IMAGE => {
            const value = try fixed(c.ot_scene_record_image, body);
            _ = try owner.drawImageOn(target, handleFromC(value.image), try imageDrawFromC(&value.options));
        },
        c.OT_SCENE_RECORD_UNICODE => {
            const value = try fixed(c.ot_scene_record_unicode, body);
            try owner.drawUnicodeOn(target, handleFromC(value.unicode), value.index, value.x, value.y, value.foreground, value.background, value.attributes);
        },
        else => return error.InvalidOptions,
    }
}
