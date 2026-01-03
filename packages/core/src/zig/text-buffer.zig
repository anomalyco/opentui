const std = @import("std");
const Allocator = std.mem.Allocator;
const seg_mod = @import("text-buffer-segment.zig");
const iter_mod = @import("text-buffer-iterators.zig");
const mem_registry_mod = @import("mem-registry.zig");
const ss = @import("syntax-style.zig");
const gp = @import("grapheme.zig");

const utf8 = @import("utf8.zig");
const utils = @import("utils.zig");

const logger = @import("logger.zig");

const Segment = seg_mod.Segment;
const UnifiedRope = seg_mod.UnifiedRope;
const LineInfo = iter_mod.LineInfo;

// Re-export types from segment module
pub const TextChunk = seg_mod.TextChunk;
pub const MemRegistry = mem_registry_mod.MemRegistry;
pub const RGBA = seg_mod.RGBA;
pub const TextSelection = seg_mod.TextSelection;
pub const TextBufferError = seg_mod.TextBufferError;
pub const Highlight = seg_mod.Highlight;
pub const StyleSpan = seg_mod.StyleSpan;
pub const WrapMode = seg_mod.WrapMode;
pub const ChunkFitResult = seg_mod.ChunkFitResult;
pub const GraphemeInfo = seg_mod.GraphemeInfo;

pub const SyntaxStyle = ss.SyntaxStyle;

pub const TextBuffer = UnifiedTextBuffer;

pub const StyledChunk = extern struct {
    text_ptr: [*]const u8,
    text_len: usize,
    fg_ptr: ?[*]const f32,
    bg_ptr: ?[*]const f32,
    attributes: u32,
};

