const std = @import("std");
const c = @import("context_abi_c");
const abi = @import("context-abi.zig");
const ctx = @import("context.zig");
const editor = @import("context-editor-abi.zig");
const Owner = abi.ContextHandle;
const admit = editor.admit;
const fail = editor.fail;
const record = editor.record;

fn text(owner: *Owner, id: ?*const c.ot_handle) !*ctx.SharedText {
    return owner.core.getTextBuffer(abi.handleFromC((id orelse return error.InvalidOptions).*));
}

fn view(owner: *Owner, id: ?*const c.ot_handle) !*ctx.TextView {
    return owner.core.getTextBufferView(abi.handleFromC((id orelse return error.InvalidOptions).*));
}

pub fn ot_text_buffer_create(context: ?*Owner, options: ?*const c.ot_edit_buffer_options, out: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const value = record(c.ot_edit_buffer_options, options) catch |err| return fail(owner, err);
    if (out == null or value.reserved != 0 or value.width_method > c.OT_WIDTH_METHOD_UNICODE_WIDE) return fail(owner, error.InvalidOptions);
    out.?.* = abi.handleToC(owner.core.createTextBuffer(@enumFromInt(value.width_method)) catch |err| return fail(owner, err));
    return c.OT_OK;
}

pub fn ot_text_buffer_destroy(context: ?*Owner, id: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const value = text(context.?, id) catch |err| return fail(context, err);
    context.?.core.destroy(value.handle) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_text_buffer_view_create(context: ?*Owner, id: ?*const c.ot_handle, out: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (id == null or out == null) return fail(context, error.InvalidOptions);
    out.?.* = abi.handleToC(context.?.core.createTextBufferView(abi.handleFromC(id.?.*)) catch |err| return fail(context, err));
    return c.OT_OK;
}

pub fn ot_text_buffer_view_destroy(context: ?*Owner, id: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const value = view(context.?, id) catch |err| return fail(context, err);
    context.?.core.destroy(value.handle) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_text_buffer_set_text(context: ?*Owner, id: ?*const c.ot_handle, bytes: ?[*]const u8, count: u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (id == null or (count != 0 and bytes == null)) return fail(context, error.InvalidOptions);
    context.?.core.textBufferSetText(abi.handleFromC(id.?.*), if (bytes) |p| p[0..count] else &.{}) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_text_buffer_append(context: ?*Owner, id: ?*const c.ot_handle, bytes: ?[*]const u8, count: u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (id == null or (count != 0 and bytes == null)) return fail(context, error.InvalidOptions);
    context.?.core.textBufferAppend(abi.handleFromC(id.?.*), if (bytes) |p| p[0..count] else &.{}) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_text_buffer_clear(context: ?*Owner, id: ?*const c.ot_handle, reset: u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (id == null or reset > 1) return fail(context, error.InvalidOptions);
    context.?.core.textBufferClear(abi.handleFromC(id.?.*), reset == 1) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_text_buffer_set_styled_text(context: ?*Owner, id: ?*const c.ot_handle, bytes: ?[*]const u8, count: u32, chunks: ?[*]const c.ot_scene_linked_text_chunk, chunk_count: u32, urls: ?[*]const u8, url_count: u32) callconv(.c) c.ot_status {
    return abi.setStyledText(c.ot_scene_linked_text_chunk, true, context, id, bytes, count, chunks, chunk_count, urls, url_count);
}

pub fn ot_text_buffer_replace_styled_batch(
    context: ?*Owner,
    records: ?[*]const c.ot_text_buffer_replacement,
    count: u32,
    bytes: ?[*]const u8,
    byte_count: u32,
    chunk_records: ?[*]const c.ot_scene_linked_text_chunk,
    chunk_count: u32,
    urls: ?[*]const u8,
    url_count: u32,
    out: ?[*]c.ot_text_buffer_replacement_info,
) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    if (count > c.OT_TEXT_REPLACEMENT_COUNT_MAX or chunk_count > c.OT_TEXT_REPLACEMENT_CHUNKS_MAX or
        byte_count > c.OT_TEXT_REPLACEMENT_BYTES_MAX or url_count > c.OT_TEXT_REPLACEMENT_URL_BYTES_MAX or
        (count != 0 and (records == null or out == null)) or (byte_count != 0 and bytes == null) or
        (chunk_count != 0 and chunk_records == null) or (url_count != 0 and urls == null)) return fail(owner, error.InvalidOptions);
    const input = if (bytes) |p| p[0..byte_count] else &.{};
    const url_bytes = if (urls) |p| p[0..url_count] else &.{};
    const chunks = owner.core.allocator.alloc(ctx.StyledTextChunk, chunk_count) catch |err| return fail(owner, err);
    defer owner.core.allocator.free(chunks);
    for (chunks, 0..) |*chunk, index| {
        const value = record(c.ot_scene_linked_text_chunk, &chunk_records.?[index]) catch |err| return fail(owner, err);
        if (value.reserved != 0 or value.flags & ~@as(u32, c.OT_SCENE_TEXT_FOREGROUND | c.OT_SCENE_TEXT_BACKGROUND | c.OT_SCENE_TEXT_LINK) != 0 or
            value.link_offset > url_bytes.len or value.link_byte_count > url_bytes.len - value.link_offset or
            (value.flags & c.OT_SCENE_TEXT_LINK == 0 and (value.link_offset != 0 or value.link_byte_count != 0))) return fail(owner, error.InvalidOptions);
        chunk.* = .{
            .byte_count = value.byte_count,
            .foreground = if (value.flags & c.OT_SCENE_TEXT_FOREGROUND != 0) value.foreground else null,
            .background = if (value.flags & c.OT_SCENE_TEXT_BACKGROUND != 0) value.background else null,
            .attributes = value.attributes,
            .link_url = if (value.flags & c.OT_SCENE_TEXT_LINK != 0) url_bytes[value.link_offset..][0..value.link_byte_count] else null,
        };
    }
    var replacements: [c.OT_TEXT_REPLACEMENT_COUNT_MAX]ctx.Context.TextReplacement = undefined;
    for (replacements[0..count], 0..) |*replacement, index| {
        const value = record(c.ot_text_buffer_replacement, &records.?[index]) catch |err| return fail(owner, err);
        if (value.byte_offset > input.len or value.byte_count > input.len - value.byte_offset or
            value.chunk_offset > chunks.len or value.chunk_count > chunks.len - value.chunk_offset) return fail(owner, error.InvalidOptions);
        replacement.* = .{
            .buffer = abi.handleFromC(value.buffer),
            .view = abi.handleFromC(value.view),
            .bytes = input[value.byte_offset..][0..value.byte_count],
            .chunks = chunks[value.chunk_offset..][0..value.chunk_count],
        };
    }
    const output: []ctx.Context.TextReplacementInfo = if (out) |p| @as([*]ctx.Context.TextReplacementInfo, @ptrCast(p))[0..count] else &.{};
    owner.core.textBufferReplaceStyledBatch(replacements[0..count], output) catch |err| return fail(owner, err);
    return c.OT_OK;
}

comptime {
    std.debug.assert(c.OT_TEXT_REPLACEMENT_COUNT_MAX == ctx.Context.text_replacement_count_max);
    std.debug.assert(c.OT_TEXT_REPLACEMENT_CHUNKS_MAX == ctx.Context.text_replacement_chunks_max);
    std.debug.assert(c.OT_TEXT_REPLACEMENT_BYTES_MAX == ctx.Context.text_replacement_bytes_max);
    std.debug.assert(c.OT_TEXT_REPLACEMENT_URL_BYTES_MAX == ctx.Context.text_replacement_url_bytes_max);
    std.debug.assert(@sizeOf(c.ot_text_buffer_replacement) == 56);
    std.debug.assert(@sizeOf(c.ot_text_buffer_replacement_info) == @sizeOf(ctx.Context.TextReplacementInfo));
    std.debug.assert(@alignOf(c.ot_text_buffer_replacement_info) == @alignOf(ctx.Context.TextReplacementInfo));
    for (.{ "text_length", "byte_count" }) |field| {
        std.debug.assert(@offsetOf(c.ot_text_buffer_replacement_info, field) == @offsetOf(ctx.Context.TextReplacementInfo, field));
    }
}

pub fn ot_text_buffer_set_syntax_style(context: ?*Owner, id: ?*const c.ot_handle, style: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (id == null) return fail(context, error.InvalidOptions);
    context.?.core.textBufferSetSyntaxStyle(abi.handleFromC(id.?.*), if (style) |p| abi.handleFromC(p.*) else null) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_text_buffer_get_info(context: ?*Owner, id: ?*const c.ot_handle, out: ?*c.ot_text_buffer_info) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    const info = record(c.ot_text_buffer_info, out) catch |err| return fail(owner, err);
    if (info.reserved != 0) return fail(owner, error.InvalidOptions);
    const value = text(owner, id) catch |err| return fail(owner, err);
    const buffer = value.buffer;
    out.?.* = .{ .struct_size = @sizeOf(c.ot_text_buffer_info), .abi_version = 1, .content_epoch = buffer.getContentEpoch(), .byte_count = buffer.getByteSize(), .text_length = buffer.getLength(), .line_count = buffer.lineCount(), .highlight_count = buffer.getHighlightCount(), .tab_width = buffer.getTabWidth(), .reserved = 0 };
    return c.OT_OK;
}

pub fn ot_text_buffer_get_text(context: ?*Owner, id: ?*const c.ot_handle, bytes: ?[*]u8, capacity: u32, out: ?*u32) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    if (out == null or (capacity != 0 and bytes == null)) return fail(owner, error.InvalidOptions);
    const value = text(owner, id) catch |err| return fail(owner, err);
    const count = value.buffer.getByteSize();
    if (capacity != 0 and capacity < count) return fail(owner, error.BufferTooSmall);
    out.?.* = if (capacity == 0) count else @intCast(value.buffer.getPlainTextIntoBuffer(bytes.?[0..capacity]));
    return c.OT_OK;
}

pub fn ot_text_buffer_get_range(context: ?*Owner, id: ?*const c.ot_handle, start: u32, end: u32, bytes: ?[*]u8, capacity: u32, out: ?*u32) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    if (out == null or (capacity != 0 and bytes == null)) return fail(owner, error.InvalidOptions);
    const value = text(owner, id) catch |err| return fail(owner, err);
    const bound = value.buffer.getByteSize();
    if (capacity != 0 and capacity < bound) return fail(owner, error.BufferTooSmall);
    if (capacity == 0) {
        out.?.* = bound;
        return c.OT_OK;
    }
    editor.prepareBuffer(value.buffer) catch |err| return fail(owner, err);
    out.?.* = @intCast(value.buffer.getTextRange(start, end, bytes.?[0..capacity]));
    return c.OT_OK;
}

pub fn ot_text_buffer_set_defaults(context: ?*Owner, id: ?*const c.ot_handle, mask: u32, options: ?*const c.ot_editor_style) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null) return fail(owner, error.InvalidOptions);
    const defaults = editor.defaultsFromC(mask, options) catch |err| return fail(owner, err);
    owner.core.textBufferSetDefaults(abi.handleFromC(id.?.*), defaults) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn ot_text_buffer_set_tab_width(context: ?*Owner, id: ?*const c.ot_handle, width: u32) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null or width > 255) return fail(owner, error.InvalidOptions);
    owner.core.textBufferSetTabWidth(abi.handleFromC(id.?.*), @intCast(width)) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn ot_text_buffer_highlight(context: ?*Owner, id: ?*const c.ot_handle, operation: u32, argument: u32, highlight: ?*const c.ot_edit_highlight) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null) return fail(owner, error.InvalidOptions);
    const decoded = editor.highlightFromC(operation, argument, highlight) catch |err| return fail(owner, err);
    owner.core.textBufferHighlight(abi.handleFromC(id.?.*), decoded) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn ot_text_buffer_get_highlights(context: ?*Owner, id: ?*const c.ot_handle, line: u32, highlights: ?[*]c.ot_edit_highlight, capacity: u32, out: ?*u32) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    if (out == null or (capacity != 0 and highlights == null)) return fail(owner, error.InvalidOptions);
    const value = text(owner, id) catch |err| return fail(owner, err);
    const items = value.buffer.getLineHighlights(line);
    if (items.len > std.math.maxInt(u32)) return fail(owner, error.TextLimit);
    if (capacity != 0 and capacity < items.len) return fail(owner, error.BufferTooSmall);
    if (capacity != 0) for (items, 0..) |h, index| {
        highlights.?[index] = .{ .start = h.col_start, .end = h.col_end, .style_id = h.style_id, .priority = h.priority, .ref = h.hl_ref };
    };
    out.?.* = @intCast(items.len);
    return c.OT_OK;
}

