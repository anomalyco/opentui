const std = @import("std");
const Allocator = std.mem.Allocator;
const tb = @import("text-buffer.zig");
const seg_mod = @import("text-buffer-segment.zig");
const iter_mod = @import("text-buffer-iterators.zig");
const utf8 = @import("utf8.zig");

const UnifiedTextBuffer = tb.UnifiedTextBuffer;
const RGBA = tb.RGBA;
const TextSelection = tb.TextSelection;
pub const WrapMode = tb.WrapMode;
const TextChunk = seg_mod.TextChunk;
const StyleSpan = tb.StyleSpan;

pub const TextBufferViewError = error{
    OutOfMemory,
};

/// Colors for a text selection. Color intent (rgb, indexed, default) is
/// carried inside the RGBA values themselves, so no separate tag fields
/// are needed.
pub const SelectionStyle = struct {
    bgColor: ?RGBA = null,
    fgColor: ?RGBA = null,

    pub fn rgb(bgColor: ?RGBA, fgColor: ?RGBA) SelectionStyle {
        return .{
            .bgColor = bgColor,
            .fgColor = fgColor,
        };
    }
};

/// How a selection occupies cells between stored anchor and focus offsets.
/// `cell` includes the grapheme under the max endpoint (block / Vim-visual).
/// `boundary` is the half-open insert range `[min, max)` (thin / GUI carets).
/// Occupancy is independent of cursor style; style is paint only.
pub const SelectionOccupancy = enum(u8) {
    cell = 0,
    boundary = 1,
};

/// How local cell coordinates expand into a highlight range.
/// `cell` is the current inclusive press/drag. `word` and `line` expand
/// each endpoint through selectWord / selectLine.
pub const SelectionBehavior = enum(u8) {
    cell = 0,
    word = 1,
    line = 2,
};

/// Half-open display-offset range used by word/line click expansion.
pub const SelectionRange = struct {
    start: u32,
    end: u32,
};

/// Ghostty-style boundaries for double-click selection. NUL is omitted because
/// OpenTUI text buffers do not use it for unwritten terminal cells.
/// Keep this policy separate from `utf8.findChunkLayoutInfo`: wrap and editor
/// motion split on `/`, `-`, and CJK/ASCII transitions, but selection does not.
/// Wrapping also permits breaks between adjacent CJK characters.
/// Selection groups consecutive graphemes by this class, so space and tab runs
/// are selectable instead of mapping to an adjacent word.
const default_word_boundaries = [_]u21{
    ' ',
    '\t',
    '\'',
    '"',
    '│',
    '`',
    '|',
    ':',
    ';',
    ',',
    '(',
    ')',
    '[',
    ']',
    '{',
    '}',
    '<',
    '>',
    '$',
};

const SelectionEndpoints = struct {
    anchor: u32,
    focus: u32,
};

/// Viewport defines a rectangular window into the virtual line space
pub const Viewport = struct {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
};

pub const LineInfo = struct {
    line_start_cols: []const u32,
    line_width_cols: []const u32,
    line_sources: []const u32,
    line_wraps: []const u32,
    line_width_cols_max: u32,
};

pub const WrapInfo = struct {
    line_first_vline: []const u32,
    line_vline_counts: []const u32,
};

/// Output structure for virtual line calculation
pub const VirtualLineOutput = struct {
    virtual_lines: *std.ArrayListUnmanaged(VirtualLine),
    cached_line_starts: *std.ArrayListUnmanaged(u32),
    cached_line_widths: *std.ArrayListUnmanaged(u32),
    cached_line_sources: *std.ArrayListUnmanaged(u32),
    cached_line_wrap_indices: *std.ArrayListUnmanaged(u32),
    cached_line_first_vline: *std.ArrayListUnmanaged(u32),
    cached_line_vline_counts: *std.ArrayListUnmanaged(u32),
};

/// Result from measuring dimensions without modifying cache
pub const MeasureResult = struct {
    line_count: u32,
    width_cols_max: u32,
};

pub const VirtualLineSpanInfo = struct {
    spans: []const StyleSpan,
    source_line: usize,
    source_col_start: u32,
};

/// Byte and display-column windows describe the same whole-grapheme slice;
/// columns alone cannot recover UTF-8 boundaries.
pub const VirtualChunk = struct {
    chunk: *const TextChunk,
    byte_start_in_chunk: u32,
    byte_len: u32,
    col_start_in_chunk: u32,
    width_cols: u32,
};

const PendingWordPiece = struct {
    col_start_in_chunk: u32,
    width_cols: u32,
    byte_start: u32,
    byte_end: u32,
    chunk: *const TextChunk,
};

const PendingWordPieceFit = struct {
    width_cols: u32,
    bytes_used: u32,
};

pub const VirtualLine = struct {
    chunks: std.ArrayListUnmanaged(VirtualChunk),
    width_cols: u32,
    document_cell_offset: u32,
    source_line: usize,
    source_col_start: u32,
    is_truncated: bool,
    ellipsis_col: u32,
    truncation_suffix_col_start: u32,

    pub fn init() VirtualLine {
        return .{
            .chunks = .empty,
            .width_cols = 0,
            .document_cell_offset = 0,
            .source_line = 0,
            .source_col_start = 0,
            .is_truncated = false,
            .ellipsis_col = 0,
            .truncation_suffix_col_start = 0,
        };
    }

    fn appendChunk(self: *VirtualLine, allocator: Allocator, chunk: VirtualChunk) Allocator.Error!void {
        if (self.chunks.capacity == 0) {
            try self.chunks.ensureTotalCapacityPrecise(allocator, 1);
        } else if (self.chunks.items.len == self.chunks.capacity) {
            try self.chunks.ensureUnusedCapacity(allocator, 1);
        }
        self.chunks.appendAssumeCapacity(chunk);
    }
};

pub const LocalSelection = struct {
    anchorX: i32,
    anchorY: i32,
    focusX: i32,
    focusY: i32,
    isActive: bool,
};

pub const TextBufferView = UnifiedTextBufferView;

// Width-independent metadata for the current view layout, in rope traversal
// order. Nothing is attached to chunks or retained by their undo roots.
const WordLayoutStorage = struct {
    arena: std.heap.ArenaAllocator,
    layouts: std.ArrayListUnmanaged(utf8.ChunkLayoutInfo) = .empty,

    fn reset(self: *WordLayoutStorage) void {
        _ = self.arena.reset(.free_all);
        self.layouts = .empty;
    }
};

