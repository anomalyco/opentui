const std = @import("std");
const c = @import("context_abi_c");
const abi = @import("context-abi.zig");
const ctx = @import("context.zig");
const eb = @import("edit-buffer.zig");
const iter = @import("text-buffer-iterators.zig");
const Owner = abi.ContextHandle;

/// Validates admission only; checked Context methods acquire their own mutation guard.
pub fn admit(context: ?*Owner, read: bool) !*Owner {
    const owner = context orelse return error.InvalidOptions;
    if (owner.owner_thread != std.Thread.getCurrentId()) return error.WrongThread;
    if (read) {
        try owner.core.checkSceneRead();
    } else {
        if (owner.core.closing) return error.ContextClosed;
        if (owner.core.mutating) return error.ContextBusy;
    }
    return owner;
}

/// Raw native operations must release the Context guard on every exit path.
pub fn beginMutation(context: ?*Owner) !*Owner {
    const owner = try admit(context, false);
    try owner.core.beginMutation();
    return owner;
}

pub fn fail(context: ?*Owner, err: anyerror) c.ot_status {
    if (err == error.WrongThread) return c.OT_WRONG_THREAD;
    return if (context) |owner| abi.sessionError(owner, err) else c.OT_INVALID_ARGUMENT;
}

pub fn record(comptime T: type, ptr: ?*const T) !*const T {
    const value = ptr orelse return error.InvalidOptions;
    if (value.struct_size != @sizeOf(T)) return error.InvalidOptions;
    if (value.abi_version != c.OT_CONTEXT_ABI_VERSION) return error.UnsupportedVersion;
    return value;
}

fn edit(owner: *Owner, id: ?*const c.ot_handle) !*ctx.Edit {
    return owner.core.getEditBuffer(abi.handleFromC((id orelse return error.InvalidOptions).*));
}

fn view(owner: *Owner, id: ?*const c.ot_handle) !*ctx.Editor {
    return owner.core.getEditorView(abi.handleFromC((id orelse return error.InvalidOptions).*));
}

pub const prepareBuffer = ctx.Context.prepareTextBuffer;

fn prepareWordLine(value: *ctx.Edit) !void {
    try prepareBuffer(value.buffer.tb);
    const rope = value.buffer.tb.rope();
    const marker = rope.getMarker(.linestart, value.buffer.getPrimaryCursor().row) orelse return;
    var index = marker.leaf_index + 1;
    while (index < rope.count()) : (index += 1) {
        const segment = rope.get(index).?;
        if (segment.isBreak() or segment.isLineStart()) break;
        if (segment.asText()) |chunk| _ = try value.buffer.tb.getLayoutInfoFor(chunk);
    }
}

pub fn rgba(color: [4]u16) !void {
    try @import("buffer.zig").validateColor(color);
}

pub fn styleRecord(ptr: ?*const c.ot_editor_style) !*const c.ot_editor_style {
    const value = try record(c.ot_editor_style, ptr);
    if (value.flags & ~@as(u32, 7) != 0) return error.InvalidOptions;
    if (value.flags & c.OT_EDITOR_STYLE_ATTRIBUTES == 0 and value.attributes != 0) return error.InvalidOptions;
    if (value.flags & c.OT_EDITOR_STYLE_FOREGROUND == 0) for (value.foreground) |v| {
        if (v != 0) return error.InvalidOptions;
    };
    if (value.flags & c.OT_EDITOR_STYLE_BACKGROUND == 0) for (value.background) |v| {
        if (v != 0) return error.InvalidOptions;
    };
    return value;
}

pub fn ot_edit_buffer_set_tab_width(context: ?*Owner, id: ?*const c.ot_handle, width: u32) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null or width > 255) return fail(owner, error.InvalidOptions);
    owner.core.editBufferSetTabWidth(abi.handleFromC(id.?.*), @intCast(width)) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn ot_edit_buffer_command(context: ?*Owner, id: ?*const c.ot_handle, command: u32, argument: u32) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null or command > c.OT_EDIT_DEBUG_ROPE or
        (command != c.OT_EDIT_GOTO_LINE and command != c.OT_EDIT_CURSOR_OFFSET and argument != 0)) return fail(owner, error.InvalidOptions);
    const operation: ctx.EditCommand = switch (command) {
        c.OT_EDIT_DELETE_FORWARD => .delete_forward,
        c.OT_EDIT_BACKSPACE => .backspace,
        c.OT_EDIT_NEW_LINE => .new_line,
        c.OT_EDIT_DELETE_LINE => .delete_line,
        c.OT_EDIT_MOVE_LEFT => .move_left,
        c.OT_EDIT_MOVE_RIGHT => .move_right,
        c.OT_EDIT_MOVE_UP => .move_up,
        c.OT_EDIT_MOVE_DOWN => .move_down,
        c.OT_EDIT_GOTO_LINE => .{ .goto_line = argument },
        c.OT_EDIT_CURSOR_OFFSET => .{ .cursor_offset = argument },
        c.OT_EDIT_CLEAR => .clear,
        c.OT_EDIT_CLEAR_HISTORY => .clear_history,
        c.OT_EDIT_DEBUG_ROPE => .debug_rope,
        else => unreachable,
    };
    owner.core.editCommand(abi.handleFromC(id.?.*), operation) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn ot_edit_buffer_history(context: ?*Owner, id: ?*const c.ot_handle, redo: u32, bytes: ?[*]u8, capacity: u32, out: ?*u32) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null or redo > 1 or bytes == null or capacity < 64 or out == null) return fail(owner, error.InvalidOptions);
    const meta = owner.core.editHistory(abi.handleFromC(id.?.*), redo == 1) catch |err| return fail(owner, err);
    std.debug.assert(meta.len <= 64);
    @memcpy(bytes.?[0..meta.len], meta);
    out.?.* = @intCast(meta.len);
    return c.OT_OK;
}