pub const UnifiedTextBuffer = struct {
    const Self = @This();

    mem_registry: MemRegistry,
    default_fg: ?RGBA,
    default_bg: ?RGBA,
    default_attributes: ?u32,

    allocator: Allocator,
    global_allocator: Allocator,
    arena: *std.heap.ArenaAllocator,

    rope: UnifiedRope,
    syntax_style: ?*const SyntaxStyle,

    pool: *gp.GraphemePool,

    width_method: utf8.WidthMethod,

    view_dirty_flags: std.ArrayListUnmanaged(bool),
    next_view_id: u32,
    free_view_ids: std.ArrayListUnmanaged(u32),

    // Per-line highlight cache (invalidated on edits)
    // Maps line_idx to highlights for that line
    line_highlights: std.ArrayListUnmanaged(std.ArrayListUnmanaged(Highlight)),
    line_spans: std.ArrayListUnmanaged(std.ArrayListUnmanaged(StyleSpan)),
    highlight_batch_depth: u32,
    dirty_span_lines: std.AutoHashMap(usize, void),

    styled_text_mem_id: ?u8,
    styled_buffer: ?[]u8,
    styled_capacity: usize,

    tab_width: u8,

    pub fn init(
        global_allocator: Allocator,
        pool: *gp.GraphemePool,
        width_method: utf8.WidthMethod,
    ) TextBufferError!*Self {
        const self = global_allocator.create(Self) catch return TextBufferError.OutOfMemory;
        errdefer global_allocator.destroy(self);

        const internal_arena = global_allocator.create(std.heap.ArenaAllocator) catch return TextBufferError.OutOfMemory;
        errdefer global_allocator.destroy(internal_arena);
        internal_arena.* = std.heap.ArenaAllocator.init(global_allocator);

        const internal_allocator = internal_arena.allocator();

        const rope = UnifiedRope.init(internal_allocator) catch return TextBufferError.OutOfMemory;

        var view_dirty_flags: std.ArrayListUnmanaged(bool) = .{};
        errdefer view_dirty_flags.deinit(global_allocator);

        var free_view_ids: std.ArrayListUnmanaged(u32) = .{};
        errdefer free_view_ids.deinit(global_allocator);

        var mem_registry = MemRegistry.init(global_allocator);
        errdefer mem_registry.deinit();

        var dirty_span_lines = std.AutoHashMap(usize, void).init(global_allocator);
        errdefer dirty_span_lines.deinit();

        self.* = .{
            .mem_registry = mem_registry,
            .default_fg = null,
            .default_bg = null,
            .default_attributes = null,
            .allocator = internal_allocator,
            .global_allocator = global_allocator,
            .arena = internal_arena,
            .rope = rope,
            .syntax_style = null,
            .pool = pool,
            .width_method = width_method,
            .view_dirty_flags = view_dirty_flags,
            .next_view_id = 0,
            .free_view_ids = free_view_ids,
            .line_highlights = .{},
            .line_spans = .{},
            .highlight_batch_depth = 0,
            .dirty_span_lines = dirty_span_lines,
            .styled_text_mem_id = null,
            .styled_buffer = null,
            .styled_capacity = 0,
            .tab_width = 2,
        };

        return self;
    }

    pub fn deinit(self: *Self) void {
        if (self.syntax_style) |style| {
            (@constCast(style)).offDestroy(@ptrCast(self), onSyntaxStyleDestroyed);
        }

        self.view_dirty_flags.deinit(self.global_allocator);
        self.free_view_ids.deinit(self.global_allocator);

        // Free highlight/span caches
        for (self.line_highlights.items) |*hl_list| {
            hl_list.deinit(self.global_allocator);
        }
        self.line_highlights.deinit(self.global_allocator);

        for (self.line_spans.items) |*span_list| {
            span_list.deinit(self.global_allocator);
        }
        self.line_spans.deinit(self.global_allocator);

        // Free dirty span lines hashmap
        self.dirty_span_lines.deinit();

        // Free persistent styled text buffer
        if (self.styled_buffer) |buf| {
            self.global_allocator.free(buf);
        }

        self.mem_registry.deinit();
        self.arena.deinit();
        self.global_allocator.destroy(self.arena);
        self.global_allocator.destroy(self);
    }

    // View registration (same as original)
    pub fn registerView(self: *Self) TextBufferError!u32 {
        if (self.free_view_ids.items.len > 0) {
            const id = self.free_view_ids.items[self.free_view_ids.items.len - 1];
            _ = self.free_view_ids.pop();
            self.view_dirty_flags.items[id] = true;
            return id;
        }

        const id = self.next_view_id;
        self.next_view_id += 1;
        try self.view_dirty_flags.append(self.global_allocator, true);
        return id;
    }

    pub fn unregisterView(self: *Self, view_id: u32) void {
        if (view_id < self.view_dirty_flags.items.len) {
            self.free_view_ids.append(self.global_allocator, view_id) catch {};
        }
    }

    pub fn isViewDirty(self: *const Self, view_id: u32) bool {
        if (view_id < self.view_dirty_flags.items.len) {
            return self.view_dirty_flags.items[view_id];
        }
        return false;
    }

    pub fn clearViewDirty(self: *Self, view_id: u32) void {
        if (view_id < self.view_dirty_flags.items.len) {
            self.view_dirty_flags.items[view_id] = false;
        }
    }

    fn markAllViewsDirty(self: *Self) void {
        for (self.view_dirty_flags.items) |*flag| {
            flag.* = true;
        }
    }

    pub fn markViewsDirty(self: *Self) void {
        self.markAllViewsDirty();
    }

    // Basic queries using unified rope
    pub fn getLength(self: *const Self) u32 {
        const metrics = self.rope.root.metrics();
        return metrics.custom.total_width;
    }

    pub fn getByteSize(self: *const Self) u32 {
        const metrics = self.rope.root.metrics();
        const total_bytes = metrics.custom.total_bytes;

        // Add newlines between lines (line_count - 1)
        const line_count = iter_mod.getLineCount(&self.rope);
        if (line_count > 0) {
            return total_bytes + (line_count - 1); // newlines
        }
        return total_bytes;
    }

    pub fn measureText(self: *const Self, text: []const u8) u32 {
        // For grapheme-accurate width calculation (used by highlighting system),
        // use utf8.calculateTextWidth which properly handles grapheme clusters
        const is_ascii = utf8.isAsciiOnly(text);
        return utf8.calculateTextWidth(text, self.tab_width, is_ascii, self.width_method);
    }

    /// Clear the text content without resetting arena or memory registry.
    /// Preserves highlights, memory buffers, and arena allocations.
    /// Use this for frequent text updates where undo/redo history should be preserved.
    pub fn clear(self: *Self) void {
        self.rope.clear();
        self.markAllViewsDirty();
    }

    /// Reset rope storage before replacing full text.
    fn resetForSetText(self: *Self) TextBufferError!void {
        _ = self.arena.reset(.retain_capacity);
        self.rope = UnifiedRope.init(self.allocator) catch return TextBufferError.OutOfMemory;
        self.markAllViewsDirty();
    }

    pub fn reset(self: *Self) void {
        // Free highlight/span arrays (they use global_allocator, not arena)
        for (self.line_highlights.items) |*hl_list| {
            hl_list.deinit(self.global_allocator);
        }
        self.line_highlights.clearRetainingCapacity();

        for (self.line_spans.items) |*span_list| {
            span_list.deinit(self.global_allocator);
        }
        self.line_spans.clearRetainingCapacity();

        // Free persistent styled text buffer
        if (self.styled_buffer) |buf| {
            self.global_allocator.free(buf);
        }
        self.styled_buffer = null;
        self.styled_text_mem_id = null;
        self.styled_capacity = 0;

        // Now reset the arena (frees all the internal memory)
        _ = self.arena.reset(if (self.arena.queryCapacity() > 0) .retain_capacity else .free_all);

        self.mem_registry.clear();

        self.rope = UnifiedRope.init(self.allocator) catch return;

        self.markAllViewsDirty();
    }

    // Default colors/attributes
    pub fn setDefaultFg(self: *Self, fg: ?RGBA) void {
        self.default_fg = fg;
    }

    pub fn setDefaultBg(self: *Self, bg: ?RGBA) void {
        self.default_bg = bg;
    }

    pub fn setDefaultAttributes(self: *Self, attributes: ?u32) void {
        self.default_attributes = attributes;
    }

    pub fn resetDefaults(self: *Self) void {
        self.default_fg = null;
        self.default_bg = null;
        self.default_attributes = null;
    }

    fn onSyntaxStyleDestroyed(ctx_ptr: *anyopaque) void {
        const self = @as(*Self, @ptrCast(@alignCast(ctx_ptr)));
        self.syntax_style = null;
    }

    pub fn setSyntaxStyle(self: *Self, syntax_style: ?*const SyntaxStyle) void {
        if (self.syntax_style) |prev| {
            (@constCast(prev)).offDestroy(@ptrCast(self), onSyntaxStyleDestroyed);
        }
        self.syntax_style = syntax_style;
        if (syntax_style) |style| {
            _ = (@constCast(style)).onDestroy(@ptrCast(self), onSyntaxStyleDestroyed) catch {};
        }
    }

    pub fn getSyntaxStyle(self: *const Self) ?*const SyntaxStyle {
        return self.syntax_style;
    }

    /// Set the text content using SIMD-optimized line break detection
    pub fn setText(self: *Self, text: []const u8) TextBufferError!void {
        self.clear();
        const mem_id = try self.mem_registry.register(text, false);
        try self.setTextInternal(mem_id, text);
    }

    /// Set text from a pre-registered memory ID
    pub fn setTextFromMemId(self: *Self, mem_id: u8) TextBufferError!void {
        const text = self.mem_registry.get(mem_id) orelse return TextBufferError.InvalidMemId;
        self.clear();
        try self.setTextInternal(mem_id, text);
    }

    /// Set text from a pre-registered memory ID with a rope reset to avoid arena growth.
    pub fn setTextFromMemIdReset(self: *Self, mem_id: u8) TextBufferError!void {
        const text = self.mem_registry.get(mem_id) orelse return TextBufferError.InvalidMemId;
        try self.resetForSetText();
        try self.setTextInternal(mem_id, text);
    }

    /// Append text to the end of the buffer without clearing
    pub fn append(self: *Self, text: []const u8) TextBufferError!void {
        if (text.len == 0) {
            return;
        }

        const mem_id = try self.mem_registry.register(text, false);
        try self.appendInternal(mem_id, text);
    }

    /// Append text from a pre-registered memory ID
    pub fn appendFromMemId(self: *Self, mem_id: u8) TextBufferError!void {
        const text = self.mem_registry.get(mem_id) orelse return TextBufferError.InvalidMemId;
        try self.appendInternal(mem_id, text);
    }

    /// Internal append that doesn't register memory
    fn appendInternal(self: *Self, mem_id: u8, text: []const u8) TextBufferError!void {
        if (text.len == 0) {
            return;
        }

        // The rope's boundary rewrite will handle normalization at join points
        var result = try self.textToSegments(self.global_allocator, text, mem_id, 0, false);
        defer result.segments.deinit();

        const insert_pos = self.rope.count();
        try self.rope.insert_slice(insert_pos, result.segments.items);

        self.markAllViewsDirty();
    }

    /// Internal setText that doesn't call clear (for use by setStyledText)
    fn setTextInternal(self: *Self, mem_id: u8, text: []const u8) TextBufferError!void {
        if (text.len == 0) {
            self.markAllViewsDirty();
            return;
        }

        var result = try self.textToSegments(self.global_allocator, text, mem_id, 0, true);
        defer result.segments.deinit();

        try self.rope.setSegments(result.segments.items);

        self.markAllViewsDirty();
    }

    /// Create a TextChunk from a memory buffer range
    pub fn createChunk(
        self: *const Self,
        mem_id: u8,
        byte_start: u32,
        byte_end: u32,
    ) TextChunk {
        const mem_buf = self.mem_registry.get(mem_id).?;
        const chunk_bytes = mem_buf[byte_start..byte_end];
        const is_ascii = utf8.isAsciiOnly(chunk_bytes);

        var flags: u8 = 0;
        if (chunk_bytes.len > 0 and is_ascii) {
            flags |= TextChunk.Flags.ASCII_ONLY;
        }

        const chunk_width: u16 = @intCast(@min(65535, utf8.calculateTextWidth(chunk_bytes, self.tab_width, is_ascii, self.width_method)));

        return TextChunk{
            .mem_id = mem_id,
            .byte_start = byte_start,
            .byte_end = byte_end,
            .width = chunk_width,
            .flags = flags,
        };
    }

    /// Convert text to segments with line breaks
    /// Returns segments array and total width
    pub fn textToSegments(
        self: *const Self,
        allocator: Allocator,
        text: []const u8,
        mem_id: u8,
        byte_offset: u32,
        prepend_linestart: bool,
    ) TextBufferError!struct { segments: std.ArrayList(Segment), total_width: u32 } {
        var break_result = utf8.LineBreakResult.init(allocator);
        defer break_result.deinit();
        try utf8.findLineBreaks(text, &break_result);

        var segments = std.ArrayList(Segment).init(allocator);
        errdefer segments.deinit();

        if (prepend_linestart) {
            try segments.append(Segment{ .linestart = {} });
        }

        var local_start: u32 = 0;
        var total_width: u32 = 0;

        for (break_result.breaks.items) |line_break| {
            const break_pos: u32 = @intCast(line_break.pos);
            const local_end: u32 = switch (line_break.kind) {
                .CRLF => break_pos - 1,
                .CR, .LF => break_pos,
            };

            if (local_end > local_start) {
                const chunk = self.createChunk(mem_id, byte_offset + local_start, byte_offset + local_end);
                try segments.append(Segment{ .text = chunk });
                total_width += chunk.width;
            }

            try segments.append(Segment{ .brk = {} });
            try segments.append(Segment{ .linestart = {} });

            local_start = break_pos + 1;
        }

        if (local_start < text.len) {
            const chunk = self.createChunk(mem_id, byte_offset + local_start, byte_offset + @as(u32, @intCast(text.len)));
            try segments.append(Segment{ .text = chunk });
            total_width += chunk.width;
        }

        return .{ .segments = segments, .total_width = total_width };
    }

    pub fn getLineCount(self: *const Self) u32 {
        const count = self.rope.count();
        if (count == 0) return 0; // Truly empty (after reset)
        return iter_mod.getLineCount(&self.rope);
    }

    pub fn lineCount(self: *const Self) u32 {
        return self.getLineCount();
    }

    /// Register a memory buffer
    pub fn registerMemBuffer(self: *Self, data: []const u8, owned: bool) TextBufferError!u8 {
        return try self.mem_registry.register(data, owned);
    }

    pub fn getMemBuffer(self: *const Self, mem_id: u8) ?[]const u8 {
        return self.mem_registry.get(mem_id);
    }

    /// Add a line from a memory buffer (for compatibility with old API)
    /// Note: This is not as efficient as setText for bulk operations
    /// Adds text segment with a break separator before it (if not the first line)
    pub fn addLine(
        self: *Self,
        mem_id: u8,
        byte_start: u32,
        byte_end: u32,
    ) TextBufferError!void {
        _ = self.mem_registry.get(mem_id) orelse return TextBufferError.InvalidMemId;

        const chunk = self.createChunk(mem_id, byte_start, byte_end);

        const had_content = self.rope.count() > 1;

        if (had_content) {
            try self.rope.append(Segment{ .brk = {} });
            try self.rope.append(Segment{ .linestart = {} });
        }

        try self.rope.append(Segment{ .text = chunk });

        self.markAllViewsDirty();
    }

    pub fn getArenaAllocatedBytes(self: *const Self) usize {
        return self.arena.queryCapacity();
    }

    pub fn getRopeSegmentCount(self: *const Self) usize {
        return self.rope.count();
    }

    pub fn getMemRegistryUsedSlots(self: *const Self) usize {
        return self.mem_registry.getUsedSlots();
    }

    pub fn getMemRegistryFreeSlots(self: *const Self) usize {
        return self.mem_registry.getFreeSlots();
    }

    pub fn getStyledCapacity(self: *const Self) usize {
        return self.styled_capacity;
    }

    pub fn getHighlightLineCount(self: *const Self) usize {
        return self.line_highlights.items.len;
    }

    pub fn getHighlightLineCapacity(self: *const Self) usize {
        return self.line_highlights.capacity;
    }

    pub fn getHighlightCapacityTotal(self: *const Self) usize {
        var total: usize = 0;
        for (self.line_highlights.items) |hl_list| {
            total += hl_list.capacity;
        }
        return total;
    }

    pub fn getSpanLineCount(self: *const Self) usize {
        return self.line_spans.items.len;
    }

    pub fn getSpanLineCapacity(self: *const Self) usize {
        return self.line_spans.capacity;
    }

    pub fn getSpanCapacityTotal(self: *const Self) usize {
        var total: usize = 0;
        for (self.line_spans.items) |span_list| {
            total += span_list.capacity;
        }
        return total;
    }

    pub fn getDirtySpanLineCount(self: *const Self) usize {
        return self.dirty_span_lines.count();
    }

    /// Extract all text as UTF-8 bytes into provided output buffer
    pub fn getPlainTextIntoBuffer(self: *const Self, out_buffer: []u8) usize {
        var out_index: usize = 0;

        const line_count = self.getLineCount();

        const Context = struct {
            buffer: *const UnifiedTextBuffer,
            out_buffer: []u8,
            out_index: *usize,
            line_count: u32,

            fn segmentCallback(ctx_ptr: *anyopaque, line_idx: u32, chunk: *const TextChunk, chunk_idx_in_line: u32) void {
                _ = line_idx;
                _ = chunk_idx_in_line;
                const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
                const chunk_bytes = chunk.getBytes(&ctx.buffer.mem_registry);
                const copy_len = @min(chunk_bytes.len, ctx.out_buffer.len - ctx.out_index.*);
                if (copy_len > 0) {
                    @memcpy(ctx.out_buffer[ctx.out_index.* .. ctx.out_index.* + copy_len], chunk_bytes[0..copy_len]);
                    ctx.out_index.* += copy_len;
                }
            }

            fn lineEndCallback(ctx_ptr: *anyopaque, line_info: LineInfo) void {
                const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
                // Add newline between lines (not after last line)
                if (ctx.line_count > 0 and line_info.line_idx < ctx.line_count - 1 and ctx.out_index.* < ctx.out_buffer.len) {
                    ctx.out_buffer[ctx.out_index.*] = '\n';
                    ctx.out_index.* += 1;
                }
            }
        };

        var ctx = Context{
            .buffer = self,
            .out_buffer = out_buffer,
            .out_index = &out_index,
            .line_count = line_count,
        };
        iter_mod.walkLinesAndSegments(&self.rope, &ctx, Context.segmentCallback, Context.lineEndCallback);

        return out_index;
    }

    pub fn startHighlightsTransaction(self: *Self) void {
        self.highlight_batch_depth += 1;
    }

    pub fn endHighlightsTransaction(self: *Self) void {
        if (self.highlight_batch_depth == 0) return;

        self.highlight_batch_depth -= 1;

        if (self.highlight_batch_depth == 0) {
            var it = self.dirty_span_lines.keyIterator();
            while (it.next()) |line_idx| {
                self.rebuildLineSpans(line_idx.*) catch {};
            }
            self.dirty_span_lines.clearRetainingCapacity();
        }
    }

    fn markLineSpansDirty(self: *Self, line_idx: usize) void {
        self.dirty_span_lines.put(line_idx, {}) catch {};
    }

    // Highlight system
    fn ensureLineHighlightStorage(self: *Self, line_idx: usize) TextBufferError!void {
        while (self.line_highlights.items.len <= line_idx) {
            try self.line_highlights.append(self.global_allocator, .{});
        }
        while (self.line_spans.items.len <= line_idx) {
            try self.line_spans.append(self.global_allocator, .{});
        }
    }

    pub fn addHighlight(
        self: *Self,
        line_idx: usize,
        col_start: u32,
        col_end: u32,
        style_id: u32,
        priority: u8,
        hl_ref: u16,
    ) TextBufferError!void {
        const line_count = self.getLineCount();
        if (line_idx >= line_count) {
            return TextBufferError.InvalidIndex;
        }

        if (col_start >= col_end) {
            return; // Empty range
        }

        try self.ensureLineHighlightStorage(line_idx);

        const hl = Highlight{
            .col_start = col_start,
            .col_end = col_end,
            .style_id = style_id,
            .priority = priority,
            .hl_ref = hl_ref,
        };

        try self.line_highlights.items[line_idx].append(self.global_allocator, hl);

        if (self.highlight_batch_depth == 0) {
            try self.rebuildLineSpans(line_idx);
        } else {
            self.markLineSpansDirty(line_idx);
        }
    }

    pub fn getLineHighlights(self: *const Self, line_idx: usize) []const Highlight {
        if (line_idx < self.line_highlights.items.len) {
            return self.line_highlights.items[line_idx].items;
        }
        return &[_]Highlight{};
    }

    pub fn getLineSpans(self: *const Self, line_idx: usize) []const StyleSpan {
        if (line_idx < self.line_spans.items.len) {
            return self.line_spans.items[line_idx].items;
        }
        return &[_]StyleSpan{};
    }

    fn rebuildLineSpans(self: *Self, line_idx: usize) TextBufferError!void {
        if (line_idx >= self.line_spans.items.len) {
            return TextBufferError.InvalidIndex;
        }

        self.line_spans.items[line_idx].clearRetainingCapacity();

        if (line_idx >= self.line_highlights.items.len or self.line_highlights.items[line_idx].items.len == 0) {
            return; // No highlights
        }

        const highlights = self.line_highlights.items[line_idx].items;

        // Collect all boundary columns
        const Event = struct {
            col: u32,
            is_start: bool,
            hl_idx: usize,
        };

        var events = std.ArrayList(Event).init(self.global_allocator);
        defer events.deinit();

        for (highlights, 0..) |hl, idx| {
            try events.append(.{ .col = hl.col_start, .is_start = true, .hl_idx = idx });
            try events.append(.{ .col = hl.col_end, .is_start = false, .hl_idx = idx });
        }

        // Sort by column, ends before starts at same position
        const sortFn = struct {
            fn lessThan(_: void, a: Event, b: Event) bool {
                if (a.col != b.col) return a.col < b.col;
                if (a.is_start != b.is_start) return !a.is_start; // ends before starts
                // If both are same type at same column, use hl_idx for stable sort
                return a.hl_idx < b.hl_idx;
            }
        }.lessThan;
        std.mem.sort(Event, events.items, {}, sortFn);

        // Build spans by tracking active highlights
        var active = std.AutoHashMap(usize, void).init(self.global_allocator);
        defer active.deinit();

        var current_col: u32 = 0;

        for (events.items) |event| {
            // Find current highest priority style before processing event
            var current_priority: i16 = -1;
            var current_style: u32 = 0;
            var it = active.keyIterator();
            while (it.next()) |hl_idx| {
                const hl = highlights[hl_idx.*];
                if (hl.priority > current_priority) {
                    current_priority = @intCast(hl.priority);
                    current_style = hl.style_id;
                }
            }

            // Emit span for the segment leading up to this event
            if (event.col > current_col) {
                try self.line_spans.items[line_idx].append(self.global_allocator, StyleSpan{
                    .col = current_col,
                    .style_id = current_style,
                    .next_col = event.col,
                });
                current_col = event.col;
            }

            // Process event
            if (event.is_start) {
                try active.put(event.hl_idx, {});
            } else {
                _ = active.remove(event.hl_idx);
            }
        }

        // Emit final span after last event if there were any highlights
        // This ensures the line returns to default styling after the last highlight ends
        if (events.items.len > 0 and active.count() == 0) {
            const line_width = iter_mod.lineWidthAt(&self.rope, @intCast(line_idx));
            if (current_col < line_width) {
                try self.line_spans.items[line_idx].append(self.global_allocator, StyleSpan{
                    .col = current_col,
                    .style_id = 0, // No style (default)
                    .next_col = line_width,
                });
            }
        }
    }

    /// Add highlight by row/col coordinates
    pub fn addHighlightByCoords(
        self: *Self,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
        style_id: u32,
        priority: u8,
        hl_ref: u16,
    ) TextBufferError!void {
        const char_start = iter_mod.coordsToOffset(&self.rope, start_row, start_col) orelse return TextBufferError.InvalidIndex;
        const char_end = iter_mod.coordsToOffset(&self.rope, end_row, end_col) orelse return TextBufferError.InvalidIndex;
        return self.addHighlightByCharRange(char_start, char_end, style_id, priority, hl_ref);
    }

    /// Add highlight by character range
    pub fn addHighlightByCharRange(
        self: *Self,
        char_start: u32,
        char_end: u32,
        style_id: u32,
        priority: u8,
        hl_ref: u16,
    ) TextBufferError!void {
        const line_count = self.getLineCount();
        if (char_start >= char_end or line_count == 0) {
            return;
        }

        // Walk lines to find which lines this highlight affects
        const Context = struct {
            buffer: *Self,
            char_start: u32,
            char_end: u32,
            style_id: u32,
            priority: u8,
            hl_ref: u16,
            start_line_idx: ?usize = null,

            fn callback(ctx_ptr: *anyopaque, line_info: LineInfo) void {
                const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
                const line_start_char = line_info.char_offset;
                const line_end_char = line_info.char_offset + line_info.width;

                // Skip lines before the highlight
                if (line_end_char <= ctx.char_start) return;
                // Stop after the highlight ends
                if (line_start_char >= ctx.char_end) return;

                // This line overlaps with the highlight
                const col_start = if (ctx.char_start > line_start_char)
                    ctx.char_start - line_start_char
                else
                    0;

                const col_end = if (ctx.char_end < line_end_char)
                    ctx.char_end - line_start_char
                else
                    line_info.width;

                ctx.buffer.addHighlight(
                    line_info.line_idx,
                    col_start,
                    col_end,
                    ctx.style_id,
                    ctx.priority,
                    ctx.hl_ref,
                ) catch {};
            }
        };

        var ctx = Context{
            .buffer = self,
            .char_start = char_start,
            .char_end = char_end,
            .style_id = style_id,
            .priority = priority,
            .hl_ref = hl_ref,
        };
        iter_mod.walkLines(&self.rope, &ctx, Context.callback, false);
    }

    /// Remove all highlights with a specific reference ID
    pub fn removeHighlightsByRef(self: *Self, hl_ref: u16) void {
        for (self.line_highlights.items, 0..) |*hl_list, line_idx| {
            var i: usize = 0;
            var changed = false;
            while (i < hl_list.items.len) {
                if (hl_list.items[i].hl_ref == hl_ref) {
                    _ = hl_list.orderedRemove(i);
                    changed = true;
                    continue;
                }
                i += 1;
            }
            if (changed) {
                if (self.highlight_batch_depth == 0) {
                    self.rebuildLineSpans(line_idx) catch {};
                } else {
                    self.markLineSpansDirty(line_idx);
                }
            }
        }
    }

    /// Clear all highlights from a specific line
    pub fn clearLineHighlights(self: *Self, line_idx: usize) void {
        if (line_idx < self.line_highlights.items.len) {
            self.line_highlights.items[line_idx].clearRetainingCapacity();
        }
        if (line_idx < self.line_spans.items.len) {
            self.line_spans.items[line_idx].clearRetainingCapacity();
        }
    }

    /// Clear all highlights
    pub fn clearAllHighlights(self: *Self) void {
        for (self.line_highlights.items) |*hl_list| {
            hl_list.clearRetainingCapacity();
        }
        for (self.line_spans.items) |*span_list| {
            span_list.clearRetainingCapacity();
        }
    }

    /// Get highlights for a specific line
    pub fn getLineHighlightsSlice(self: *const Self, line_idx: usize) []const Highlight {
        if (line_idx < self.line_highlights.items.len) {
            return self.line_highlights.items[line_idx].items;
        }
        return &[_]Highlight{};
    }

    /// Get total number of highlights across all lines
    pub fn getHighlightCount(self: *const Self) u32 {
        var count: u32 = 0;
        for (self.line_highlights.items) |hl_list| {
            count += @intCast(hl_list.items.len);
        }
        return count;
    }

    /// Set styled text from chunks with individual styling
    /// Accepts StyledChunk array for FFI compatibility
    /// TODO: This is for backward compatibility, there should be a better way to do this.
    pub fn setStyledText(
        self: *Self,
        chunks: []const StyledChunk,
    ) TextBufferError!void {
        if (chunks.len == 0) {
            self.clear();
            self.clearAllHighlights();
            return;
        }

        // Calculate total text length
        var total_len: usize = 0;
        for (chunks) |chunk| {
            total_len += chunk.text_len;
        }

        if (total_len == 0) {
            self.clear();
            self.clearAllHighlights();
            return;
        }

        self.clear();
        self.clearAllHighlights();
        try self.resetForSetText();

        if (total_len > self.styled_capacity) {
            if (self.styled_buffer) |old_buf| {
                self.global_allocator.free(old_buf);
            }
            const new_buf = self.global_allocator.alloc(u8, total_len) catch return TextBufferError.OutOfMemory;
            self.styled_buffer = new_buf;
            self.styled_capacity = total_len;
        }

        const full_text = self.styled_buffer.?[0..total_len];

        var offset: usize = 0;
        for (chunks) |chunk| {
            if (chunk.text_len > 0) {
                const chunk_text = chunk.text_ptr[0..chunk.text_len];
                @memcpy(full_text[offset .. offset + chunk.text_len], chunk_text);
                offset += chunk.text_len;
            }
        }

        if (self.styled_text_mem_id) |mem_id| {
            try self.mem_registry.replace(mem_id, full_text, false);
        } else {
            const mem_id = try self.mem_registry.register(full_text, false);
            self.styled_text_mem_id = mem_id;
        }

        try self.setTextInternal(self.styled_text_mem_id.?, full_text);

        if (self.syntax_style) |style| {
            self.startHighlightsTransaction();
            defer self.endHighlightsTransaction();

            var char_pos: u32 = 0;
            for (chunks) |chunk| {
                const chunk_text = chunk.text_ptr[0..chunk.text_len];
                const chunk_len = self.measureText(chunk_text);

                if (chunk_len > 0) {
                    const fg = if (chunk.fg_ptr) |fgPtr| utils.f32PtrToRGBA(fgPtr) else null;
                    const bg = if (chunk.bg_ptr) |bgPtr| utils.f32PtrToRGBA(bgPtr) else null;

                    const style_id = (@constCast(style)).registerStyleByValue(fg, bg, chunk.attributes) catch continue;

                    self.addHighlightByCharRange(char_pos, char_pos + chunk_len, style_id, 1, 0) catch {};
                }

                char_pos += chunk_len;
            }
        }
    }

    /// Load text from a file path (relative to cwd)
    /// The file content is allocated in the arena and will be freed when the buffer is destroyed
    pub fn loadFile(self: *Self, path: []const u8) TextBufferError!void {
        const file = std.fs.cwd().openFile(path, .{}) catch |err| {
            return switch (err) {
                error.FileNotFound => TextBufferError.InvalidIndex,
                error.AccessDenied => TextBufferError.InvalidIndex,
                else => TextBufferError.OutOfMemory,
            };
        };
        defer file.close();

        const file_size = file.getEndPos() catch return TextBufferError.OutOfMemory;

        self.clear();

        const content = self.allocator.alloc(u8, file_size) catch return TextBufferError.OutOfMemory;
        const bytes_read = file.readAll(content) catch return TextBufferError.OutOfMemory;
        const text = content[0..bytes_read];
        const mem_id = try self.mem_registry.register(text, false);

        try self.setTextInternal(mem_id, text);
    }

    pub fn getTabWidth(self: *const Self) u8 {
        return self.tab_width;
    }

    /// Set tab width (will be rounded up to nearest multiple of 2)
    pub fn setTabWidth(self: *Self, width: u8) void {
        const clamped_width = @max(2, width);
        self.tab_width = if (clamped_width % 2 == 0) clamped_width else clamped_width + 1;
    }

    /// Debug log the rope structure using rope.toText
    pub fn debugLogRope(self: *const Self) void {
        logger.debug("=== TextBuffer Rope Debug ===", .{});
        logger.debug("Line count: {}", .{self.getLineCount()});
        logger.debug("Char count: {}", .{self.getLength()});
        logger.debug("Byte size: {}", .{self.getByteSize()});

        const rope_text = self.rope.toText(self.allocator) catch {
            logger.debug("Failed to generate rope text representation", .{});
            return;
        };
        logger.debug("Rope structure: {s}", .{rope_text});
        logger.debug("=== End Rope Debug ===", .{});
    }

    /// Get text within a range of display-width offsets
    /// Automatically snaps to grapheme boundaries:
    /// Returns number of bytes written to out_buffer
    pub fn getTextRange(self: *const Self, start_offset: u32, end_offset: u32, out_buffer: []u8) usize {
        if (start_offset >= end_offset) return 0;
        if (out_buffer.len == 0) return 0;

        const total_weight = self.rope.totalWeight();
        if (start_offset >= total_weight) return 0;

        const clamped_end = @min(end_offset, total_weight);

        return iter_mod.extractTextBetweenOffsets(
            &self.rope,
            &self.mem_registry,
            self.tab_width,
            start_offset,
            clamped_end,
            out_buffer,
            self.width_method,
        );
    }

    /// Get text within a range specified by row/col coordinates
    /// Automatically snaps to grapheme boundaries:
    /// Returns number of bytes written to out_buffer
    pub fn getTextRangeByCoords(self: *Self, start_row: u32, start_col: u32, end_row: u32, end_col: u32, out_buffer: []u8) usize {
        const start_offset = iter_mod.coordsToOffset(&self.rope, start_row, start_col) orelse return 0;
        const end_offset = iter_mod.coordsToOffset(&self.rope, end_row, end_col) orelse return 0;
        return self.getTextRange(start_offset, end_offset, out_buffer);
    }
};