pub fn ot_text_buffer_view_set_viewport(context: ?*Owner, id: ?*const c.ot_handle, options: ?*const c.ot_editor_viewport, size_only: u32) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    const vp = record(c.ot_editor_viewport, options) catch |err| return fail(owner, err);
    if (id == null or size_only > 1 or (size_only == 1 and (vp.x != 0 or vp.y != 0))) return fail(owner, error.InvalidOptions);
    owner.core.textViewSetViewport(abi.handleFromC(id.?.*), .{ .x = vp.x, .y = vp.y, .width = vp.width, .height = vp.height }, size_only == 1) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn ot_text_buffer_view_command(context: ?*Owner, id: ?*const c.ot_handle, command: u32, argument: u32) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null or command > c.OT_TEXT_VIEW_TRUNCATE or
        (command == c.OT_TEXT_VIEW_WRAP_MODE and argument > 2) or (command == c.OT_TEXT_VIEW_TRUNCATE and argument > 1)) return fail(owner, error.InvalidOptions);
    const operation: ctx.TextViewCommand = switch (command) {
        c.OT_TEXT_VIEW_WRAP_WIDTH => .{ .wrap_width = if (argument == 0) null else argument },
        c.OT_TEXT_VIEW_WRAP_MODE => .{ .wrap_mode = @enumFromInt(argument) },
        c.OT_TEXT_VIEW_FIRST_LINE_OFFSET => .{ .first_line_offset = argument },
        c.OT_TEXT_VIEW_TAB_INDICATOR => .{ .tab_indicator = if (argument == 0) null else argument },
        c.OT_TEXT_VIEW_TRUNCATE => .{ .truncate = argument == 1 },
        else => unreachable,
    };
    owner.core.textViewCommand(abi.handleFromC(id.?.*), operation) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn ot_text_buffer_view_set_tab_color(context: ?*Owner, id: ?*const c.ot_handle, color: ?*const [4]u16) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null) return fail(owner, error.InvalidOptions);
    owner.core.textViewSetTabColor(abi.handleFromC(id.?.*), if (color) |v| v.* else null) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn ot_text_buffer_view_select(context: ?*Owner, id: ?*const c.ot_handle, options: ?*const c.ot_editor_selection, out: ?*u32) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null or out == null) return fail(owner, error.InvalidOptions);
    const selection = editor.selectionFromC(options, false) catch |err| return fail(owner, err);
    out.?.* = @intFromBool(owner.core.textViewSelect(abi.handleFromC(id.?.*), selection) catch |err| return fail(owner, err));
    return c.OT_OK;
}