pub fn ot_edit_buffer_get_position(context: ?*Owner, id: ?*const c.ot_handle, query: u32, a: u32, b: u32, out: ?*c.ot_edit_position) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    _ = record(c.ot_edit_position, out) catch |err| return fail(owner, err);
    if (query > c.OT_EDIT_POSITION_LINE_START or (query < c.OT_EDIT_POSITION_OFFSET and a != 0) or
        (query != c.OT_EDIT_POSITION_COORDS and b != 0)) return fail(owner, error.InvalidOptions);
    const value = edit(owner, id) catch |err| return fail(owner, err);
    prepareBuffer(value.buffer.tb) catch |err| return fail(owner, err);
    const rope = value.buffer.tb.rope();
    if (query == c.OT_EDIT_POSITION_NEXT_WORD or query == c.OT_EDIT_POSITION_PREV_WORD)
        prepareWordLine(value) catch |err| return fail(owner, err);
    const cursor: ?eb.Cursor = switch (query) {
        c.OT_EDIT_POSITION_CURSOR => value.buffer.getPrimaryCursor(),
        c.OT_EDIT_POSITION_NEXT_WORD => value.buffer.getNextWordBoundary(),
        c.OT_EDIT_POSITION_PREV_WORD => value.buffer.getPrevWordBoundary(),
        c.OT_EDIT_POSITION_EOL => value.buffer.getEOL(),
        c.OT_EDIT_POSITION_OFFSET => if (iter.offsetToCoords(rope, a)) |pos| .{ .row = pos.row, .col = pos.col, .offset = a } else null,
        c.OT_EDIT_POSITION_COORDS, c.OT_EDIT_POSITION_LINE_START => if (iter.coordsToOffset(rope, a, b)) |offset| .{ .row = a, .col = b, .offset = offset } else null,
        else => unreachable,
    };
    out.?.* = .{ .struct_size = @sizeOf(c.ot_edit_position), .abi_version = c.OT_CONTEXT_ABI_VERSION, .valid = @intFromBool(cursor != null), .row = if (cursor) |v| v.row else 0, .col = if (cursor) |v| v.col else 0, .offset = if (cursor) |v| v.offset else 0 };
    return c.OT_OK;
}

pub fn ot_edit_buffer_get_range(context: ?*Owner, id: ?*const c.ot_handle, by_coords: u32, start_row: u32, start_col: u32, end_row: u32, end_col: u32, bytes: ?[*]u8, capacity: u32, out: ?*u32) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    if (out == null or by_coords > 1 or (capacity != 0 and bytes == null) or
        (by_coords == 0 and (start_row != 0 or end_row != 0))) return fail(owner, error.InvalidOptions);
    const value = edit(owner, id) catch |err| return fail(owner, err);
    const bound = value.buffer.tb.getByteSize();
    if (capacity != 0 and capacity < bound) return fail(owner, error.BufferTooSmall);
    if (capacity == 0) {
        out.?.* = bound;
        return c.OT_OK;
    }
    prepareBuffer(value.buffer.tb) catch |err| return fail(owner, err);
    out.?.* = @intCast(if (by_coords == 1)
        value.buffer.getTextRangeByCoords(start_row, start_col, end_row, end_col, bytes.?[0..capacity])
    else
        value.buffer.getTextRange(start_col, end_col, bytes.?[0..capacity]) catch |err| return fail(owner, err));
    return c.OT_OK;
}

pub fn ot_edit_buffer_set_defaults(context: ?*Owner, id: ?*const c.ot_handle, mask: u32, options: ?*const c.ot_editor_style) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null) return fail(owner, error.InvalidOptions);
    const defaults = defaultsFromC(mask, options) catch |err| return fail(owner, err);
    owner.core.editSetDefaults(abi.handleFromC(id.?.*), defaults) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn ot_syntax_style_register(context: ?*Owner, id: ?*const c.ot_handle, bytes: ?[*]const u8, count: u32, options: ?*const c.ot_editor_style, out: ?*u32) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    const style = styleRecord(options) catch |err| return fail(owner, err);
    if (id == null or (count != 0 and bytes == null) or out == null) return fail(owner, error.InvalidOptions);
    const name = if (bytes) |p| p[0..count] else &.{};
    out.?.* = owner.core.syntaxStyleRegister(abi.handleFromC(id.?.*), name, .{
        .fg = if (style.flags & 1 != 0) style.foreground else null,
        .bg = if (style.flags & 2 != 0) style.background else null,
        .attributes = style.attributes,
    }) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn ot_editor_view_set_viewport(context: ?*Owner, id: ?*const c.ot_handle, options: ?*const c.ot_editor_viewport, size_only: u32, move_cursor: u32) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    const vp = record(c.ot_editor_viewport, options) catch |err| return fail(owner, err);
    if (id == null or size_only > 1 or move_cursor > 1 or (size_only == 1 and (vp.x != 0 or vp.y != 0 or move_cursor != 0))) return fail(owner, error.InvalidOptions);
    owner.core.editorSetViewport(abi.handleFromC(id.?.*), .{ .x = vp.x, .y = vp.y, .width = vp.width, .height = vp.height }, size_only == 1, move_cursor == 1) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn ot_editor_view_get_viewport(context: ?*Owner, id: ?*const c.ot_handle, out: ?*c.ot_editor_viewport) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    _ = record(c.ot_editor_viewport, out) catch |err| return fail(owner, err);
    const value = view(owner, id) catch |err| return fail(owner, err);
    const vp = value.view.getViewport() orelse return fail(owner, error.InvalidOptions);
    out.?.* = .{ .struct_size = @sizeOf(c.ot_editor_viewport), .abi_version = c.OT_CONTEXT_ABI_VERSION, .x = vp.x, .y = vp.y, .width = vp.width, .height = vp.height };
    return c.OT_OK;
}

