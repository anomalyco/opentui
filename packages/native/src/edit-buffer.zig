const std = @import("std");
const Allocator = std.mem.Allocator;
const tb = @import("text-buffer.zig");
const iter_mod = @import("text-buffer-iterators.zig");
const seg_mod = @import("text-buffer-segment.zig");
const gp = @import("grapheme.zig");
const link = @import("link.zig");

const utf8 = @import("utf8.zig");
const event_emitter = @import("event-emitter.zig");
const text_work = @import("text-work.zig");
const edit_marks = @import("edit-marks.zig");

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

/// Typed notifications for Context. Distinct from EditBufferEvent, which drives
/// EditorView's synchronous cursor listeners.
pub const NativeEvent = enum {
    cursor_changed,
    content_changed,
    history_cursor_changed,
};

pub const NativeEventNotify = struct {
    userdata: *anyopaque,
    callback: *const fn (*anyopaque, NativeEvent) void,
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
    /// Every slot growth registered, so a failed edit releases those after its checkpoint in
    /// reverse. Each growth at least doubles a capacity below 2^32, so 32 entries suffice.
    grown: [32]struct { mem_id: u8, buffer_count: usize } = undefined,
    grown_len: u8 = 0,

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

        // Earlier bytes stay in the old slot; the new slot starts empty.
        const new_cap = @max(self.cap * 2, need);
        const new_mem = try self.allocator.alloc(u8, new_cap);
        errdefer self.allocator.free(new_mem);
        const buffer_count = text_buffer.mem_registry.buffers.items.len;
        const new_mem_id = try text_buffer.registerMemBuffer(new_mem, true);
        self.grown[self.grown_len] = .{ .mem_id = new_mem_id, .buffer_count = buffer_count };
        self.grown_len += 1;
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

    /// Restores the add buffer after a failed edit and releases the slots that growth registered.
    const Checkpoint = struct {
        add_buffer: AddBuffer,

        fn restore(checkpoint: Checkpoint, text_buffer: *UnifiedTextBuffer, add_buffer: *AddBuffer) void {
            while (add_buffer.grown_len > checkpoint.add_buffer.grown_len) {
                add_buffer.grown_len -= 1;
                const grown = add_buffer.grown[add_buffer.grown_len];
                text_buffer.mem_registry.cancelLastRegistration(grown.mem_id, grown.buffer_count);
            }
            add_buffer.* = checkpoint.add_buffer;
        }
    };
};