pub fn ot_text_buffer_view_get_info(context: ?*Owner, id: ?*const c.ot_handle, out: ?*c.ot_editor_view_info) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    _ = record(c.ot_editor_view_info, out) catch |err| return fail(owner, err);
    const value = view(owner, id) catch |err| return fail(owner, err);
    value.prepareView() catch |err| return fail(owner, err);
    const selection = value.view.packSelectionInfo();
    const present = selection != std.math.maxInt(u64);
    const count = value.view.getVirtualLineCount();
    out.?.* = .{ .struct_size = @sizeOf(c.ot_editor_view_info), .abi_version = 1, .virtual_line_count = count, .total_virtual_line_count = count, .selection_present = @intFromBool(present), .selection_start = if (present) @intCast(selection >> 32) else 0, .selection_end = if (present) @truncate(selection) else 0, .selection_occupancy = @intFromEnum(value.view.getSelectionOccupancy()) };
    return c.OT_OK;
}

pub fn ot_text_buffer_view_get_selected_text(context: ?*Owner, id: ?*const c.ot_handle, bytes: ?[*]u8, capacity: u32, out: ?*u32) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    if (out == null or (capacity != 0 and bytes == null)) return fail(owner, error.InvalidOptions);
    const value = view(owner, id) catch |err| return fail(owner, err);
    const bound = if (value.view.packSelectionInfo() == std.math.maxInt(u64)) 0 else value.text.buffer.getByteSize();
    if (capacity != 0 and capacity < bound) return fail(owner, error.BufferTooSmall);
    if (capacity == 0 or bound == 0) {
        out.?.* = bound;
        return c.OT_OK;
    }
    out.?.* = @intCast(value.view.getSelectedTextIntoBuffer(bytes.?[0..capacity]));
    return c.OT_OK;
}