pub fn ot_editor_view_set_scroll_margin(context: ?*Owner, id: ?*const c.ot_handle, margin: f32) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null) return fail(owner, error.InvalidOptions);
    owner.core.editorSetScrollMargin(abi.handleFromC(id.?.*), margin) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn ot_editor_view_command(context: ?*Owner, id: ?*const c.ot_handle, command: u32, argument: u32) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null or command > c.OT_EDITOR_TAB_INDICATOR or (command < c.OT_EDITOR_CURSOR_OFFSET and argument != 0) or
        (command == c.OT_EDITOR_WRAP_MODE and argument > 2)) return fail(owner, error.InvalidOptions);
    const operation: ctx.EditorCommand = switch (command) {
        c.OT_EDITOR_MOVE_UP => .move_up,
        c.OT_EDITOR_MOVE_DOWN => .move_down,
        c.OT_EDITOR_GOTO_LINE_END => .goto_line_end,
        c.OT_EDITOR_DELETE_SELECTION => .delete_selection,
        c.OT_EDITOR_CURSOR_OFFSET => .{ .cursor_offset = argument },
        c.OT_EDITOR_WRAP_MODE => .{ .wrap_mode = @enumFromInt(argument) },
        c.OT_EDITOR_TAB_INDICATOR => .{ .tab_indicator = if (argument == 0) null else argument },
        else => unreachable,
    };
    owner.core.editorCommand(abi.handleFromC(id.?.*), operation) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn ot_editor_view_set_tab_color(context: ?*Owner, id: ?*const c.ot_handle, color: ?*const [4]u16) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null) return fail(owner, error.InvalidOptions);
    owner.core.editorSetTabColor(abi.handleFromC(id.?.*), if (color) |v| v.* else null) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn ot_editor_view_select(context: ?*Owner, id: ?*const c.ot_handle, options: ?*const c.ot_editor_selection, out: ?*u32) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null or out == null) return fail(owner, error.InvalidOptions);
    const selection = selectionFromC(options, true) catch |err| return fail(owner, err);
    out.?.* = @intFromBool(owner.core.editorSelect(abi.handleFromC(id.?.*), selection) catch |err| return fail(owner, err));
    return c.OT_OK;
}

pub fn selectionFromC(options: ?*const c.ot_editor_selection, is_editor: bool) !ctx.TextSelection {
    const s = try record(c.ot_editor_selection, options);
    const local = s.operation == c.OT_EDITOR_SELECT_LOCAL or s.operation == c.OT_EDITOR_SELECT_LOCAL_UPDATE;
    const offsets = s.operation == c.OT_EDITOR_SELECT_SET or s.operation == c.OT_EDITOR_SELECT_INCLUSIVE;
    const colors = local or offsets or s.operation == c.OT_EDITOR_SELECT_UPDATE or s.operation == c.OT_EDITOR_SELECT_COLORS;
    if (s.reserved != 0 or s.operation > c.OT_EDITOR_SELECT_COLORS or s.flags & ~@as(u32, 3) != 0 or
        s.update_cursor > 1 or s.follow_cursor > 1 or
        (!is_editor and (s.update_cursor != 0 or s.follow_cursor != 0)) or
        (!local and (s.anchor_x != 0 or s.anchor_y != 0 or s.focus_x != 0 or s.focus_y != 0 or s.update_cursor != 0 or s.follow_cursor != 0)) or
        (!offsets and s.start != 0) or (!offsets and s.operation != c.OT_EDITOR_SELECT_UPDATE and s.end != 0) or
        (!colors and s.flags != 0) or (local and s.behavior > 2) or
        (s.operation == c.OT_EDITOR_SELECT_OCCUPANCY and s.behavior > 1) or
        (!local and s.operation != c.OT_EDITOR_SELECT_OCCUPANCY and s.behavior != 0)) return error.InvalidOptions;
    if (s.flags & 1 == 0) for (s.foreground) |v| {
        if (v != 0) return error.InvalidOptions;
    };
    if (s.flags & 2 == 0) for (s.background) |v| {
        if (v != 0) return error.InvalidOptions;
    };
    return .{
        .operation = @enumFromInt(s.operation),
        .start = s.start,
        .end = s.end,
        .anchor_x = s.anchor_x,
        .anchor_y = s.anchor_y,
        .focus_x = s.focus_x,
        .focus_y = s.focus_y,
        .foreground = if (s.flags & 1 != 0) s.foreground else null,
        .background = if (s.flags & 2 != 0) s.background else null,
        .behavior = if (local) @enumFromInt(s.behavior) else .cell,
        .occupancy = if (s.operation == c.OT_EDITOR_SELECT_OCCUPANCY) @enumFromInt(s.behavior) else .cell,
        .update_cursor = s.update_cursor == 1,
        .follow_cursor = s.follow_cursor == 1,
    };
}

