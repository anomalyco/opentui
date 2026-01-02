const std = @import("std");
const Allocator = std.mem.Allocator;
const tb = @import("text-buffer.zig");
const iter_mod = @import("text-buffer-iterators.zig");
const seg_mod = @import("text-buffer-segment.zig");
const gp = @import("grapheme.zig");

const utf8 = @import("utf8.zig");
const event_emitter = @import("event-emitter.zig");
const event_bus = @import("event-bus.zig");

const UnifiedTextBuffer = tb.UnifiedTextBuffer;
const TextChunk = seg_mod.TextChunk;
const Segment = seg_mod.Segment;
const UnifiedRope = seg_mod.UnifiedRope;

var global_edit_buffer_id: u16 = 0;

pub const EditBufferError = error{
    OutOfMemory,
    InvalidCursor,
};

pub const EditBufferEvent = enum {
    cursorChanged,
};

/// Cursor position (row, col in display-width coordinates)
pub const Cursor = struct {
    row: u32,
    col: u32,
    desired_col: u32 = 0,
    offset: u32 = 0, // Global display-width offset from buffer start
};

const CursorCoords = struct { row: u32, col: u32 };

const AddBuffer = struct {
    mem_id: u8,
    ptr: [*]u8,
    len: usize,
    cap: usize,
    allocator: Allocator,

    fn init(allocator: Allocator, text_buffer: *UnifiedTextBuffer, initial_cap: usize) !AddBuffer {
        const mem = try allocator.alloc(u8, initial_cap);
        const mem_id = try text_buffer.registerMemBuffer(mem, true);

        return .{
            .mem_id = mem_id,
            .ptr = mem.ptr,
            .len = 0,
            .cap = mem.len,
            .allocator = allocator,
        };
    }

    fn ensureCapacity(self: *AddBuffer, text_buffer: *UnifiedTextBuffer, need: usize) !void {
        if (self.len + need <= self.cap) return;

        // TODO: Create a new buffer, register the new buffer and use the new mem_id for subsequent inserts
        const new_cap = @max(self.cap * 2, self.len + need);
        const new_mem = try self.allocator.alloc(u8, new_cap);
        const new_mem_id = try text_buffer.registerMemBuffer(new_mem, true);
        self.mem_id = new_mem_id;
        self.ptr = new_mem.ptr;
        self.len = 0;
        self.cap = new_mem.len;
    }

    fn append(self: *AddBuffer, bytes: []const u8) struct { mem_id: u8, start: u32, end: u32 } {
        std.debug.assert(self.len + bytes.len <= self.cap);
        const start: u32 = @intCast(self.len);

        const dest_slice = self.ptr[0..self.cap];
        @memcpy(dest_slice[self.len .. self.len + bytes.len], bytes);

        self.len += bytes.len;
        const end: u32 = @intCast(self.len);
        return .{ .mem_id = self.mem_id, .start = start, .end = end };
    }
};