pub const UnifiedTextBufferView = struct {
    const Self = UnifiedTextBufferView;

    text_buffer: *UnifiedTextBuffer,
    original_text_buffer: *UnifiedTextBuffer,
    view_id: u32,
    selection: ?TextSelection,
    /// Local selection endpoints stay separate from the derived range because
    /// cell occupancy can extend `selection.end` past the focus grapheme.
    selection_endpoints: ?SelectionEndpoints,
    selection_occupancy: SelectionOccupancy,
    selection_behavior: SelectionBehavior,
    viewport: ?Viewport,
    wrap_width: ?u32,
    wrap_mode: WrapMode,
    first_line_offset: u32,
    virtual_lines: std.ArrayListUnmanaged(VirtualLine),
    virtual_lines_dirty: bool,
    cached_line_starts: std.ArrayListUnmanaged(u32),
    cached_line_widths: std.ArrayListUnmanaged(u32),
    cached_line_sources: std.ArrayListUnmanaged(u32),
    cached_line_wrap_indices: std.ArrayListUnmanaged(u32),
    cached_line_first_vline: std.ArrayListUnmanaged(u32),
    cached_line_vline_counts: std.ArrayListUnmanaged(u32),
    global_allocator: Allocator,
    virtual_lines_arena: *std.heap.ArenaAllocator,
    word_layout: WordLayoutStorage,

    /// Persistent arena for measureForDimensions. Each call resets it with
    /// retain_capacity to avoid mmap/munmap churn during streaming.
    measure_arena: std.heap.ArenaAllocator,
    tab_indicator: ?u32,
    tab_indicator_color: ?RGBA,
    truncate: bool,
    ellipsis_chunk: TextChunk,

    // Measurement cache for Yoga layout. Keyed by (buffer, epoch, width, wrap_mode).
    // Using epoch instead of dirty flag prevents stale returns when unrelated
    // code paths clear dirty (e.g., updateVirtualLines).
    cached_measure_width: ?u32,
    cached_measure_wrap_mode: WrapMode,
    cached_measure_first_line_offset: u32,
    cached_measure_result: ?MeasureResult,
    cached_measure_epoch: u64,
    cached_measure_buffer: ?*UnifiedTextBuffer,

    truncation_applied: bool,

    pub fn init(global_allocator: Allocator, text_buffer: *UnifiedTextBuffer) TextBufferViewError!*Self {
        const self = global_allocator.create(Self) catch return TextBufferViewError.OutOfMemory;
        errdefer global_allocator.destroy(self);

        const virtual_lines_internal_arena = global_allocator.create(std.heap.ArenaAllocator) catch return TextBufferViewError.OutOfMemory;
        errdefer global_allocator.destroy(virtual_lines_internal_arena);
        virtual_lines_internal_arena.* = std.heap.ArenaAllocator.init(global_allocator);

        const view_id = text_buffer.registerView() catch return TextBufferViewError.OutOfMemory;

        const ellipsis_text = "...";
        const mem_id = text_buffer.registerMemBuffer(ellipsis_text, false) catch return TextBufferViewError.OutOfMemory;
        const ellipsis_chunk = text_buffer.createChunk(mem_id, 0, 3);

        self.* = .{
            .text_buffer = text_buffer,
            .original_text_buffer = text_buffer,
            .view_id = view_id,
            .selection = null,
            .selection_endpoints = null,
            .selection_occupancy = .cell,
            .selection_behavior = .cell,
            .viewport = null,
            .wrap_width = null,
            .wrap_mode = .none,
            .first_line_offset = 0,
            .virtual_lines = .empty,
            .virtual_lines_dirty = true,
            .cached_line_starts = .empty,
            .cached_line_widths = .empty,
            .cached_line_sources = .empty,
            .cached_line_wrap_indices = .empty,
            .cached_line_first_vline = .empty,
            .cached_line_vline_counts = .empty,
            .global_allocator = global_allocator,
            .virtual_lines_arena = virtual_lines_internal_arena,
            .word_layout = .{ .arena = std.heap.ArenaAllocator.init(global_allocator) },
            .measure_arena = std.heap.ArenaAllocator.init(global_allocator),
            .tab_indicator = null,
            .tab_indicator_color = null,
            .truncate = false,
            .ellipsis_chunk = ellipsis_chunk,
            .cached_measure_width = null,
            .cached_measure_wrap_mode = .none,
            .cached_measure_first_line_offset = 0,
            .cached_measure_result = null,
            .cached_measure_epoch = 0,
            .cached_measure_buffer = null,
            .truncation_applied = false,
        };

        return self;
    }

    /// IMPORTANT: Views must be destroyed BEFORE their associated TextBuffer.
    /// Destroying the TextBuffer first will cause use-after-free when calling deinit.
    /// The TypeScript wrappers enforce this order via the destroy() methods.
    pub fn deinit(self: *Self) void {
        const global_allocator = self.global_allocator;
        defer global_allocator.destroy(self);

        self.original_text_buffer.unregisterView(self.view_id);
        self.virtual_lines_arena.deinit();
        global_allocator.destroy(self.virtual_lines_arena);
        self.measure_arena.deinit();
        self.word_layout.arena.deinit();
        self.* = undefined;
    }

    pub fn setViewport(self: *Self, vp: ?Viewport) void {
        self.viewport = vp;

        // If viewport has width, set wrap width (wrapping behavior depends on wrap_mode)
        if (vp) |viewport| {
            if (self.wrap_width != viewport.width) {
                self.wrap_width = viewport.width;
                self.virtual_lines_dirty = true;
                self.truncation_applied = false;
            }
        } else {
            self.truncation_applied = false;
        }
    }

    pub fn getViewport(self: *const Self) ?Viewport {
        return self.viewport;
    }

    // This is a convenience method that preserves existing offset
    pub fn setViewportSize(self: *Self, width: u32, height: u32) void {
        if (self.viewport) |vp| {
            self.setViewport(.{
                .x = vp.x,
                .y = vp.y,
                .width = width,
                .height = height,
            });
        } else {
            self.setViewport(.{
                .x = 0,
                .y = 0,
                .width = width,
                .height = height,
            });
        }
    }

    pub fn setWrapWidth(self: *Self, width: ?u32) void {
        if (self.wrap_width != width) {
            self.wrap_width = width;
            self.virtual_lines_dirty = true;
            self.truncation_applied = false;
        }
    }

    pub fn setWrapMode(self: *Self, mode: WrapMode) void {
        if (self.wrap_mode != mode) {
            self.wrap_mode = mode;
            self.virtual_lines_dirty = true;
            self.truncation_applied = false;
        }
    }

    pub fn setFirstLineOffset(self: *Self, offset: u32) void {
        if (self.first_line_offset != offset) {
            self.first_line_offset = offset;
            self.virtual_lines_dirty = true;
            self.truncation_applied = false;
        }
    }

    fn resetVirtualLineStorage(self: *Self, mode: std.heap.ArenaAllocator.ResetMode) void {
        _ = self.virtual_lines_arena.reset(mode);
        self.virtual_lines = .empty;
        self.cached_line_starts = .empty;
        self.cached_line_widths = .empty;
        self.cached_line_sources = .empty;
        self.cached_line_wrap_indices = .empty;
        self.cached_line_first_vline = .empty;
        self.cached_line_vline_counts = .empty;
        self.truncation_applied = false;
    }

    pub fn updateVirtualLines(self: *Self) void {
        const buffer_dirty = self.text_buffer.isViewDirty(self.view_id);
        if (!self.virtual_lines_dirty and !buffer_dirty) return;

        if (buffer_dirty or self.wrap_mode != .word or self.wrap_width == null) self.word_layout.reset();
        self.resetVirtualLineStorage(if (!buffer_dirty and self.wrap_mode == .word) .retain_capacity else .free_all);
        const virtual_allocator = self.virtual_lines_arena.allocator();

        // Create output structure for the generic function
        const output: VirtualLineOutput = .{
            .virtual_lines = &self.virtual_lines,
            .cached_line_starts = &self.cached_line_starts,
            .cached_line_widths = &self.cached_line_widths,
            .cached_line_sources = &self.cached_line_sources,
            .cached_line_wrap_indices = &self.cached_line_wrap_indices,
            .cached_line_first_vline = &self.cached_line_first_vline,
            .cached_line_vline_counts = &self.cached_line_vline_counts,
        };

        const calculated = if (self.wrap_mode == .none or self.wrap_width == null)
            calculateUnwrappedVirtualLines(virtual_allocator, self.text_buffer, output)
        else switch (self.wrap_mode) {
            .none => unreachable,
            .char => calculateVirtualLinesGeneric(.render, .char, virtual_allocator, self.text_buffer, self.wrap_width.?, self.first_line_offset, output, null),
            .word => calculateVirtualLinesGeneric(.render, .word, virtual_allocator, self.text_buffer, self.wrap_width.?, self.first_line_offset, output, &self.word_layout),
        };
        if (!calculated) {
            // Builders append to parallel arrays; discard partial output as a unit
            // and remain dirty so the next access can retry cleanly.
            self.resetVirtualLineStorage(.free_all);
            self.word_layout.reset();
            self.virtual_lines_dirty = true;
            return;
        }

        self.virtual_lines_dirty = false;
        self.text_buffer.clearViewDirty(self.view_id);
    }

    pub fn getVirtualLineCount(self: *Self) u32 {
        self.updateVirtualLines();
        return @intCast(self.virtual_lines.items.len);
    }

    pub fn getVirtualLines(self: *Self) []const VirtualLine {
        self.updateVirtualLines();

        const all_vlines = self.virtual_lines.items;

        if (self.truncate and self.viewport != null) {
            self.ensureTruncation();
        }

        if (self.viewport) |vp| {
            const start_idx = @min(vp.y, @as(u32, @intCast(all_vlines.len)));
            const end_idx = @min(start_idx + vp.height, @as(u32, @intCast(all_vlines.len)));
            return all_vlines[start_idx..end_idx];
        }

        return all_vlines;
    }

    pub fn getCachedLineInfo(self: *Self) LineInfo {
        self.updateVirtualLines();

        // If viewport is set, return only the visible lines' info
        if (self.viewport) |vp| {
            const start_idx = @min(vp.y, @as(u32, @intCast(self.cached_line_starts.items.len)));
            const end_idx = @min(start_idx + vp.height, @as(u32, @intCast(self.cached_line_starts.items.len)));

            const viewport_line_start_cols = self.cached_line_starts.items[start_idx..end_idx];
            const viewport_line_width_cols = self.cached_line_widths.items[start_idx..end_idx];
            const viewport_line_sources = self.cached_line_sources.items[start_idx..end_idx];
            const viewport_line_wraps = self.cached_line_wrap_indices.items[start_idx..end_idx];

            var width_cols_max: u32 = 0;
            for (viewport_line_width_cols) |w| {
                width_cols_max = @max(width_cols_max, w);
            }

            return .{
                .line_start_cols = viewport_line_start_cols,
                .line_width_cols = viewport_line_width_cols,
                .line_sources = viewport_line_sources,
                .line_wraps = viewport_line_wraps,
                .line_width_cols_max = width_cols_max,
            };
        }

        return .{
            .line_start_cols = self.cached_line_starts.items,
            .line_width_cols = self.cached_line_widths.items,
            .line_sources = self.cached_line_sources.items,
            .line_wraps = self.cached_line_wrap_indices.items,
            .line_width_cols_max = self.text_buffer.lineWidthColsMax(),
        };
    }

    pub fn getLogicalLineInfo(self: *Self) LineInfo {
        self.updateVirtualLines();

        return .{
            .line_start_cols = self.cached_line_starts.items,
            .line_width_cols = self.cached_line_widths.items,
            .line_sources = self.cached_line_sources.items,
            .line_wraps = self.cached_line_wrap_indices.items,
            .line_width_cols_max = self.text_buffer.lineWidthColsMax(),
        };
    }

    pub fn getWrapInfo(self: *Self) WrapInfo {
        self.updateVirtualLines();
        return .{
            .line_first_vline = self.cached_line_first_vline.items,
            .line_vline_counts = self.cached_line_vline_counts.items,
        };
    }

    pub fn findVisualLineIndex(self: *Self, logical_row: u32, logical_col: u32) u32 {
        self.updateVirtualLines();

        const vlines = self.virtual_lines.items;
        if (vlines.len == 0) return 0;

        const wrap_info = self.getWrapInfo();

        // Clamp logical_row to valid range
        const clamped_row = if (logical_row >= wrap_info.line_first_vline.len)
            if (wrap_info.line_first_vline.len > 0) wrap_info.line_first_vline.len - 1 else 0
        else
            logical_row;

        if (clamped_row >= wrap_info.line_first_vline.len) return 0;

        const first_vline_idx = wrap_info.line_first_vline[clamped_row];
        const vline_count = wrap_info.line_vline_counts[clamped_row];

        if (vline_count == 0) return first_vline_idx;

        var i: u32 = 1;
        while (i < vline_count) : (i += 1) {
            const vline_idx = first_vline_idx + i;
            if (vline_idx >= vlines.len) break;
            // A soft-wrap boundary belongs to the following visual line. Consumed
            // separators before its source start remain on the previous line.
            if (logical_col < vlines[vline_idx].source_col_start) return vline_idx - 1;
        }

        // If not found, return last virtual line for this logical line
        const last_vline_idx = first_vline_idx + vline_count - 1;
        if (last_vline_idx < vlines.len) {
            return last_vline_idx;
        }

        return first_vline_idx;
    }

    pub fn getPlainTextIntoBuffer(self: *const Self, out_buffer: []u8) usize {
        return self.text_buffer.getPlainTextIntoBuffer(out_buffer);
    }

    pub fn getArenaAllocatedBytes(self: *const Self) usize {
        return self.virtual_lines_arena.queryCapacity();
    }

    fn selectionFromStyle(start: u32, end: u32, style: SelectionStyle) TextSelection {
        return .{
            .start = start,
            .end = end,
            .bgColor = style.bgColor,
            .fgColor = style.fgColor,
        };
    }

    fn clearSelectionEndpoints(self: *Self) void {
        self.selection_endpoints = null;
    }

    fn offsetSelectionRange(self: *Self, start: u32, end: u32) struct { start: u32, end: u32 } {
        const text_end = self.text_buffer.textEndOffset();
        var range_start = @min(@min(start, end), text_end);
        var range_end = @min(@max(start, end), text_end);
        if (range_start == range_end) {
            if (self.text_buffer.graphemeBoundsAtOffset(range_start)) |bounds| range_start = bounds.start;
            return .{ .start = range_start, .end = range_start };
        }

        if (self.text_buffer.graphemeBoundsAtOffset(range_start)) |bounds| {
            range_start = bounds.start;
        }
        if (self.text_buffer.graphemeBoundsAtOffset(range_end)) |bounds| {
            if (bounds.start < range_end) range_end = bounds.end;
        }

        return .{ .start = range_start, .end = @min(range_end, text_end) };
    }

    pub fn setSelection(self: *Self, start: u32, end: u32, bgColor: ?RGBA, fgColor: ?RGBA) void {
        self.setSelectionStyle(start, end, SelectionStyle.rgb(bgColor, fgColor));
    }

    pub fn setSelectionStyle(self: *Self, start: u32, end: u32, style: SelectionStyle) void {
        // Offset APIs write an already-exclusive [start, end) and do not go
        // through occupancy. Clear stored cell-pin endpoints so a later
        // occupancy change or cursor sync cannot replay a stale focus.
        self.clearSelectionEndpoints();
        const range = self.offsetSelectionRange(start, end);
        self.selection = selectionFromStyle(range.start, range.end, style);
    }

    pub fn updateSelection(self: *Self, end: u32, bgColor: ?RGBA, fgColor: ?RGBA) void {
        self.updateSelectionStyle(end, SelectionStyle.rgb(bgColor, fgColor));
    }

    pub fn updateSelectionStyle(self: *Self, end: u32, style: SelectionStyle) void {
        if (self.selection) |sel| {
            self.clearSelectionEndpoints();
            const range = self.offsetSelectionRange(sel.start, end);
            self.selection = selectionFromStyle(range.start, range.end, style);
        }
    }

    pub fn setSelectionColors(self: *Self, bgColor: ?RGBA, fgColor: ?RGBA) void {
        if (self.selection) |*selection| {
            selection.bgColor = bgColor;
            selection.fgColor = fgColor;
        }
    }

    pub fn resetSelection(self: *Self) void {
        self.selection = null;
        self.clearSelectionEndpoints();
        self.selection_behavior = .cell;
    }

    pub fn setSelectionOccupancy(self: *Self, occupancy: SelectionOccupancy) void {
        self.selection_occupancy = occupancy;
        const endpoints = if (self.selection_endpoints) |*endpoints| endpoints else return;
        const selection = if (self.selection) |*selection| selection else return;
        const text_end = self.getTextEndOffset();
        endpoints.anchor = @min(endpoints.anchor, text_end);
        endpoints.focus = @min(endpoints.focus, text_end);
        const range = self.expandSelectionRange(endpoints.anchor, endpoints.focus, text_end, self.selection_behavior) orelse
            self.selectionRange(endpoints.anchor, endpoints.focus, text_end);
        selection.start = range.start;
        selection.end = range.end;
    }

    pub fn getSelectionOccupancy(self: *const Self) SelectionOccupancy {
        return self.selection_occupancy;
    }

    /// Inclusive-end offset helper: under `cell` occupancy, extend `end` by the
    /// grapheme at that offset. Under `boundary`, write `[start, end)` as-is.
    /// Does not store cell-pin endpoints (offset API).
    pub fn setSelectionInclusiveStyle(self: *Self, start: u32, end: u32, style: SelectionStyle) void {
        const lo = @min(start, end);
        const hi = @max(start, end);
        const exclusive_end = if (self.selection_occupancy == .cell)
            if (self.text_buffer.graphemeBoundsAtOffset(hi)) |bounds| bounds.end else hi
        else
            hi;
        self.setSelectionStyle(lo, exclusive_end, style);
    }

    pub fn getSelection(self: *const Self) ?TextSelection {
        return self.selection;
    }

    pub fn getTextBuffer(self: *const Self) *UnifiedTextBuffer {
        return self.text_buffer;
    }

    pub fn switchToBuffer(self: *Self, buffer: *UnifiedTextBuffer) void {
        self.word_layout.reset();
        self.text_buffer = buffer;
        self.virtual_lines_dirty = true;
    }

    pub fn switchToOriginalBuffer(self: *Self) void {
        if (self.text_buffer != self.original_text_buffer) {
            self.word_layout.reset();
            self.text_buffer = self.original_text_buffer;
            self.virtual_lines_dirty = true;
        }
    }

    pub fn setLocalSelection(self: *Self, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?RGBA, fgColor: ?RGBA) bool {
        return self.setLocalSelectionStyle(anchorX, anchorY, focusX, focusY, SelectionStyle.rgb(bgColor, fgColor), .cell);
    }

    pub fn setLocalSelectionBehavior(self: *Self, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?RGBA, fgColor: ?RGBA, behavior: SelectionBehavior) bool {
        return self.setLocalSelectionStyle(anchorX, anchorY, focusX, focusY, SelectionStyle.rgb(bgColor, fgColor), behavior);
    }

    pub fn setLocalSelectionStyle(self: *Self, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, style: SelectionStyle, behavior: SelectionBehavior) bool {
        self.updateVirtualLines();
        if (self.truncate and self.viewport != null) {
            self.ensureTruncation();
        }

        const anchor_above = anchorY < 0;
        const focus_above = focusY < 0;
        const max_y = @as(i32, @intCast(self.virtual_lines.items.len)) - 1;
        const anchor_below = anchorY > max_y;
        const focus_below = focusY > max_y;

        if ((anchor_above and focus_above) or (anchor_below and focus_below)) {
            const had_selection = self.selection != null;
            self.resetSelection();
            return had_selection;
        }

        const text_end_offset = self.getTextEndOffset();

        // Vertical clamping takes precedence when a point is below and left.
        const anchor_offset = if (anchor_below)
            text_end_offset
        else if (anchor_above or anchorX < 0)
            0
        else
            self.coordsToCharOffset(anchorX, anchorY) orelse {
                const had_selection = self.selection != null;
                self.resetSelection();
                return had_selection;
            };

        const focus_offset = if (focus_below)
            text_end_offset
        else if (focus_above or focusX < 0)
            0
        else
            self.coordsToCharOffset(focusX, focusY) orelse {
                const had_selection = self.selection != null;
                self.resetSelection();
                return had_selection;
            };

        self.selection_endpoints = .{ .anchor = anchor_offset, .focus = focus_offset };
        self.selection_behavior = behavior;

        const range = self.expandSelectionRange(anchor_offset, focus_offset, text_end_offset, behavior) orelse
            self.selectionRange(anchor_offset, focus_offset, text_end_offset);

        // Always store selection, even if zero-width, to preserve anchor for updateLocalSelection
        const new_selection = selectionFromStyle(range.start, range.end, style);

        const selection_changed = if (self.selection) |old_sel|
            old_sel.start != new_selection.start or old_sel.end != new_selection.end
        else
            true;

        self.selection = new_selection;
        return selection_changed;
    }

    pub fn updateLocalSelection(self: *Self, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?RGBA, fgColor: ?RGBA) bool {
        return self.updateLocalSelectionStyle(anchorX, anchorY, focusX, focusY, SelectionStyle.rgb(bgColor, fgColor), .cell);
    }

    pub fn updateLocalSelectionBehavior(self: *Self, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?RGBA, fgColor: ?RGBA, behavior: SelectionBehavior) bool {
        return self.updateLocalSelectionStyle(anchorX, anchorY, focusX, focusY, SelectionStyle.rgb(bgColor, fgColor), behavior);
    }

    pub fn updateLocalSelectionStyle(self: *Self, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, style: SelectionStyle, behavior: SelectionBehavior) bool {
        if (self.selection_endpoints != null) {
            return self.updateLocalSelectionFocusOnly(focusX, focusY, style, behavior);
        } else {
            return self.setLocalSelectionStyle(anchorX, anchorY, focusX, focusY, style, behavior);
        }
    }

    fn updateLocalSelectionFocusOnly(self: *Self, focusX: i32, focusY: i32, style: SelectionStyle, behavior: SelectionBehavior) bool {
        const endpoints = self.selection_endpoints orelse return false;
        const anchor_offset = endpoints.anchor;

        self.updateVirtualLines();
        if (self.truncate and self.viewport != null) {
            self.ensureTruncation();
        }

        const focus_above = focusY < 0;
        const max_y = @as(i32, @intCast(self.virtual_lines.items.len)) - 1;
        const focus_below = focusY > max_y;

        const text_end_offset = self.getTextEndOffset();

        const focus_col_offset = if (focus_below)
            text_end_offset
        else if (focus_above or focusX < 0)
            0
        else
            self.coordsToCharOffset(focusX, focusY) orelse return false;

        self.selection_endpoints.?.focus = focus_col_offset;
        self.selection_behavior = behavior;

        const range = self.expandSelectionRange(anchor_offset, focus_col_offset, text_end_offset, behavior) orelse return false;
        self.selection = selectionFromStyle(range.start, range.end, style);

        return true;
    }

    /// Keep the exclusive highlight and store cell endpoints so a later
    /// cell drag or shift-extend does not re-expand by word or line.
    /// Cell occupancy pins focus on the last occupied grapheme; boundary
    /// occupancy pins it on the exclusive end.
    pub fn convertSelectionToCell(self: *Self) bool {
        const selection = self.selection orelse return false;
        if (selection.start == selection.end) return false;

        const focus = if (self.selection_occupancy == .boundary)
            selection.end
        else if (self.text_buffer.graphemeBoundsAtOffset(selection.end - 1)) |bounds|
            bounds.start
        else
            selection.end - 1;

        self.selection_endpoints = .{ .anchor = selection.start, .focus = focus };
        self.selection_behavior = .cell;
        return true;
    }

    fn expandSelectionRange(
        self: *Self,
        anchor_offset: u32,
        focus_offset: u32,
        text_end_offset: u32,
        behavior: SelectionBehavior,
    ) ?SelectionRange {
        switch (behavior) {
            .cell => return self.selectionRange(anchor_offset, focus_offset, text_end_offset),
            .word => {
                const a = self.selectWordBetween(anchor_offset, focus_offset);
                const b = self.selectWordBetween(focus_offset, anchor_offset);
                return unionRanges(a, b);
            },
            .line => {
                const a = self.selectLine(anchor_offset);
                const b = self.selectLine(focus_offset);
                return unionRanges(a, b);
            },
        }
    }

    fn unionRanges(a: ?SelectionRange, b: ?SelectionRange) ?SelectionRange {
        const left = a orelse return b;
        const right = b orelse return a;
        return .{
            .start = @min(left.start, right.start),
            .end = @max(left.end, right.end),
        };
    }

    /// Word at `offset`. Null on newline or end-of-buffer. `/` is not a boundary.
    pub fn selectWord(self: *Self, offset: u32) ?SelectionRange {
        const grapheme = self.selectionGraphemeAt(offset) orelse return null;
        if (grapheme.is_break) return null;

        const expect_boundary = isWordBoundary(grapheme.first_cp);
        var start = grapheme.start;
        var end = grapheme.end;

        while (self.prevSelectionGrapheme(start)) |prev| {
            if (prev.is_break) break;
            if (isWordBoundary(prev.first_cp) != expect_boundary) break;
            if (prev.start >= start) break;
            start = prev.start;
        }

        while (self.selectionGraphemeAt(end)) |next| {
            if (next.is_break) break;
            if (isWordBoundary(next.first_cp) != expect_boundary) break;
            if (next.end <= end) break;
            end = next.end;
        }

        return .{ .start = start, .end = end };
    }

    /// First non-null `selectWord` walking from `from` toward `toward`, inclusive.
    pub fn selectWordBetween(self: *Self, from: u32, toward: u32) ?SelectionRange {
        const text_end = self.text_buffer.textEndOffset();
        var offset = @min(from, text_end);
        const limit = @min(toward, text_end);

        if (offset <= limit) {
            while (offset <= limit) {
                if (self.selectWord(offset)) |range| return range;
                const next = self.selectionGraphemeAt(offset) orelse return null;
                if (next.end <= offset) return null;
                offset = next.end;
            }
            return null;
        }

        while (true) {
            if (self.selectWord(offset)) |range| return range;
            if (offset <= limit) return null;
            const prev = self.prevSelectionGrapheme(offset) orelse return null;
            if (prev.start >= offset) return null;
            offset = prev.start;
        }
    }

    /// Logical line at `offset`, ASCII space/tab trimmed. All-whitespace keeps
    /// the full source line so a blank line is still selected.
    pub fn selectLine(self: *Self, offset: u32) ?SelectionRange {
        return self.trimLineWhitespace(self.sourceLineRangeAt(offset) orelse return null);
    }

    fn sourceLineRangeAt(self: *Self, offset: u32) ?SelectionRange {
        const rope = self.text_buffer.rope();
        const text_end = self.text_buffer.textEndOffset();
        if (offset > text_end) return null;
        const coords = iter_mod.offsetToCoords(rope, offset) orelse return null;
        const start = offset - coords.col;
        return .{ .start = start, .end = start + iter_mod.lineWidthAt(rope, coords.row) };
    }

    fn trimLineWhitespace(self: *Self, range: SelectionRange) SelectionRange {
        var start = range.start;
        var end = range.end;
        var saw_content = false;

        var offset = range.start;
        while (offset < range.end) {
            const grapheme = self.selectionGraphemeAt(offset) orelse break;
            if (grapheme.is_break) break;
            if (grapheme.first_cp != ' ' and grapheme.first_cp != '\t') {
                if (!saw_content) start = grapheme.start;
                end = grapheme.end;
                saw_content = true;
            }
            if (grapheme.end <= offset) break;
            offset = grapheme.end;
        }

        if (!saw_content) return range;
        return .{ .start = start, .end = end };
    }

    const SelectionGrapheme = struct {
        start: u32,
        end: u32,
        first_cp: u21,
        is_break: bool,
    };

    fn selectionGraphemeAt(self: *Self, offset: u32) ?SelectionGrapheme {
        const text_end = self.text_buffer.textEndOffset();
        if (offset >= text_end) return null;

        const rope = self.text_buffer.rope();
        const coords = iter_mod.offsetToCoords(rope, offset) orelse return null;
        const line_width = iter_mod.lineWidthAt(rope, coords.row);
        const line_start = offset - coords.col;

        if (coords.col >= line_width) {
            return .{
                .start = line_start + line_width,
                .end = line_start + line_width + 1,
                .first_cp = '\n',
                .is_break = true,
            };
        }

        const linestart = rope.getMarker(.linestart, coords.row) orelse return null;
        var seg_idx = linestart.leaf_index + 1;
        var cols_before: u32 = 0;
        const mem_registry = self.text_buffer.memRegistry();
        const tab_width = self.text_buffer.tabWidth();
        const width_method = self.text_buffer.widthMethod();

        while (seg_idx < rope.count()) : (seg_idx += 1) {
            const seg = rope.get(seg_idx) orelse break;
            if (seg.isBreak() or seg.isLineStart()) break;
            const chunk = seg.asText() orelse continue;
            const next_cols = cols_before + chunk.width_cols;
            if (coords.col < next_cols) {
                const bytes = chunk.getBytes(mem_registry);
                const is_ascii = (chunk.flags & TextChunk.Flags.ASCII_ONLY) != 0;
                const pos = utf8.findGraphemePosByWidth(
                    bytes,
                    coords.col - cols_before,
                    tab_width,
                    is_ascii,
                    false,
                    width_method,
                );
                if (pos.byte_offset >= bytes.len) return null;
                var width = utf8.getGraphemeWidthAt(bytes, pos.byte_offset, tab_width, width_method);
                if (width == 0) {
                    const next = utf8.findGraphemePosByWidth(
                        bytes,
                        pos.columns_used + 1,
                        tab_width,
                        is_ascii,
                        false,
                        width_method,
                    );
                    if (next.byte_offset < bytes.len) {
                        width = utf8.getGraphemeWidthAt(bytes, next.byte_offset, tab_width, width_method);
                    }
                }
                const first_cp = utf8.decodeUtf8Unchecked(bytes, pos.byte_offset).cp;
                const start = line_start + cols_before + pos.columns_used;
                return .{
                    .start = start,
                    .end = start + width,
                    .first_cp = first_cp,
                    .is_break = first_cp == '\n' or first_cp == '\r',
                };
            }
            cols_before = next_cols;
        }
        return null;
    }

    fn prevSelectionGrapheme(self: *Self, offset: u32) ?SelectionGrapheme {
        if (offset == 0) return null;
        return self.selectionGraphemeAt(offset - 1);
    }

    fn isWordBoundary(cp: u21) bool {
        return std.mem.indexOfScalar(u21, &default_word_boundaries, cp) != null;
    }

    /// Derive the exclusive highlight/copy/delete range from stored endpoints.
    /// `cell`: `[min, max + width(max))` so both endpoint graphemes are occupied.
    /// `boundary`: `[min, max)` — the insert range the caret swept.
    /// Zero extent (`anchor == focus`) stays empty in both modes: a press is
    /// not a cell to occupy.
    fn selectionRange(self: *Self, anchor_offset: u32, focus_offset: u32, text_end_offset: u32) SelectionRange {
        var start = @min(anchor_offset, focus_offset);
        var end = @max(anchor_offset, focus_offset);
        if (anchor_offset == focus_offset) {
            const offset = @min(start, text_end_offset);
            return .{ .start = offset, .end = offset };
        }

        if (self.text_buffer.graphemeBoundsAtOffset(start)) |bounds| {
            start = bounds.start;
        }
        if (self.text_buffer.graphemeBoundsAtOffset(end)) |bounds| {
            if (self.selection_occupancy == .cell or bounds.start < end) {
                end = bounds.end;
            }
        }

        start = @min(start, text_end_offset);
        end = @min(end, text_end_offset);
        return .{ .start = start, .end = end };
    }

    pub fn resetLocalSelection(self: *Self) void {
        self.resetSelection();
    }

    fn getTextEndOffset(self: *Self) u32 {
        self.updateVirtualLines();
        if (self.truncate and self.viewport != null) {
            self.ensureTruncation();
        }

        if (self.virtual_lines.items.len == 0) return 0;
        const last_line_idx = self.virtual_lines.items.len - 1;
        const last_vline = &self.virtual_lines.items[last_line_idx];

        if (last_vline.is_truncated) {
            return last_vline.document_cell_offset + last_vline.truncation_suffix_col_start + (last_vline.width_cols -| last_vline.ellipsis_col -| 3);
        }

        return self.text_buffer.rope().totalWeight();
    }

    /// Cell occupancy clamps wrap padding to the last cell. Boundary occupancy
    /// maps it to the insertion gap after that cell.
    fn maxLocalXOnVisualLine(self: *const Self, vlines: []const VirtualLine, vline_idx: usize) u32 {
        const vline = &vlines[vline_idx];
        if (vline.width_cols == 0) return 0;
        if (self.selection_occupancy == .cell and vline_idx + 1 < vlines.len) {
            const next_vline = &vlines[vline_idx + 1];
            if (next_vline.source_line == vline.source_line) {
                return vline.width_cols - 1;
            }
        }
        return vline.width_cols;
    }

    fn coordsToCharOffset(self: *Self, x: i32, y: i32) ?u32 {
        self.updateVirtualLines();
        if (self.truncate and self.viewport != null) {
            self.ensureTruncation();
        }

        const y_offset: i32 = if (self.viewport) |vp| @intCast(vp.y) else 0;
        const x_offset: i32 = if (self.viewport) |vp|
            (if (self.wrap_mode == .none) @intCast(vp.x) else 0)
        else
            0;

        if (self.virtual_lines.items.len == 0) {
            return 0;
        }

        const abs_y = y + y_offset;
        const abs_x = x + x_offset;

        const clamped_y = @max(0, @min(abs_y, @as(i32, @intCast(self.virtual_lines.items.len)) - 1));

        const vline_idx: usize = @intCast(clamped_y);
        const vline = &self.virtual_lines.items[vline_idx];
        const lineStart = vline.document_cell_offset;
        const max_local_x = self.maxLocalXOnVisualLine(self.virtual_lines.items, vline_idx);

        var localX = @max(0, @min(abs_x, @as(i32, @intCast(max_local_x))));

        if (vline.is_truncated) {
            const ellipsis_width: u32 = 3;
            const localX_u32: u32 = @intCast(localX);

            if (localX_u32 >= vline.ellipsis_col and localX_u32 < vline.ellipsis_col + ellipsis_width) {
                localX = @intCast(vline.ellipsis_col);
            } else if (localX_u32 >= vline.ellipsis_col + ellipsis_width) {
                const suffix_offset = localX_u32 - vline.ellipsis_col - ellipsis_width;
                localX = @intCast(vline.truncation_suffix_col_start + suffix_offset);
            }
        }

        if (!vline.is_truncated and localX == @as(i32, @intCast(vline.width_cols))) {
            const rendered_source_end = vline.source_col_start + vline.width_cols;
            const next_idx = vline_idx + 1;
            const has_next_same_source = next_idx < self.virtual_lines.items.len and
                self.virtual_lines.items[next_idx].source_line == vline.source_line;
            if (has_next_same_source and
                self.virtual_lines.items[next_idx].source_col_start > rendered_source_end)
            {
                return self.virtual_lines.items[next_idx].document_cell_offset;
            }
            if (!has_next_same_source) {
                const logical_line_width = self.text_buffer.lineWidthAt(@intCast(vline.source_line));
                if (logical_line_width > rendered_source_end) {
                    return lineStart - vline.source_col_start + logical_line_width;
                }
            }
        }

        const result = lineStart + @as(u32, @intCast(localX));

        return result;
    }

    /// Pack selection info into u64 for efficient passing
    /// Returns 0xFFFF_FFFF_FFFF_FFFF for no selection or zero-width selection
    pub fn packSelectionInfo(self: *const Self) u64 {
        if (self.selection) |sel| {
            if (sel.start == sel.end) {
                return 0xFFFF_FFFF_FFFF_FFFF;
            }
            return (@as(u64, sel.start) << 32) | @as(u64, sel.end);
        } else {
            return 0xFFFF_FFFF_FFFF_FFFF;
        }
    }

    /// Get selected text into buffer - using efficient single-pass API
    pub fn getSelectedTextIntoBuffer(self: *Self, out_buffer: []u8) usize {
        const selection = self.selection orelse return 0;
        if (selection.start == selection.end) return 0;
        return self.text_buffer.getTextRange(selection.start, selection.end, out_buffer);
    }

    pub fn getVirtualLineSpans(self: *const Self, vline_idx: usize) VirtualLineSpanInfo {
        if (vline_idx >= self.virtual_lines.items.len) {
            return .{ .spans = &[_]StyleSpan{}, .source_line = 0, .source_col_start = 0 };
        }

        const vline = &self.virtual_lines.items[vline_idx];
        const spans = self.text_buffer.getLineSpans(vline.source_line);

        return .{
            .spans = spans,
            .source_line = vline.source_line,
            .source_col_start = vline.source_col_start,
        };
    }

    pub fn setTabIndicator(self: *Self, indicator: ?u32) void {
        self.tab_indicator = indicator;
    }

    pub fn getTabIndicator(self: *const Self) ?u32 {
        return self.tab_indicator;
    }

    pub fn setTabIndicatorColor(self: *Self, color: ?RGBA) void {
        self.tab_indicator_color = color;
    }

    pub fn getTabIndicatorColor(self: *const Self) ?RGBA {
        return self.tab_indicator_color;
    }

    pub fn setTruncate(self: *Self, truncate: bool) void {
        if (self.truncate != truncate) {
            self.truncate = truncate;
            self.virtual_lines_dirty = true;
            self.truncation_applied = false;
        }
    }

    pub fn getTruncate(self: *const Self) bool {
        return self.truncate;
    }

    fn ensureTruncation(self: *Self) void {
        if (!self.truncate or self.viewport == null) return;

        if (self.truncation_applied) return;

        if (!self.applyTruncation()) {
            self.truncation_applied = false;
            return;
        }
        self.truncation_applied = true;
    }

    fn applyTruncation(self: *Self) bool {
        const vp = self.viewport orelse return true;
        if (vp.width == 0) return true;

        const ellipsis_width: u32 = 3;

        // Truncation budgets are columns, but VirtualChunks materialize byte windows.
        // Snap both cuts to whole graphemes so renderer bytes remain atomic.
        const keepChunkPrefix = struct {
            fn apply(view: *Self, chunk: VirtualChunk, keep_cols: u32) ?VirtualChunk {
                if (keep_cols == 0) return null;
                if (keep_cols >= chunk.width_cols) return chunk;

                const bytes = chunk.chunk.getBytes(view.text_buffer.memRegistry());
                const window = bytes[chunk.byte_start_in_chunk .. chunk.byte_start_in_chunk + chunk.byte_len];
                const fit = utf8.findWrapPosByWidthGraphemeSafe(
                    window,
                    keep_cols,
                    view.text_buffer.tabWidth(),
                    (chunk.chunk.flags & TextChunk.Flags.ASCII_ONLY) != 0,
                    view.text_buffer.widthMethod(),
                );
                if (fit.byte_offset == 0 or fit.columns_used == 0) return null;

                var partial = chunk;
                partial.byte_len = fit.byte_offset;
                partial.width_cols = fit.columns_used;
                return partial;
            }
        }.apply;

        const dropChunkPrefix = struct {
            fn apply(view: *Self, chunk: VirtualChunk, drop_cols: u32) ?VirtualChunk {
                if (drop_cols == 0) return chunk;
                if (drop_cols >= chunk.width_cols) return null;

                const bytes = chunk.chunk.getBytes(view.text_buffer.memRegistry());
                const window = bytes[chunk.byte_start_in_chunk .. chunk.byte_start_in_chunk + chunk.byte_len];
                const dropped = utf8.findGraphemePosByWidth(
                    window,
                    drop_cols,
                    view.text_buffer.tabWidth(),
                    (chunk.chunk.flags & TextChunk.Flags.ASCII_ONLY) != 0,
                    true,
                    view.text_buffer.widthMethod(),
                );
                if (dropped.byte_offset >= chunk.byte_len or dropped.columns_used >= chunk.width_cols) return null;

                var partial = chunk;
                partial.byte_start_in_chunk += dropped.byte_offset;
                partial.byte_len -= dropped.byte_offset;
                partial.col_start_in_chunk += dropped.columns_used;
                partial.width_cols -= dropped.columns_used;
                return partial;
            }
        }.apply;

        const Replacement = struct {
            chunks: std.ArrayListUnmanaged(VirtualChunk) = .empty,
            width_cols: u32 = 0,
            is_truncated: bool = false,
            ellipsis_col: u32 = 0,
            truncation_suffix_col_start: u32 = 0,
        };
        var overflow_count: usize = 0;
        for (self.virtual_lines.items) |vline| {
            if (vline.width_cols > vp.width) overflow_count += 1;
        }
        if (overflow_count == 0) return true;

        // Stage all replacements first so OOM leaves the original layout retryable.
        const replacements = self.global_allocator.alloc(Replacement, overflow_count) catch return false;
        defer self.global_allocator.free(replacements);
        @memset(replacements, .{});
        const arena_allocator = self.virtual_lines_arena.allocator();

        var replacement_index: usize = 0;
        for (self.virtual_lines.items) |vline| {
            if (vline.width_cols <= vp.width) continue;
            const replacement = &replacements[replacement_index];
            replacement_index += 1;
            replacement.truncation_suffix_col_start = vline.width_cols;

            if (vp.width <= ellipsis_width) {
                replacement.is_truncated = true;
                continue;
            }

            const available_width = vp.width - ellipsis_width;
            const prefix_width = available_width / 2;
            const suffix_width = available_width - prefix_width;

            var prefix_accumulated: u32 = 0;
            for (vline.chunks.items) |chunk| {
                if (prefix_accumulated >= prefix_width) break;

                const space_left = prefix_width - prefix_accumulated;
                if (chunk.width_cols <= space_left) {
                    replacement.chunks.append(arena_allocator, chunk) catch return false;
                    prefix_accumulated += chunk.width_cols;
                } else {
                    if (keepChunkPrefix(self, chunk, space_left)) |partial| {
                        replacement.chunks.append(arena_allocator, partial) catch return false;
                        prefix_accumulated += partial.width_cols;
                    }
                    break;
                }
            }

            replacement.chunks.append(arena_allocator, .{
                .chunk = &self.ellipsis_chunk,
                .byte_start_in_chunk = 0,
                .byte_len = self.ellipsis_chunk.byte_end - self.ellipsis_chunk.byte_start,
                .col_start_in_chunk = 0,
                .width_cols = ellipsis_width,
            }) catch return false;

            const suffix_start_pos = vline.width_cols - suffix_width;

            var pos_accumulated: u32 = 0;
            var suffix_accumulated: u32 = 0;
            var actual_suffix_start: ?u32 = null;
            for (vline.chunks.items) |chunk| {
                const chunk_end = pos_accumulated + chunk.width_cols;

                if (chunk_end <= suffix_start_pos) {
                    pos_accumulated += chunk.width_cols;
                    continue;
                }

                if (pos_accumulated >= suffix_start_pos) {
                    replacement.chunks.append(arena_allocator, chunk) catch return false;
                    if (actual_suffix_start == null) actual_suffix_start = pos_accumulated;
                    suffix_accumulated += chunk.width_cols;
                } else {
                    if (dropChunkPrefix(self, chunk, suffix_start_pos - pos_accumulated)) |partial| {
                        replacement.chunks.append(arena_allocator, partial) catch return false;
                        if (actual_suffix_start == null) {
                            actual_suffix_start = pos_accumulated + partial.col_start_in_chunk - chunk.col_start_in_chunk;
                        }
                        suffix_accumulated += partial.width_cols;
                    }
                }

                pos_accumulated += chunk.width_cols;
            }

            replacement.width_cols = prefix_accumulated + ellipsis_width + suffix_accumulated;
            replacement.is_truncated = true;
            replacement.ellipsis_col = prefix_accumulated;
            replacement.truncation_suffix_col_start = actual_suffix_start orelse vline.width_cols;
        }

        replacement_index = 0;
        for (self.virtual_lines.items) |*vline| {
            if (vline.width_cols <= vp.width) continue;
            const replacement = replacements[replacement_index];
            replacement_index += 1;
            vline.chunks = replacement.chunks;
            vline.width_cols = replacement.width_cols;
            vline.is_truncated = replacement.is_truncated;
            vline.ellipsis_col = replacement.ellipsis_col;
            vline.truncation_suffix_col_start = replacement.truncation_suffix_col_start;
        }
        return true;
    }

    /// Measure dimensions for given width/height WITHOUT modifying virtual lines cache
    /// This is useful for Yoga measure functions that need to know dimensions without committing changes
    /// Special case: width=0 or wrap_mode=.none means "measure intrinsic/max-content width" (no wrapping)
    pub fn measureForDimensions(self: *Self, width: u32, height: u32) TextBufferViewError!MeasureResult {
        _ = height; // Height is for future use, currently only width affects layout
        const epoch = self.text_buffer.getContentEpoch();
        if (self.cached_measure_result) |result| {
            if (self.cached_measure_epoch == epoch and self.cached_measure_buffer == self.text_buffer) {
                if (self.cached_measure_width) |cached_width| {
                    if (cached_width == width and
                        self.cached_measure_wrap_mode == self.wrap_mode and
                        self.cached_measure_first_line_offset == self.first_line_offset)
                    {
                        return result;
                    }
                }
            }
        }

        // No-wrap path avoids allocations by using marker-based line widths.
        if (width == 0 or self.wrap_mode == .none) {
            const line_count = self.text_buffer.lineCount();
            var width_cols_max: u32 = 0;
            var row: u32 = 0;
            while (row < line_count) : (row += 1) {
                width_cols_max = @max(width_cols_max, self.text_buffer.lineWidthAt(row));
            }

            const result: MeasureResult = .{
                .line_count = line_count,
                .width_cols_max = width_cols_max,
            };

            self.cached_measure_width = width;
            self.cached_measure_wrap_mode = self.wrap_mode;
            self.cached_measure_first_line_offset = self.first_line_offset;
            self.cached_measure_result = result;
            self.cached_measure_epoch = epoch;
            self.cached_measure_buffer = self.text_buffer;

            return result;
        }

        // Reuse arena capacity to avoid allocation overhead during streaming.
        _ = self.measure_arena.reset(.retain_capacity);
        const measure_allocator = self.measure_arena.allocator();

        var result: MeasureResult = .{ .line_count = 0, .width_cols_max = 0 };
        const calculated = switch (self.wrap_mode) {
            .none => unreachable,
            .char => calculateVirtualLinesGeneric(.measure, .char, measure_allocator, self.text_buffer, width, self.first_line_offset, &result, null),
            .word => calculateVirtualLinesGeneric(.measure, .word, measure_allocator, self.text_buffer, width, self.first_line_offset, &result, null),
        };
        if (!calculated) return TextBufferViewError.OutOfMemory;

        self.cached_measure_width = width;
        self.cached_measure_wrap_mode = self.wrap_mode;
        self.cached_measure_first_line_offset = self.first_line_offset;
        self.cached_measure_result = result;
        self.cached_measure_epoch = epoch;
        self.cached_measure_buffer = self.text_buffer;

        return result;
    }

    const CalculationMode = enum { render, measure };

    fn calculateUnwrappedVirtualLines(
        allocator: Allocator,
        text_buffer: *UnifiedTextBuffer,
        output: VirtualLineOutput,
    ) bool {
        // No wrapping - create 1:1 mapping to real lines
        const Context = struct {
            text_buffer: *UnifiedTextBuffer,
            allocator: Allocator,
            output: VirtualLineOutput,
            current_vline: ?VirtualLine = null,
            failed: bool = false,

            fn segment_callback(ctx_ptr: *anyopaque, line_idx: u32, chunk: *const TextChunk, _: u32) void {
                _ = line_idx;
                const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
                if (ctx.failed) return;

                if (ctx.current_vline) |*vline| {
                    vline.appendChunk(ctx.allocator, .{
                        .chunk = chunk,
                        .byte_start_in_chunk = 0,
                        .byte_len = chunk.byte_end - chunk.byte_start,
                        .col_start_in_chunk = 0,
                        .width_cols = chunk.width_cols,
                    }) catch {
                        ctx.failed = true;
                    };
                }
            }

            fn line_end_callback(ctx_ptr: *anyopaque, line_info: iter_mod.LineInfo) void {
                const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
                if (ctx.failed) return;

                const first_vline_idx: u32 = @intCast(ctx.output.virtual_lines.items.len);
                ctx.output.cached_line_first_vline.append(ctx.allocator, first_vline_idx) catch {
                    ctx.failed = true;
                    return;
                };
                ctx.output.cached_line_vline_counts.append(ctx.allocator, 1) catch {
                    ctx.failed = true;
                    return;
                };

                var vline = if (ctx.current_vline) |v| v else VirtualLine.init();
                vline.width_cols = line_info.width_cols;
                vline.document_cell_offset = line_info.col_offset;
                vline.source_line = line_info.line_idx;
                vline.source_col_start = 0;

                ctx.output.virtual_lines.append(ctx.allocator, vline) catch {
                    ctx.failed = true;
                    return;
                };
                ctx.output.cached_line_starts.append(ctx.allocator, vline.document_cell_offset) catch {
                    ctx.failed = true;
                    return;
                };
                ctx.output.cached_line_widths.append(ctx.allocator, vline.width_cols) catch {
                    ctx.failed = true;
                    return;
                };
                ctx.output.cached_line_sources.append(ctx.allocator, @intCast(line_info.line_idx)) catch {
                    ctx.failed = true;
                    return;
                };
                ctx.output.cached_line_wrap_indices.append(ctx.allocator, 0) catch {
                    ctx.failed = true;
                    return;
                };

                ctx.current_vline = VirtualLine.init();
            }
        };

        var ctx: Context = .{
            .text_buffer = text_buffer,
            .allocator = allocator,
            .output = output,
            .current_vline = VirtualLine.init(),
        };

        text_buffer.walkLinesAndSegments(&ctx, Context.segment_callback, Context.line_end_callback);
        return !ctx.failed;
    }

    /// One wrapping policy, specialized at comptime for its output and break mode.
    fn calculateVirtualLinesGeneric(
        comptime calculation: CalculationMode,
        comptime wrap_mode: WrapMode,
        allocator: Allocator,
        text_buffer: *UnifiedTextBuffer,
        wrap_w: u32,
        first_line_offset: u32,
        result: if (calculation == .render) VirtualLineOutput else *MeasureResult,
        word_layout: ?*WordLayoutStorage,
    ) bool {
        comptime std.debug.assert(wrap_mode != .none);

        const WrapContext = struct {
            text_buffer: *UnifiedTextBuffer,
            allocator: Allocator,
            result: @TypeOf(result),
            word_layout: ?*WordLayoutStorage,
            word_layout_index: usize = 0,
            wrap_w: u32,
            current_wrap_width: u32,
            document_cell_offset: u32 = 0,
            line_idx: u32 = 0,
            source_line_col_offset: u32 = 0,
            current_vline_width_cols: u32 = 0,
            current_vline: if (calculation == .render) VirtualLine else void = if (calculation == .render) VirtualLine.init() else {},
            current_line_first_vline_idx: if (calculation == .render) u32 else void = if (calculation == .render) 0 else {},
            current_line_vline_count: if (calculation == .render) u32 else void = if (calculation == .render) 0 else {},
            pending_word_pieces: if (wrap_mode == .word) std.ArrayListUnmanaged(PendingWordPiece) else void = if (wrap_mode == .word) .empty else {},
            pending_word_width_cols: if (wrap_mode == .word) u32 else void = if (wrap_mode == .word) 0 else {},
            pending_word_last_class: if (wrap_mode == .word) utf8.WordClass else void = if (wrap_mode == .word) .other else {},
            word_line_preflight: if (wrap_mode == .word) bool else void,
            word_line_chunks: if (wrap_mode == .word) std.ArrayListUnmanaged(*const TextChunk) else void = if (wrap_mode == .word) .empty else {},
            word_line_first_chunk: if (wrap_mode == .word) ?*const TextChunk else void = if (wrap_mode == .word) null else {},
            word_line_last_cp: if (wrap_mode == .word) ?u21 else void = if (wrap_mode == .word) null else {},
            source_line_cjk_breaks: if (wrap_mode == .word) bool else void = if (wrap_mode == .word) true else {},
            source_line_has_non_whitespace: if (wrap_mode == .word) bool else void = if (wrap_mode == .word) false else {},
            word_chunk: if (wrap_mode == .word) ?*const TextChunk else void = if (wrap_mode == .word) null else {},
            word_chunk_col_start: if (wrap_mode == .word) u32 else void = if (wrap_mode == .word) 0 else {},
            word_chunk_byte_start: if (wrap_mode == .word) u32 else void = if (wrap_mode == .word) 0 else {},
            logical_measure_line_count: if (wrap_mode == .word and calculation == .measure) u32 else void = if (wrap_mode == .word and calculation == .measure) 0 else {},
            logical_measure_width_max: if (wrap_mode == .word and calculation == .measure) u32 else void = if (wrap_mode == .word and calculation == .measure) 0 else {},
            failed: bool = false,

            fn lineWrapWidth(wctx: *@This()) u32 {
                return wctx.current_wrap_width;
            }

            fn wordWrapWidth(wctx: *@This()) u32 {
                return @max(wctx.lineWrapWidth(), 1);
            }

            fn commitVirtualLine(wctx: *@This()) Allocator.Error!void {
                if (comptime calculation == .render) {
                    wctx.current_vline.width_cols = wctx.current_vline_width_cols;
                    wctx.current_vline.source_line = wctx.line_idx;
                    wctx.current_vline.source_col_start = wctx.source_line_col_offset;
                }
                try wctx.recordVirtualLine();

                if (comptime calculation == .render) wctx.current_line_vline_count += 1;

                wctx.source_line_col_offset += wctx.current_vline_width_cols;
                if (comptime calculation == .render) {
                    wctx.current_vline = VirtualLine.init();
                    wctx.current_vline.document_cell_offset = wctx.document_cell_offset;
                }
                wctx.current_vline_width_cols = 0;
                wctx.current_wrap_width = wctx.wrap_w;
            }

            fn recordVirtualLine(wctx: *@This()) Allocator.Error!void {
                if (comptime calculation == .measure) {
                    wctx.result.line_count += 1;
                    wctx.result.width_cols_max = @max(wctx.result.width_cols_max, wctx.current_vline_width_cols);
                    if (comptime wrap_mode == .word) {
                        wctx.logical_measure_line_count += 1;
                        wctx.logical_measure_width_max = @max(wctx.logical_measure_width_max, wctx.current_vline_width_cols);
                    }
                } else {
                    const out = wctx.result;
                    try out.virtual_lines.append(wctx.allocator, wctx.current_vline);
                    try out.cached_line_starts.append(wctx.allocator, wctx.current_vline.document_cell_offset);
                    try out.cached_line_widths.append(wctx.allocator, wctx.current_vline.width_cols);
                    try out.cached_line_sources.append(wctx.allocator, wctx.line_idx);
                    try out.cached_line_wrap_indices.append(wctx.allocator, wctx.current_line_vline_count);
                }
            }

            inline fn addVirtualChunk(wctx: *@This(), chunk: *const TextChunk, byte_start: u32, byte_len: u32, col_start: u32, width_cols: u32) Allocator.Error!void {
                if (byte_len == 0) return;

                if (comptime calculation == .render and wrap_mode == .word) {
                    if (wctx.current_vline.chunks.items.len > 0) {
                        const last = &wctx.current_vline.chunks.items[wctx.current_vline.chunks.items.len - 1];
                        if (last.chunk == chunk and
                            last.byte_start_in_chunk + last.byte_len == byte_start and
                            last.col_start_in_chunk + last.width_cols == col_start)
                        {
                            last.byte_len += byte_len;
                            last.width_cols += width_cols;
                            wctx.document_cell_offset += width_cols;
                            wctx.current_vline_width_cols += width_cols;
                            return;
                        }
                    }
                }

                if (comptime calculation == .render) {
                    try wctx.current_vline.appendChunk(wctx.allocator, .{
                        .chunk = chunk,
                        .byte_start_in_chunk = byte_start,
                        .byte_len = byte_len,
                        .col_start_in_chunk = col_start,
                        .width_cols = width_cols,
                    });
                }
                wctx.document_cell_offset += width_cols;
                wctx.current_vline_width_cols += width_cols;
            }

            inline fn addVirtualChunkSticky(wctx: *@This(), chunk: *const TextChunk, byte_start: u32, byte_len: u32, col_start: u32, width_cols: u32) bool {
                addVirtualChunk(wctx, chunk, byte_start, byte_len, col_start, width_cols) catch {
                    wctx.failed = true;
                    return false;
                };
                return true;
            }

            fn commitVirtualLineSticky(wctx: *@This()) bool {
                commitVirtualLine(wctx) catch {
                    wctx.failed = true;
                    return false;
                };
                return true;
            }

            fn consumeDroppedWhitespace(wctx: *@This(), width_cols: u32) void {
                // Wrapped separators are hidden on the continuation but remain in
                // the preceding visual line's logical source interval.
                wctx.document_cell_offset += width_cols;
                wctx.source_line_col_offset += width_cols;
                if (comptime calculation == .render) wctx.current_vline.document_cell_offset = wctx.document_cell_offset;
            }

            fn queuePendingWordPiece(wctx: *@This(), chunk: *const TextChunk, col_start_in_chunk: u32, width_cols: u32, byte_start: u32, byte_end: u32) void {
                if (width_cols == 0 or wctx.failed) return;

                if (wctx.pending_word_pieces.items.len > 0) {
                    const last = &wctx.pending_word_pieces.items[wctx.pending_word_pieces.items.len - 1];
                    if (last.chunk == chunk and last.col_start_in_chunk + last.width_cols == col_start_in_chunk and last.byte_end == byte_start) {
                        last.width_cols += width_cols;
                        last.byte_end = byte_end;
                        wctx.pending_word_width_cols += width_cols;
                        return;
                    }
                }

                wctx.pending_word_pieces.append(wctx.allocator, .{
                    .col_start_in_chunk = col_start_in_chunk,
                    .width_cols = width_cols,
                    .byte_start = byte_start,
                    .byte_end = byte_end,
                    .chunk = chunk,
                }) catch {
                    wctx.failed = true;
                    return;
                };
                wctx.pending_word_width_cols += width_cols;
            }

            fn clearPendingWord(wctx: *@This()) void {
                wctx.pending_word_pieces.clearRetainingCapacity();
                wctx.pending_word_width_cols = 0;
                wctx.pending_word_last_class = .other;
            }

            fn dropPendingWordPrefix(wctx: *@This(), count: usize) void {
                if (count == 0) return;
                const remaining = wctx.pending_word_pieces.items.len - count;
                if (remaining > 0) {
                    std.mem.copyForwards(
                        PendingWordPiece,
                        wctx.pending_word_pieces.items[0..remaining],
                        wctx.pending_word_pieces.items[count..],
                    );
                }
                wctx.pending_word_pieces.items.len = remaining;
            }

            fn fitPendingWordPiece(wctx: *@This(), piece: PendingWordPiece, max_width_cols: u32, allow_forced_grapheme: bool) PendingWordPieceFit {
                if (piece.width_cols <= max_width_cols) {
                    return .{ .width_cols = piece.width_cols, .bytes_used = piece.byte_end - piece.byte_start };
                }
                if (max_width_cols == 0) return .{ .width_cols = 0, .bytes_used = 0 };

                const chunk_bytes = piece.chunk.getBytes(wctx.text_buffer.memRegistry());
                if (piece.byte_start > piece.byte_end or piece.byte_end > chunk_bytes.len) {
                    wctx.failed = true;
                    return .{ .width_cols = 0, .bytes_used = 0 };
                }
                const slice_bytes = chunk_bytes[piece.byte_start..piece.byte_end];
                const is_ascii_only = (piece.chunk.flags & TextChunk.Flags.ASCII_ONLY) != 0;
                const fit = utf8.findWrapPosByWidthGraphemeSafe(
                    slice_bytes,
                    max_width_cols,
                    wctx.text_buffer.tabWidth(),
                    is_ascii_only,
                    wctx.text_buffer.widthMethod(),
                );
                if (fit.columns_used > 0 and fit.byte_offset > 0) {
                    return .{
                        .width_cols = @min(fit.columns_used, piece.width_cols),
                        .bytes_used = @min(fit.byte_offset, piece.byte_end - piece.byte_start),
                    };
                }

                if (!allow_forced_grapheme) return .{ .width_cols = 0, .bytes_used = 0 };

                const forced = utf8.findGraphemePosByWidth(
                    slice_bytes,
                    max_width_cols,
                    wctx.text_buffer.tabWidth(),
                    is_ascii_only,
                    true,
                    wctx.text_buffer.widthMethod(),
                );
                if (forced.columns_used == 0 or forced.byte_offset == 0) {
                    wctx.failed = true;
                    return .{ .width_cols = 0, .bytes_used = 0 };
                }
                return .{
                    .width_cols = @min(forced.columns_used, piece.width_cols),
                    .bytes_used = @min(forced.byte_offset, piece.byte_end - piece.byte_start),
                };
            }

            fn consumePendingWordPrefix(wctx: *@This(), max_width_cols: u32) bool {
                if (max_width_cols == 0 or wctx.pending_word_width_cols == 0 or wctx.failed) return false;

                const vline_width_cols_before = wctx.current_vline_width_cols;
                var remaining_width_cols = max_width_cols;
                var consumed_count: usize = 0;
                while (consumed_count < wctx.pending_word_pieces.items.len and remaining_width_cols > 0) {
                    const piece = wctx.pending_word_pieces.items[consumed_count];
                    if (piece.width_cols <= remaining_width_cols) {
                        if (!addVirtualChunkSticky(wctx, piece.chunk, piece.byte_start, piece.byte_end - piece.byte_start, piece.col_start_in_chunk, piece.width_cols)) return false;
                        remaining_width_cols -= piece.width_cols;
                        consumed_count += 1;
                        continue;
                    }

                    const fit = fitPendingWordPiece(wctx, piece, remaining_width_cols, wctx.current_vline_width_cols == vline_width_cols_before);
                    if (fit.width_cols == 0) break;
                    if (!addVirtualChunkSticky(wctx, piece.chunk, piece.byte_start, fit.bytes_used, piece.col_start_in_chunk, fit.width_cols)) return false;
                    wctx.pending_word_pieces.items[consumed_count].col_start_in_chunk += fit.width_cols;
                    wctx.pending_word_pieces.items[consumed_count].width_cols -= fit.width_cols;
                    wctx.pending_word_pieces.items[consumed_count].byte_start += fit.bytes_used;
                    if (wctx.pending_word_pieces.items[consumed_count].width_cols == 0) consumed_count += 1;
                    break;
                }

                dropPendingWordPrefix(wctx, consumed_count);
                const consumed_width_cols = wctx.current_vline_width_cols - vline_width_cols_before;
                wctx.pending_word_width_cols -= consumed_width_cols;
                return consumed_width_cols > 0;
            }

            fn appendPendingWordToLine(wctx: *@This()) void {
                for (wctx.pending_word_pieces.items) |piece| {
                    if (!addVirtualChunkSticky(wctx, piece.chunk, piece.byte_start, piece.byte_end - piece.byte_start, piece.col_start_in_chunk, piece.width_cols)) return;
                }
                clearPendingWord(wctx);
            }

            fn finalizePendingWord(wctx: *@This()) void {
                while (wctx.pending_word_width_cols > 0 and !wctx.failed) {
                    const wrap_limit_cols = wctx.wordWrapWidth();
                    if (wctx.current_vline_width_cols > 0 and wctx.current_vline_width_cols + wctx.pending_word_width_cols > wrap_limit_cols) {
                        if (!commitVirtualLineSticky(wctx)) return;
                        continue;
                    }
                    if (wctx.current_vline_width_cols == 0 and wctx.pending_word_width_cols > wrap_limit_cols) {
                        if (!consumePendingWordPrefix(wctx, wrap_limit_cols)) return;
                        if (wctx.pending_word_width_cols > 0 and !commitVirtualLineSticky(wctx)) return;
                        continue;
                    }
                    appendPendingWordToLine(wctx);
                }
            }

            inline fn placeCompleteWordPiece(wctx: *@This(), chunk: *const TextChunk, col_start_in_chunk: u32, width_cols: u32, byte_start: u32, byte_end: u32) void {
                if (width_cols == 0 or wctx.failed) return;

                var piece: PendingWordPiece = .{
                    .col_start_in_chunk = col_start_in_chunk,
                    .width_cols = width_cols,
                    .byte_start = byte_start,
                    .byte_end = byte_end,
                    .chunk = chunk,
                };
                while (piece.width_cols > 0 and !wctx.failed) {
                    const wrap_limit_cols = wctx.wordWrapWidth();
                    if (piece.width_cols <= wrap_limit_cols) {
                        if (wctx.current_vline_width_cols > 0 and wctx.current_vline_width_cols + piece.width_cols > wrap_limit_cols and !commitVirtualLineSticky(wctx)) return;
                        _ = addVirtualChunkSticky(wctx, chunk, piece.byte_start, piece.byte_end - piece.byte_start, piece.col_start_in_chunk, piece.width_cols);
                        return;
                    }
                    if (wctx.current_vline_width_cols > 0 and !commitVirtualLineSticky(wctx)) return;

                    const fit = fitPendingWordPiece(wctx, piece, wctx.wordWrapWidth(), true);
                    if (fit.width_cols == 0) return;
                    if (!addVirtualChunkSticky(wctx, chunk, piece.byte_start, fit.bytes_used, piece.col_start_in_chunk, fit.width_cols)) return;
                    piece.col_start_in_chunk += fit.width_cols;
                    piece.width_cols -= fit.width_cols;
                    piece.byte_start += fit.bytes_used;
                    if (piece.width_cols > 0 and !commitVirtualLineSticky(wctx)) return;
                }
            }

            fn flushCompleteWordPiece(wctx: *@This(), chunk: *const TextChunk, col_start_in_chunk: u32, width_cols: u32, byte_start: u32, byte_end: u32) void {
                if (width_cols == 0 or wctx.failed) return;
                if (wctx.pending_word_width_cols > 0) {
                    queuePendingWordPiece(wctx, chunk, col_start_in_chunk, width_cols, byte_start, byte_end);
                    finalizePendingWord(wctx);
                } else {
                    placeCompleteWordPiece(wctx, chunk, col_start_in_chunk, width_cols, byte_start, byte_end);
                }
            }

            fn processWhitespaceBreak(wctx: *@This(), chunk: *const TextChunk, col_start: u32, byte_start: u32, wrap_break: utf8.LayoutWrapBreak) void {
                // A fitting word and separator already coalesce into one chunk.
                if (wctx.pending_word_width_cols == 0 and wrap_break.width_cols > 0 and wrap_break.col_start > col_start and
                    wctx.current_vline_width_cols + (wrap_break.colEnd() - col_start) <= wctx.wordWrapWidth())
                {
                    _ = addVirtualChunkSticky(wctx, chunk, byte_start, wrap_break.byteEnd() - byte_start, col_start, wrap_break.colEnd() - col_start);
                    wctx.source_line_has_non_whitespace = true;
                    return;
                }
                if (wrap_break.col_start > col_start) {
                    flushCompleteWordPiece(
                        wctx,
                        chunk,
                        col_start,
                        wrap_break.col_start - col_start,
                        byte_start,
                        wrap_break.byte_start,
                    );
                    if (wctx.failed) return;
                    wctx.source_line_has_non_whitespace = true;
                } else if (wctx.pending_word_width_cols > 0) {
                    finalizePendingWord(wctx);
                    if (wctx.failed) return;
                }

                // Logical-line indentation is content; only later separators may be elided.
                const preserve_leading = !wctx.source_line_has_non_whitespace;
                const wrap_limit_cols = wctx.wordWrapWidth();
                if (!preserve_leading and wctx.current_vline_width_cols + wrap_break.width_cols > wrap_limit_cols) {
                    if (wctx.current_vline_width_cols > 0 and !commitVirtualLineSticky(wctx)) return;
                    consumeDroppedWhitespace(wctx, wrap_break.width_cols);
                    return;
                }

                if (!preserve_leading and wctx.current_vline_width_cols == 0) {
                    consumeDroppedWhitespace(wctx, wrap_break.width_cols);
                    return;
                }

                placeCompleteWordPiece(
                    wctx,
                    chunk,
                    wrap_break.col_start,
                    wrap_break.width_cols,
                    wrap_break.byte_start,
                    wrap_break.byteEnd(),
                );
            }

            inline fn processWordWrapBreakValue(wctx: *@This(), wrap_break: utf8.LayoutWrapBreak) void {
                if (wrap_break.kind == .cjk_intercharacter and !wctx.source_line_cjk_breaks) return;
                const chunk = wctx.word_chunk orelse return;
                const chunk_bytes = chunk.getBytes(wctx.text_buffer.memRegistry());
                const col_end = @min(wrap_break.colEnd(), chunk.width_cols);
                const byte_end = @min(wrap_break.byteEnd(), @as(u32, @intCast(chunk_bytes.len)));
                if (col_end < wctx.word_chunk_col_start or byte_end < wctx.word_chunk_byte_start) return;
                if (wrap_break.kind == .whitespace) {
                    processWhitespaceBreak(wctx, chunk, wctx.word_chunk_col_start, wctx.word_chunk_byte_start, wrap_break);
                    if (wctx.failed) return;
                    wctx.word_chunk_col_start = col_end;
                    wctx.word_chunk_byte_start = byte_end;
                    return;
                }
                if (col_end > wctx.word_chunk_col_start) {
                    flushCompleteWordPiece(
                        wctx,
                        chunk,
                        wctx.word_chunk_col_start,
                        col_end - wctx.word_chunk_col_start,
                        wctx.word_chunk_byte_start,
                        byte_end,
                    );
                    if (wctx.failed) return;
                    wctx.source_line_has_non_whitespace = true;
                } else if (byte_end > wctx.word_chunk_byte_start and wctx.pending_word_width_cols > 0) {
                    finalizePendingWord(wctx);
                    if (wctx.failed) return;
                }
                wctx.word_chunk_col_start = col_end;
                wctx.word_chunk_byte_start = byte_end;
            }

            inline fn processWordWrapBreak(wctx: *@This(), wrap_break: utf8.LayoutWrapBreak) !bool {
                processWordWrapBreakValue(wctx, wrap_break);
                return !wctx.failed;
            }

            fn processWordChunk(wctx: *@This(), chunk: *const TextChunk) void {
                const chunk_bytes = chunk.getBytes(wctx.text_buffer.memRegistry());
                // Reuse existing caches, but retain cold layout only for medium
                // non-ASCII chunks; vectorized ASCII and small/large chunks stream.
                const cached_layout = chunk.getCachedLayoutInfo(wctx.text_buffer.tabWidth(), wctx.text_buffer.widthMethod());
                var layout: ?utf8.ChunkLayoutInfo = if (cached_layout) |cached|
                    cached
                else blk: {
                    if (comptime calculation == .render) {
                        if (!chunk.isAsciiOnly() and chunk_bytes.len >= 1024 and chunk_bytes.len <= 64 * 1024) {
                            const info: seg_mod.TextBufferError!utf8.ChunkLayoutInfo = if (wctx.source_line_cjk_breaks)
                                wctx.text_buffer.getLayoutInfoFor(chunk)
                            else if (wctx.text_buffer.getWordLayoutInfoFor(chunk)) |word_info| .{
                                .wrap_breaks = word_info.wrap_breaks,
                                .word_classes = .{ .first = word_info.word_classes.first, .last = word_info.word_classes.last },
                            } else |err| err;
                            break :blk info catch |err| switch (err) {
                                error.OutOfMemory => null,
                                else => {
                                    wctx.failed = true;
                                    return;
                                },
                            };
                        }
                    }
                    break :blk null;
                };
                if (wctx.word_layout) |storage| {
                    const index = wctx.word_layout_index;
                    wctx.word_layout_index += 1;
                    if (index < storage.layouts.items.len) {
                        layout = storage.layouts.items[index];
                    } else {
                        const saved = save: {
                            const layout_allocator = storage.arena.allocator();
                            if (layout == null) {
                                var breaks: std.ArrayListUnmanaged(utf8.LayoutWrapBreak) = .empty;
                                const classes = utf8.findChunkLayoutInfo(layout_allocator, chunk_bytes, wctx.text_buffer.tabWidth(), chunk.isAsciiOnly(), wctx.text_buffer.widthMethod(), &breaks) catch break :save false;
                                layout = .{ .wrap_breaks = breaks.toOwnedSlice(layout_allocator) catch break :save false, .word_classes = classes };
                            }
                            storage.layouts.append(layout_allocator, layout.?) catch break :save false;
                            break :save true;
                        };
                        if (!saved) {
                            // Optional reuse must not prevent a streaming layout on OOM.
                            storage.reset();
                            wctx.word_layout = null;
                            layout = null;
                        }
                    }
                }
                const word_classes = if (layout) |info|
                    info.word_classes
                else
                    utf8.chunkWordClassEdges(chunk_bytes);
                if (wctx.pending_word_width_cols > 0 and
                    (utf8.isCjkAsciiTransition(wctx.pending_word_last_class, word_classes.first) or
                        (wctx.source_line_cjk_breaks and chunk_bytes.len > 0 and
                            utf8.isCjkIntercharacterBreak(wctx.pending_word_last_class, word_classes.first, utf8.decodeUtf8Unchecked(chunk_bytes, 0).cp))))
                {
                    finalizePendingWord(wctx);
                    if (wctx.failed) return;
                }
                wctx.word_chunk = chunk;
                wctx.word_chunk_col_start = 0;
                wctx.word_chunk_byte_start = 0;
                const last_word_class = if (layout) |info| blk: {
                    var cjk_idx: usize = 0;
                    for (info.wrap_breaks) |wrap_break| {
                        if (wctx.source_line_cjk_breaks) {
                            while (cjk_idx < info.cjk_breaks.len and info.cjk_breaks[cjk_idx].byte_start < wrap_break.byte_start) : (cjk_idx += 1) {
                                processWordWrapBreakValue(wctx, info.cjk_breaks[cjk_idx]);
                                if (wctx.failed) return;
                            }
                        }
                        processWordWrapBreakValue(wctx, wrap_break);
                        if (wctx.failed) return;
                    }
                    if (wctx.source_line_cjk_breaks) {
                        for (info.cjk_breaks[cjk_idx..]) |wrap_break| {
                            processWordWrapBreakValue(wctx, wrap_break);
                            if (wctx.failed) return;
                        }
                    }
                    break :blk info.word_classes.last;
                } else blk: {
                    const streamed_layout = utf8.walkChunkLayoutInfoComptime(
                        chunk_bytes,
                        wctx.text_buffer.tabWidth(),
                        chunk.isAsciiOnly(),
                        wctx.text_buffer.widthMethod(),
                        wctx,
                        processWordWrapBreak,
                    ) catch {
                        wctx.failed = true;
                        return;
                    };
                    break :blk streamed_layout.last;
                };

                if (wctx.word_chunk_col_start < chunk.width_cols) {
                    queuePendingWordPiece(
                        wctx,
                        chunk,
                        wctx.word_chunk_col_start,
                        chunk.width_cols - wctx.word_chunk_col_start,
                        wctx.word_chunk_byte_start,
                        @intCast(chunk_bytes.len),
                    );
                    if (!wctx.failed) wctx.pending_word_last_class = last_word_class;
                    wctx.source_line_has_non_whitespace = true;
                }
                wctx.word_chunk = null;
            }

            fn processCharChunk(comptime width_method: utf8.WidthMethod, wctx: *@This(), chunk: *const TextChunk) Allocator.Error!void {
                const chunk_bytes = chunk.getBytes(wctx.text_buffer.memRegistry());
                const is_ascii_only = (chunk.flags & TextChunk.Flags.ASCII_ONLY) != 0;
                const tab_width = wctx.text_buffer.tabWidth();
                var chunk_byte_offset: usize = 0;
                var chunk_col_offset: u32 = 0;

                // Advance bytes with columns; re-deriving each byte boundary would
                // make repeated wraps within a long chunk quadratic.
                while (chunk_col_offset < chunk.width_cols) {
                    const line_wrap_width_cols = wctx.lineWrapWidth();
                    const remaining_width_cols = if (wctx.current_vline_width_cols < line_wrap_width_cols) line_wrap_width_cols - wctx.current_vline_width_cols else 0;

                    if (remaining_width_cols == 0) {
                        if (wctx.current_vline_width_cols > 0) {
                            try commitVirtualLine(wctx);
                            continue;
                        }
                        const remaining_bytes = chunk_bytes[chunk_byte_offset..];
                        const force_result = utf8.findGraphemePosByWidth(remaining_bytes, 1, tab_width, is_ascii_only, true, width_method);
                        if (force_result.grapheme_count > 0) {
                            try addVirtualChunk(wctx, chunk, @intCast(chunk_byte_offset), force_result.byte_offset, chunk_col_offset, force_result.columns_used);
                            chunk_col_offset += force_result.columns_used;
                            chunk_byte_offset += force_result.byte_offset;
                        } else {
                            break;
                        }
                        continue;
                    }

                    const remaining_bytes = chunk_bytes[chunk_byte_offset..];
                    const wrap_result = utf8.findWrapPosByWidthGraphemeSafe(
                        remaining_bytes,
                        remaining_width_cols,
                        tab_width,
                        is_ascii_only,
                        width_method,
                    );

                    if (wrap_result.grapheme_count == 0) {
                        if (wctx.current_vline_width_cols > 0) {
                            try commitVirtualLine(wctx);
                            continue;
                        }
                        const force_result = utf8.findGraphemePosByWidth(remaining_bytes, 1, tab_width, is_ascii_only, true, width_method);
                        if (force_result.grapheme_count > 0) {
                            try addVirtualChunk(wctx, chunk, @intCast(chunk_byte_offset), force_result.byte_offset, chunk_col_offset, force_result.columns_used);
                            chunk_col_offset += force_result.columns_used;
                            chunk_byte_offset += force_result.byte_offset;
                            if (chunk_col_offset < chunk.width_cols) {
                                try commitVirtualLine(wctx);
                                continue;
                            }
                        }
                        break;
                    }

                    try addVirtualChunk(wctx, chunk, @intCast(chunk_byte_offset), wrap_result.byte_offset, chunk_col_offset, wrap_result.columns_used);
                    chunk_col_offset += wrap_result.columns_used;
                    chunk_byte_offset += wrap_result.byte_offset;

                    if (wctx.current_vline_width_cols >= line_wrap_width_cols and chunk_col_offset < chunk.width_cols) {
                        try commitVirtualLine(wctx);
                    }
                }
            }

            fn segment_callback(ctx_ptr: *anyopaque, _: u32, chunk: *const TextChunk, chunk_idx_in_line: u32) void {
                const wctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
                if (wctx.failed) return;

                if (comptime wrap_mode == .word) {
                    // Printable ASCII cannot join graphemes across chunks. Stream it,
                    // retaining the single-chunk measurement-summary shortcut.
                    if (!wctx.word_line_preflight) {
                        if (comptime calculation == .measure) {
                            if (wctx.word_line_first_chunk) |first| {
                                processWordChunk(wctx, first);
                                wctx.word_line_first_chunk = null;
                                if (wctx.failed) return;
                            } else if (chunk_idx_in_line == 0) {
                                wctx.word_line_first_chunk = chunk;
                                return;
                            }
                        }
                        processWordChunk(wctx, chunk);
                        return;
                    }
                    // Decide the policy before emitting any CJK opportunities. Retain
                    // only this line's chunk pointers, without rescanning its bytes.
                    if (wctx.word_line_first_chunk == null) {
                        wctx.word_line_first_chunk = chunk;
                        return;
                    }
                    wctx.word_line_chunks.append(wctx.allocator, chunk) catch {
                        wctx.failed = true;
                        return;
                    };
                    const bytes = chunk.getBytes(wctx.text_buffer.memRegistry());
                    if (wctx.source_line_cjk_breaks and bytes.len > 0) {
                        if (wctx.word_line_last_cp == null) {
                            const first_bytes = wctx.word_line_first_chunk.?.getBytes(wctx.text_buffer.memRegistry());
                            wctx.word_line_last_cp = utf8.chunkWordClassEdges(first_bytes).last_cp;
                        }
                        const first_cp = utf8.decodeUtf8Unchecked(bytes, 0).cp;
                        if (wctx.word_line_last_cp) |last_cp| {
                            // Uncertain incoming state keeps the existing word policy.
                            inline for (std.meta.tags(@import("uucode").grapheme.BreakState)) |initial_state| {
                                var state = initial_state;
                                if (!utf8.isGraphemeBreak(last_cp, first_cp, &state, wctx.text_buffer.widthMethod())) {
                                    wctx.source_line_cjk_breaks = false;
                                    break;
                                }
                            }
                        }
                        wctx.word_line_last_cp = utf8.chunkWordClassEdges(bytes).last_cp;
                    }
                } else {
                    const process_result = switch (wctx.text_buffer.widthMethod()) {
                        inline else => |width_method| processCharChunk(width_method, wctx, chunk),
                    };
                    process_result catch {
                        wctx.failed = true;
                    };
                }
            }

            fn line_end_callback(ctx_ptr: *anyopaque, line_info: iter_mod.LineInfo) void {
                const wctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
                if (wctx.failed) return;

                var used_measure_cache = false;
                var measure_cache_chunk: ?*const TextChunk = null;
                var measure_cache_first_width: u32 = 0;
                if (comptime wrap_mode == .word and calculation == .measure) {
                    if (wctx.word_line_first_chunk != null and wctx.word_line_chunks.items.len == 0) {
                        const chunk = wctx.word_line_first_chunk.?;
                        measure_cache_chunk = chunk;
                        const first_width = wctx.lineWrapWidth();
                        measure_cache_first_width = first_width;
                        if (chunk.getWordMeasureSummary(
                            wctx.wrap_w,
                            first_width,
                            wctx.text_buffer.tabWidth(),
                            wctx.text_buffer.widthMethod(),
                        )) |summary| {
                            wctx.result.line_count += summary.line_count;
                            wctx.result.width_cols_max = @max(wctx.result.width_cols_max, summary.width_max);
                            wctx.document_cell_offset += chunk.width_cols;
                            used_measure_cache = true;
                        }
                    }
                }

                if (comptime wrap_mode == .word) {
                    if (!used_measure_cache) {
                        if (wctx.word_line_first_chunk) |chunk| {
                            processWordChunk(wctx, chunk);
                            if (wctx.failed) return;
                        }
                        for (wctx.word_line_chunks.items) |chunk| {
                            processWordChunk(wctx, chunk);
                            if (wctx.failed) return;
                        }
                        finalizePendingWord(wctx);
                    }
                    clearPendingWord(wctx);
                    wctx.word_line_first_chunk = null;
                    wctx.word_line_chunks.clearRetainingCapacity();
                }

                const has_content = if (comptime calculation == .render)
                    wctx.current_vline.chunks.items.len > 0
                else
                    wctx.current_vline_width_cols > 0;
                if (!used_measure_cache and (has_content or line_info.width_cols == 0)) {
                    if (comptime calculation == .render) {
                        wctx.current_vline.width_cols = wctx.current_vline_width_cols;
                        wctx.current_vline.source_line = wctx.line_idx;
                        wctx.current_vline.source_col_start = wctx.source_line_col_offset;
                    }
                    wctx.recordVirtualLine() catch {
                        wctx.failed = true;
                        return;
                    };
                    if (comptime calculation == .render) wctx.current_line_vline_count += 1;
                }

                if (comptime wrap_mode == .word and calculation == .measure) {
                    if (!used_measure_cache) {
                        if (measure_cache_chunk) |chunk| {
                            // Summary storage is best-effort; this measurement remains valid on OOM.
                            chunk.setWordMeasureSummary(
                                wctx.text_buffer.getAllocator(),
                                wctx.wrap_w,
                                measure_cache_first_width,
                                wctx.text_buffer.tabWidth(),
                                wctx.text_buffer.widthMethod(),
                                .{
                                    .line_count = wctx.logical_measure_line_count,
                                    .width_max = wctx.logical_measure_width_max,
                                },
                            ) catch |err| switch (err) {
                                error.OutOfMemory => {},
                                else => {
                                    wctx.failed = true;
                                    return;
                                },
                            };
                        }
                    }
                }

                if (comptime calculation == .render) {
                    const out = wctx.result;
                    out.cached_line_first_vline.append(wctx.allocator, wctx.current_line_first_vline_idx) catch {
                        wctx.failed = true;
                        return;
                    };
                    out.cached_line_vline_counts.append(wctx.allocator, wctx.current_line_vline_count) catch {
                        wctx.failed = true;
                        return;
                    };
                }

                wctx.document_cell_offset += 1;

                wctx.line_idx += 1;
                wctx.source_line_col_offset = 0;
                wctx.current_vline_width_cols = 0;
                wctx.current_wrap_width = wctx.wrap_w;
                if (comptime calculation == .render) {
                    wctx.current_vline = VirtualLine.init();
                    wctx.current_vline.document_cell_offset = wctx.document_cell_offset;
                    wctx.current_line_first_vline_idx = @intCast(wctx.result.virtual_lines.items.len);
                    wctx.current_line_vline_count = 0;
                }
                if (comptime wrap_mode == .word) {
                    wctx.source_line_has_non_whitespace = false;
                    wctx.source_line_cjk_breaks = true;
                    wctx.word_line_last_cp = null;
                }
                if (comptime wrap_mode == .word and calculation == .measure) {
                    wctx.logical_measure_line_count = 0;
                    wctx.logical_measure_width_max = 0;
                }
            }
        };

        // first_line_offset reduces only the initial visual-line budget;
        // committed continuations reset to the full wrap width.
        var wrap_ctx: WrapContext = .{
            .text_buffer = text_buffer,
            .allocator = allocator,
            .result = result,
            .word_layout = word_layout,
            .word_line_preflight = if (comptime wrap_mode == .word) !text_buffer.rope().root.metrics().custom.ascii_only else {},
            .wrap_w = wrap_w,
            .current_wrap_width = if (first_line_offset > 0 and first_line_offset < wrap_w)
                wrap_w - first_line_offset
            else
                wrap_w,
        };

        defer if (comptime wrap_mode == .word) wrap_ctx.word_line_chunks.deinit(allocator);
        // Retain unchanged chunks and reclaim layouts detached by incremental edits.
        if (comptime calculation == .render and wrap_mode == .word) text_buffer.layout_cache.beginLayout();
        text_buffer.walkLinesAndSegments(&wrap_ctx, WrapContext.segment_callback, WrapContext.line_end_callback);
        // Failed traversal leaves live chunks unmarked; sibling views may still borrow them.
        if (wrap_ctx.failed) return false;
        if (comptime calculation == .render and wrap_mode == .word) text_buffer.layout_cache.endLayout();
        return true;
    }
};