pub fn ot_editor_view_get_info(context: ?*Owner, id: ?*const c.ot_handle, follow_cursor: u32, out: ?*c.ot_editor_view_info) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    _ = record(c.ot_editor_view_info, out) catch |err| return fail(owner, err);
    if (id == null or follow_cursor > 1) return fail(owner, error.InvalidOptions);
    const value = owner.core.editorPrepareView(abi.handleFromC(id.?.*), follow_cursor == 1) catch |err| return fail(owner, err);
    out.?.* = selectionInfo(value);
    out.?.virtual_line_count = @intCast(value.view.text_buffer_view.getVirtualLines().len);
    out.?.total_virtual_line_count = value.view.getTotalVirtualLineCount();
    return c.OT_OK;
}

pub fn ot_editor_view_get_selection(context: ?*Owner, id: ?*const c.ot_handle, out: ?*c.ot_editor_view_info) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    _ = record(c.ot_editor_view_info, out) catch |err| return fail(owner, err);
    const value = view(owner, id) catch |err| return fail(owner, err);
    out.?.* = selectionInfo(value);
    return c.OT_OK;
}

fn selectionInfo(value: *const ctx.Editor) c.ot_editor_view_info {
    const selection = value.view.packSelectionInfo();
    const present = selection != std.math.maxInt(u64);
    return .{ .struct_size = @sizeOf(c.ot_editor_view_info), .abi_version = c.OT_CONTEXT_ABI_VERSION, .virtual_line_count = 0, .total_virtual_line_count = 0, .selection_present = @intFromBool(present), .selection_start = if (present) @intCast(selection >> 32) else 0, .selection_end = if (present) @truncate(selection) else 0, .selection_occupancy = @intFromEnum(value.view.getSelectionOccupancy()) };
}

pub fn ot_editor_view_get_selected_text(context: ?*Owner, id: ?*const c.ot_handle, bytes: ?[*]u8, capacity: u32, out: ?*u32) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    if (out == null or (capacity != 0 and bytes == null)) return fail(owner, error.InvalidOptions);
    const value = view(owner, id) catch |err| return fail(owner, err);
    const bound = if (value.view.packSelectionInfo() == std.math.maxInt(u64)) 0 else value.view.text_buffer_view.text_buffer.getByteSize();
    if (capacity != 0 and capacity < bound) return fail(owner, error.BufferTooSmall);
    if (capacity == 0 or bound == 0) {
        out.?.* = bound;
        return c.OT_OK;
    }
    out.?.* = @intCast(value.view.getSelectedTextIntoBuffer(bytes.?[0..capacity]));
    return c.OT_OK;
}

test "Context editor selection query avoids preparation and preserves checked reset results" {
    const core = try ctx.Context.init(std.testing.allocator, std.testing.io, .{});
    defer core.deinit() catch unreachable;
    var owner: Owner = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = core, .owner_thread = std.Thread.getCurrentId() };
    const buffer = try core.createEditBuffer(.unicode);
    const id = try core.createEditorView(buffer, 4, 2);
    const handle = abi.handleToC(id);
    try core.editSetText(buffer, "a\xe4\xb8\xadb\nc", false);
    _ = try core.editorSelect(id, .{ .operation = .set, .start = 1, .end = 3 });
    _ = try core.editorSelect(id, .{ .operation = .occupancy, .occupancy = .boundary });
    const editor = try core.getEditorView(id);
    const viewport = editor.view.getViewport();
    const arena = editor.view.text_buffer_view.virtual_lines_arena;
    _ = arena.reset(.free_all);
    editor.view.text_buffer_view.virtual_lines_dirty = true;
    const allocator = arena.child_allocator;
    var failing = std.testing.FailingAllocator.init(allocator, .{ .fail_index = 0 });
    arena.child_allocator = failing.allocator();
    defer arena.child_allocator = allocator;

    var info = std.mem.zeroes(c.ot_editor_view_info);
    info.struct_size = @sizeOf(c.ot_editor_view_info);
    info.abi_version = c.OT_CONTEXT_ABI_VERSION;
    try std.testing.expectEqual(c.OT_OK, ot_editor_view_get_selection(&owner, &handle, &info));
    try std.testing.expectEqual(@as(u32, 1), info.selection_present);
    try std.testing.expectEqual(@as(u32, 1), info.selection_start);
    try std.testing.expectEqual(@as(u32, 3), info.selection_end);
    try std.testing.expectEqual(@as(u32, 1), info.selection_occupancy);
    try std.testing.expectEqual(@as(u32, 0), info.virtual_line_count);
    try std.testing.expectEqual(@as(u32, 0), info.total_virtual_line_count);
    try std.testing.expect(!failing.has_induced_failure);
    try std.testing.expect(editor.view.text_buffer_view.virtual_lines_dirty);
    try std.testing.expectEqualDeep(viewport, editor.view.getViewport());

    var text: [7]u8 = undefined;
    var count: u32 = 0;
    try std.testing.expectEqual(c.OT_OK, ot_editor_view_get_selected_text(&owner, &handle, &text, text.len, &count));
    try std.testing.expectEqualStrings("\xe4\xb8\xad", text[0..count]);

    const saved = info;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_editor_view_get_selection(&owner, null, &info));
    try std.testing.expectEqualDeep(saved, info);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_editor_view_get_selection(&owner, &handle, null));
    core.mutating = true;
    const busy = ot_editor_view_get_selection(&owner, &handle, &info);
    core.scene_measuring = true;
    const observational = ot_editor_view_get_selection(&owner, &handle, &info);
    core.scene_measuring = false;
    core.mutating = false;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, busy);
    try std.testing.expectEqual(c.OT_OK, observational);
    try std.testing.expectEqualDeep(saved, info);

    var selection = std.mem.zeroes(c.ot_editor_selection);
    selection.struct_size = @sizeOf(c.ot_editor_selection);
    selection.abi_version = c.OT_CONTEXT_ABI_VERSION;
    selection.operation = c.OT_EDITOR_SELECT_LOCAL_RESET;
    var changed: u32 = 99;
    try std.testing.expectEqual(c.OT_OK, ot_editor_view_select(&owner, &handle, &selection, &changed));
    try std.testing.expectEqual(@as(u32, 0), changed);
    try std.testing.expectEqual(c.OT_OK, ot_editor_view_get_selection(&owner, &handle, &info));
    try std.testing.expectEqual(@as(u32, 0), info.selection_present);
    try std.testing.expectEqual(@as(u32, 0), info.selection_start);
    try std.testing.expectEqual(@as(u32, 0), info.selection_end);
    try std.testing.expect(!failing.has_induced_failure);
    try std.testing.expectEqual(c.OT_OUT_OF_MEMORY, ot_editor_view_get_info(&owner, &handle, 0, &info));
    arena.child_allocator = allocator;
    try std.testing.expectEqual(c.OT_OK, ot_editor_view_get_info(&owner, &handle, 0, &info));
    try std.testing.expectEqual(@as(u32, 2), info.total_virtual_line_count);
}