pub const EditBuffer = struct {
    tb: *UnifiedTextBuffer,
    add_buffer: AddBuffer,
    cursor: Cursor,
    allocator: Allocator,
    events: event_emitter.EventEmitter(EditBufferEvent),
    segment_splitter: UnifiedRope.Node.LeafSplitFn,
    notify: ?NativeEventNotify,
    /// The id of the next mark; ids are never reused, undo included.
    next_mark_id: u32 = 1,

    pub fn init(
        allocator: Allocator,
        pool: *gp.GraphemePool,
        link_pool: *link.LinkPool,
        width_method: utf8.WidthMethod,
        notify: ?NativeEventNotify,
    ) !*EditBuffer {
        return initWithOptions(allocator, pool, link_pool, width_method, notify, .{});
    }

    pub fn initWithOptions(
        allocator: Allocator,
        pool: *gp.GraphemePool,
        link_pool: *link.LinkPool,
        width_method: utf8.WidthMethod,
        notify: ?NativeEventNotify,
        options: UnifiedTextBuffer.InitOptions,
    ) !*EditBuffer {
        const self = try allocator.create(EditBuffer);
        errdefer allocator.destroy(self);

        // A cursor that moves by cell cannot stop on a zero-width control, so editors show notation.
        var text_options = options;
        text_options.control_display = .notation;
        const text_buffer = try UnifiedTextBuffer.initWithOptions(allocator, pool, link_pool, width_method, text_options);
        errdefer text_buffer.deinit();

        const add_buffer = try AddBuffer.init(allocator, text_buffer, 65536);

        self.* = .{
            .tb = text_buffer,
            .add_buffer = add_buffer,
            .cursor = .{ .row = 0, .col = 0 },
            .allocator = allocator,
            .events = event_emitter.EventEmitter(EditBufferEvent).init(allocator),
            .segment_splitter = .{ .ctx = self, .splitFn = splitSegmentCallback, .joinFn = joinSegmentCallback },
            .notify = notify,
        };

        return self;
    }

    pub fn deinit(self: *EditBuffer) void {
        const allocator = self.allocator;
        defer allocator.destroy(self);

        // Registry owns all AddBuffer memory, don't free it manually
        self.events.deinit();
        self.tb.deinit();
        self.* = undefined;
    }

    fn emitNativeEvent(self: *const EditBuffer, event: NativeEvent) void {
        if (self.notify) |notify| notify.callback(notify.userdata, event);
    }

    /// Runs the synchronous cursor listeners (editor views) before notifying the Context.
    fn publishCursor(self: *EditBuffer, content_changed: bool) void {
        self.events.emit(.cursorChanged);
        self.emitNativeEvent(.cursor_changed);
        if (content_changed) self.emitNativeEvent(.content_changed);
    }

    pub fn getTextBuffer(self: *EditBuffer) *UnifiedTextBuffer {
        return self.tb;
    }

    pub fn getPrimaryCursor(self: *const EditBuffer) Cursor {
        return self.cursor;
    }

    pub fn setCursor(self: *EditBuffer, row: u32, col: u32) !void {
        const line_count = self.tb.lineCount();
        const clamped_row = @min(row, line_count -| 1);

        const line_width = iter_mod.lineWidthAt(self.tb.rope(), clamped_row);
        const clamped_col = @min(col, line_width);

        const offset = iter_mod.coordsToOffset(self.tb.rope(), clamped_row, clamped_col) orelse 0;

        self.cursor = .{ .row = clamped_row, .col = clamped_col, .desired_col = clamped_col, .offset = offset };

        self.publishCursor(false);
    }

    pub fn setCursorByOffset(self: *EditBuffer, offset: u32) !void {
        const coords = iter_mod.offsetToCoords(self.tb.rope(), offset) orelse iter_mod.Coords{ .row = 0, .col = 0 };
        try self.setCursor(coords.row, coords.col);
    }

    fn remapCol(self: *EditBuffer, row: u32, target_col: u32, old_tab_width: u8) ?u32 {
        var seg_idx = (iter_mod.lineStart(self.tb.rope(), row) orelse return null).leaf_index + 1;
        var old_col: u32 = 0;
        var new_col: u32 = 0;

        while (seg_idx < self.tb.rope().count()) : (seg_idx += 1) {
            const seg = self.tb.rope().get(seg_idx) orelse break;
            if (seg.isBreak() or seg.isLineStart()) break;
            const chunk = seg.asText() orelse continue;
            const bytes = chunk.getBytes(self.tb.memRegistry());
            // The restored root's cached widths use the current policy, not the checkpoint's.
            const next_col = old_col +| utf8.calculateTextWidth(bytes, old_tab_width, self.tb.controlDisplay(), chunk.isAsciiOnly(), self.tb.widthMethod());
            if (target_col <= next_col) {
                const pos = utf8.findPosByWidth(
                    bytes,
                    target_col -| old_col,
                    old_tab_width,
                    self.tb.controlDisplay(),
                    chunk.isAsciiOnly(),
                    false,
                    self.tb.widthMethod(),
                );
                return new_col +| utf8.calculateTextWidth(
                    bytes[0..pos.byte_offset],
                    self.tb.tabWidth(),
                    self.tb.controlDisplay(),
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

        const cursor = &self.cursor;
        const new_col = self.remapCol(cursor.row, cursor.col, old_width) orelse
            @min(cursor.col, iter_mod.lineWidthAt(self.tb.rope(), cursor.row));
        if (cursor.desired_col == cursor.col) cursor.desired_col = new_col;
        cursor.col = new_col;
        cursor.offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row, new_col) orelse 0;

        self.publishCursor(false);
    }

    fn addCheckpoint(self: *const EditBuffer) AddBuffer.Checkpoint {
        return .{ .add_buffer = self.add_buffer };
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

        const result = utf8.findPosByWidth(chunk_bytes, weight, self.tb.tabWidth(), self.tb.controlDisplay(), is_ascii_only, false, self.tb.widthMethod());
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

    /// Keeps chunk boundaries on grapheme boundaries. Contiguous text merges or splits in place;
    /// a grapheme split across other memory is copied to the add buffer. Widths are measured
    /// again, since a grapheme can continue across the join.
    fn joinSegmentCallback(ctx: ?*anyopaque, left: *const Segment, right: *const Segment) error{OutOfMemory}!?UnifiedRope.Node.LeafJoin {
        const self = @as(*EditBuffer, @ptrCast(@alignCast(ctx.?)));
        const l = left.asText() orelse return null;
        const r = right.asText() orelse return null;
        const l_bytes = l.getBytes(self.tb.memRegistry());
        const r_bytes = r.getBytes(self.tb.memRegistry());
        if (Segment.canMerge(left, right)) {
            const span: ?[2]u32 = if (Segment.findJunction(l_bytes, r_bytes, self.tb.widthMethod())) |at| span: {
                const start = l.width_cols - self.tb.measureText(l_bytes[at.tail..]);
                break :span .{ start, start + self.tb.measureText(l_bytes.ptr[at.tail .. l_bytes.len + at.head]) };
            } else null;
            return .{ .joined = .{ .text = self.tb.createChunk(l.mem_id, l.byte_start, r.byte_end) }, .span = span, .more = true };
        }
        const at = Segment.findJunction(l_bytes, r_bytes, self.tb.widthMethod()) orelse {
            // A wcwidth cut inside a regional-indicator pair can re-pair the right piece with the next leaf.
            const cp = utf8.decodeUtf8Unchecked(r_bytes, 0).cp;
            return if (cp >= 0x1F1E6 and cp <= 0x1F1FF) .{ .left = left.*, .joined = right.*, .more = true } else null;
        };
        text_work.add(.grapheme_joins, 1);
        const joined = if (l.mem_id == r.mem_id and l.byte_end == r.byte_start)
            self.tb.createChunk(l.mem_id, l.byte_start + at.tail, r.byte_start + at.head)
        else copy: {
            const len = l_bytes.len - at.tail + at.head;
            self.add_buffer.ensureCapacity(self.tb, len) catch return error.OutOfMemory;
            const added = self.add_buffer.append(l_bytes[at.tail..]);
            _ = self.add_buffer.append(r_bytes[0..at.head]);
            text_work.add(.grapheme_join_bytes, len);
            break :copy self.tb.createChunk(added.mem_id, added.start, added.start + @as(u32, @intCast(len)));
        };
        return .{
            .left = if (at.tail > 0) .{ .text = self.tb.createChunk(l.mem_id, l.byte_start, l.byte_start + at.tail) } else null,
            .joined = .{ .text = joined },
            .span = .{ 0, joined.width_cols },
            .right = if (at.head < r_bytes.len) .{ .text = self.tb.createChunk(r.mem_id, r.byte_start + at.head, r.byte_end) } else null,
            .more = true,
        };
    }

    pub fn insertText(self: *EditBuffer, bytes: []const u8) !void {
        if (bytes.len == 0) return;

        const cursor = self.cursor;
        const insert_offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row, cursor.col) orelse return EditBufferError.InvalidCursor;

        const checkpoint = self.addCheckpoint();
        errdefer checkpoint.restore(self.tb, &self.add_buffer);
        try self.add_buffer.ensureCapacity(self.tb, bytes.len);

        const chunk_ref = self.add_buffer.append(bytes);
        const base_mem_id = chunk_ref.mem_id;
        const base_start = chunk_ref.start;

        var result = try self.tb.textToSegments(self.allocator, bytes, base_mem_id, base_start, false);
        defer result.segments.deinit(result.allocator);

        // Prepare root/end-marker repairs without touching shared history.
        var candidate = self.tb.rope().*;
        const span = try candidate.insertSliceByWeight(insert_offset, insertBias(cursor), result.segments.items, &self.segment_splitter);
        const added_lines = iter_mod.getLineCount(&candidate) - self.tb.lineCount();
        const end = endCursor(.{ .row = cursor.row, .col = cursor.col, .offset = insert_offset }, added_lines, &candidate, span.end);
        var splice = self.editSplice(cursor.row, cursor.col, insert_offset, false);
        const marks = try splice.nextMarks(self.tb.rope().allocator, &candidate);
        try self.autoStoreUndo();
        self.tb.rope().root = candidate.root;
        splice.inserted(self.tb, marks);
        self.cursor = end;

        self.tb.markViewsDirty();
        self.publishCursor(true);
    }

    pub fn deleteRange(self: *EditBuffer, start_cursor: Cursor, end_cursor: Cursor) !void {
        var start = start_cursor;
        var end = end_cursor;
        if (start.row > end.row or (start.row == end.row and start.col > end.col)) {
            const temp = start;
            start = end;
            end = temp;
        }

        const rope = self.tb.rope();
        const empty = start.row == end.row and start.col == end.col;
        const start_offset = iter_mod.coordsToOffset(rope, start.row, start.col) orelse return if (empty) {} else EditBufferError.InvalidCursor;
        const end_offset = iter_mod.coordsToOffset(rope, end.row, end.col) orelse return EditBufferError.InvalidCursor;
        // An empty range holds text only where a line without cells, but with bytes, ends the text.
        if (empty and (start.col > 0 or end_offset < rope.totalWeight() or
            rope.count() == (iter_mod.lineStart(rope, start.row) orelse return).leaf_index + 1)) return;

        const checkpoint = self.addCheckpoint();
        errdefer checkpoint.restore(self.tb, &self.add_buffer);
        var candidate = rope.*;
        const span = try self.replaceByWeight(&candidate, start_offset, end_offset, &.{});
        var splice = self.editSplice(start.row, start.col, start_offset, false);
        const marks = try splice.nextMarks(rope.allocator, &candidate);
        try self.autoStoreUndo();
        self.tb.rope().root = candidate.root;
        splice.deleted(self.tb, marks);

        self.tb.markViewsDirty();
        self.cursor = endCursor(.{ .row = start.row, .col = start.col, .offset = start_offset }, 0, &candidate, deletedCursorOffset(span));

        self.publishCursor(true);
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
        const has_deletion = start_offset != end_offset;

        const checkpoint = self.addCheckpoint();
        errdefer checkpoint.restore(self.tb, &self.add_buffer);
        try self.add_buffer.ensureCapacity(self.tb, bytes.len);
        const chunk_ref = self.add_buffer.append(bytes);
        var segments = try self.tb.textToSegments(self.allocator, bytes, chunk_ref.mem_id, chunk_ref.start, false);
        defer segments.segments.deinit(segments.allocator);

        var deleted = self.tb.rope().*;
        var inserted = deleted;
        var start = self.getPrimaryCursor();
        var deleted_span: UnifiedRope.JoinSpan = undefined;
        var inserted_span: UnifiedRope.JoinSpan = undefined;
        if (has_deletion) {
            const coords = iter_mod.offsetToCoords(self.tb.rope(), start_offset).?;
            start = .{ .row = coords.row, .col = coords.col, .offset = start_offset };
            deleted_span = try self.replaceByWeight(&deleted, start_offset, end_offset, &.{});
            if (bytes.len > 0) inserted_span = try self.replaceByWeight(&inserted, start_offset, end_offset, segments.segments.items);
        } else if (bytes.len > 0) {
            start.offset = iter_mod.coordsToOffset(self.tb.rope(), start.row, start.col) orelse return EditBufferError.InvalidCursor;
            inserted_span = try inserted.insertSliceByWeight(start.offset, insertBias(start), segments.segments.items, &self.segment_splitter);
        }
        const deleted_cursor = if (has_deletion) endCursor(start, 0, &deleted, deletedCursorOffset(deleted_span)) else start;
        const inserted_cursor = if (bytes.len > 0) endCursor(start, iter_mod.getLineCount(&inserted) - iter_mod.getLineCount(&deleted), &inserted, inserted_span.end) else start;

        // Each store_undo allocates a node, a cursor-metadata buffer, and
        // at most one redo branch. Reserve both stores before either can trim
        // shared history. The backing bytes have the rope arena's lifetime.
        const history_step_size = @sizeOf(UnifiedRope.UndoNode) + @alignOf(UnifiedRope.UndoNode) - 1 +
            64 + @sizeOf(UnifiedRope.UndoBranch) + @alignOf(UnifiedRope.UndoBranch) - 1;
        const step_count = @as(usize, @intFromBool(has_deletion)) + @intFromBool(bytes.len > 0);
        const history_storage = try self.tb.rope().allocator.alloc(u8, history_step_size * step_count);
        var history_allocator = std.heap.FixedBufferAllocator.init(history_storage);
        // One splice byte for both steps: seeking the cell again in the deleted text can land
        // elsewhere when the deletion joined graphemes. Both mark versions precede publication.
        // after_delete may set a layer, which the insertion must move too.
        var splice = self.editSplice(start.row, start.col, start.offset, true);
        const deleted_marks = if (has_deletion) try splice.nextMarks(self.tb.rope().allocator, &deleted) else 0;
        const inserted_marks = if (bytes.len > 0) try splice.nextMarks(self.tb.rope().allocator, &inserted) else 0;
        if (has_deletion) {
            self.publishReplacementStep(&deleted, deleted_cursor, history_allocator.allocator());
            splice.deleted(self.tb, deleted_marks);
        }
        after_delete.handle(after_delete.ctx);
        if (bytes.len > 0) {
            self.publishReplacementStep(&inserted, inserted_cursor, history_allocator.allocator());
            splice.inserted(self.tb, inserted_marks);
        }
    }

    /// Where an edit at rope weight `offset` starts in text bytes, and the text's byte count, so
    /// highlight layers and marks can follow each step once its root is published. Free without
    /// either.
    const EditSplice = struct {
        active: bool,
        start_byte: u32 = 0,
        byte_count: u32 = 0,
        /// The marks after the steps that `nextMarks` prepared, and the text bytes after them.
        marks: usize = 0,
        marks_byte_count: u32 = 0,
        /// Whether the edit started with marks: only then does it publish their next version.
        marked: bool = false,

        /// The marks once the text becomes `after`, one step on from the last call: built before
        /// the step publishes, so publishing cannot fail.
        inline fn nextMarks(self: *EditSplice, allocator: Allocator, after: *const UnifiedRope) !usize {
            if (edit_marks.live(self.marks).len == 0) return self.marks;
            return self.prepareMarks(allocator, after);
        }

        fn prepareMarks(self: *EditSplice, allocator: Allocator, after: *const UnifiedRope) !usize {
            text_work.add(.mark_preparations, 1);
            const byte_count = iter_mod.textBytes(&after.root.metrics());
            const before = self.marks_byte_count;
            self.marks = (try edit_marks.splice(allocator, self.marks, self.start_byte, before -| byte_count, byte_count -| before)) orelse self.marks;
            self.marks_byte_count = byte_count;
            return self.marks;
        }

        fn inserted(self: *EditSplice, text_buffer: *UnifiedTextBuffer, marks: usize) void {
            if (!self.active) return;
            const byte_count = text_buffer.getByteSize();
            text_buffer.layers.insertBytes(self.start_byte, byte_count - self.byte_count);
            self.published(text_buffer, byte_count, marks);
        }

        fn deleted(self: *EditSplice, text_buffer: *UnifiedTextBuffer, marks: usize) void {
            if (!self.active) return;
            const byte_count = text_buffer.getByteSize();
            text_buffer.layers.deleteBytes(text_buffer.global_allocator, text_buffer.link_pool, self.start_byte, self.start_byte + (self.byte_count - byte_count));
            self.published(text_buffer, byte_count, marks);
        }

        fn published(self: *EditSplice, text_buffer: *UnifiedTextBuffer, byte_count: u32, marks: usize) void {
            self.byte_count = byte_count;
            if (self.marked) text_buffer.rope().aux = marks;
            text_buffer.assertLayerBoundaries();
            text_buffer.assertMarks();
        }
    };

    inline fn editSplice(self: *const EditBuffer, row: u32, col: u32, offset: u32, always: bool) EditSplice {
        if (!always and self.tb.layers.isEmpty() and self.tb.marks().len == 0) return .{ .active = false };
        return self.activeSplice(row, col, offset);
    }

    fn activeSplice(self: *const EditBuffer, row: u32, col: u32, offset: u32) EditSplice {
        const marks = self.tb.rope().aux;
        // At a line start an edit goes before zero-width text (`insertBias`, `replaceByWeight`);
        // elsewhere after it, where the weight seek lands.
        const start_byte = if (col == 0) self.tb.lineStartByte(row) else self.tb.byteOffsetAtWeight(offset);
        const marks_byte_count = iter_mod.textBytes(&self.tb.rope().root.metrics());
        return .{ .active = true, .start_byte = start_byte, .byte_count = self.tb.getByteSize(), .marks = marks, .marks_byte_count = marks_byte_count, .marked = marks != 0 };
    }

    fn publishReplacementStep(self: *EditBuffer, candidate: *const UnifiedRope, cursor: Cursor, history_allocator: Allocator) void {
        const rope = self.tb.rope();
        const allocator = rope.allocator;
        rope.allocator = history_allocator;
        self.autoStoreUndo() catch unreachable; // Reserved above, including alignment and redo branching.
        rope.allocator = allocator;
        rope.root = candidate.root;
        self.cursor = cursor;
        self.tb.markViewsDirty();
        self.publishCursor(true);
    }

    /// The cursor at `offset` in `after`, an edit at `start` that added `added_lines` lines.
    fn endCursor(start: Cursor, added_lines: u32, after: *const UnifiedRope, offset: u32) Cursor {
        const row = start.row + added_lines;
        const col = if (added_lines == 0) offset - (start.offset - start.col) else offset - iter_mod.lineStart(after, row).?.weight;
        return .{ .row = row, .col = col, .desired_col = col, .offset = offset };
    }

    /// A deletion that joins graphemes leaves the cursor after the joined grapheme (`span.start`
    /// would leave it before). An insert leaves it after the grapheme that holds its end.
    fn deletedCursorOffset(span: UnifiedRope.JoinSpan) u32 {
        return span.end;
    }

    /// An insert goes before zero-width text at a line start and after it elsewhere, as in one chunk.
    fn insertBias(cursor: Cursor) UnifiedRope.Node.Bias {
        return if (cursor.col == 0) .right else .left;
    }

    /// A weight lies on both sides of zero-weight leaves. A range takes those at its start only from a line start,
    /// and those at its end unless it ends at a line start before the text end. Inside a chunk, its split decides.
    fn replaceByWeight(self: *EditBuffer, candidate: *UnifiedRope, start_offset: u32, end_offset: u32, segments: []const Segment) !UnifiedRope.JoinSpan {
        const rope = self.tb.rope();
        const start = iter_mod.offsetToCoords(rope, start_offset) orelse return EditBufferError.InvalidCursor;
        const end = iter_mod.offsetToCoords(rope, end_offset) orelse return EditBufferError.InvalidCursor;
        const end_bias: UnifiedRope.Node.Bias = if (end.col == 0 and end_offset < rope.totalWeight()) .right else .left;
        return candidate.replaceRangeByWeight(start_offset, end_offset, if (start.col == 0) .right else .left, end_bias, segments, &self.segment_splitter);
    }

    pub fn backspace(self: *EditBuffer) !void {
        const cursor = self.cursor;

        if (cursor.col == 0) {
            var start = cursor;
            if (cursor.row > 0) start = .{ .row = cursor.row - 1, .col = iter_mod.lineWidthAt(self.tb.rope(), cursor.row - 1) };
            try self.deleteRange(start, cursor);
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
        const cursor = self.cursor;

        const line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row);
        const line_count = self.tb.lineCount();

        if (cursor.col >= line_width) {
            var end: Cursor = .{ .row = cursor.row, .col = line_width };
            if (cursor.row + 1 < line_count) end = .{ .row = cursor.row + 1, .col = 0 };
            try self.deleteRange(.{ .row = cursor.row, .col = line_width }, end);
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
        self.cursor = self.getPrevCharBoundary();
        self.publishCursor(false);
    }

    /// Where moveLeft puts the cursor: the start of the grapheme before it, or the end of the line above.
    pub fn getPrevCharBoundary(self: *EditBuffer) Cursor {
        var cursor = self.cursor;
        if (cursor.col > 0) {
            cursor.col -= self.tb.getPrevGraphemeWidth(cursor.row, cursor.col);
        } else if (cursor.row > 0) {
            cursor.row -= 1;
            cursor.col = iter_mod.lineWidthAt(self.tb.rope(), cursor.row);
        }
        cursor.desired_col = cursor.col;
        cursor.offset = iter_mod.coordsToOffset(self.tb.rope(), cursor.row, cursor.col) orelse 0;
        return cursor;
    }

    pub fn moveRight(self: *EditBuffer) void {
        const cursor = &self.cursor;

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

        self.publishCursor(false);
    }

    pub fn moveUp(self: *EditBuffer) void {
        if (self.cursor.row > 0) self.moveToRow(self.cursor.row - 1);
        self.publishCursor(false);
    }

    pub fn moveDown(self: *EditBuffer) void {
        if (self.cursor.row + 1 < self.tb.getLineCount()) self.moveToRow(self.cursor.row + 1);
        self.publishCursor(false);
    }

    /// Keeps the desired column, so a later move can return to it.
    fn moveToRow(self: *EditBuffer, row: u32) void {
        const cursor = &self.cursor;
        if (cursor.desired_col == 0) cursor.desired_col = cursor.col;
        cursor.row = row;
        cursor.col = self.snapColumn(row, @min(cursor.desired_col, iter_mod.lineWidthAt(self.tb.rope(), row)));
        cursor.offset = iter_mod.coordsToOffset(self.tb.rope(), row, cursor.col) orelse 0;
    }

    /// Returns the start of the cursor unit (grapheme, code point, or tab) that covers `col`, so a
    /// cursor does not land on the second cell of a wide unit.
    pub fn snapColumn(self: *EditBuffer, row: u32, col: u32) u32 {
        const text = self.tb;
        const bounds = iter_mod.getCursorUnitBoundsAt(text.rope(), text.memRegistry(), row, col, text.tabWidth(), text.controlDisplay(), text.widthMethod());
        return if (bounds) |unit| unit.start else col;
    }

    /// Returns the column that the last vertical move asked for: the unsnapped desired column
    /// when the cursor sits on its snapped start, else the cursor column.
    pub fn unsnappedColumn(self: *EditBuffer) u32 {
        const cursor = self.cursor;
        return if (self.snapColumn(cursor.row, cursor.desired_col) == cursor.col) cursor.desired_col else cursor.col;
    }

    /// Set text and completely reset the buffer state (clears history, resets add_buffer)
    pub fn setText(self: *EditBuffer, text: []const u8) !void {
        _ = try self.setTextOwned(text, null);
    }

    /// Like setText, but reuses the live slot `preferred_id` for the copy when there is one.
    pub fn setTextOwned(self: *EditBuffer, text: []const u8, preferred_id: ?u8) !u8 {
        if (preferred_id) |id| {
            // The live add buffer must remain owned and writable after replacement.
            if (id == self.add_buffer.mem_id or id == 255) return error.InvalidMemId;
        }
        const owned_text = try self.allocator.dupe(u8, text);
        errdefer self.allocator.free(owned_text);
        const mem_id = try self.tb.replaceText(owned_text, preferred_id, true);
        self.add_buffer.len = 0;
        self.finishTextReplacement();
        return mem_id;
    }

    /// Replace text while preserving undo history (creates an undo point). The bytes go to
    /// the add buffer, so a replacement takes no registry slot of its own.
    pub fn replaceText(self: *EditBuffer, text: []const u8) !void {
        var meta_buffer: [64]u8 = undefined;
        const meta = try self.encodeCurrentCursorMeta(&meta_buffer);
        const checkpoint = self.addCheckpoint();
        errdefer checkpoint.restore(self.tb, &self.add_buffer);
        try self.add_buffer.ensureCapacity(self.tb, text.len);
        const added = self.add_buffer.append(text);
        try self.tb.setTextFromMemRangeWithUndo(added.mem_id, added.start, added.end, meta);
        self.finishTextReplacement();
    }

    /// A whole-text replacement leaves no marks; undo restores the ones before it.
    fn finishTextReplacement(self: *EditBuffer) void {
        self.tb.rope().aux = 0;
        self.cursor = .{ .row = 0, .col = 0 };
        self.publishCursor(true);
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
            // deleteRange leaves the cursor at the end of the previous line.
            const prev_line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row - 1);
            const curr_line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row);
            try self.deleteRange(
                .{ .row = cursor.row - 1, .col = prev_line_width },
                .{ .row = cursor.row, .col = curr_line_width },
            );
        } else {
            const line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row);
            try self.deleteRange(
                .{ .row = cursor.row, .col = 0 },
                .{ .row = cursor.row, .col = line_width },
            );
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

    fn autoStoreUndo(self: *EditBuffer) !void {
        var meta_buffer: [64]u8 = undefined;
        const meta = try self.encodeCurrentCursorMeta(meta_buffer[0..]);
        try self.tb.rope().store_undo(meta);
    }

    pub fn undo(self: *EditBuffer) ![]const u8 {
        var meta_buffer: [64]u8 = undefined;
        const meta = try self.encodeCurrentCursorMeta(&meta_buffer);
        return self.restoreHistoryStep(try self.tb.undo(meta));
    }

    pub fn redo(self: *EditBuffer) ![]const u8 {
        return self.restoreHistoryStep(try self.tb.redo());
    }

    /// Moves the cursor to a restored step's metadata and returns its public part.
    fn restoreHistoryStep(self: *EditBuffer, meta: []const u8) ![]const u8 {
        const current = self.getPrimaryCursor();
        // Unknown metadata keeps the cursor, clamped to the restored text.
        const decoded = CursorMeta.decode(meta) orelse
            CursorMeta{ .row = current.row, .col = current.col, .desired_col = current.col };
        const width_changed = if (decoded.tab_width) |width| width != self.tb.tabWidth() else false;
        const col = if (width_changed)
            self.remapCol(decoded.row, decoded.col, decoded.tab_width.?) orelse decoded.col
        else
            decoded.col;
        try self.setCursor(decoded.row, col);
        self.cursor.desired_col = if (width_changed and decoded.desired_col == decoded.col)
            col
        else
            decoded.desired_col;

        self.tb.markViewsDirty();
        self.emitNativeEvent(.content_changed);
        self.emitNativeEvent(.history_cursor_changed);
        return CursorMeta.publicBytes(meta);
    }

    pub fn canUndo(self: *const EditBuffer) bool {
        return self.tb.rope().can_undo();
    }

    /// `clear` replaces the root without an undo point, which leaves the redo branch unusable.
    pub fn canRedo(self: *const EditBuffer) bool {
        const rope = self.tb.rope();
        return rope.can_redo() and rope.curr_history.?.root == rope.root;
    }

    pub fn clearHistory(self: *EditBuffer) void {
        self.tb.rope().clear_history();
    }

    pub fn clear(self: *EditBuffer) !void {
        try self.tb.clear();
        self.tb.rope().aux = 0;
        try self.setCursor(0, 0);
        self.emitNativeEvent(.content_changed);
    }

    pub const MarkOptions = struct {
        kind: u32 = 0,
        atomic: bool = false,
        /// A SyntaxStyle id, unless `style_value` is set.
        style: u32 = 0,
        style_value: ?tb.StyleDefinition = null,
        priority: u32 = 0,
        /// Cursor offsets, `start <= end`; past the text they mean its end.
        start: u32,
        end: u32,
    };

    /// Adds a mark and returns its id.
    pub fn addMark(self: *EditBuffer, options: MarkOptions) !u32 {
        std.debug.assert(options.start <= options.end);
        const rope = self.tb.rope();
        if (self.tb.marks().len == edit_marks.count_max or self.next_mark_id == std.math.maxInt(u32)) return error.ObjectLimit;
        const style = if (options.style_value) |value| try self.tb.internMarkStyle(value) else options.style;
        const mark: edit_marks.Mark = .{
            .id = self.next_mark_id,
            .kind = options.kind,
            .style = style,
            .start_byte = self.tb.byteAtOffset(options.start),
            .end_byte = self.tb.byteAtOffset(options.end),
            .priority = options.priority,
            .atomic = options.atomic,
            .style_value = options.style_value != null,
        };
        self.setMarks(try edit_marks.add(rope.allocator, rope.aux, rope.aux_owned, mark));
        self.next_mark_id += 1;
        return mark.id;
    }

    /// Removes mark `id`; returns whether there was one.
    pub fn removeMark(self: *EditBuffer, id: u32) !bool {
        const rope = self.tb.rope();
        self.setMarks((try edit_marks.remove(rope.allocator, rope.aux, rope.aux_owned, id)) orelse return false);
        return true;
    }

    /// Removes every mark; undo can restore them with the text they belong to.
    pub fn clearMarks(self: *EditBuffer) void {
        const rope = self.tb.rope();
        if (self.tb.marks().len > 0) self.setMarks(edit_marks.clear(rope.aux, rope.aux_owned));
    }

    /// A mark operation's version is the buffer's alone until history stores or loads one.
    fn setMarks(self: *EditBuffer, marks: usize) void {
        self.tb.rope().aux = marks;
        self.tb.rope().aux_owned = true;
        self.tb.assertMarks();
        self.tb.span_generation += 1;
    }

    /// The cursor offsets of `mark`: its start rounds down and its end up to a cursor stop.
    pub fn markOffsets(self: *const EditBuffer, mark: edit_marks.Mark) struct { start: u32, end: u32 } {
        return .{ .start = self.tb.weightAtByte(mark.start_byte, true), .end = self.tb.weightAtByte(mark.end_byte, false) };
    }

    // The cursor rules around atomic marks (tracks/c5-native-marks.md, C5.3). Of overlapping marks the
    // rules take the oldest (lowest id) first; every move ends outside all of them.

    pub const Toward = enum { nearer, end, start };
    const Span = struct { start: u32, end: u32 };

    /// The oldest atomic mark that contains `at`, starts at or after `start_min` and ends at or before `end_max`.
    fn oldestAtomic(self: *const EditBuffer, at: u32, start_min: u32, end_max: u32) ?Span {
        var found: ?Span = null;
        var found_id: u32 = std.math.maxInt(u32);
        for (self.tb.marks()) |mark| {
            if (!mark.atomic or mark.id > found_id) continue;
            const span = self.markOffsets(mark);
            if (span.start <= at and at < span.end and span.start >= start_min and span.end <= end_max) {
                found = .{ .start = span.start, .end = span.end };
                found_id = mark.id;
            }
        }
        return found;
    }

    /// Where a plain Left from `offset` goes: a unit back, or to the end of the line above.
    fn prevStop(self: *EditBuffer, offset: u32) u32 {
        const at = iter_mod.offsetToCoords(self.tb.rope(), offset) orelse return offset;
        return if (at.col > 0) offset - self.tb.getPrevGraphemeWidth(at.row, at.col) else offset -| 1;
    }

    /// One unit before the marks that surround `start`: Left steps over one chip. A chip that touches it
    /// there stops it at the touching edge.
    fn unitBefore(self: *EditBuffer, start: u32) u32 {
        const s = self.outside(start, false);
        const p = self.prevStop(s);
        return if (self.oldestAtomic(p, 0, std.math.maxInt(u32)) != null) s else p;
    }

    /// The first offset from `offset` toward the end or the start that no atomic mark surrounds.
    fn outside(self: *const EditBuffer, offset: u32, to_end: bool) u32 {
        var x = offset;
        var moved = true;
        while (moved) {
            moved = false;
            for (self.tb.marks()) |mark| {
                if (!mark.atomic) continue;
                const span = self.markOffsets(mark);
                if (span.start < x and x < span.end) {
                    x = if (to_end) span.end else span.start;
                    moved = true;
                }
            }
        }
        return x;
    }

    /// Moves the cursor to the start of the unit it is in, then, when atomic marks surround it, to the outer
    /// edge of them toward `toward`.
    pub fn keepOutside(self: *EditBuffer, toward: Toward) !void {
        const col = self.snapColumn(self.cursor.row, self.cursor.col);
        if (col != self.cursor.col) try self.setCursor(self.cursor.row, col);
        const c = self.cursor.offset;
        const start = self.outside(c, false);
        if (start == c) return;
        const end = self.outside(c, true);
        const to_end = switch (toward) {
            .nearer => end - c <= c - start,
            .end => true,
            .start => false,
        };
        try self.setCursorByOffset(if (to_end) end else start);
    }

    /// Left from an atomic mark's end goes one unit before it; Right from its start, or from one cell before it,
    /// to its end. Each steps over one chip; a move ends outside every mark.
    pub fn moveAtomic(self: *EditBuffer, right: bool) !void {
        const c = self.cursor.offset;
        const mark = if (right) self.oldestAtomic(c + 1, c, std.math.maxInt(u32)) else if (c > 0) self.oldestAtomic(c - 1, 0, c) else null;
        if (mark) |m| {
            try self.setCursorByOffset(if (right) m.end else self.unitBefore(m.start));
        } else if (right) self.moveRight() else self.moveLeft();
        try self.keepOutside(if (right) .end else .start);
    }

    /// Moves to `offset`, past an atomic mark there as Left and Right do.
    pub fn setCursorByOffsetAtomic(self: *EditBuffer, offset: u32) !void {
        const c = self.cursor.offset;
        const mark = if (offset > c) self.oldestAtomic(offset, c, std.math.maxInt(u32)) else if (offset < c) self.oldestAtomic(offset, 0, c) else null;
        try self.setCursorByOffset(if (mark) |m| (if (offset > c) m.end else self.unitBefore(m.start)) else offset);
        try self.keepOutside(if (offset > c) .end else if (offset < c) .start else .nearer);
    }

    /// After a vertical move from `from` into an atomic mark: nearer its start, one unit before it, nearer its
    /// end, past it; but Down never goes back to or before `from`, and Up never forward to or past it.
    pub fn leaveAtomic(self: *EditBuffer, from: u32, down: bool) !void {
        const c = self.cursor.offset;
        if (self.oldestAtomic(c, 0, std.math.maxInt(u32))) |mark| {
            const p = self.prevStop(mark.start);
            const end = self.outside(mark.end, true);
            const to_start = if (c - mark.start < mark.end - c) !down or p > from else !down and end >= from;
            try self.setCursorByOffset(if (to_start) self.outside(p, down) else end);
        }
        try self.keepOutside(if (down) .end else .start);
    }

    /// Backspace at an atomic mark's end or Delete at its start deletes the whole mark as one edit; of marks
    /// with that edge there, the oldest.
    pub fn deleteAtomic(self: *EditBuffer, forward_delete: bool) !void {
        const c = self.cursor.offset;
        const mark = if (forward_delete) self.oldestAtomic(c, c, std.math.maxInt(u32)) else if (c > 0) self.oldestAtomic(c - 1, 0, c) else null;
        if (mark) |m| {
            const rope = self.tb.rope();
            const start = iter_mod.offsetToCoords(rope, m.start).?;
            const end = iter_mod.offsetToCoords(rope, m.end).?;
            try self.deleteRange(.{ .row = start.row, .col = start.col }, .{ .row = end.row, .col = end.col });
        } else if (forward_delete) try self.deleteForward() else try self.backspace();
        // A delete that joins graphemes can move a mark's edge across the cursor.
        try self.keepOutside(.nearer);
    }

    pub fn getNextWordBoundary(self: *EditBuffer) Cursor {
        const cursor = self.cursor;

        const line_count = self.tb.lineCount();
        if (cursor.row >= line_count) return cursor;

        const line_width = iter_mod.lineWidthAt(self.tb.rope(), cursor.row);

        var seg_idx = (iter_mod.lineStart(self.tb.rope(), cursor.row) orelse return cursor).leaf_index + 1;
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
        const cursor = self.cursor;

        if (cursor.row == 0 and cursor.col == 0) return cursor;

        var seg_idx = (iter_mod.lineStart(self.tb.rope(), cursor.row) orelse return cursor).leaf_index + 1;
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
        const cursor = self.cursor;

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
