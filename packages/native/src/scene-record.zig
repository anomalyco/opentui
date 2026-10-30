//! Paint recordings: the byte stream a host submits to acknowledge a RECORD request.
const std = @import("std");
const c = @import("context_abi_c");
const context = @import("context.zig");
const buffer = @import("buffer.zig");
const handles = @import("context-handles.zig");
const scene = @import("scene.zig");
const native = @import("native-renderable.zig");
const PaintSlot = scene.PaintSlot;

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

/// Decodes into caller storage. Returning the record by value made callers reload it with wide
/// loads just after narrow field stores, which stalls on store forwarding on every primitive draw.
pub fn bufferDrawFromC(header: *const c.ot_buffer_draw_header, draw: *context.BufferDraw) !void {
    if (header.struct_size < @sizeOf(c.ot_buffer_draw_header)) return error.InvalidOptions;
    if (header.abi_version != c.OT_CONTEXT_ABI_VERSION) return error.UnsupportedVersion;
    if (header.operation > c.OT_BUFFER_DRAW_RESPECT_ALPHA) return error.InvalidOptions;
    draw.* = .{ .operation = @enumFromInt(header.operation) };
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
            const Record = c.ot_buffer_draw_text_record;
            // A record without max_width, as bindings built before it was added send, has no limit.
            const fitted = header.struct_size == @sizeOf(Record);
            if (!fitted and header.struct_size != @offsetOf(Record, "max_width")) return error.InvalidOptions;
            if (header.flags & ~@as(u32, c.OT_BUFFER_DRAW_HAS_BACKGROUND | c.OT_BUFFER_DRAW_FIT_ELLIPSIS) != 0) return error.InvalidOptions;
            const record: *const Record = @ptrCast(header);
            draw.x = record.x;
            draw.y = record.y;
            draw.attributes = record.attributes;
            draw.foreground = record.foreground;
            if (header.flags & c.OT_BUFFER_DRAW_HAS_BACKGROUND != 0) draw.background = record.background;
            draw.fit = .{ .max_width = if (fitted) record.max_width else 0, .ellipsis = header.flags & c.OT_BUFFER_DRAW_FIT_ELLIPSIS != 0 };
            if (draw.fit.ellipsis and draw.fit.max_width == 0) return error.InvalidOptions;
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

/// Command record types. SLOT records frame the commands and are not one.
pub const Command = enum(u32) { draw = 1, stack, grid, @"packed", supersample, grayscale, color_matrix, text_view, editor_view, scene_body, image, unicode };

fn command(operation: u32) !Command {
    return std.enums.fromInt(Command, operation) orelse error.InvalidOptions;
}

comptime {
    std.debug.assert(@sizeOf(usize) >= 8); // commandSize adds up to four u32 lengths.
    // Each OT_SCENE_RECORD_<NAME> type has an equal Command tag, and each tag has a type.
    @setEvalBranchQuota(200_000);
    var count = 0;
    for (@typeInfo(c).@"struct".decls) |decl| {
        const name = if (std.mem.startsWith(u8, decl.name, "OT_SCENE_RECORD_")) decl.name["OT_SCENE_RECORD_".len..] else continue;
        if (std.mem.eql(u8, name, "SLOT") or std.mem.eql(u8, name, "BYTES_MAX") or std.mem.startsWith(u8, name, "PHASE_") or std.mem.startsWith(u8, name, "GRAYSCALE_")) continue;
        var lower: [name.len]u8 = undefined;
        const tag = std.meta.stringToEnum(Command, std.ascii.lowerString(&lower, name)) orelse @compileError(decl.name ++ " has no Command tag");
        if (@intFromEnum(tag) != @field(c, decl.name)) @compileError(decl.name ++ " differs from its Command tag");
        count += 1;
    }
    if (count != std.meta.fields(Command).len) @compileError("a Command tag has no OT_SCENE_RECORD_ type");
}

/// Unpadded byte count of a command record, after checking its fixed fields.
fn commandSize(operation: Command, body: []const u8) !usize {
    switch (operation) {
        .draw => {
            const value = try fixed(c.ot_scene_record_draw, body);
            const draw = try fixed(c.ot_buffer_draw_header, body[@sizeOf(c.ot_scene_record_draw)..]);
            if (value.text_length > c.OT_BUFFER_TEXT_BYTES_MAX or value.bottom_length > c.OT_BUFFER_TEXT_BYTES_MAX or
                (draw.operation != c.OT_BUFFER_DRAW_COMPOSE and !zeroHandle(value.source))) return error.InvalidOptions;
            return @sizeOf(c.ot_scene_record_draw) + @as(usize, draw.struct_size) + value.text_length + value.bottom_length;
        },
        .stack => return @sizeOf(c.ot_scene_record_stack),
        .grid => {
            const value = try fixed(c.ot_scene_record_grid, body);
            return @sizeOf(c.ot_scene_record_grid) + (@as(usize, value.column_count) + value.row_count) * @sizeOf(i32);
        },
        .@"packed" => {
            const value = try fixed(c.ot_scene_record_packed, body);
            if (value.reserved != 0) return error.InvalidOptions;
            return @sizeOf(c.ot_scene_record_packed) + @as(usize, value.byte_count);
        },
        .supersample => {
            const value = try fixed(c.ot_scene_record_supersample, body);
            if (value.reserved != 0) return error.InvalidOptions;
            return @sizeOf(c.ot_scene_record_supersample) + @as(usize, value.byte_count);
        },
        .grayscale => {
            const value = try fixed(c.ot_scene_record_grayscale, body);
            const flags = c.OT_SCENE_RECORD_GRAYSCALE_FOREGROUND | c.OT_SCENE_RECORD_GRAYSCALE_BACKGROUND | c.OT_SCENE_RECORD_GRAYSCALE_SUPERSAMPLED;
            if (value.flags & ~@as(u32, flags) != 0) return error.InvalidOptions;
            return @sizeOf(c.ot_scene_record_grayscale) + @as(usize, value.sample_count) * @sizeOf(f32);
        },
        .color_matrix => {
            const value = try fixed(c.ot_scene_record_color_matrix, body);
            if (value.has_mask > 1 or (value.has_mask == 0 and value.mask_count != 0)) return error.InvalidOptions;
            return @sizeOf(c.ot_scene_record_color_matrix) + @as(usize, value.mask_count) * @sizeOf(f32);
        },
        .text_view, .editor_view, .scene_body => return @sizeOf(c.ot_scene_record_view),
        .image => return @sizeOf(c.ot_scene_record_image),
        .unicode => return @sizeOf(c.ot_scene_record_unicode),
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
            if (std.mem.alignForward(usize, try commandSize(try command(header.operation), body), 8) != size) return error.InvalidOptions;
            segment.end = @intCast(offset + size);
        }
        offset += size;
    }
}