pub fn ot_editor_view_get_position(context: ?*Owner, id: ?*const c.ot_handle, query: u32, out: ?*c.ot_editor_position) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    _ = record(c.ot_editor_position, out) catch |err| return fail(owner, err);
    if (query > c.OT_EDITOR_POSITION_VISUAL_EOL) return fail(owner, error.InvalidOptions);
    const value = view(owner, id) catch |err| return fail(owner, err);
    value.prepareView() catch |err| return fail(owner, err);
    if (query == c.OT_EDITOR_POSITION_NEXT_WORD or query == c.OT_EDITOR_POSITION_PREV_WORD)
        prepareWordLine(value.edit) catch |err| return fail(owner, err);
    const cursor = switch (query) {
        c.OT_EDITOR_POSITION_CURSOR => value.view.getVisualCursor(),
        c.OT_EDITOR_POSITION_NEXT_WORD => value.view.getNextWordBoundary(),
        c.OT_EDITOR_POSITION_PREV_WORD => value.view.getPrevWordBoundary(),
        c.OT_EDITOR_POSITION_EOL => value.view.getEOL(),
        c.OT_EDITOR_POSITION_VISUAL_SOL => value.view.getVisualSOL(),
        c.OT_EDITOR_POSITION_VISUAL_EOL => value.view.getVisualEOL(),
        else => unreachable,
    };
    out.?.* = .{ .struct_size = @sizeOf(c.ot_editor_position), .abi_version = c.OT_CONTEXT_ABI_VERSION, .visual_row = cursor.visual_row, .visual_col = cursor.visual_col, .logical_row = cursor.logical_row, .logical_col = cursor.logical_col, .offset = cursor.offset };
    return c.OT_OK;
}

pub fn ot_editor_view_get_lines(context: ?*Owner, id: ?*const c.ot_handle, logical: u32, lines: ?[*]c.ot_scene_text_line, capacity: u32, out: ?*c.ot_editor_measure) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    _ = record(c.ot_editor_measure, out) catch |err| return fail(owner, err);
    if (logical > 1 or (capacity != 0 and lines == null)) return fail(owner, error.InvalidOptions);
    const value = view(owner, id) catch |err| return fail(owner, err);
    value.prepareView() catch |err| return fail(owner, err);
    const info = if (logical == 1) value.view.getLogicalLineInfo() else value.view.getCachedLineInfo();
    if (value.view.text_buffer_view.virtual_lines_dirty) return fail(owner, error.OutOfMemory);
    const count = info.line_start_cols.len;
    if (capacity != 0 and capacity < count) return fail(owner, error.BufferTooSmall);
    if (capacity != 0) for (0..count) |index| {
        lines.?[index] = .{ .start_cols = info.line_start_cols[index], .width_cols = info.line_width_cols[index], .source_line = info.line_sources[index], .wrap_index = info.line_wraps[index] };
    };
    out.?.* = .{ .struct_size = @sizeOf(c.ot_editor_measure), .abi_version = c.OT_CONTEXT_ABI_VERSION, .line_count = @intCast(count), .width_cols_max = info.line_width_cols_max };
    return c.OT_OK;
}