pub fn ot_text_buffer_view_get_lines(context: ?*Owner, id: ?*const c.ot_handle, logical: u32, lines: ?[*]c.ot_scene_text_line, capacity: u32, out: ?*c.ot_editor_measure) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    _ = record(c.ot_editor_measure, out) catch |err| return fail(owner, err);
    if (logical > 1 or (capacity != 0 and lines == null)) return fail(owner, error.InvalidOptions);
    const value = view(owner, id) catch |err| return fail(owner, err);
    value.prepareView() catch |err| return fail(owner, err);
    const info = if (logical == 1) value.view.getLogicalLineInfo() else value.view.getCachedLineInfo();
    const count = info.line_start_cols.len;
    if (capacity != 0 and capacity < count) return fail(owner, error.BufferTooSmall);
    if (capacity != 0) for (0..count) |index| {
        lines.?[index] = .{ .start_cols = info.line_start_cols[index], .width_cols = info.line_width_cols[index], .source_line = info.line_sources[index], .wrap_index = info.line_wraps[index] };
    };
    out.?.* = .{ .struct_size = @sizeOf(c.ot_editor_measure), .abi_version = 1, .line_count = @intCast(count), .width_cols_max = info.line_width_cols_max };
    return c.OT_OK;
}

pub fn ot_text_buffer_view_measure(context: ?*Owner, id: ?*const c.ot_handle, width: u32, height: u32, out: ?*c.ot_editor_measure) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    _ = record(c.ot_editor_measure, out) catch |err| return fail(owner, err);
    if (width > std.math.maxInt(i32) or height > std.math.maxInt(i32)) return fail(owner, error.InvalidOptions);
    const value = view(owner, id) catch |err| return fail(owner, err);
    editor.prepareBuffer(value.text.buffer) catch |err| return fail(owner, err);
    const measured = value.view.measureForDimensions(width, height) catch |err| return fail(owner, err);
    out.?.* = .{ .struct_size = @sizeOf(c.ot_editor_measure), .abi_version = 1, .line_count = measured.line_count, .width_cols_max = measured.width_cols_max };
    return c.OT_OK;
}

pub fn ot_scene_set_text_view(context: ?*Owner, node: ?*const c.ot_handle, source: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (node == null) return fail(context, error.InvalidOptions);
    context.?.core.sceneSetTextView(abi.handleFromC(node.?.*), if (source) |p| abi.handleFromC(p.*) else null) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_scene_set_text_view_paint(context: ?*Owner, node: ?*const c.ot_handle, enabled: u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (node == null or enabled > 1) return fail(context, error.InvalidOptions);
    context.?.core.sceneSetTextViewPaint(abi.handleFromC(node.?.*), enabled == 1) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_scene_select_text_view_paint(context: ?*Owner, node: ?*const c.ot_handle, frame: ?*const c.ot_scene_frame_request, enabled: u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (node == null or frame == null or enabled > 1) return fail(context, error.InvalidOptions);
    const request = abi.frameRequestFromC(frame.?.*) catch |err| return fail(context, err);
    context.?.core.sceneSelectTextViewPaint(abi.handleFromC(node.?.*), request, enabled == 1) catch |err| return fail(context, err);
    return c.OT_OK;
}

pub fn ot_buffer_draw_text_view(context: ?*Owner, target: ?*const c.ot_handle, frame: ?*const c.ot_scene_frame_request, source: ?*const c.ot_handle, x: i32, y: i32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (target == null or source == null) return fail(context, error.InvalidOptions);
    const request = if (frame) |p| abi.frameRequestFromC(p.*) catch |err| return fail(context, err) else null;
    context.?.core.drawTextBufferView(abi.handleFromC(target.?.*), request, abi.handleFromC(source.?.*), x, y) catch |err| return fail(context, err);
    return c.OT_OK;
}

test "Context shared text ABI rejects malformed replacement and preserves short-copy output" {
    var owner: Owner = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try ctx.Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const text_id = abi.handleToC(try owner.core.createTextBuffer(.unicode));
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_set_text(&owner, &text_id, "kept", 4));
    var output: [4]u8 = undefined;
    var count: u32 = 99;
    const chunk: c.ot_scene_linked_text_chunk = .{ .struct_size = @sizeOf(c.ot_scene_linked_text_chunk), .abi_version = 1, .byte_count = 4, .flags = 4, .foreground = @splat(0), .background = @splat(0), .attributes = 0, .reserved = 0, .link_offset = 1, .link_byte_count = 4 };
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_text_buffer_set_styled_text(&owner, &text_id, "next", 4, &.{chunk}, 1, "url", 3));
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_get_text(&owner, &text_id, &output, output.len, &count));
    try std.testing.expectEqualStrings("kept", &output);
    count = 99;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_text_buffer_get_text(&owner, &text_id, &output, 3, &count));
    try std.testing.expectEqual(99, count);
    try std.testing.expectEqualStrings("kept", &output);
}