pub const EditBuffer = struct {
    id: u16,
    tb: *UnifiedTextBuffer,
    add_buffer: AddBuffer,
    cursors: std.ArrayListUnmanaged(Cursor),
    allocator: Allocator,
    events: event_emitter.EventEmitter(EditBufferEvent),
    segment_splitter: UnifiedRope.Node.LeafSplitFn,

    pub fn init(
        allocator: Allocator,
        pool: *gp.GraphemePool,
        width_method: utf8.WidthMethod,
    ) !*EditBuffer {
        const self = try allocator.create(EditBuffer);
        errdefer allocator.destroy(self);

        const text_buffer = try UnifiedTextBuffer.init(allocator, pool, width_method);
        errdefer text_buffer.deinit();

        const add_buffer = try AddBuffer.init(allocator, text_buffer, 65536);
        errdefer {}

        var cursors: std.ArrayListUnmanaged(Cursor) = .{};
        errdefer cursors.deinit(allocator);

        try cursors.append(allocator, .{ .row = 0, .col = 0 });

        const buffer_id = global_edit_buffer_id;
        global_edit_buffer_id += 1;

        self.* = .{
            .id = buffer_id,
            .tb = text_buffer,
            .add_buffer = add_buffer,
            .cursors = cursors,
            .allocator = allocator,
            .events = event_emitter.EventEmitter(EditBufferEvent).init(allocator),
            .segment_splitter = .{ .ctx = self, .splitFn = splitSegmentCallback },
        };

        return self;
    }

    pub fn deinit(self: *EditBuffer) void {
        // Registry owns all AddBuffer memory, don't free it manually
        self.events.deinit();
        self.tb.deinit();
        self.cursors.deinit(self.allocator);
        self.allocator.destroy(self);
    }

    pub fn getId(self: *const EditBuffer) u16 {
        return self.id;
    }

    fn emitNativeEvent(self: *const EditBuffer, event_name: []const u8) void {
        var id_bytes: [2]u8 = undefined;
        std.mem.writeInt(u16, &id_bytes, self.id, .little);

        const full_name = std.fmt.allocPrint(self.allocator, "eb_{s}", .{event_name}) catch return;
        defer self.allocator.free(full_name);

        event_bus.emit(full_name, &id_bytes);
    }

    pub fn getTextBuffer(self: *EditBuffer) *UnifiedTextBuffer {
        return self.tb;
    }

    pub fn getCursor(self: *const EditBuffer, idx: usize) ?Cursor {
        if (idx >= self.cursors.items.len) return null;
        return self.cursors.items[idx];
    }

    pub fn getPrimaryCursor(self: *const EditBuffer) Cursor {
        if (self.cursors.items.len == 0) return .{ .row = 0, .col = 0 };
        return self.cursors.items[0];
    }

    pub fn setCursor(self: *EditBuffer, row: u32, col: u32) !void {
        const line_count = self.tb.lineCount();
        const clamped_row = @min(row, line_count -| 1);

        const line_width = iter_mod.lineWidthAt(&self.tb.rope, clamped_row);
        const clamped_col = @min(col, line_width);

        const offset = iter_mod.coordsToOffset(&self.tb.rope, clamped_row, clamped_col) orelse 0;

        if (self.cursors.items.len == 0) {
            try self.cursors.append(self.allocator, .{ .row = clamped_row, .col = clamped_col, .desired_col = clamped_col, .offset = offset });
        } else {
            self.cursors.items[0] = .{ .row = clamped_row, .col = clamped_col, .desired_col = clamped_col, .offset = offset };
        }

        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursor-changed");
    }

    pub fn setCursorByOffset(self: *EditBuffer, offset: u32) !void {
        const coords = iter_mod.offsetToCoords(&self.tb.rope, offset) orelse iter_mod.Coords{ .row = 0, .col = 0 };
        try self.setCursor(coords.row, coords.col);
    }

    fn ensureAddCapacity(self: *EditBuffer, need: usize) !void {
        try self.add_buffer.ensureCapacity(self.tb, need);
    }

    /// TODO: This method should live in text-buffer-segment.zig and the Rope should take it as comptime param
    fn splitChunkAtWeight(
        self: *EditBuffer,
        chunk: *const TextChunk,
        weight: u32,
    ) error{ OutOfBounds, OutOfMemory }!struct { left: TextChunk, right: TextChunk } {
        const chunk_weight = chunk.width;

        if (weight == 0) {
            return .{
                .left = TextChunk{ .mem_id = 0, .byte_start = 0, .byte_end = 0, .width = 0 },
                .right = chunk.*,
            };
        } else if (weight >= chunk_weight) {
            return .{
                .left = chunk.*,
                .right = TextChunk{ .mem_id = 0, .byte_start = 0, .byte_end = 0, .width = 0 },
            };
        }

        const chunk_bytes = chunk.getBytes(&self.tb.mem_registry);
        const is_ascii_only = (chunk.flags & TextChunk.Flags.ASCII_ONLY) != 0;

        const result = utf8.findPosByWidth(chunk_bytes, weight, self.tb.tab_width, is_ascii_only, false, self.tb.width_method);
        const split_byte_offset = result.byte_offset;

        const left_chunk = self.tb.createChunk(
            chunk.mem_id,
            chunk.byte_start,
            chunk.byte_start + split_byte_offset,
        );

        const right_chunk = self.tb.createChunk(
            chunk.mem_id,
            chunk.byte_start + split_byte_offset,
            chunk.byte_end,
        );

        return .{ .left = left_chunk, .right = right_chunk };
    }

    fn splitSegmentCallback(
        ctx: ?*anyopaque,
        allocator: Allocator,
        leaf: *const Segment,
        weight_in_leaf: u32,
    ) error{ OutOfBounds, OutOfMemory }!UnifiedRope.Node.LeafSplitResult {
        _ = allocator;
        const edit_buf = @as(*EditBuffer, @ptrCast(@alignCast(ctx.?)));

        if (leaf.asText()) |chunk| {
            const result = try edit_buf.splitChunkAtWeight(chunk, weight_in_leaf);
            return .{
                .left = Segment{ .text = result.left },
                .right = Segment{ .text = result.right },
            };
        } else {
            return .{
                .left = Segment{ .brk = {} },
                .right = Segment{ .brk = {} },
            };
        }
    }

    pub fn insertText(self: *EditBuffer, bytes: []const u8) !void {
        if (bytes.len == 0) return;
        if (self.cursors.items.len == 0) return;

        try self.autoStoreUndo();

        const cursor = self.cursors.items[0];

        try self.ensureAddCapacity(bytes.len);

        const insert_offset = iter_mod.coordsToOffset(&self.tb.rope, cursor.row, cursor.col) orelse return EditBufferError.InvalidCursor;

        const chunk_ref = self.add_buffer.append(bytes);
        const base_mem_id = chunk_ref.mem_id;
        const base_start = chunk_ref.start;

        var result = try self.tb.textToSegments(self.allocator, bytes, base_mem_id, base_start, false);
        defer result.segments.deinit(result.allocator);

        const inserted_width = result.total_width;

        // Calculate width after last break
        var width_after_last_break: u32 = 0;
        var num_breaks: usize = 0;
        for (result.segments.items) |seg| {
            if (seg.isBreak()) {
                num_breaks += 1;
                width_after_last_break = 0;
            } else if (seg.asText()) |chunk| {
                width_after_last_break += chunk.width;
            }
        }

        if (result.segments.items.len > 0) {
            try self.tb.rope.insertSliceByWeight(insert_offset, result.segments.items, &self.segment_splitter);
        }
        if (num_breaks > 0) {
            const new_row = cursor.row + @as(u32, @intCast(num_breaks));
            const new_col = width_after_last_break;
            const new_offset = iter_mod.coordsToOffset(&self.tb.rope, new_row, new_col) orelse 0;
            self.cursors.items[0] = .{
                .row = new_row,
                .col = new_col,
                .desired_col = new_col,
                .offset = new_offset,
            };
        } else {
            const new_col = cursor.col + inserted_width;
            const new_offset = iter_mod.coordsToOffset(&self.tb.rope, cursor.row, new_col) orelse 0;
            self.cursors.items[0] = .{
                .row = cursor.row,
                .col = new_col,
                .desired_col = new_col,
                .offset = new_offset,
            };
        }

        self.tb.markViewsDirty();
        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursor-changed");
        self.emitNativeEvent("content-changed");
    }

    pub fn deleteRange(self: *EditBuffer, start_cursor: Cursor, end_cursor: Cursor) !void {
        var start = start_cursor;
        var end = end_cursor;
        if (start.row > end.row or (start.row == end.row and start.col > end.col)) {
            const temp = start;
            start = end;
            end = temp;
        }

        if (start.row == end.row and start.col == end.col) return;

        try self.autoStoreUndo();

        const start_offset = iter_mod.coordsToOffset(&self.tb.rope, start.row, start.col) orelse return EditBufferError.InvalidCursor;
        const end_offset = iter_mod.coordsToOffset(&self.tb.rope, end.row, end.col) orelse return EditBufferError.InvalidCursor;

        if (start_offset >= end_offset) return;

        try self.tb.rope.deleteRangeByWeight(start_offset, end_offset, &self.segment_splitter);

        self.tb.markViewsDirty();

        if (self.cursors.items.len > 0) {
            const line_count = self.tb.lineCount();
            const clamped_row = if (start.row >= line_count) line_count -| 1 else start.row;
            const line_width = if (line_count > 0) iter_mod.lineWidthAt(&self.tb.rope, clamped_row) else 0;
            const clamped_col = @min(start.col, line_width);
            const offset = iter_mod.coordsToOffset(&self.tb.rope, clamped_row, clamped_col) orelse 0;

            self.cursors.items[0] = .{ .row = clamped_row, .col = clamped_col, .desired_col = clamped_col, .offset = offset };
        }

        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursor-changed");
        self.emitNativeEvent("content-changed");
    }

    pub fn backspace(self: *EditBuffer) !void {
        if (self.cursors.items.len == 0) return;
        const cursor = self.cursors.items[0];

        if (cursor.row == 0 and cursor.col == 0) return;

        if (cursor.col == 0) {
            if (cursor.row > 0) {
                const prev_line_width = iter_mod.lineWidthAt(&self.tb.rope, cursor.row - 1);
                try self.deleteRange(
                    .{ .row = cursor.row - 1, .col = prev_line_width },
                    .{ .row = cursor.row, .col = 0 },
                );
            }
        } else {
            const prev_grapheme_width = iter_mod.getPrevGraphemeWidth(&self.tb.rope, &self.tb.mem_registry, cursor.row, cursor.col, self.tb.tab_width, self.tb.width_method);
            if (prev_grapheme_width == 0) return; // Nothing to delete

            const target_col = cursor.col - prev_grapheme_width;
            try self.deleteRange(
                .{ .row = cursor.row, .col = target_col },
                .{ .row = cursor.row, .col = cursor.col },
            );
        }

        // deleteRange already checks for placeholder insertion
    }

    pub fn deleteForward(self: *EditBuffer) !void {
        if (self.cursors.items.len == 0) return;
        const cursor = self.cursors.items[0];

        try self.autoStoreUndo();

        const line_width = iter_mod.lineWidthAt(&self.tb.rope, cursor.row);
        const line_count = self.tb.lineCount();

        if (cursor.col >= line_width) {
            if (cursor.row + 1 < line_count) {
                try self.deleteRange(
                    .{ .row = cursor.row, .col = line_width },
                    .{ .row = cursor.row + 1, .col = 0 },
                );
            }
        } else {
            const grapheme_width = iter_mod.getGraphemeWidthAt(&self.tb.rope, &self.tb.mem_registry, cursor.row, cursor.col, self.tb.tab_width, self.tb.width_method);
            if (grapheme_width > 0) {
                try self.deleteRange(
                    .{ .row = cursor.row, .col = cursor.col },
                    .{ .row = cursor.row, .col = cursor.col + grapheme_width },
                );
            }
        }
    }

    pub fn moveLeft(self: *EditBuffer) void {
        if (self.cursors.items.len == 0) {
            return;
        }
        const cursor = &self.cursors.items[0];

        if (cursor.col > 0) {
            const prev_width = iter_mod.getPrevGraphemeWidth(&self.tb.rope, &self.tb.mem_registry, cursor.row, cursor.col, self.tb.tab_width, self.tb.width_method);
            cursor.col -= prev_width;
        } else if (cursor.row > 0) {
            cursor.row -= 1;
            const line_width = iter_mod.lineWidthAt(&self.tb.rope, cursor.row);
            cursor.col = line_width;
        }
        cursor.desired_col = cursor.col;
        cursor.offset = iter_mod.coordsToOffset(&self.tb.rope, cursor.row, cursor.col) orelse 0;

        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursor-changed");
    }

    pub fn moveRight(self: *EditBuffer) void {
        if (self.cursors.items.len == 0) return;
        const cursor = &self.cursors.items[0];

        const line_width = iter_mod.lineWidthAt(&self.tb.rope, cursor.row);
        const line_count = self.tb.getLineCount();

        if (cursor.col < line_width) {
            const grapheme_width = iter_mod.getGraphemeWidthAt(&self.tb.rope, &self.tb.mem_registry, cursor.row, cursor.col, self.tb.tab_width, self.tb.width_method);
            cursor.col += grapheme_width;
        } else if (cursor.row + 1 < line_count) {
            cursor.row += 1;
            cursor.col = 0;
        }
        cursor.desired_col = cursor.col;
        cursor.offset = iter_mod.coordsToOffset(&self.tb.rope, cursor.row, cursor.col) orelse 0;

        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursor-changed");
    }

    pub fn moveUp(self: *EditBuffer) void {
        if (self.cursors.items.len == 0) return;
        const cursor = &self.cursors.items[0];

        if (cursor.row > 0) {
            if (cursor.desired_col == 0) {
                cursor.desired_col = cursor.col;
            }

            cursor.row -= 1;

            const line_width = iter_mod.lineWidthAt(&self.tb.rope, cursor.row);

            cursor.col = @min(cursor.desired_col, line_width);
            cursor.offset = iter_mod.coordsToOffset(&self.tb.rope, cursor.row, cursor.col) orelse 0;
        }

        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursor-changed");
    }

    pub fn moveDown(self: *EditBuffer) void {
        if (self.cursors.items.len == 0) return;
        const cursor = &self.cursors.items[0];

        const line_count = self.tb.getLineCount();
        if (cursor.row + 1 < line_count) {
            if (cursor.desired_col == 0) {
                cursor.desired_col = cursor.col;
            }

            cursor.row += 1;

            const line_width = iter_mod.lineWidthAt(&self.tb.rope, cursor.row);

            cursor.col = @min(cursor.desired_col, line_width);
            cursor.offset = iter_mod.coordsToOffset(&self.tb.rope, cursor.row, cursor.col) orelse 0;
        }

        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursor-changed");
    }

    /// Set text and completely reset the buffer state (clears history, resets add_buffer)
    pub fn setText(self: *EditBuffer, text: []const u8) !void {
        const owned_text = try self.allocator.dupe(u8, text);
        const mem_id = try self.tb.registerMemBuffer(owned_text, true);
        try self.setTextFromMemId(mem_id);
    }

    /// Set text from memory ID and completely reset the buffer state (clears history, resets add_buffer)
    pub fn setTextFromMemId(self: *EditBuffer, mem_id: u8) !void {
        self.tb.rope.clear_history();
        self.add_buffer.len = 0;

        try self.tb.setTextFromMemId(mem_id);
        try self.setCursor(0, 0);

        self.emitNativeEvent("content-changed");
    }

    /// Replace text while preserving undo history (creates an undo point)
    pub fn replaceText(self: *EditBuffer, text: []const u8) !void {
        const owned_text = try self.allocator.dupe(u8, text);
        const mem_id = try self.tb.registerMemBuffer(owned_text, true);
        try self.replaceTextFromMemId(mem_id);
    }

    /// Replace text from memory ID while preserving undo history (creates an undo point)
    pub fn replaceTextFromMemId(self: *EditBuffer, mem_id: u8) !void {
        try self.autoStoreUndo();

        try self.tb.setTextFromMemId(mem_id);
        try self.setCursor(0, 0);

        self.emitNativeEvent("content-changed");
    }

    pub fn getText(self: *EditBuffer, out_buffer: []u8) usize {
        return self.tb.getPlainTextIntoBuffer(out_buffer);
    }

    pub fn deleteLine(self: *EditBuffer) !void {
        const cursor = self.getPrimaryCursor();
        const line_count = self.tb.lineCount();

        if (cursor.row >= line_count) return;

        if (cursor.row + 1 < line_count) {
            try self.deleteRange(
                .{ .row = cursor.row, .col = 0 },
                .{ .row = cursor.row + 1, .col = 0 },
            );
        } else if (cursor.row > 0) {
            const prev_line_width = iter_mod.lineWidthAt(&self.tb.rope, cursor.row - 1);
            const curr_line_width = iter_mod.lineWidthAt(&self.tb.rope, cursor.row);

            try self.deleteRange(
                .{ .row = cursor.row - 1, .col = prev_line_width },
                .{ .row = cursor.row, .col = curr_line_width },
            );

            self.tb.markViewsDirty();

            const new_row = cursor.row - 1;
            const new_col = prev_line_width;
            const new_offset = iter_mod.coordsToOffset(&self.tb.rope, new_row, new_col) orelse 0;
            self.cursors.items[0] = .{ .row = new_row, .col = new_col, .desired_col = new_col, .offset = new_offset };
            self.events.emit(.cursorChanged);
            self.emitNativeEvent("cursor-changed");
        } else {
            const line_width = iter_mod.lineWidthAt(&self.tb.rope, cursor.row);
            if (line_width > 0) {
                try self.deleteRange(
                    .{ .row = cursor.row, .col = 0 },
                    .{ .row = cursor.row, .col = line_width },
                );
            }
        }
    }

    pub fn gotoLine(self: *EditBuffer, line: u32) !void {
        const line_count = self.tb.lineCount();
        const target_line = @min(line, line_count -| 1);

        if (line >= line_count) {
            const last_line_width = iter_mod.lineWidthAt(&self.tb.rope, target_line);
            try self.setCursor(target_line, last_line_width);
        } else {
            try self.setCursor(target_line, 0);
        }
    }

    pub fn getCursorPosition(self: *const EditBuffer) struct { line: u32, visual_col: u32, offset: u32 } {
        const cursor = self.getPrimaryCursor();

        return .{
            .line = cursor.row,
            .visual_col = cursor.col,
            .offset = cursor.offset,
        };
    }

    pub fn debugLogRope(self: *const EditBuffer) void {
        self.tb.debugLogRope();
    }

    fn autoStoreUndo(self: *EditBuffer) !void {
        try self.tb.rope.store_undo("edit");
    }

    pub fn undo(self: *EditBuffer) ![]const u8 {
        const prev_meta = try self.tb.rope.undo("current");

        const cursor = self.getPrimaryCursor();
        try self.setCursor(cursor.row, cursor.col);

        self.tb.markViewsDirty();
        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursorChanged");

        return prev_meta;
    }

    pub fn redo(self: *EditBuffer) ![]const u8 {
        const next_meta = try self.tb.rope.redo();

        const cursor = self.getPrimaryCursor();
        try self.setCursor(cursor.row, cursor.col);

        self.tb.markViewsDirty();
        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursorChanged");

        return next_meta;
    }

    pub fn canUndo(self: *const EditBuffer) bool {
        return self.tb.rope.can_undo();
    }

    pub fn canRedo(self: *const EditBuffer) bool {
        return self.tb.rope.can_redo();
    }

    pub fn clearHistory(self: *EditBuffer) void {
        self.tb.rope.clear_history();
    }

    pub fn clear(self: *EditBuffer) !void {
        self.tb.clear();
        try self.setCursor(0, 0);
        self.emitNativeEvent("content-changed");
    }

    pub fn getNextWordBoundary(self: *EditBuffer) Cursor {
        if (self.cursors.items.len == 0) return .{ .row = 0, .col = 0 };
        const cursor = self.cursors.items[0];

        const line_count = self.tb.lineCount();
        if (cursor.row >= line_count) return cursor;

        const line_width = iter_mod.lineWidthAt(&self.tb.rope, cursor.row);

        const linestart = self.tb.rope.getMarker(.linestart, cursor.row) orelse return cursor;
        var seg_idx = linestart.leaf_index + 1;
        var cols_before: u32 = 0;
        var passed_cursor = false;

        while (seg_idx < self.tb.rope.count()) : (seg_idx += 1) {
            const seg = self.tb.rope.get(seg_idx) orelse break;
            if (seg.isBreak() or seg.isLineStart()) break;
            if (seg.asText()) |chunk| {
                const next_cols = cols_before + chunk.width;

                // Check this chunk if cursor is within it OR if we've already passed the cursor
                if (cursor.col < next_cols or passed_cursor) {
                    const wrap_offsets = chunk.getWrapOffsets(&self.tb.mem_registry, self.tb.allocator, self.tb.width_method) catch {
                        cols_before = next_cols;
                        passed_cursor = true;
                        continue;
                    };

                    // For chunks containing or after the cursor, find the first break after cursor position
                    const local_cursor_col = if (cursor.col > cols_before) cursor.col - cols_before else 0;

                    for (wrap_offsets) |wrap_break| {
                        const break_col = @as(u32, wrap_break.char_offset);
                        // If we've passed the cursor chunk, any break is valid
                        // If we're in the cursor chunk, break must be after cursor position
                        if (passed_cursor or break_col > local_cursor_col) {
                            const target_col = cols_before + break_col + 1;
                            if (target_col <= line_width) {
                                const offset = iter_mod.coordsToOffset(&self.tb.rope, cursor.row, target_col) orelse cursor.offset;
                                return .{ .row = cursor.row, .col = target_col, .desired_col = target_col, .offset = offset };
                            }
                        }
                    }

                    // Mark that we've processed/passed the cursor position
                    passed_cursor = true;
                }
                cols_before = next_cols;
            }
        }

        if (cursor.row + 1 < line_count) {
            const offset = iter_mod.coordsToOffset(&self.tb.rope, cursor.row + 1, 0) orelse cursor.offset;
            return .{ .row = cursor.row + 1, .col = 0, .desired_col = 0, .offset = offset };
        }

        const offset = iter_mod.coordsToOffset(&self.tb.rope, cursor.row, line_width) orelse cursor.offset;
        return .{ .row = cursor.row, .col = line_width, .desired_col = line_width, .offset = offset };
    }

    pub fn getPrevWordBoundary(self: *EditBuffer) Cursor {
        if (self.cursors.items.len == 0) return .{ .row = 0, .col = 0 };
        const cursor = self.cursors.items[0];

        if (cursor.row == 0 and cursor.col == 0) return cursor;

        const linestart = self.tb.rope.getMarker(.linestart, cursor.row) orelse return cursor;
        var seg_idx = linestart.leaf_index + 1;
        var cols_before: u32 = 0;
        var last_boundary: ?u32 = null;

        while (seg_idx < self.tb.rope.count()) : (seg_idx += 1) {
            const seg = self.tb.rope.get(seg_idx) orelse break;
            if (seg.isBreak() or seg.isLineStart()) break;
            if (seg.asText()) |chunk| {
                const next_cols = cols_before + chunk.width;

                const wrap_offsets = chunk.getWrapOffsets(&self.tb.mem_registry, self.tb.allocator, self.tb.width_method) catch {
                    cols_before = next_cols;
                    continue;
                };

                for (wrap_offsets) |wrap_break| {
                    const break_col = cols_before + @as(u32, wrap_break.char_offset) + 1;
                    if (break_col < cursor.col) {
                        last_boundary = break_col;
                    }
                }

                cols_before = next_cols;
                if (cursor.col <= cols_before) break;
            }
        }

        if (last_boundary) |boundary_col| {
            const offset = iter_mod.coordsToOffset(&self.tb.rope, cursor.row, boundary_col) orelse cursor.offset;
            return .{ .row = cursor.row, .col = boundary_col, .desired_col = boundary_col, .offset = offset };
        }

        if (cursor.row > 0) {
            const prev_line_width = iter_mod.lineWidthAt(&self.tb.rope, cursor.row - 1);
            const offset = iter_mod.coordsToOffset(&self.tb.rope, cursor.row - 1, prev_line_width) orelse cursor.offset;
            return .{ .row = cursor.row - 1, .col = prev_line_width, .desired_col = prev_line_width, .offset = offset };
        }

        return .{ .row = 0, .col = 0, .desired_col = 0, .offset = 0 };
    }

    pub fn getEOL(self: *EditBuffer) Cursor {
        if (self.cursors.items.len == 0) return .{ .row = 0, .col = 0 };
        const cursor = self.cursors.items[0];

        const line_count = self.tb.lineCount();
        if (cursor.row >= line_count) return cursor;

        const line_width = iter_mod.lineWidthAt(&self.tb.rope, cursor.row);
        const offset = iter_mod.coordsToOffset(&self.tb.rope, cursor.row, line_width) orelse cursor.offset;

        return .{ .row = cursor.row, .col = line_width, .desired_col = line_width, .offset = offset };
    }

    /// Get text within a range of display-width offsets
    /// Automatically snaps to grapheme boundaries:
    /// - start_offset excludes graphemes that start before it
    /// - end_offset includes graphemes that start before it
    /// Returns number of bytes written to out_buffer
    pub fn getTextRange(self: *EditBuffer, start_offset: u32, end_offset: u32, out_buffer: []u8) !usize {
        return self.tb.getTextRange(start_offset, end_offset, out_buffer);
    }

    /// Get text within a range specified by row/col coordinates
    /// Automatically snaps to grapheme boundaries:
    /// Returns number of bytes written to out_buffer
    pub fn getTextRangeByCoords(self: *EditBuffer, start_row: u32, start_col: u32, end_row: u32, end_col: u32, out_buffer: []u8) usize {
        return self.tb.getTextRangeByCoords(start_row, start_col, end_row, end_col, out_buffer);
    }
};
