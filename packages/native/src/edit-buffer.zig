const std = @import("std");
const Allocator = std.mem.Allocator;
const tb = @import("text-buffer.zig");
const iter_mod = @import("text-buffer-iterators.zig");
const seg_mod = @import("text-buffer-segment.zig");
const gp = @import("grapheme.zig");
const link = @import("link.zig");

const utf8 = @import("utf8.zig");
const event_emitter = @import("event-emitter.zig");
const event_bus = @import("event-bus.zig");

const UnifiedTextBuffer = tb.UnifiedTextBuffer;
const TextChunk = seg_mod.TextChunk;
const Segment = seg_mod.Segment;
const UnifiedRope = seg_mod.UnifiedRope;

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

const CursorMeta = struct {
    row: u32,
    col: u32,
    desired_col: u32,
    tab_width: ?u8 = null,

    fn fromCursor(cursor: Cursor, tab_width: u8) CursorMeta {
        return .{
            .row = cursor.row,
            .col = cursor.col,
            .desired_col = cursor.desired_col,
            .tab_width = tab_width,
        };
    }

    fn encode(self: CursorMeta, out_buffer: []u8) ![]const u8 {
        if (self.tab_width) |tab_width| {
            return std.fmt.bufPrint(out_buffer, "cursor:{d}:{d}:{d}:{d}", .{ self.row, self.col, self.desired_col, tab_width });
        }
        return std.fmt.bufPrint(out_buffer, "cursor:{d}:{d}:{d}", .{ self.row, self.col, self.desired_col });
    }

    fn decode(bytes: []const u8) ?CursorMeta {
        const prefix = "cursor:";
        if (!std.mem.startsWith(u8, bytes, prefix)) {
            return null;
        }

        var parts = std.mem.splitScalar(u8, bytes[prefix.len..], ':');

        const row = std.fmt.parseInt(u32, parts.next() orelse return null, 10) catch return null;
        const col = std.fmt.parseInt(u32, parts.next() orelse return null, 10) catch return null;
        const desired_col = std.fmt.parseInt(u32, parts.next() orelse return null, 10) catch return null;
        const tab_width = if (parts.next()) |part|
            std.fmt.parseInt(u8, part, 10) catch return null
        else
            null;

        if (parts.next() != null) {
            return null;
        }

        return .{
            .row = row,
            .col = col,
            .desired_col = desired_col,
            .tab_width = tab_width,
        };
    }

    fn publicBytes(bytes: []const u8) []const u8 {
        const decoded = decode(bytes) orelse return bytes;
        if (decoded.tab_width == null) return bytes;
        const last_separator = std.mem.lastIndexOfScalar(u8, bytes, ':') orelse return bytes;
        return bytes[0..last_separator];
    }
};