test "Context shared text ABI rejects cursor updates without changing selection" {
    var owner: Owner = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try ctx.Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const text_id = abi.handleToC(try owner.core.createTextBuffer(.unicode));
    const view_id = abi.handleToC(try owner.core.createTextBufferView(abi.handleFromC(text_id)));
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_set_text(&owner, &text_id, "ab\ncd", 5));
    var info = std.mem.zeroes(c.ot_editor_view_info);
    info.struct_size = @sizeOf(c.ot_editor_view_info);
    info.abi_version = 1;
    var selection = std.mem.zeroes(c.ot_editor_selection);
    selection.struct_size = @sizeOf(c.ot_editor_selection);
    selection.abi_version = 1;
    selection.operation = c.OT_EDITOR_SELECT_SET;
    selection.start = 1;
    selection.end = 1;
    var changed: u32 = 99;
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_view_select(&owner, &view_id, &selection, &changed));
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_view_get_info(&owner, &view_id, &info));
    try std.testing.expectEqual(0, info.selection_present);
    selection.end = 4;
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_view_select(&owner, &view_id, &selection, &changed));
    selection.update_cursor = 1;
    changed = 99;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_text_buffer_view_select(&owner, &view_id, &selection, &changed));
    try std.testing.expectEqual(99, changed);
    var selected: [5]u8 = undefined;
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_view_get_selected_text(&owner, &view_id, &selected, selected.len, &changed));
    try std.testing.expectEqualStrings("b\nc", selected[0..changed]);
    try std.testing.expect(!owner.core.mutating);
}

test "Context shared text ABI releases provisional linked replacement on allocation failure" {
    var completed = false;
    for (0..128) |failure_offset| {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        var owner: Owner = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
        defer owner.io_threaded.deinit();
        owner.core = try ctx.Context.init(failing.allocator(), owner.io_threaded.io(), .{});
        defer owner.core.deinit() catch unreachable;
        const text_id = abi.handleToC(try owner.core.createTextBuffer(.unicode));
        try std.testing.expectEqual(c.OT_OK, ot_text_buffer_set_text(&owner, &text_id, "kept", 4));
        _ = try owner.core.createTextBufferView(abi.handleFromC(text_id));
        _ = try owner.core.createTextBufferView(abi.handleFromC(text_id));
        const resource = try owner.core.getTextBuffer(abi.handleFromC(text_id));
        const epoch = resource.buffer.getContentEpoch();
        const chunk: c.ot_scene_linked_text_chunk = .{ .struct_size = @sizeOf(c.ot_scene_linked_text_chunk), .abi_version = 1, .byte_count = 4, .flags = 4, .foreground = @splat(0), .background = @splat(0), .attributes = 0, .reserved = 0, .link_offset = 0, .link_byte_count = 19 };
        failing.fail_index = failing.alloc_index + failure_offset;
        failing.resize_fail_index = failing.resize_index;
        const status = ot_text_buffer_set_styled_text(&owner, &text_id, "next", 4, &.{chunk}, 1, "https://example.com", 19);
        failing.fail_index = std.math.maxInt(usize);
        failing.resize_fail_index = std.math.maxInt(usize);
        try std.testing.expect(!owner.core.mutating);
        var bytes: [4]u8 = undefined;
        var count: u32 = 0;
        try std.testing.expectEqual(c.OT_OK, ot_text_buffer_get_text(&owner, &text_id, &bytes, bytes.len, &count));
        if (failing.has_induced_failure) {
            try std.testing.expectEqual(c.OT_OUT_OF_MEMORY, status);
            try std.testing.expectEqualStrings("kept", &bytes);
            try std.testing.expectEqual(epoch, resource.buffer.getContentEpoch());
            try std.testing.expect(resource.owned_style == null);
        } else {
            try std.testing.expectEqual(c.OT_OK, status);
            try std.testing.expectEqualStrings("next", &bytes);
            completed = true;
            break;
        }
    }
    try std.testing.expect(completed);
}