pub fn ot_editor_view_measure(context: ?*Owner, id: ?*const c.ot_handle, width: u32, height: u32, out: ?*c.ot_editor_measure) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    _ = record(c.ot_editor_measure, out) catch |err| return fail(owner, err);
    if (width > std.math.maxInt(i32) or height > std.math.maxInt(i32)) return fail(owner, error.InvalidOptions);
    const value = view(owner, id) catch |err| return fail(owner, err);
    prepareBuffer(value.view.text_buffer_view.text_buffer) catch |err| return fail(owner, err);
    const measured = value.view.text_buffer_view.measureForDimensions(width, height) catch |err| return fail(owner, err);
    out.?.* = .{ .struct_size = @sizeOf(c.ot_editor_measure), .abi_version = c.OT_CONTEXT_ABI_VERSION, .line_count = measured.line_count, .width_cols_max = measured.width_cols_max };
    return c.OT_OK;
}

pub fn ot_editor_view_set_placeholder(context: ?*Owner, id: ?*const c.ot_handle, bytes_ptr: ?[*]const u8, byte_count: u32, chunks_ptr: ?[*]const c.ot_scene_text_chunk, chunk_count: u32) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null or (byte_count != 0 and bytes_ptr == null) or (chunk_count != 0 and chunks_ptr == null) or chunk_count > byte_count) return fail(owner, error.InvalidOptions);
    const bytes = if (bytes_ptr) |p| p[0..byte_count] else &.{};
    const chunks = if (chunks_ptr) |p| p[0..chunk_count] else &.{};
    for (chunks) |*chunk| {
        _ = record(c.ot_scene_text_chunk, chunk) catch |err| return fail(owner, err);
        if (chunk.reserved != 0 or chunk.flags & ~@as(u32, 3) != 0) return fail(owner, error.InvalidOptions);
        rgba(chunk.foreground) catch |err| return fail(owner, err);
        rgba(chunk.background) catch |err| return fail(owner, err);
    }
    const decoded = owner.core.allocator.alloc(ctx.StyledTextChunk, chunks.len) catch |err| return fail(owner, err);
    defer owner.core.allocator.free(decoded);
    for (chunks, decoded) |chunk, *target| {
        target.* = .{
            .byte_count = chunk.byte_count,
            .foreground = if (chunk.flags & 1 != 0) chunk.foreground else null,
            .background = if (chunk.flags & 2 != 0) chunk.background else null,
            .attributes = chunk.attributes,
        };
    }
    owner.core.editorSetPlaceholder(abi.handleFromC(id.?.*), bytes, decoded) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn ot_edit_buffer_highlight(context: ?*Owner, id: ?*const c.ot_handle, operation: u32, argument: u32, highlight: ?*const c.ot_edit_highlight) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null) return fail(owner, error.InvalidOptions);
    const decoded = highlightFromC(operation, argument, highlight) catch |err| return fail(owner, err);
    owner.core.editHighlight(abi.handleFromC(id.?.*), decoded) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn highlightFromC(operation: u32, argument: u32, highlight: ?*const c.ot_edit_highlight) !ctx.TextHighlight {
    if (operation > c.OT_EDIT_HIGHLIGHT_CLEAR_ALL or
        ((operation == c.OT_EDIT_HIGHLIGHT_ADD_RANGE or operation == c.OT_EDIT_HIGHLIGHT_CLEAR_ALL) and argument != 0) or
        ((operation <= c.OT_EDIT_HIGHLIGHT_ADD_RANGE) != (highlight != null)) or
        (operation == c.OT_EDIT_HIGHLIGHT_REMOVE_REF and argument > 65535)) return error.InvalidOptions;
    if (highlight) |h| if (h.priority > 255 or h.ref > 65535) return error.InvalidOptions;
    const range: ctx.TextHighlight.Range = if (highlight) |h| .{
        .start = h.start,
        .end = h.end,
        .style_id = h.style_id,
        .priority = @intCast(h.priority),
        .ref = @intCast(h.ref),
    } else undefined;
    return switch (operation) {
        c.OT_EDIT_HIGHLIGHT_ADD_LINE => .{ .add_line = .{ .line = argument, .range = range } },
        c.OT_EDIT_HIGHLIGHT_ADD_RANGE => .{ .add_range = range },
        c.OT_EDIT_HIGHLIGHT_REMOVE_REF => .{ .remove_ref = @intCast(argument) },
        c.OT_EDIT_HIGHLIGHT_CLEAR_LINE => .{ .clear_line = argument },
        c.OT_EDIT_HIGHLIGHT_CLEAR_ALL => .clear_all,
        else => unreachable,
    };
}

pub fn ot_edit_buffer_get_highlights(context: ?*Owner, id: ?*const c.ot_handle, line: u32, highlights: ?[*]c.ot_edit_highlight, capacity: u32, out: ?*u32) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    if (out == null or (capacity != 0 and highlights == null)) return fail(owner, error.InvalidOptions);
    const value = edit(owner, id) catch |err| return fail(owner, err);
    const items = value.buffer.tb.getLineHighlights(line);
    if (items.len > std.math.maxInt(u32)) return fail(owner, error.TextLimit);
    if (capacity != 0 and capacity < items.len) return fail(owner, error.BufferTooSmall);
    if (capacity != 0) for (items, 0..) |h, index| {
        highlights.?[index] = .{ .start = h.col_start, .end = h.col_end, .style_id = h.style_id, .priority = h.priority, .ref = h.hl_ref };
    };
    out.?.* = @intCast(items.len);
    return c.OT_OK;
}