const AddBuffer = struct {
    mem_id: u8,
    ptr: [*]u8,
    len: usize,
    cap: usize,
    allocator: Allocator,

    fn init(allocator: Allocator, text_buffer: *UnifiedTextBuffer, initial_cap: usize) !AddBuffer {
        const mem = try allocator.alloc(u8, initial_cap);
        errdefer allocator.free(mem);
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
        errdefer self.allocator.free(new_mem);
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
    id: u32,
    tb: *UnifiedTextBuffer,
    add_buffer: AddBuffer,
    cursors: std.ArrayListUnmanaged(Cursor),
    allocator: Allocator,
    events: event_emitter.EventEmitter(EditBufferEvent),
    segment_splitter: UnifiedRope.Node.LeafSplitFn,
    event_sink: ?*event_bus.EventSink,

    pub fn init(
        allocator: Allocator,
        pool: *gp.GraphemePool,
        link_pool: *link.LinkPool,
        width_method: utf8.WidthMethod,
        event_sink: ?*event_bus.EventSink,
    ) !*EditBuffer {
        return initWithOptions(allocator, pool, link_pool, width_method, event_sink, .{});
    }

    pub fn initWithOptions(
        allocator: Allocator,
        pool: *gp.GraphemePool,
        link_pool: *link.LinkPool,
        width_method: utf8.WidthMethod,
        event_sink: ?*event_bus.EventSink,
        options: UnifiedTextBuffer.InitOptions,
    ) !*EditBuffer {
        const self = try allocator.create(EditBuffer);
        errdefer allocator.destroy(self);

        const text_buffer = try UnifiedTextBuffer.initWithOptions(allocator, pool, link_pool, width_method, options);
        errdefer text_buffer.deinit();

        const add_buffer = try AddBuffer.init(allocator, text_buffer, 65536);

        var cursors: std.ArrayListUnmanaged(Cursor) = .empty;
        errdefer cursors.deinit(allocator);

        try cursors.append(allocator, .{ .row = 0, .col = 0 });

        self.* = .{
            .id = if (event_sink) |sink| try sink.allocateEditBufferId() else 0,
            .tb = text_buffer,
            .add_buffer = add_buffer,
            .cursors = cursors,
            .allocator = allocator,
            .events = event_emitter.EventEmitter(EditBufferEvent).init(allocator),
            .segment_splitter = .{ .ctx = self, .splitFn = splitSegmentCallback },
            .event_sink = event_sink,
        };

        return self;
    }

    pub fn deinit(self: *EditBuffer) void {
        const allocator = self.allocator;
        defer allocator.destroy(self);

        // Registry owns all AddBuffer memory, don't free it manually
        self.events.deinit();
        self.tb.deinit();
        self.cursors.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn getId(self: *const EditBuffer) u32 {
        return self.id;
    }

    fn emitNativeEvent(self: *const EditBuffer, comptime event_name: []const u8) void {
        const sink = self.event_sink orelse return;
        var id_bytes: [4]u8 = undefined;
        std.mem.writeInt(u32, &id_bytes, self.id, .little);

        event_bus.emit(sink, "eb_" ++ event_name, &id_bytes);
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

        const line_width = iter_mod.lineWidthAt(self.tb.rope(), clamped_row);
        const clamped_col = @min(col, line_width);

        const offset = iter_mod.coordsToOffset(self.tb.rope(), clamped_row, clamped_col) orelse 0;

        if (self.cursors.items.len == 0) {
            try self.cursors.append(self.allocator, .{ .row = clamped_row, .col = clamped_col, .desired_col = clamped_col, .offset = offset });
        } else {
            self.cursors.items[0] = .{ .row = clamped_row, .col = clamped_col, .desired_col = clamped_col, .offset = offset };
        }

        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursor-changed");
    }

    pub fn setCursorByOffset(self: *EditBuffer, offset: u32) !void {
        const coords = iter_mod.offsetToCoords(self.tb.rope(), offset) orelse iter_mod.Coords{ .row = 0, .col = 0 };
        try self.setCursor(coords.row, coords.col);
    }

    fn remapCol(self: *EditBuffer, row: u32, target_col: u32, old_tab_width: u8) ?u32 {
        const linestart = self.tb.rope().getMarker(.linestart, row) orelse return null;
        var seg_idx = linestart.leaf_index + 1;
        var old_col: u32 = 0;
        var new_col: u32 = 0;

        while (seg_idx < self.tb.rope().count()) : (seg_idx += 1) {
            const seg = self.tb.rope().get(seg_idx) orelse break;
            if (seg.isBreak() or seg.isLineStart()) break;
            const chunk = seg.asText() orelse continue;
            const bytes = chunk.getBytes(self.tb.memRegistry());
            // The restored root's cached widths use the current policy, not the checkpoint's.
            const next_col = old_col +| utf8.calculateTextWidth(bytes, old_tab_width, chunk.isAsciiOnly(), self.tb.widthMethod());
            if (target_col <= next_col) {
                const pos = utf8.findPosByWidth(
                    bytes,
                    target_col -| old_col,
                    old_tab_width,
                    chunk.isAsciiOnly(),
                    false,
                    self.tb.widthMethod(),
                );
                return new_col +| utf8.calculateTextWidth(
                    bytes[0..pos.byte_offset],
                    self.tb.tabWidth(),
                    chunk.isAsciiOnly(),
                    self.tb.widthMethod(),
                );
            }
            old_col = next_col;
            new_col +|= chunk.width_cols;
        }

        return if (target_col == old_col) new_col else null;
    }

    pub fn setTabWidth(self: *EditBuffer, width: u8) void {
        const old_width = self.tb.tabWidth();
        self.tb.setTabWidth(width);
        if (old_width == self.tb.tabWidth()) return;

        for (self.cursors.items) |*cursor| {
            const new_col = self.remapCol(cursor.row, cursor.col, old_width) orelse
                @min(cursor.col, iter_mod.lineWidthAt(self.tb.rope(), cursor.row));
            if (cursor.desired_col == cursor.col) cursor.desired_col = new_col;
            cursor.col = new_col;
            cursor.offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row, new_col) orelse 0;
        }

        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursor-changed");
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
        const chunk_weight = chunk.width_cols;

        if (weight == 0) {
            return .{
                .left = TextChunk{ .mem_id = 0, .byte_start = 0, .byte_end = 0, .width_cols = 0 },
                .right = chunk.*,
            };
        } else if (weight >= chunk_weight) {
            return .{
                .left = chunk.*,
                .right = TextChunk{ .mem_id = 0, .byte_start = 0, .byte_end = 0, .width_cols = 0 },
            };
        }

        const chunk_bytes = chunk.getBytes(self.tb.memRegistry());
        const is_ascii_only = (chunk.flags & TextChunk.Flags.ASCII_ONLY) != 0;

        const result = utf8.findPosByWidth(chunk_bytes, weight, self.tb.tabWidth(), is_ascii_only, false, self.tb.widthMethod());
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
        allocator: Allocator,
        ctx: ?*anyopaque,
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

        const cursor = self.cursors.items[0];
        const insert_offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row, cursor.col) orelse return EditBufferError.InvalidCursor;

        const previous_add_buffer = self.add_buffer;
        const previous_buffer_count = self.tb.mem_registry.buffers.items.len;
        errdefer {
            if (self.add_buffer.mem_id != previous_add_buffer.mem_id) {
                self.tb.mem_registry.cancelLastRegistration(self.add_buffer.mem_id, previous_buffer_count);
            }
            self.add_buffer = previous_add_buffer;
        }
        try self.ensureAddCapacity(bytes.len);

        const chunk_ref = self.add_buffer.append(bytes);
        const base_mem_id = chunk_ref.mem_id;
        const base_start = chunk_ref.start;

        var result = try self.tb.textToSegments(self.allocator, bytes, base_mem_id, base_start, false);
        defer result.segments.deinit(result.allocator);

        const inserted_width_cols = result.total_width_cols;

        // Calculate width after last break
        var width_after_last_break: u32 = 0;
        var num_breaks: usize = 0;
        for (result.segments.items) |seg| {
            if (seg.isBreak()) {
                num_breaks += 1;
                width_after_last_break = 0;
            } else if (seg.asText()) |chunk| {
                width_after_last_break += chunk.width_cols;
            }
        }

        // Prepare root/end-marker repairs without touching shared history or marker caches.
        var candidate = self.tb.rope().*;
        try candidate.insertSliceByWeight(insert_offset, result.segments.items, &self.segment_splitter);
        try self.autoStoreUndo();
        self.tb.rope().root = candidate.root;
        self.tb.rope().version = candidate.version;
        if (num_breaks > 0) {
            const new_row = cursor.row + @as(u32, @intCast(num_breaks));
            const new_col = width_after_last_break;
            const new_offset = iter_mod.coordsToOffset(self.tb.rope(), new_row, new_col) orelse 0;
            self.cursors.items[0] = .{
                .row = new_row,
                .col = new_col,
                .desired_col = new_col,
                .offset = new_offset,
            };
        } else {
            const new_col = cursor.col + inserted_width_cols;
            const new_offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row, new_col) orelse 0;
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

        const start_offset = iter_mod.coordsToOffset(self.tb.rope(), start.row, start.col) orelse return EditBufferError.InvalidCursor;
        const end_offset = iter_mod.coordsToOffset(self.tb.rope(), end.row, end.col) orelse return EditBufferError.InvalidCursor;

        if (start_offset >= end_offset) return;

        var candidate = self.tb.rope().*;
        try candidate.deleteRangeByWeight(start_offset, end_offset, &self.segment_splitter);
        try self.autoStoreUndo();
        self.tb.rope().root = candidate.root;
        self.tb.rope().version = candidate.version;

        self.tb.markViewsDirty();

        if (self.cursors.items.len > 0) {
            const line_count = self.tb.lineCount();
            const clamped_row = if (start.row >= line_count) line_count -| 1 else start.row;
            const line_width = if (line_count > 0) iter_mod.lineWidthAt(self.tb.rope(), clamped_row) else 0;
            const clamped_col = @min(start.col, line_width);
            const offset = iter_mod.coordsToOffset(self.tb.rope(), clamped_row, clamped_col) orelse 0;

            self.cursors.items[0] = .{ .row = clamped_row, .col = clamped_col, .desired_col = clamped_col, .offset = offset };
        }

        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursor-changed");
        self.emitNativeEvent("content-changed");
    }

    /// Replace an exclusive display-cell range, preserving delete-then-insert history and events.
    /// All fallible work precedes deletion; after_delete runs between the accepted edits.
    pub fn replaceRange(
        self: *EditBuffer,
        start_offset: u32,
        end_offset: u32,
        bytes: []const u8,
        after_delete: event_emitter.EventEmitter(EditBufferEvent).Listener,
    ) !void {
        if (start_offset > end_offset or end_offset > self.tb.rope().totalWeight()) {
            return EditBufferError.InvalidCursor;
        }
        if (self.cursors.items.len == 0) return EditBufferError.InvalidCursor;
        const has_deletion = start_offset != end_offset;

        const previous_add_buffer = self.add_buffer;
        const previous_buffer_count = self.tb.mem_registry.buffers.items.len;
        errdefer {
            if (self.add_buffer.mem_id != previous_add_buffer.mem_id) {
                self.tb.mem_registry.cancelLastRegistration(self.add_buffer.mem_id, previous_buffer_count);
            }
            self.add_buffer = previous_add_buffer;
        }
        try self.ensureAddCapacity(bytes.len);
        const chunk_ref = self.add_buffer.append(bytes);
        var segments = try self.tb.textToSegments(self.allocator, bytes, chunk_ref.mem_id, chunk_ref.start, false);
        defer segments.segments.deinit(segments.allocator);

        var deleted = self.tb.rope().*;
        try deleted.deleteRangeByWeight(start_offset, end_offset, &self.segment_splitter);
        var deleted_cursor = if (has_deletion)
            cursorAfterDeletion(self.tb.rope(), &deleted, start_offset)
        else
            self.getPrimaryCursor();
        if (!has_deletion and bytes.len > 0) {
            deleted_cursor.offset = iter_mod.coordsToOffset(self.tb.rope(), deleted_cursor.row, deleted_cursor.col) orelse
                return EditBufferError.InvalidCursor;
        }
        var inserted = deleted;
        try inserted.insertSliceByWeight(deleted_cursor.offset, segments.segments.items, &self.segment_splitter);
        var inserted_cursor = deleted_cursor;
        for (segments.segments.items) |segment| {
            if (segment.isBreak()) {
                inserted_cursor.row += 1;
                inserted_cursor.col = 0;
                inserted_cursor.offset += 1;
            } else if (segment.asText()) |chunk| {
                inserted_cursor.col += chunk.width_cols;
                inserted_cursor.offset += chunk.width_cols;
            }
        }
        if (inserted_cursor.row != deleted_cursor.row) {
            inserted_cursor.offset = newlineOffset(&inserted, inserted_cursor.row - 1) + 1 + inserted_cursor.col;
        }
        inserted_cursor.desired_col = inserted_cursor.col;

        // Each store_undo allocates a node, a cursor-metadata buffer, and
        // at most one redo branch. Reserve both stores before either can trim
        // shared history. The backing bytes have the rope arena's lifetime.
        const history_step_size = @sizeOf(UnifiedRope.UndoNode) + @alignOf(UnifiedRope.UndoNode) - 1 +
            64 + @sizeOf(UnifiedRope.UndoBranch) + @alignOf(UnifiedRope.UndoBranch) - 1;
        const step_count = @as(usize, @intFromBool(has_deletion)) + @intFromBool(bytes.len > 0);
        const history_storage = try self.tb.rope().allocator.alloc(u8, history_step_size * step_count);
        var history_allocator = std.heap.FixedBufferAllocator.init(history_storage);
        if (has_deletion) self.publishReplacementStep(&deleted, deleted_cursor, history_allocator.allocator());
        after_delete.handle(after_delete.ctx);
        if (bytes.len > 0) self.publishReplacementStep(&inserted, inserted_cursor, history_allocator.allocator());
    }

    fn publishReplacementStep(self: *EditBuffer, candidate: *const UnifiedRope, cursor: Cursor, history_allocator: Allocator) void {
        const rope = self.tb.rope();
        const allocator = rope.allocator;
        rope.allocator = history_allocator;
        self.autoStoreUndo() catch unreachable; // Reserved above, including alignment and redo branching.
        rope.allocator = allocator;
        rope.root = candidate.root;
        rope.version = candidate.version;
        self.cursors.items[0] = cursor;
        self.tb.markViewsDirty();
        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursor-changed");
        self.emitNativeEvent("content-changed");
    }

    fn cursorAfterDeletion(rope: *const UnifiedRope, deleted: *const UnifiedRope, offset: u32) Cursor {
        std.debug.assert(offset <= rope.totalWeight());
        // Use aggregate metrics rather than allocating or mutating the live marker cache.
        var node = rope.root;
        var remaining = offset;
        var row: u32 = 0;
        while (node.* == .branch) {
            const branch = node.branch;
            if (remaining < branch.left_metrics.weight()) {
                node = branch.left;
            } else {
                remaining -= branch.left_metrics.weight();
                row += branch.left_metrics.custom.newline_count;
                node = branch.right;
            }
        }
        if (remaining >= node.metrics().weight()) row += node.metrics().custom.newline_count;
        const line_start = if (row > 0) newlineOffset(rope, row - 1) + 1 else 0;
        var clamped_offset = offset;
        if (remaining != 0 and !node.metrics().custom.ascii_only) {
            const line_end = if (row < deleted.root.metrics().custom.newline_count)
                newlineOffset(deleted, row)
            else
                deleted.totalWeight();
            clamped_offset = @min(offset, line_end);
        }
        std.debug.assert(line_start <= clamped_offset);
        const col = clamped_offset - line_start;
        return .{ .row = row, .col = col, .desired_col = col, .offset = clamped_offset };
    }

    fn newlineOffset(rope: *const UnifiedRope, row: u32) u32 {
        std.debug.assert(row < rope.root.metrics().custom.newline_count);
        var node = rope.root;
        var newline = row;
        var offset: u32 = 0;
        while (node.* == .branch) {
            const branch = node.branch;
            if (newline < branch.left_metrics.custom.newline_count) {
                node = branch.left;
            } else {
                newline -= branch.left_metrics.custom.newline_count;
                offset += branch.left_metrics.weight();
                node = branch.right;
            }
        }
        return offset;
    }

    pub fn backspace(self: *EditBuffer) !void {
        if (self.cursors.items.len == 0) return;
        const cursor = self.cursors.items[0];

        if (cursor.row == 0 and cursor.col == 0) return;

        if (cursor.col == 0) {
            if (cursor.row > 0) {
                const prev_line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row - 1);
                try self.deleteRange(
                    .{ .row = cursor.row - 1, .col = prev_line_width },
                    .{ .row = cursor.row, .col = 0 },
                );
            }
        } else {
            const prev_grapheme_width = self.tb.getPrevGraphemeWidth(cursor.row, cursor.col);
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

        const line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row);
        const line_count = self.tb.lineCount();

        if (cursor.col >= line_width) {
            if (cursor.row + 1 < line_count) {
                try self.deleteRange(
                    .{ .row = cursor.row, .col = line_width },
                    .{ .row = cursor.row + 1, .col = 0 },
                );
            }
        } else {
            const grapheme_width = self.tb.getGraphemeWidthAt(cursor.row, cursor.col);
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
            const prev_width = self.tb.getPrevGraphemeWidth(cursor.row, cursor.col);
            cursor.col -= prev_width;
        } else if (cursor.row > 0) {
            cursor.row -= 1;
            const line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row);
            cursor.col = line_width;
        }
        cursor.desired_col = cursor.col;
        cursor.offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row, cursor.col) orelse 0;

        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursor-changed");
    }

    pub fn moveRight(self: *EditBuffer) void {
        if (self.cursors.items.len == 0) return;
        const cursor = &self.cursors.items[0];

        const line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row);
        const line_count = self.tb.getLineCount();

        if (cursor.col < line_width) {
            const grapheme_width = self.tb.getGraphemeWidthAt(cursor.row, cursor.col);
            cursor.col += grapheme_width;
        } else if (cursor.row + 1 < line_count) {
            cursor.row += 1;
            cursor.col = 0;
        }
        cursor.desired_col = cursor.col;
        cursor.offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row, cursor.col) orelse 0;

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

            const line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row);

            cursor.col = @min(cursor.desired_col, line_width);
            cursor.offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row, cursor.col) orelse 0;
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

            const line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row);

            cursor.col = @min(cursor.desired_col, line_width);
            cursor.offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row, cursor.col) orelse 0;
        }

        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursor-changed");
    }

    /// Set text and completely reset the buffer state (clears history, resets add_buffer)
    pub fn setText(self: *EditBuffer, text: []const u8) !void {
        const owned_text = try self.allocator.dupe(u8, text);
        const previous_buffer_count = self.tb.mem_registry.buffers.items.len;
        const mem_id = self.tb.registerMemBuffer(owned_text, true) catch |err| {
            self.allocator.free(owned_text);
            return err;
        };
        errdefer self.tb.mem_registry.cancelLastRegistration(mem_id, previous_buffer_count);
        try self.setTextFromMemId(mem_id);
    }

    pub fn setTextBorrowed(self: *EditBuffer, text: []const u8, preferred_id: ?u8) !u8 {
        return self.resetText(text, preferred_id, false);
    }

    pub fn setTextOwned(self: *EditBuffer, text: []const u8, preferred_id: ?u8) !u8 {
        const owned_text = try self.allocator.dupe(u8, text);
        errdefer self.allocator.free(owned_text);
        return self.resetText(owned_text, preferred_id, true);
    }

    fn resetText(self: *EditBuffer, text: []const u8, preferred_id: ?u8, owned: bool) !u8 {
        if (preferred_id) |id| {
            // The live add buffer must remain owned and writable after replacement.
            if (id == self.add_buffer.mem_id or id == 255) return error.InvalidMemId;
        }
        try self.cursors.ensureTotalCapacity(self.allocator, 1);
        const mem_id = try self.tb.replaceText(text, preferred_id, owned);
        self.add_buffer.len = 0;
        self.finishTextReplacement();
        return mem_id;
    }

    /// Set text from memory ID and completely reset the buffer state (clears history, resets add_buffer)
    pub fn setTextFromMemId(self: *EditBuffer, mem_id: u8) !void {
        // This call or its caller may have cleared the text before an allocation failed.
        errdefer if (self.tb.rope().totalWeight() == 0 and self.cursors.items.len > 0) {
            const cursor = &self.cursors.items[0];
            if (cursor.row != 0 or cursor.col != 0 or cursor.offset != 0) {
                cursor.* = .{ .row = 0, .col = 0 };
            }
        };
        try self.cursors.ensureTotalCapacity(self.allocator, 1);
        try self.tb.setTextFromMemId(mem_id);
        self.tb.rope().clear_history();
        self.add_buffer.len = 0;
        self.finishTextReplacement();
    }

    /// Replace text while preserving undo history (creates an undo point)
    pub fn replaceText(self: *EditBuffer, text: []const u8) !void {
        const owned_text = try self.allocator.dupe(u8, text);
        const previous_buffer_count = self.tb.mem_registry.buffers.items.len;
        const mem_id = self.tb.registerMemBuffer(owned_text, true) catch |err| {
            self.allocator.free(owned_text);
            return err;
        };
        errdefer self.tb.mem_registry.cancelLastRegistration(mem_id, previous_buffer_count);
        try self.replaceTextFromMemId(mem_id);
    }

    pub fn replaceTextBorrowed(self: *EditBuffer, text: []const u8) !u8 {
        var meta_buffer: [64]u8 = undefined;
        const meta = try self.encodeCurrentCursorMeta(&meta_buffer);
        try self.cursors.ensureTotalCapacity(self.allocator, 1);
        const previous_buffer_count = self.tb.mem_registry.buffers.items.len;
        const mem_id = try self.tb.registerMemBuffer(text, false);
        errdefer self.tb.mem_registry.cancelLastRegistration(mem_id, previous_buffer_count);
        try self.tb.setTextFromMemIdWithUndo(mem_id, meta);
        self.finishTextReplacement();
        return mem_id;
    }

    /// Replace text from memory ID while preserving undo history (creates an undo point)
    pub fn replaceTextFromMemId(self: *EditBuffer, mem_id: u8) !void {
        errdefer if (self.tb.rope().totalWeight() == 0 and self.cursors.items.len > 0) {
            const cursor = &self.cursors.items[0];
            if (cursor.row != 0 or cursor.col != 0 or cursor.offset != 0) {
                cursor.* = .{ .row = 0, .col = 0 };
            }
        };
        var meta_buffer: [64]u8 = undefined;
        const meta = try self.encodeCurrentCursorMeta(&meta_buffer);
        try self.cursors.ensureTotalCapacity(self.allocator, 1);
        try self.tb.setTextFromMemIdWithUndo(mem_id, meta);
        self.finishTextReplacement();
    }

    fn finishTextReplacement(self: *EditBuffer) void {
        // Capacity is reserved before text acceptance; the origin needs no marker lookup.
        const origin: Cursor = .{ .row = 0, .col = 0 };
        if (self.cursors.items.len == 0) {
            self.cursors.appendAssumeCapacity(origin);
        } else {
            self.cursors.items[0] = origin;
        }
        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursor-changed");
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
            const prev_line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row - 1);
            const curr_line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row);

            try self.deleteRange(
                .{ .row = cursor.row - 1, .col = prev_line_width },
                .{ .row = cursor.row, .col = curr_line_width },
            );

            self.tb.markViewsDirty();

            const new_row = cursor.row - 1;
            const new_col = prev_line_width;
            const new_offset = iter_mod.coordsToOffset(self.tb.rope(), new_row, new_col) orelse 0;
            self.cursors.items[0] = .{ .row = new_row, .col = new_col, .desired_col = new_col, .offset = new_offset };
            self.events.emit(.cursorChanged);
            self.emitNativeEvent("cursor-changed");
        } else {
            const line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row);
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
            const last_line_width = iter_mod.lineWidthAt(self.tb.rope(), target_line);
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

    fn encodeCurrentCursorMeta(self: *EditBuffer, out_buffer: []u8) ![]const u8 {
        const cursor = self.getPrimaryCursor();
        return CursorMeta.fromCursor(cursor, self.tb.tabWidth()).encode(out_buffer);
    }

    fn restoreCursorFromMeta(self: *EditBuffer, meta: []const u8) !bool {
        const decodedMeta = CursorMeta.decode(meta) orelse return false;

        const width_changed = if (decodedMeta.tab_width) |width| width != self.tb.tabWidth() else false;
        const col = if (width_changed)
            self.remapCol(decodedMeta.row, decodedMeta.col, decodedMeta.tab_width.?) orelse decodedMeta.col
        else
            decodedMeta.col;
        try self.setCursor(decodedMeta.row, col);

        if (self.cursors.items.len > 0) {
            self.cursors.items[0].desired_col = if (width_changed and decodedMeta.desired_col == decodedMeta.col)
                col
            else
                decodedMeta.desired_col;
        }

        return true;
    }

    fn autoStoreUndo(self: *EditBuffer) !void {
        var meta_buffer: [64]u8 = undefined;
        const meta = try self.encodeCurrentCursorMeta(meta_buffer[0..]);
        try self.tb.rope().store_undo(meta);
    }

    pub fn undo(self: *EditBuffer) ![]const u8 {
        var current_meta_buffer: [64]u8 = undefined;
        const current_meta = try self.encodeCurrentCursorMeta(current_meta_buffer[0..]);
        const prev_meta = try self.tb.undo(current_meta);

        const restored = try self.restoreCursorFromMeta(prev_meta);

        if (!restored) {
            const cursor = self.getPrimaryCursor();
            try self.setCursor(cursor.row, cursor.col);
        }

        self.tb.markViewsDirty();
        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursorChanged");

        return CursorMeta.publicBytes(prev_meta);
    }

    pub fn redo(self: *EditBuffer) ![]const u8 {
        const next_meta = try self.tb.redo();

        const restored = try self.restoreCursorFromMeta(next_meta);

        if (!restored) {
            const cursor = self.getPrimaryCursor();
            try self.setCursor(cursor.row, cursor.col);
        }

        self.tb.markViewsDirty();
        self.events.emit(.cursorChanged);
        self.emitNativeEvent("cursorChanged");

        return CursorMeta.publicBytes(next_meta);
    }

    pub fn canUndo(self: *const EditBuffer) bool {
        return self.tb.rope().can_undo();
    }

    pub fn canRedo(self: *const EditBuffer) bool {
        return self.tb.rope().can_redo();
    }

    pub fn clearHistory(self: *EditBuffer) void {
        self.tb.rope().clear_history();
    }

    pub fn clear(self: *EditBuffer) !void {
        try self.tb.clear();
        try self.setCursor(0, 0);
        self.emitNativeEvent("content-changed");
    }

    pub fn getNextWordBoundary(self: *EditBuffer) Cursor {
        if (self.cursors.items.len == 0) return .{ .row = 0, .col = 0 };
        const cursor = self.cursors.items[0];

        const line_count = self.tb.lineCount();
        if (cursor.row >= line_count) return cursor;

        const line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row);

        const linestart = self.tb.rope().getMarker(.linestart, cursor.row) orelse return cursor;
        var seg_idx = linestart.leaf_index + 1;
        var cols_before: u32 = 0;
        var passed_cursor = false;
        var previous_word_class: utf8.WordClass = .other;

        while (seg_idx < self.tb.rope().count()) : (seg_idx += 1) {
            const seg = self.tb.rope().get(seg_idx) orelse break;
            if (seg.isBreak() or seg.isLineStart()) break;
            if (seg.asText()) |chunk| {
                const next_cols = cols_before + chunk.width_cols;
                const layout = self.tb.getWordLayoutInfoFor(chunk) catch {
                    cols_before = next_cols;
                    passed_cursor = passed_cursor or cursor.col < next_cols;
                    previous_word_class = .other;
                    continue;
                };

                if (utf8.isCjkAsciiTransition(previous_word_class, layout.word_classes.first) and
                    cols_before > cursor.col and cols_before <= line_width)
                {
                    const offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row, cols_before) orelse cursor.offset;
                    return .{ .row = cursor.row, .col = cols_before, .desired_col = cols_before, .offset = offset };
                }

                // Check this chunk if cursor is within it OR if we've already passed the cursor
                if (cursor.col < next_cols or passed_cursor) {
                    const wrap_breaks = layout.wrap_breaks;

                    // For chunks containing or after the cursor, find the first break after cursor position
                    const local_cursor_col = if (cursor.col > cols_before) cursor.col - cols_before else 0;

                    for (wrap_breaks) |wrap_break| {
                        const break_col = wrap_break.col_start;
                        const target_col = cols_before + wrap_break.colEnd();

                        // If we've passed the cursor chunk, any break is valid
                        // If we're in the cursor chunk, break must be after cursor position
                        if (passed_cursor or break_col > local_cursor_col) {
                            if (target_col > cursor.col and target_col <= line_width) {
                                const offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row, target_col) orelse cursor.offset;
                                return .{ .row = cursor.row, .col = target_col, .desired_col = target_col, .offset = offset };
                            }
                        }

                        // A boundary at the cursor can still be the next word step
                        // for script-transition cases like "a日", "日a", or "丽abc".
                        // Only accept it when the boundary starts on a word codepoint.
                        if (!passed_cursor and break_col == local_cursor_col) {
                            const break_byte_offset: usize = @intCast(wrap_break.byte_start);
                            const chunk_bytes = chunk.getBytes(self.tb.memRegistry());
                            if (break_byte_offset < chunk_bytes.len) {
                                const break_cp = utf8.decodeUtf8Unchecked(chunk_bytes, break_byte_offset).cp;
                                if (utf8.isWordCodepoint(break_cp)) {
                                    if (target_col > cursor.col and target_col <= line_width) {
                                        const offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row, target_col) orelse cursor.offset;
                                        return .{ .row = cursor.row, .col = target_col, .desired_col = target_col, .offset = offset };
                                    }
                                }
                            }
                        }
                    }

                    // Mark that we've processed/passed the cursor position
                    passed_cursor = true;
                }
                previous_word_class = layout.word_classes.last;
                cols_before = next_cols;
            }
        }

        if (cursor.row + 1 < line_count) {
            const offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row + 1, 0) orelse cursor.offset;
            return .{ .row = cursor.row + 1, .col = 0, .desired_col = 0, .offset = offset };
        }

        const offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row, line_width) orelse cursor.offset;
        return .{ .row = cursor.row, .col = line_width, .desired_col = line_width, .offset = offset };
    }

    pub fn getPrevWordBoundary(self: *EditBuffer) Cursor {
        if (self.cursors.items.len == 0) return .{ .row = 0, .col = 0 };
        const cursor = self.cursors.items[0];

        if (cursor.row == 0 and cursor.col == 0) return cursor;

        const linestart = self.tb.rope().getMarker(.linestart, cursor.row) orelse return cursor;
        var seg_idx = linestart.leaf_index + 1;
        var cols_before: u32 = 0;
        var last_boundary: ?u32 = null;
        var previous_word_class: utf8.WordClass = .other;

        while (seg_idx < self.tb.rope().count()) : (seg_idx += 1) {
            const seg = self.tb.rope().get(seg_idx) orelse break;
            if (seg.isBreak() or seg.isLineStart()) break;
            if (seg.asText()) |chunk| {
                const next_cols = cols_before + chunk.width_cols;

                const layout = self.tb.getWordLayoutInfoFor(chunk) catch {
                    cols_before = next_cols;
                    previous_word_class = .other;
                    continue;
                };

                if (utf8.isCjkAsciiTransition(previous_word_class, layout.word_classes.first) and cols_before < cursor.col) {
                    last_boundary = cols_before;
                }

                for (layout.wrap_breaks) |wrap_break| {
                    const boundary_col = cols_before + wrap_break.colEnd();
                    if (boundary_col < cursor.col) {
                        last_boundary = boundary_col;
                    }
                }

                previous_word_class = layout.word_classes.last;
                cols_before = next_cols;
                if (cursor.col <= cols_before) break;
            }
        }

        if (last_boundary) |boundary_col| {
            const offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row, boundary_col) orelse cursor.offset;
            return .{ .row = cursor.row, .col = boundary_col, .desired_col = boundary_col, .offset = offset };
        }

        if (cursor.row > 0) {
            const prev_line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row - 1);
            const offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row - 1, prev_line_width) orelse cursor.offset;
            return .{ .row = cursor.row - 1, .col = prev_line_width, .desired_col = prev_line_width, .offset = offset };
        }

        return .{ .row = 0, .col = 0, .desired_col = 0, .offset = 0 };
    }

    pub fn getEOL(self: *EditBuffer) Cursor {
        if (self.cursors.items.len == 0) return .{ .row = 0, .col = 0 };
        const cursor = self.cursors.items[0];

        const line_count = self.tb.lineCount();
        if (cursor.row >= line_count) return cursor;

        const line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row);
        const offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row, line_width) orelse cursor.offset;

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