/// What one slot's recording paints, compared with the presented frame's by retained paint.
pub const Fingerprint = struct {
    // Hook flags, phases, command bytes, and the identity and paint epoch of each resource
    // the commands read: equal digests play equal cells.
    digest: u64 = 0,
    // Rows the commands can write, before the member clip bounds them.
    top: i64 = std.math.maxInt(i64),
    bottom: i64 = std.math.minInt(i64),
    // A composed buffer has no paint epoch, so the slot repaints on every frame.
    stable: bool = true,
    // DRAW clear and COLOR_MATRIX write outside the member clip.
    non_local: bool = false,
    image: bool = false,

    fn rows(self: *Fingerprint, top: i64, bottom: i64) void {
        self.top = @min(self.top, top);
        self.bottom = @max(self.bottom, bottom);
    }
};

/// Fingerprint an indexed slot. Each command is bounded by its own fields; a view reaches the
/// clip bottom, and a command that names no height or fails to decode reaches the whole clip.
pub fn fingerprint(owner: *Context, member: *const native.NativeRenderable, bytes: []const u8, segments: Segments, hooks: u32, frame_id: u64) Fingerprint {
    const clip_bottom = std.math.maxInt(i64);
    var result: Fingerprint = .{};
    var hasher = std.hash.Wyhash.init(hooks);
    const raw = owner.raw();
    for (segments) |segment| {
        hasher.update(std.mem.asBytes(&(segment.end - segment.start)));
        hasher.update(bytes[segment.start..segment.end]);
        var offset: usize = segment.start;
        while (offset < segment.end) {
            // index checked the framing and every fixed part.
            const header = fixed(c.ot_scene_record_header, bytes[offset..]) catch unreachable;
            const body = bytes[offset..][0..header.size];
            offset += header.size;
            switch (command(header.operation) catch unreachable) {
                .draw => {
                    const value = fixed(c.ot_scene_record_draw, body) catch unreachable;
                    var draw: context.BufferDraw = undefined;
                    bufferDrawFromC(fixed(c.ot_buffer_draw_header, body[@sizeOf(c.ot_scene_record_draw)..]) catch unreachable, &draw) catch {
                        result.rows(std.math.minInt(i64), clip_bottom);
                        continue;
                    };
                    switch (draw.operation) {
                        .clear => result.non_local = true,
                        .respect_alpha => {},
                        .fill, .box => result.rows(draw.y, @as(i64, draw.y) + draw.height),
                        .text, .cell, .cell_blend, .char => result.rows(draw.y, @as(i64, draw.y) + 1),
                        .compose => {
                            result.stable = false;
                            const source = raw.getBuffer(handleFromC(value.source)) catch continue;
                            result.rows(draw.y, @as(i64, draw.y) + source.height);
                        },
                    }
                },
                .stack => {},
                .grid => {
                    const value = fixed(c.ot_scene_record_grid, body) catch unreachable;
                    const offsets: [*]align(1) const i32 = @ptrCast(body[@sizeOf(c.ot_scene_record_grid)..].ptr);
                    if (value.row_count < 2) continue;
                    const first = offsets[value.column_count];
                    const last = offsets[value.column_count + value.row_count - 1];
                    result.rows(@min(first, last), @as(i64, @max(first, last)) + 1);
                },
                .@"packed" => {
                    const value = fixed(c.ot_scene_record_packed, body) catch unreachable;
                    result.rows(value.y, @as(i64, value.y) + value.height);
                },
                .supersample => result.rows((fixed(c.ot_scene_record_supersample, body) catch unreachable).y, clip_bottom),
                .grayscale => {
                    const value = fixed(c.ot_scene_record_grayscale, body) catch unreachable;
                    result.rows(value.y, @as(i64, value.y) + value.height);
                },
                .color_matrix => result.non_local = true,
                .text_view, .editor_view, .scene_body => {
                    const value = fixed(c.ot_scene_record_view, body) catch unreachable;
                    result.rows(value.y, clip_bottom);
                    // A destroyed resource plays nothing; a live one paints its epoch's cells.
                    var state = [2]u64{ 0, 0 };
                    var layout: scene.Layout = .{};
                    const source = handleFromC(value.source);
                    // A view bound to another node takes that node's size, which no epoch tracks.
                    var bound: ?*native.NativeRenderable = null;
                    if (header.operation == c.OT_SCENE_RECORD_TEXT_VIEW) {
                        if (raw.getTextBufferView(source)) |view| {
                            state = .{ view.paint_epoch, @intFromBool(view.text.buffer.getSyntaxStyle() != null) };
                            bound = view.node;
                        } else |_| {}
                    } else if (header.operation == c.OT_SCENE_RECORD_EDITOR_VIEW) {
                        if (raw.getEditorView(source)) |editor| {
                            state = .{ editor.paint_epoch, @intFromBool(editor.edit.buffer.tb.getSyntaxStyle() != null) };
                            bound = editor.node;
                        } else |_| {}
                    } else if (raw.getRenderable(source)) |node| {
                        // A body paints at the node's paint size, with focus colors when focus lies within it.
                        state = .{ node.scene_node.?.paint_epoch, @intFromBool(node.scene_node.?.focus_frame == frame_id) };
                        layout = scene.getPaintLayout(node) catch .{};
                    } else |_| {}
                    if (bound != null and bound.? != member) result.stable = false;
                    hasher.update(std.mem.asBytes(&state));
                    hasher.update(std.mem.asBytes(&layout));
                },
                // Images take the full path, as image nodes do.
                .image => result.image = true,
                .unicode => {
                    const value = fixed(c.ot_scene_record_unicode, body) catch unreachable;
                    result.rows(value.y, @as(i64, value.y) + 1);
                    const live = if (raw.getUnicode(handleFromC(value.unicode))) |_| true else |_| false;
                    hasher.update(&[_]u8{@intFromBool(live)});
                },
            }
        }
    }
    result.digest = hasher.final();
    return result;
}