test "Context shared text batch rejects every allocation failure including the final cell without publication" {
    var completed = false;
    var rejected: usize = 0;
    for (0..256) |failure_offset| {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        var owner: Owner = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
        defer owner.io_threaded.deinit();
        owner.core = try ctx.Context.init(failing.allocator(), owner.io_threaded.io(), .{});
        defer owner.core.deinit() catch unreachable;
        var records: [2]c.ot_text_buffer_replacement = undefined;
        var roots: [2]*const @import("text-buffer-segment.zig").UnifiedRope.Node = undefined;
        var styles: [2]*const @import("syntax-style.zig").SyntaxStyle = undefined;
        var epochs: [2]u64 = undefined;
        var chunk = std.mem.zeroes(c.ot_scene_linked_text_chunk);
        chunk.struct_size = @sizeOf(c.ot_scene_linked_text_chunk);
        chunk.abi_version = 1;
        chunk.byte_count = 4;
        chunk.flags = c.OT_SCENE_TEXT_LINK;
        chunk.link_byte_count = 25;
        for (&records, 0..) |*replacement, index| {
            const text_id = try owner.core.createTextBuffer(.unicode);
            const view_id = try owner.core.createTextBufferView(text_id);
            const handle = abi.handleToC(text_id);
            try std.testing.expectEqual(c.OT_OK, ot_text_buffer_set_styled_text(&owner, &handle, "kept", 4, &.{chunk}, 1, "https://example.test/kept", 25));
            const value = try owner.core.getTextBuffer(text_id);
            roots[index] = value.buffer.rope().root;
            styles[index] = value.buffer.getSyntaxStyle().?;
            epochs[index] = value.buffer.getContentEpoch();
            (try owner.core.getTextBufferView(view_id)).view.setSelection(0, 1, null, null);
            replacement.* = .{ .struct_size = @sizeOf(c.ot_text_buffer_replacement), .abi_version = 1, .buffer = handle, .view = abi.handleToC(view_id), .byte_offset = @intCast(index * 4), .byte_count = 4, .chunk_offset = @intCast(index), .chunk_count = 1 };
        }
        var output = [_]c.ot_text_buffer_replacement_info{.{ .text_length = 99, .byte_count = 99 }} ** 2;
        failing.fail_index = failing.alloc_index + failure_offset;
        failing.resize_fail_index = failing.resize_index;
        const status = ot_text_buffer_replace_styled_batch(&owner, &records, records.len, "nextlast", 8, &.{ chunk, chunk }, 2, "https://example.test/next", 25, &output);
        failing.fail_index = std.math.maxInt(usize);
        failing.resize_fail_index = std.math.maxInt(usize);
        try std.testing.expect(!owner.core.mutating);
        try std.testing.expectEqual(@as(u64, 1), owner.core.links.getLiveSlotCount());
        try std.testing.expectEqual(failing.has_induced_failure, owner.core.links.interned_live_ids.contains("https://example.test/kept"));
        for (records, 0..) |replacement, index| {
            const value = try owner.core.getTextBuffer(abi.handleFromC(replacement.buffer));
            const dependent = try owner.core.getTextBufferView(abi.handleFromC(replacement.view));
            var bytes: [4]u8 = undefined;
            _ = value.buffer.getPlainTextIntoBuffer(&bytes);
            if (failing.has_induced_failure) {
                try std.testing.expectEqual(c.OT_OUT_OF_MEMORY, status);
                try std.testing.expectEqualStrings("kept", &bytes);
                try std.testing.expectEqual(roots[index], value.buffer.rope().root);
                try std.testing.expectEqual(epochs[index], value.buffer.getContentEpoch());
                try std.testing.expectEqual(styles[index], value.buffer.getSyntaxStyle().?);
                try std.testing.expectEqual(@as(usize, 1), styles[index].emitter.listeners.get(.Destroy).?.items.len);
                try std.testing.expect(dependent.view.selection != null);
                try std.testing.expectEqual(@as(u32, 99), output[index].text_length);
                try std.testing.expectEqual(@as(u32, 99), output[index].byte_count);
            } else {
                try std.testing.expectEqual(c.OT_OK, status);
                try std.testing.expectEqualStrings(if (index == 0) "next" else "last", &bytes);
                try std.testing.expect(dependent.view.selection == null);
                try std.testing.expectEqual(@as(u32, 4), output[index].text_length);
                try std.testing.expectEqual(@as(u32, 4), output[index].byte_count);
            }
        }
        if (!failing.has_induced_failure) {
            completed = true;
            break;
        }
        rejected += 1;
    }
    try std.testing.expect(completed);
    try std.testing.expect(rejected > 20);
}

test "Context shared text batch validates identities limits admission and owned styles" {
    var owner: Owner = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try ctx.Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    var records: [2]c.ot_text_buffer_replacement = undefined;
    for (&records) |*replacement| {
        const buffer = try owner.core.createTextBuffer(.unicode);
        const dependent = try owner.core.createTextBufferView(buffer);
        try owner.core.textBufferSetText(buffer, "kept");
        replacement.* = .{ .struct_size = @sizeOf(c.ot_text_buffer_replacement), .abi_version = 1, .buffer = abi.handleToC(buffer), .view = abi.handleToC(dependent), .byte_offset = 0, .byte_count = 0, .chunk_offset = 0, .chunk_count = 0 };
    }
    var output = [_]c.ot_text_buffer_replacement_info{.{ .text_length = 99, .byte_count = 99 }} ** 2;
    for (0..9) |case| {
        var invalid = records;
        const expected: c.ot_status = switch (case) {
            0 => result: {
                invalid[1].buffer.context_id += 1;
                break :result c.OT_WRONG_CONTEXT;
            },
            1 => result: {
                invalid[1].buffer.generation += 1;
                break :result c.OT_STALE_HANDLE;
            },
            2 => result: {
                invalid[1].view.context_id += 1;
                break :result c.OT_WRONG_CONTEXT;
            },
            3 => result: {
                invalid[1].view.generation += 1;
                break :result c.OT_STALE_HANDLE;
            },
            4 => result: {
                invalid[1].view = records[0].view;
                break :result c.OT_INVALID_ARGUMENT;
            },
            5 => result: {
                invalid[1] = records[0];
                break :result c.OT_INVALID_ARGUMENT;
            },
            6 => result: {
                invalid[1].byte_count = 1;
                break :result c.OT_INVALID_ARGUMENT;
            },
            7 => result: {
                invalid[1].chunk_count = 1;
                break :result c.OT_INVALID_ARGUMENT;
            },
            8 => result: {
                invalid[1].abi_version += 1;
                break :result c.OT_UNSUPPORTED_VERSION;
            },
            else => unreachable,
        };
        try std.testing.expectEqual(expected, ot_text_buffer_replace_styled_batch(&owner, &invalid, 2, null, 0, null, 0, null, 0, &output));
    }
    for ([_][4]u32{
        .{ c.OT_TEXT_REPLACEMENT_COUNT_MAX + 1, 0, 0, 0 },
        .{ 0, c.OT_TEXT_REPLACEMENT_BYTES_MAX + 1, 0, 0 },
        .{ 0, 0, c.OT_TEXT_REPLACEMENT_CHUNKS_MAX + 1, 0 },
        .{ 0, 0, 0, c.OT_TEXT_REPLACEMENT_URL_BYTES_MAX + 1 },
        .{ 1, 0, 0, 0 },
        .{ 0, 1, 0, 0 },
        .{ 0, 0, 1, 0 },
        .{ 0, 0, 0, 1 },
    }) |counts| {
        try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_text_buffer_replace_styled_batch(&owner, null, counts[0], null, counts[1], null, counts[2], null, counts[3], null));
    }
    owner.core.mutating = true;
    const busy = ot_text_buffer_replace_styled_batch(&owner, &records, 2, null, 0, null, 0, null, 0, &output);
    owner.core.mutating = false;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, busy);
    const style = try owner.core.createSyntaxStyle();
    try owner.core.textBufferSetSyntaxStyle(abi.handleFromC(records[1].buffer), style);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_text_buffer_replace_styled_batch(&owner, &records, 2, null, 0, null, 0, null, 0, &output));
    for (records, output) |replacement, info| {
        var bytes: [4]u8 = undefined;
        const buffer = (try owner.core.getTextBuffer(abi.handleFromC(replacement.buffer))).buffer;
        try std.testing.expectEqualStrings("kept", bytes[0..buffer.getPlainTextIntoBuffer(&bytes)]);
        try std.testing.expectEqual(@as(u32, 99), info.text_length);
        try std.testing.expectEqual(@as(u32, 99), info.byte_count);
    }
    try owner.core.textBufferSetSyntaxStyle(abi.handleFromC(records[1].buffer), null);
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_replace_styled_batch(&owner, &records, 2, null, 0, null, 0, null, 0, &output));
    for (output) |info| {
        try std.testing.expectEqual(@as(u32, 0), info.text_length);
        try std.testing.expectEqual(@as(u32, 0), info.byte_count);
    }
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_replace_styled_batch(&owner, null, 0, null, 0, null, 0, null, 0, null));
}