pub fn ot_syntax_style_resolve(context: ?*Owner, id: ?*const c.ot_handle, bytes: ?[*]const u8, count: u32, out: ?*u32) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    if (id == null or out == null or (count != 0 and bytes == null)) return fail(owner, error.InvalidOptions);
    const value = owner.core.getSyntaxStyle(abi.handleFromC(id.?.*)) catch |err| return fail(owner, err);
    out.?.* = value.resolveByName(if (bytes) |p| p[0..count] else &.{}) orelse 0;
    return c.OT_OK;
}

pub fn ot_syntax_style_get_count(context: ?*Owner, id: ?*const c.ot_handle, out: ?*u32) callconv(.c) c.ot_status {
    const owner = admit(context, true) catch |err| return fail(context, err);
    if (id == null or out == null) return fail(owner, error.InvalidOptions);
    const value = owner.core.getSyntaxStyle(abi.handleFromC(id.?.*)) catch |err| return fail(owner, err);
    out.?.* = @intCast(value.getStyleCount());
    return c.OT_OK;
}

pub fn ot_editor_view_replace_selection(context: ?*Owner, id: ?*const c.ot_handle, bytes_ptr: ?[*]const u8, byte_count: u32, out_steps: ?*u32) callconv(.c) c.ot_status {
    const owner = admit(context, false) catch |err| return fail(context, err);
    if (id == null or out_steps == null or (byte_count != 0 and bytes_ptr == null)) return fail(owner, error.InvalidOptions);
    const bytes = if (bytes_ptr) |p| p[0..byte_count] else &.{};
    out_steps.?.* = owner.core.editorReplaceSelection(abi.handleFromC(id.?.*), bytes) catch |err| return fail(owner, err);
    return c.OT_OK;
}

pub fn defaultsFromC(mask: u32, options: ?*const c.ot_editor_style) !ctx.TextDefaults {
    const style = try styleRecord(options);
    if (mask == 0 or mask & ~@as(u32, 7) != 0 or style.flags & ~mask != 0) return error.InvalidOptions;
    return .{
        .fields = @bitCast(@as(u3, @intCast(mask))),
        .foreground = if (style.flags & 1 != 0) style.foreground else null,
        .background = if (style.flags & 2 != 0) style.background else null,
        .attributes = if (style.flags & 4 != 0) style.attributes else null,
    };
}

test "Context checked history matches ABI metadata cursor and observer order" {
    const Probe = struct {
        core: *ctx.Context,
        events: [4]ctx.EditEvent = undefined,
        count: usize = 0,
        rejection: ?anyerror = null,

        fn receive(data: ?*anyopaque, handle: ctx.Handle, event: ctx.EditEvent) void {
            const self: *@This() = @ptrCast(@alignCast(data.?));
            self.events[self.count] = event;
            self.count += 1;
            self.core.editCommand(handle, .move_left) catch |err| {
                self.rejection = err;
            };
        }
    };
    var owner: Owner = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try ctx.Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const direct = try owner.core.createEditBuffer(.unicode);
    const checked = try owner.core.createEditBuffer(.unicode);
    for ([_]ctx.Handle{ direct, checked }) |handle| {
        _ = try owner.core.createEditorView(handle, 4, 2);
        _ = try owner.core.createEditorView(handle, 2, 1);
        try owner.core.editSetText(handle, "ab", false);
        try owner.core.editSetCursor(handle, 0, 1);
        try owner.core.editInsertText(handle, "X");
    }
    var probe: Probe = .{ .core = owner.core };
    try owner.core.setEditEventCallback(Probe.receive, &probe);
    const id = abi.handleToC(checked);
    for ([_]bool{ false, true, false, false, true, true }) |redo| {
        probe.count = 0;
        const meta = try owner.core.editHistory(direct, redo);
        const events = probe.events;
        const count = probe.count;
        probe.count = 0;
        var bytes: [64]u8 = @splat(0xaa);
        var written: u32 = 99;
        try std.testing.expectEqual(c.OT_OK, ot_edit_buffer_history(&owner, &id, @intFromBool(redo), &bytes, bytes.len, &written));
        try std.testing.expectEqualSlices(u8, meta, bytes[0..written]);
        try std.testing.expectEqualSlices(ctx.EditEvent, events[0..count], probe.events[0..probe.count]);
        if (meta.len == 0) {
            try std.testing.expectEqual(@as(usize, 0), count);
            try std.testing.expectEqual(@as(u8, 0xaa), bytes[0]);
        } else {
            try std.testing.expectEqualSlices(ctx.EditEvent, &.{ .cursor_changed, .history_cursor_changed }, events[0..count]);
            try std.testing.expectEqual(error.ContextBusy, probe.rejection.?);
        }
        const first = (try owner.core.getEditBuffer(direct)).buffer;
        const second = (try owner.core.getEditBuffer(checked)).buffer;
        var first_text: [3]u8 = undefined;
        var second_text: [3]u8 = undefined;
        try std.testing.expectEqualStrings(first_text[0..first.getText(&first_text)], second_text[0..second.getText(&second_text)]);
        try std.testing.expectEqualDeep(first.getPrimaryCursor(), second.getPrimaryCursor());
    }
}