/// Play one indexed segment. The caller owns the first floor entries of the
/// target's clip and opacity stacks.
pub fn play(owner: *Context, target: *buffer.OptimizedBuffer, floor: usize, bytes: []const u8, segment: Segment) !void {
    std.debug.assert(segment.start <= segment.end and segment.end <= bytes.len);
    var offset: usize = segment.start;
    while (offset < segment.end) {
        const header = try fixed(c.ot_scene_record_header, bytes[offset..]);
        // index validated the framing that playback walks again.
        std.debug.assert(header.size >= @sizeOf(c.ot_scene_record_header) and header.size % 8 == 0 and header.size <= segment.end - offset);
        const body = bytes[offset..][0..header.size];
        run(owner, target, floor, try command(header.operation), body) catch |err| switch (err) {
            error.StaleHandle => {},
            else => return err,
        };
        offset += header.size;
    }
}

fn run(owner: *Context, target: *buffer.OptimizedBuffer, floor: usize, operation: Command, body: []const u8) !void {
    switch (operation) {
        .draw => {
            const value = try fixed(c.ot_scene_record_draw, body);
            const record = body[@sizeOf(c.ot_scene_record_draw)..];
            const header = try fixed(c.ot_buffer_draw_header, record);
            var draw: context.BufferDraw = undefined;
            try bufferDrawFromC(header, &draw);
            const text = record[header.struct_size..][0..value.text_length];
            const bottom = record[header.struct_size + value.text_length ..][0..value.bottom_length];
            if ((text.len != 0 and draw.operation != .text and draw.operation != .box) or
                (bottom.len != 0 and draw.operation != .box)) return error.InvalidOptions;
            if (draw.operation == .compose) draw.source = handleFromC(value.source);
            try owner.drawBufferOn(target, true, &draw, text, bottom);
        },
        .stack => {
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
        .grid => {
            const value = try fixed(c.ot_scene_record_grid, body);
            const offsets: [*]const i32 = @ptrCast(@alignCast(body[@sizeOf(c.ot_scene_record_grid)..].ptr));
            try owner.drawGridOn(target, try gridFromC(&value.options), offsets[0..value.column_count], offsets[value.column_count..][0..value.row_count]);
        },
        .@"packed" => {
            const value = try fixed(c.ot_scene_record_packed, body);
            const data = body[@sizeOf(c.ot_scene_record_packed)..][0..value.byte_count];
            try target.drawPackedBufferChecked(data, value.x, value.y, value.width, value.height);
        },
        .supersample => {
            const value = try fixed(c.ot_scene_record_supersample, body);
            const data = body[@sizeOf(c.ot_scene_record_supersample)..][0..value.byte_count];
            try Context.drawSuperSampleOn(target, data, value.x, value.y, value.format, value.stride);
        },
        .grayscale => {
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
        .color_matrix => {
            const value = try fixed(c.ot_scene_record_color_matrix, body);
            const mask: [*]align(1) const f32 = @ptrCast(body[@sizeOf(c.ot_scene_record_color_matrix)..].ptr);
            try owner.colorMatrixOn(target, &value.matrix, if (value.has_mask != 0) mask[0..value.mask_count] else null, value.strength, value.channel);
        },
        .text_view => {
            const value = try fixed(c.ot_scene_record_view, body);
            try owner.drawTextViewOn(target, handleFromC(value.source), value.x, value.y);
        },
        .editor_view => {
            const value = try fixed(c.ot_scene_record_view, body);
            try owner.drawEditorViewOn(target, handleFromC(value.source), value.x, value.y);
        },
        .scene_body => {
            const value = try fixed(c.ot_scene_record_view, body);
            try owner.drawSceneBodyOn(target, handleFromC(value.source), value.x, value.y);
        },
        .image => {
            const value = try fixed(c.ot_scene_record_image, body);
            _ = try owner.drawImageOn(target, handleFromC(value.image), try imageDrawFromC(&value.options));
        },
        .unicode => {
            const value = try fixed(c.ot_scene_record_unicode, body);
            try owner.drawUnicodeOn(target, handleFromC(value.unicode), value.index, value.x, value.y, value.foreground, value.background, value.attributes);
        },
    }
}