test "Context shared text ABI rejects tab expansion before changing accepted metrics" {
    var owner: Owner = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try ctx.Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const text_id = abi.handleToC(try owner.core.createTextBuffer(.unicode));
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_set_tab_width(&owner, &text_id, 2));
    const bytes = try std.testing.allocator.alloc(u8, 17_000_000);
    defer std.testing.allocator.free(bytes);
    @memset(bytes, '\t');
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_set_text(&owner, &text_id, bytes.ptr, @intCast(bytes.len)));
    const buffer = (try owner.core.getTextBuffer(abi.handleFromC(text_id))).buffer;
    const epoch = buffer.getContentEpoch();
    const length = buffer.getLength();
    try std.testing.expectEqual(@as(u32, 34_000_000), length);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_text_buffer_set_tab_width(&owner, &text_id, 254));
    try std.testing.expectEqual(@as(u8, 2), buffer.getTabWidth());
    try std.testing.expectEqual(epoch, buffer.getContentEpoch());
    try std.testing.expectEqual(length, buffer.getLength());
    try std.testing.expectEqual(bytes.len, buffer.getByteSize());
    try std.testing.expect(!owner.core.mutating);
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_set_tab_width(&owner, &text_id, 3));
    try std.testing.expectEqual(@as(u8, 4), buffer.getTabWidth());
    try std.testing.expectEqual(@as(u32, 68_000_000), buffer.getLength());
}

test "Context shared text ABI rejects cold selection marker allocation before publication" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    var owner: Owner = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try ctx.Context.init(failing.allocator(), owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const text_id = abi.handleToC(try owner.core.createTextBuffer(.unicode));
    const view_id = abi.handleToC(try owner.core.createTextBufferView(abi.handleFromC(text_id)));
    const line = "A\u{4e2d}";
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_set_text(&owner, &text_id, line, line.len));
    var selection = std.mem.zeroes(c.ot_editor_selection);
    selection.struct_size = @sizeOf(c.ot_editor_selection);
    selection.abi_version = 1;
    selection.operation = c.OT_EDITOR_SELECT_SET;
    selection.end = 1;
    var changed: u32 = 99;
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_view_select(&owner, &view_id, &selection, &changed));
    const resource = try owner.core.getTextBufferView(abi.handleFromC(view_id));
    const accepted = resource.view.selection;
    const input = (line ++ "\n") ** 2;
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_set_text(&owner, &text_id, input, input.len));
    var info = std.mem.zeroes(c.ot_editor_view_info);
    info.struct_size = @sizeOf(c.ot_editor_view_info);
    info.abi_version = 1;
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_view_get_info(&owner, &view_id, &info));
    try std.testing.expectEqual(@as(u32, 3), info.virtual_line_count);
    const rope = resource.text.buffer.rope();
    try std.testing.expect(rope.marker_cache.version != rope.version);
    // Fail the cache allocation itself, independent of spare rope-arena capacity.
    const previous_cache = rope.marker_cache;
    rope.marker_cache = @TypeOf(rope.marker_cache).init(failing.allocator());
    defer {
        rope.marker_cache.deinit();
        rope.marker_cache = previous_cache;
    }
    selection.start = 2;
    selection.end = 3;
    changed = 99;
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    const status = ot_text_buffer_view_select(&owner, &view_id, &selection, &changed);
    failing.fail_index = std.math.maxInt(usize);
    failing.resize_fail_index = std.math.maxInt(usize);
    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(c.OT_OUT_OF_MEMORY, status);
    try std.testing.expectEqual(99, changed);
    try std.testing.expectEqualDeep(accepted, resource.view.selection);
    try std.testing.expect(!owner.core.mutating);
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_view_select(&owner, &view_id, &selection, &changed));
    try std.testing.expectEqual((@as(u64, 1) << 32) | 3, resource.view.packSelectionInfo());
}