test "Context editor accepted deletion does not return a later layout allocation failure" {
    var owner: Owner = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
    defer owner.io_threaded.deinit();
    owner.core = try ctx.Context.init(std.testing.allocator, owner.io_threaded.io(), .{});
    defer owner.core.deinit() catch unreachable;
    const edit_id = try owner.core.createEditBuffer(.unicode);
    try owner.core.editSetText(edit_id, "abcdef", false);
    const view_id = try owner.core.createEditorView(edit_id, 4, 2);
    const editor = try owner.core.getEditorView(view_id);
    editor.view.setWrapMode(.char);
    editor.view.setSelection(0, 3, null, null);
    try editor.prepareView();
    const handle: c.ot_handle = .{ .context_id = view_id.context_id, .slot = view_id.slot, .generation = view_id.generation };
    const arena = editor.view.text_buffer_view.virtual_lines_arena;
    const allocator = arena.child_allocator;
    var failing = std.testing.FailingAllocator.init(allocator, .{ .fail_index = 0 });
    arena.child_allocator = failing.allocator();
    defer arena.child_allocator = allocator;
    const status = ot_editor_view_command(&owner, &handle, c.OT_EDITOR_DELETE_SELECTION, 0);
    var text: [16]u8 = undefined;
    const actual = text[0..editor.edit.buffer.getText(&text)];
    if (status == c.OT_OK) {
        try std.testing.expectEqualStrings("def", actual);
    } else {
        try std.testing.expectEqualStrings("abcdef", actual);
    }
    try std.testing.expect(failing.has_induced_failure);
}

test "Context editor transport allocation failures are reported and owned placeholders release" {
    for (0..3) |operation| {
        var completed = false;
        for (0..128) |failure_offset| {
            var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
            var owner: Owner = .{ .gpa = .init, .io_threaded = .init_single_threaded, .core = undefined, .owner_thread = std.Thread.getCurrentId() };
            defer owner.io_threaded.deinit();
            owner.core = try ctx.Context.init(failing.allocator(), owner.io_threaded.io(), .{});
            defer owner.core.deinit() catch unreachable;
            const edit_id = try owner.core.createEditBuffer(.unicode);
            try owner.core.editSetText(edit_id, "abcd\nxy", false);
            const view_id = try owner.core.createEditorView(edit_id, 4, 2);
            const style_id = try owner.core.createSyntaxStyle();
            const edit_handle: c.ot_handle = .{ .context_id = edit_id.context_id, .slot = edit_id.slot, .generation = edit_id.generation };
            const view_handle: c.ot_handle = .{ .context_id = view_id.context_id, .slot = view_id.slot, .generation = view_id.generation };
            const style_handle: c.ot_handle = .{ .context_id = style_id.context_id, .slot = style_id.slot, .generation = style_id.generation };
            const style: c.ot_editor_style = .{ .struct_size = @sizeOf(c.ot_editor_style), .abi_version = c.OT_CONTEXT_ABI_VERSION, .flags = 1, .attributes = 0, .foreground = .{ 1, 2, 3, 255 }, .background = .{ 0, 0, 0, 0 } };
            const chunk: c.ot_scene_text_chunk = .{ .struct_size = @sizeOf(c.ot_scene_text_chunk), .abi_version = c.OT_CONTEXT_ABI_VERSION, .byte_count = 4, .flags = 1, .foreground = .{ 1, 2, 3, 255 }, .background = .{ 0, 0, 0, 0 }, .attributes = 0, .reserved = 0 };
            const highlight: c.ot_edit_highlight = .{ .start = 0, .end = 6, .style_id = 1, .priority = 0, .ref = 1 };
            var output: u32 = 99;
            var placeholder = "hint".*;
            failing.fail_index = failing.alloc_index + failure_offset;
            failing.resize_fail_index = failing.resize_index;
            const status = switch (operation) {
                0 => ot_syntax_style_register(&owner, &style_handle, "test", 4, &style, &output),
                1 => ot_editor_view_set_placeholder(&owner, &view_handle, &placeholder, 4, @ptrCast(&chunk), 1),
                2 => ot_edit_buffer_highlight(&owner, &edit_handle, c.OT_EDIT_HIGHLIGHT_ADD_RANGE, 0, &highlight),
                else => unreachable,
            };
            failing.fail_index = std.math.maxInt(usize);
            failing.resize_fail_index = std.math.maxInt(usize);
            try std.testing.expect(!owner.core.mutating);
            if (failing.has_induced_failure) {
                try std.testing.expectEqual(c.OT_OUT_OF_MEMORY, status);
                if (operation == 0) {
                    try std.testing.expectEqual(99, output);
                    try std.testing.expectEqual(0, (try owner.core.getSyntaxStyle(style_id)).getStyleCount());
                }
                if (operation == 1) try std.testing.expect((try owner.core.getEditorView(view_id)).view.placeholder_buffer == null);
                if (operation == 2) try std.testing.expectEqual(@as(u32, 0), (try owner.core.getEditBuffer(edit_id)).buffer.tb.getHighlightCount());
            } else {
                try std.testing.expectEqual(c.OT_OK, status);
                if (operation == 1) {
                    @memset(&placeholder, 'x');
                    try owner.core.editSetText(edit_id, "", false);
                    const editor = try owner.core.getEditorView(view_id);
                    try std.testing.expect(editor.view.placeholder_active);
                    var bytes: [4]u8 = undefined;
                    _ = editor.view.placeholder_buffer.?.getPlainTextIntoBuffer(&bytes);
                    try std.testing.expectEqualStrings("hint", &bytes);
                    try std.testing.expectEqual(c.OT_OK, ot_editor_view_set_placeholder(&owner, &view_handle, null, 0, null, 0));
                    try std.testing.expect(editor.view.placeholder_buffer == null);
                }
                completed = true;
                break;
            }
        }
        try std.testing.expect(completed);
    }
}