test "Context shared text ABI preserves empty chunk ordinals" {
    var owner: Owner = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try ctx.Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const text_id = abi.handleToC(try owner.core.createTextBuffer(.unicode));
    const style_id = try owner.core.createSyntaxStyle();
    try owner.core.textBufferSetSyntaxStyle(abi.handleFromC(text_id), style_id);
    var chunk = std.mem.zeroes(c.ot_scene_linked_text_chunk);
    chunk.struct_size = @sizeOf(c.ot_scene_linked_text_chunk);
    chunk.abi_version = 1;
    var chunks = [_]c.ot_scene_linked_text_chunk{chunk} ** 5;
    chunks[1].byte_count = 1;
    chunks[1].flags = c.OT_SCENE_TEXT_FOREGROUND;
    chunks[1].foreground = .{ 255, 0, 0, 255 };
    chunks[3] = chunks[1];
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_set_styled_text(&owner, &text_id, "xy", 2, &chunks, chunks.len, null, 0));
    const style = try owner.core.getSyntaxStyle(style_id);
    try std.testing.expectEqual(null, style.resolveByName("chunk0"));
    try std.testing.expect(style.resolveByName("chunk1") != null);
    try std.testing.expectEqual(null, style.resolveByName("chunk2"));
    try std.testing.expect(style.resolveByName("chunk3") != null);
    try std.testing.expectEqual(null, style.resolveByName("chunk4"));
    const buffer = (try owner.core.getTextBuffer(abi.handleFromC(text_id))).buffer;
    try std.testing.expectEqual(style.resolveByName("chunk1").?, buffer.getLineHighlights(0)[0].style_id);
    try std.testing.expectEqual(c.OT_OK, ot_text_buffer_set_styled_text(&owner, &text_id, null, 0, &.{chunk}, 1, null, 0));
    try std.testing.expectEqual(@as(u32, 0), buffer.getByteSize());
}

test "Context shared text ABI selects native paint only for an exact self request" {
    var owner: Owner = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try ctx.Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const session_id = try owner.core.createSession(.{});
    try owner.core.attachSessionRenderer(session_id, 4, 1, .{ .remote_mode = .remote });
    const session = abi.handleToC(session_id);
    const root = try owner.core.sceneCreateNode(session_id, c.OT_SCENE_ROOT, 1);
    const node_id = try owner.core.sceneCreateNode(session_id, c.OT_SCENE_TEXT_VIEW, 2);
    const node = abi.handleToC(node_id);
    try owner.core.sceneMoveNode(node_id, root, 0);
    try owner.core.sceneSetStyle(node_id, 4, 0, 0, 1, 4, 1);
    try owner.core.sceneSetStyle(node_id, 4, 1, 0, 1, 1, 1);
    try owner.core.sceneSetHooks(node_id, c.OT_SCENE_HOOK_RENDER_SELF | c.OT_SCENE_HOOK_RESUME_NATIVE_TEXT, 1, 4, 1);
    const config: c.ot_scene_frame_options = .{ .struct_size = @sizeOf(c.ot_scene_frame_options), .abi_version = 1, .background = .{ 0, 0, 0, 255 }, .use_mouse = 0, .excluded_hit_num = 0, .max_layout_rounds = 8, .max_host_requests = 64, .preserve_unwritten = 0 };
    var frame = std.mem.zeroes(c.ot_scene_frame_request);
    frame.struct_size = @sizeOf(c.ot_scene_frame_request);
    frame.abi_version = 1;
    var geometry = std.mem.zeroes(c.ot_scene_frame_geometry);
    geometry.struct_size = @sizeOf(c.ot_scene_frame_geometry);
    geometry.abi_version = c.OT_CONTEXT_ABI_VERSION;
    const unlimited = std.math.maxInt(u32);
    try std.testing.expectEqual(c.OT_OK, abi.ot_scene_frame_step_with_geometry(&owner, &session, null, &config, unlimited, unlimited, &frame, &geometry));
    try std.testing.expectEqual(c.OT_SCENE_FRAME_RENDER_SELF, frame.kind);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_select_text_view_paint(&owner, &node, null, 1));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_select_text_view_paint(&owner, &node, &frame, 2));
    frame.reserved[0] = 1;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_scene_select_text_view_paint(&owner, &node, &frame, 1));
    frame.reserved[0] = 0;
    frame.abi_version = 2;
    try std.testing.expectEqual(c.OT_UNSUPPORTED_VERSION, ot_scene_select_text_view_paint(&owner, &node, &frame, 1));
    frame.abi_version = 1;
    frame.request_id += 1;
    try std.testing.expectEqual(c.OT_STALE_FRAME, ot_scene_select_text_view_paint(&owner, &node, &frame, 1));
    frame.request_id -= 1;
    try std.testing.expectEqual(c.OT_OK, ot_scene_set_text_view_paint(&owner, &node, 0));
    try std.testing.expectEqual(c.OT_OK, ot_scene_select_text_view_paint(&owner, &node, &frame, 1));
    try std.testing.expect(!(try owner.core.getRenderable(node_id)).scene_node.?.control.text_view.paint);
    try owner.core.sceneFrameCancel(session_id, frame.frame_id);
    try std.testing.expectEqual(c.OT_STALE_FRAME, ot_scene_select_text_view_paint(&owner, &node, &frame, 1));
}
