const std = @import("std");
const builtin = @import("builtin");
const compatibility_io = if (builtin.is_test) std.testing.io else if (@hasDecl(@import("root"), "io")) @import("root").io else std.Io.failing;
const Allocator = std.mem.Allocator;
const seg_mod = @import("text-buffer-segment.zig");
const iter_mod = @import("text-buffer-iterators.zig");
const mem_registry_mod = @import("mem-registry.zig");
const ss = @import("syntax-style.zig");
const gp = @import("grapheme.zig");
const ansi = @import("ansi.zig");
const link = @import("link.zig");

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
pub const RenderClusterInfo = seg_mod.RenderClusterInfo;

pub const SyntaxStyle = ss.SyntaxStyle;

pub const TextBuffer = UnifiedTextBuffer;

/// A styled text chunk passed from TypeScript across the FFI boundary.
/// Each chunk carries raw text bytes, optional packed RGBA colors, text
/// attributes, and an optional hyperlink URL.
///
/// The color pointers point to 4 consecutive u16 values in the packed RGBA
/// format defined by ansi.zig. Use utils.ptrToRGBA to read them.
pub const StyledChunk = extern struct {
    text_ptr: [*]const u8,
    text_len: usize,
    /// Optional foreground color as 4 packed u16 values (see ansi.RGBA).
    fg_ptr: ?[*]const u16,
    /// Optional background color as 4 packed u16 values (see ansi.RGBA).
    bg_ptr: ?[*]const u16,
    attributes: u32,
    link_ptr: ?[*]const u8 = null,
    link_len: usize = 0,
};

/// Consecutive nonempty ranges of the copied text, with caller-prepared style IDs.
pub const OwnedStyledChunk = struct {
    byte_count: u32,
    style_id: u32,
};

pub const UnifiedTextBuffer = struct {
    const Self = UnifiedTextBuffer;

    mem_registry: MemRegistry,
    default_fg: ?RGBA,
    default_bg: ?RGBA,
    default_attributes: ?u32,

    allocator: Allocator,
    global_allocator: Allocator,
    arena: *std.heap.ArenaAllocator,
    layout_cache: seg_mod.ChunkLayoutCache,
    io: std.Io,
    logger: *const logger.Logger,

    _rope: UnifiedRope,
    syntax_style: ?*const SyntaxStyle,

    pool: *gp.GraphemePool,
    link_pool: *link.LinkPool,
    link_tracker: ?link.LinkTracker,

    width_method: utf8.WidthMethod,

    view_dirty_flags: std.ArrayListUnmanaged(bool),
    next_view_id: u32,
    free_view_ids: std.ArrayListUnmanaged(u32),

    /// Monotonic counter that increments on every content change. Views use this
    /// to detect stale caches even after clearViewDirty() runs.
    content_epoch: u64,

    // Per-line highlight cache (invalidated on edits)
    // Maps line_idx to highlights for that line
    line_highlights: std.ArrayListUnmanaged(std.ArrayListUnmanaged(Highlight)),
    line_spans: std.ArrayListUnmanaged(std.ArrayListUnmanaged(StyleSpan)),
    internal_highlight_count: usize,
    highlight_batch_depth: u32,
    dirty_span_lines: std.AutoHashMap(usize, void),

    styled_text_mem_id: ?u8,
    styled_buffer: ?[]u8,
    styled_capacity: usize,

    tab_width: u8,
    // Persistent roots carry the tab-width generation used for their cached
    // chunk and branch metrics, so only stale history roots are rescanned.
    tab_metrics_generation: u64,

    pub const Defaults = struct {
        fg: ?RGBA,
        bg: ?RGBA,
        attributes: ?u32,
    };

    /// Accessor: return default fg/bg/attributes as a struct.
    pub fn defaults(self: *const Self) Defaults {
        return .{
            .fg = self.default_fg,
            .bg = self.default_bg,
            .attributes = self.default_attributes,
        };
    }

    /// Accessor: return a const pointer to the mem registry.
    pub fn memRegistry(self: *const Self) *const MemRegistry {
        return &self.mem_registry;
    }

    /// Accessor: return the width method.
    pub fn widthMethod(self: *const Self) utf8.WidthMethod {
        return self.width_method;
    }

    /// Accessor: return tab width.
    pub fn tabWidth(self: *const Self) u8 {
        return self.tab_width;
    }

    /// Accessor: return the internal allocator.
    pub fn getAllocator(self: *const Self) Allocator {
        return self.allocator;
    }

    /// Accessor: return pointer to the rope (for edit-path callers).
    /// Const-preserving: returns *UnifiedRope or *const UnifiedRope depending on receiver.
    pub fn rope(self: anytype) blk: {
        const T = @TypeOf(self);
        break :blk if (T == *Self) *UnifiedRope else if (T == *const Self) *const UnifiedRope else @compileError("expected *Self or *const Self");
    } {
        return &self._rope;
    }

    /// Restore an undo root with metrics valid for the current tab width.
    pub fn undo(self: *Self, meta: []const u8) ![]const u8 {
        const previous_meta = try self._rope.undo(meta);
        self.refreshTabWidthMetrics();
        return previous_meta;
    }

    /// Restore a redo root with metrics valid for the current tab width.
    pub fn redo(self: *Self) ![]const u8 {
        const next_meta = try self._rope.redo();
        self.refreshTabWidthMetrics();
        return next_meta;
    }

    /// Accessor: get line width at a given row.
    pub fn lineWidthAt(self: *const Self, row: u32) u32 {
        return iter_mod.lineWidthAt(@constCast(&self._rope), row);
    }

    /// Accessor: get maximum line width across all lines.
    pub fn lineWidthColsMax(self: *const Self) u32 {
        return iter_mod.getMaxLineWidth(&self._rope);
    }

    pub fn getGraphemeWidthAt(self: *const Self, row: u32, col: u32) u32 {
        return iter_mod.getGraphemeWidthAt(@constCast(&self._rope), &self.mem_registry, row, col, self.tab_width, self.width_method);
    }

    pub fn getPrevGraphemeWidth(self: *const Self, row: u32, col: u32) u32 {
        return iter_mod.getPrevGraphemeWidth(@constCast(&self._rope), &self.mem_registry, row, col, self.tab_width, self.width_method);
    }

    pub fn textEndOffset(self: *const Self) u32 {
        return self._rope.totalWeight();
    }

    pub fn graphemeBoundsAtOffset(self: *const Self, offset: u32) ?struct { start: u32, end: u32 } {
        const rope_ptr = @constCast(&self._rope);
        const coords = iter_mod.offsetToCoords(rope_ptr, offset) orelse return null;
        const bounds = iter_mod.getGraphemeBoundsAt(
            rope_ptr,
            &self.mem_registry,
            coords.row,
            coords.col,
            self.tab_width,
            self.width_method,
        ) orelse return null;
        const line_start = offset - coords.col;
        return .{ .start = line_start + bounds.start, .end = line_start + bounds.end };
    }

    pub fn cursorUnitBoundsAtOffset(self: *const Self, offset: u32) ?struct { start: u32, end: u32 } {
        const rope_ptr = @constCast(&self._rope);
        const coords = iter_mod.offsetToCoords(rope_ptr, offset) orelse return null;
        const bounds = iter_mod.getCursorUnitBoundsAt(
            rope_ptr,
            &self.mem_registry,
            coords.row,
            coords.col,
            self.tab_width,
            self.width_method,
        ) orelse return null;
        const line_start = offset - coords.col;
        return .{ .start = line_start + bounds.start, .end = line_start + bounds.end };
    }

    pub fn getLayoutInfoFor(self: *const Self, chunk: *const TextChunk) TextBufferError!seg_mod.ChunkLayoutInfo {
        return chunk.getLayoutInfo(self.allocator, @constCast(&self.layout_cache), &self.mem_registry, self.tab_width, self.width_method);
    }

    pub fn getWordLayoutInfoFor(self: *const Self, chunk: *const TextChunk) TextBufferError!seg_mod.WordLayoutInfo {
        return chunk.getWordLayoutInfo(self.allocator, @constCast(&self.layout_cache), &self.mem_registry, self.tab_width, self.width_method);
    }

    /// Accessor: walk all lines and segments via callbacks.
    pub fn walkLinesAndSegments(
        self: *const Self,
        ctx: *anyopaque,
        segment_callback: *const fn (ctx: *anyopaque, line_idx: u32, chunk: *const TextChunk, chunk_idx_in_line: u32) void,
        line_end_callback: *const fn (ctx: *anyopaque, line_info: LineInfo) void,
    ) void {
        iter_mod.walkLinesAndSegments(&self._rope, ctx, segment_callback, line_end_callback);
    }

    pub const InitOptions = struct {
        io: std.Io = compatibility_io,
        logger: *const logger.Logger = logger.compatibilityLogger(),
    };

    pub fn init(
        global_allocator: Allocator,
        pool: *gp.GraphemePool,
        link_pool: *link.LinkPool,
        width_method: utf8.WidthMethod,
    ) TextBufferError!*Self {
        return initWithOptions(global_allocator, pool, link_pool, width_method, .{});
    }

    pub fn initWithOptions(
        global_allocator: Allocator,
        pool: *gp.GraphemePool,
        link_pool: *link.LinkPool,
        width_method: utf8.WidthMethod,
        options: InitOptions,
    ) TextBufferError!*Self {
        const self = global_allocator.create(Self) catch return TextBufferError.OutOfMemory;
        errdefer global_allocator.destroy(self);

        const internal_arena = global_allocator.create(std.heap.ArenaAllocator) catch return TextBufferError.OutOfMemory;
        errdefer global_allocator.destroy(internal_arena);
        internal_arena.* = std.heap.ArenaAllocator.init(global_allocator);
        errdefer internal_arena.deinit();

        try self.initStorage(global_allocator, pool, link_pool, width_method, options, internal_arena);
        return self;
    }

    fn initStorage(
        self: *Self,
        global_allocator: Allocator,
        pool: *gp.GraphemePool,
        link_pool: *link.LinkPool,
        width_method: utf8.WidthMethod,
        options: InitOptions,
        internal_arena: *std.heap.ArenaAllocator,
    ) TextBufferError!void {
        const internal_allocator = internal_arena.allocator();

        const init_rope = UnifiedRope.init(internal_allocator) catch return TextBufferError.OutOfMemory;

        var view_dirty_flags: std.ArrayListUnmanaged(bool) = .empty;
        errdefer view_dirty_flags.deinit(global_allocator);

        var free_view_ids: std.ArrayListUnmanaged(u32) = .empty;
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
            .layout_cache = .{ .allocator = global_allocator },
            .io = options.io,
            .logger = options.logger,
            ._rope = init_rope,
            .syntax_style = null,
            .pool = pool,
            .link_pool = link_pool,
            .link_tracker = null,
            .width_method = width_method,
            .view_dirty_flags = view_dirty_flags,
            .next_view_id = 0,
            .free_view_ids = free_view_ids,
            .content_epoch = 0,
            .line_highlights = .empty,
            .line_spans = .empty,
            .internal_highlight_count = 0,
            .highlight_batch_depth = 0,
            .dirty_span_lines = dirty_span_lines,
            .styled_text_mem_id = null,
            .styled_buffer = null,
            .styled_capacity = 0,
            .tab_width = 2,
            .tab_metrics_generation = 1,
        };
    }

    pub fn deinit(self: *Self) void {
        const global_allocator = self.global_allocator;
        defer global_allocator.destroy(self);

        self.retireStorage();
        self.view_dirty_flags.deinit(global_allocator);
        self.free_view_ids.deinit(global_allocator);
        self.mem_registry.deinit();
        self.arena.deinit();
        global_allocator.destroy(self.arena);
        self.* = undefined;
    }

    /// The caller has retired all views. Keep controls and empty registration
    /// tables; the dormant rope must not be read before reinitStorage.
    pub fn retireStorage(self: *Self) void {
        if (self.syntax_style) |style| {
            (@constCast(style)).offDestroy(@ptrCast(self), onSyntaxStyleDestroyed);
        }
        self.syntax_style = null;

        self.view_dirty_flags.clearRetainingCapacity();
        self.free_view_ids.clearRetainingCapacity();
        self.next_view_id = 0;

        // Free highlight/span caches
        for (self.line_highlights.items) |*hl_list| {
            hl_list.deinit(self.global_allocator);
        }
        self.line_highlights.deinit(self.global_allocator);
        self.line_highlights = .empty;

        for (self.line_spans.items) |*span_list| {
            span_list.deinit(self.global_allocator);
        }
        self.line_spans.deinit(self.global_allocator);
        self.line_spans = .empty;

        // Free dirty span lines hashmap
        self.dirty_span_lines.deinit();
        self.dirty_span_lines = std.AutoHashMap(usize, void).init(self.global_allocator);

        // Free persistent styled text buffer
        if (self.styled_buffer) |buf| {
            self.global_allocator.free(buf);
        }
        self.styled_buffer = null;

        if (self.link_tracker) |*tracker| {
            tracker.deinit();
        }
        self.link_tracker = null;

        self.layout_cache.clear();
        self.mem_registry.clear();
        // The next owned replacement discards the empty rope, so do not consolidate its old backing.
        _ = self.arena.reset(.free_all);
    }

    pub fn reinitStorage(self: *Self, width_method: utf8.WidthMethod) TextBufferError!void {
        std.debug.assert(self.next_view_id == 0 and self.syntax_style == null and self.link_tracker == null);
        const registry = self.mem_registry;
        const view_dirty_flags = self.view_dirty_flags;
        const free_view_ids = self.free_view_ids;
        try self.initStorage(self.global_allocator, self.pool, self.link_pool, width_method, .{
            .io = self.io,
            .logger = self.logger,
        }, self.arena);
        self.mem_registry = registry;
        self.view_dirty_flags = view_dirty_flags;
        self.free_view_ids = free_view_ids;
    }

    pub fn retainedStorageBytes(self: *const Self) usize {
        return @sizeOf(Self) + @sizeOf(std.heap.ArenaAllocator) + arenaStorageBytes(self.arena) +
            self.view_dirty_flags.capacity * @sizeOf(bool) + self.free_view_ids.capacity * @sizeOf(u32) +
            self.mem_registry.buffers.capacity * @sizeOf(@import("mem-registry.zig").MemBuffer) +
            self.mem_registry.free_slots.capacity;
    }

    pub fn arenaStorageBytes(arena: *const std.heap.ArenaAllocator) usize {
        var bytes = arena.queryCapacity();
        for ([_]@TypeOf(arena.state.used_list){ arena.state.used_list, arena.state.free_list }) |head| {
            var cursor = head;
            while (cursor) |node| : (cursor = node.next) bytes += @sizeOf(@TypeOf(node.*));
        }
        return bytes;
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
        const next_id = std.math.add(u32, id, 1) catch return TextBufferError.OutOfMemory;
        // Reserve the return slot before registration so teardown cannot allocate.
        try self.free_view_ids.ensureTotalCapacity(self.global_allocator, next_id);
        try self.view_dirty_flags.append(self.global_allocator, true);
        self.next_view_id = next_id;
        return id;
    }

    pub fn unregisterView(self: *Self, view_id: u32) void {
        if (view_id < self.view_dirty_flags.items.len) {
            self.free_view_ids.appendAssumeCapacity(view_id);
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

    /// Returns the current content epoch. Use this to detect buffer changes
    /// independent of the dirty flag (other code paths may clear dirty).
    pub fn getContentEpoch(self: *const Self) u64 {
        return self.content_epoch;
    }

    fn markAllViewsDirty(self: *Self) void {
        self._rope.setMetricsGeneration(self.tab_metrics_generation);
        // Increment epoch first so views see the new value when checking caches.
        // Use wrapping add for safety, though u64 won't overflow in practice.
        self.content_epoch +%= 1;
        for (self.view_dirty_flags.items) |*flag| {
            flag.* = true;
        }
    }

    pub fn markViewsDirty(self: *Self) void {
        self.markAllViewsDirty();
    }

    // Basic queries using unified rope
    pub fn getLength(self: *const Self) u32 {
        const metrics = self._rope.root.metrics();
        return metrics.custom.total_width_cols;
    }

    pub fn getByteSize(self: *const Self) u32 {
        const metrics = self._rope.root.metrics();
        const total_bytes = metrics.custom.total_bytes;

        // Add newlines between lines (line_count - 1)
        const line_count = iter_mod.getLineCount(&self._rope);
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
    pub fn clear(self: *Self) TextBufferError!void {
        try self.clearWithUndo(null);
    }

    fn clearWithUndo(self: *Self, meta: ?[]const u8) TextBufferError!void {
        try self._rope.clearWithUndo(meta);
        self.clearLinkRefs();
        self.layout_cache.clear();
        self.markAllViewsDirty();
    }

    pub fn reset(self: *Self) TextBufferError!void {
        var replacement_arena = std.heap.ArenaAllocator.init(self.global_allocator);
        errdefer replacement_arena.deinit();
        const replacement_rope = try UnifiedRope.init(replacement_arena.allocator());

        self.clearLinkRefs();

        // Free highlight/span arrays (they use global_allocator, not arena)
        for (self.line_highlights.items) |*hl_list| {
            hl_list.deinit(self.global_allocator);
        }
        self.line_highlights.clearRetainingCapacity();
        self.internal_highlight_count = 0;

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

        self.layout_cache.clear();
        self.arena.deinit();
        self.arena.* = replacement_arena;
        self._rope = replacement_rope;
        self._rope.allocator = self.allocator;
        self._rope.marker_cache = UnifiedRope.MarkerCache.init(self.allocator);

        self.mem_registry.clear();

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
        if (self.syntax_style == syntax_style) return;

        if (syntax_style) |style| {
            (@constCast(style)).onDestroy(@ptrCast(self), onSyntaxStyleDestroyed) catch return;
        }
        if (self.syntax_style) |prev| {
            (@constCast(prev)).offDestroy(@ptrCast(self), onSyntaxStyleDestroyed);
        }
        self.syntax_style = syntax_style;
    }

    pub fn getSyntaxStyle(self: *const Self) ?*const SyntaxStyle {
        return self.syntax_style;
    }

    fn getLinkTracker(self: *Self) *link.LinkTracker {
        if (self.link_tracker == null) {
            self.link_tracker = link.LinkTracker.init(self.global_allocator, self.link_pool);
        }

        return &self.link_tracker.?;
    }

    fn clearLinkRefs(self: *Self) void {
        if (self.link_tracker) |*tracker| {
            tracker.clear();
        }
    }

    /// Set the text content using SIMD-optimized line break detection
    pub fn setText(self: *Self, text: []const u8) TextBufferError!void {
        const previous_buffer_count = self.mem_registry.buffers.items.len;
        const mem_id = try self.mem_registry.register(text, false);
        errdefer self.mem_registry.cancelLastRegistration(mem_id, previous_buffer_count);
        try self.setPlainText(mem_id, text, null, null, null);
    }

    /// Set text from a pre-registered memory ID
    pub fn setTextFromMemId(self: *Self, mem_id: u8) TextBufferError!void {
        try self.setTextFromMemIdWithUndo(mem_id, null);
    }

    pub fn setTextFromMemIdWithUndo(self: *Self, mem_id: u8, meta: ?[]const u8) TextBufferError!void {
        const text = self.mem_registry.get(mem_id) orelse return TextBufferError.InvalidMemId;
        try self.setPlainText(mem_id, text, meta, null, null);
    }

    /// Replace a live preferred slot, or register a new slot if it is absent.
    /// Success clears history. Owned bytes must use the registry allocator and
    /// transfer only on success; text must not overlap the slot's old owned bytes.
    pub fn replaceText(self: *Self, text: []const u8, mem_id: ?u8, owned: bool) TextBufferError!u8 {
        return self.replaceTextInternal(text, mem_id, owned, null);
    }

    /// Consume registry-allocator bytes on success and retire the previous rope arena.
    /// All registered bytes must live outside that arena; borrowed/editor callers use replaceText.
    pub fn replaceOwnedText(self: *Self, text: []const u8, mem_id: ?u8) TextBufferError!u8 {
        var replacement_arena = std.heap.ArenaAllocator.init(self.global_allocator);
        defer replacement_arena.deinit();
        return self.replaceTextInternal(text, mem_id, true, &replacement_arena);
    }

    /// Consume registry-allocator bytes only on success, borrowing a fresh caller-owned style.
    /// The caller validates UTF-8 and bounds, retaining all inputs on failure.
    /// Success moves prepared link ownership into the buffer and empties the input tracker.
    pub fn replaceOwnedStyledText(
        self: *Self,
        text: []const u8,
        mem_id: ?u8,
        style: *SyntaxStyle,
        chunks: []const OwnedStyledChunk,
        prepared_links: ?*link.LinkTracker,
    ) TextBufferError!u8 {
        return self.replaceOwnedStyledTextPrepared(text, mem_id, style, chunks, prepared_links, null);
    }

    pub fn replaceOwnedStyledTextPrepared(
        self: *Self,
        text: []const u8,
        mem_id: ?u8,
        style: *SyntaxStyle,
        chunks: []const OwnedStyledChunk,
        prepared_links: ?*link.LinkTracker,
        retained_style: ?*SyntaxStyle,
    ) TextBufferError!u8 {
        var prepared: PreparedOwnedStyledText = undefined;
        try self.prepareOwnedStyledText(&prepared, text, mem_id, style, chunks, prepared_links, retained_style);
        defer prepared.deinit();
        return prepared.commit();
    }

    /// The arena's address must remain stable from preparation through commit or abort.
    /// Text, style and links remain caller-owned until commit; deinit also handles abort.
    pub const PreparedOwnedStyledText = struct {
        buffer: *Self,
        arena: std.heap.ArenaAllocator,
        rope: UnifiedRope = undefined,
        highlights: std.ArrayListUnmanaged(std.ArrayListUnmanaged(Highlight)) = .empty,
        spans: std.ArrayListUnmanaged(std.ArrayListUnmanaged(StyleSpan)) = .empty,
        internal_count: usize = 0,
        text: []const u8,
        mem_id: u8 = undefined,
        previous_buffer_count: usize,
        registration_pending: bool = false,
        style: *SyntaxStyle,
        links: ?*link.LinkTracker,
        retained_style: ?*SyntaxStyle,
        listener_registered: bool = false,

        pub fn deinit(prepared: *PreparedOwnedStyledText) void {
            const self = prepared.buffer;
            if (prepared.listener_registered) {
                prepared.style.offDestroy(@ptrCast(self), onSyntaxStyleDestroyed);
            }
            if (prepared.registration_pending) {
                self.mem_registry.cancelLastRegistration(prepared.mem_id, prepared.previous_buffer_count);
            }
            for (prepared.highlights.items) |*list| list.deinit(self.global_allocator);
            prepared.highlights.deinit(self.global_allocator);
            for (prepared.spans.items) |*list| list.deinit(self.global_allocator);
            prepared.spans.deinit(self.global_allocator);
            prepared.arena.deinit();
        }

        pub fn commit(prepared: *PreparedOwnedStyledText) u8 {
            const self = prepared.buffer;
            if (prepared.retained_style) |retained| {
                retained.publishDefinitions(prepared.style);
            } else {
                std.debug.assert(prepared.listener_registered);
                self.setSyntaxStyle(null);
                self.syntax_style = prepared.style;
                prepared.listener_registered = false;
            }
            self.layout_cache.clear();
            std.mem.swap(std.heap.ArenaAllocator, self.arena, &prepared.arena);
            self._rope = prepared.rope;
            self._rope.allocator = self.allocator;
            self._rope.marker_cache = UnifiedRope.MarkerCache.init(self.allocator);
            std.mem.swap(@TypeOf(self.line_highlights), &self.line_highlights, &prepared.highlights);
            std.mem.swap(@TypeOf(self.line_spans), &self.line_spans, &prepared.spans);
            self.internal_highlight_count = prepared.internal_count;
            self.dirty_span_lines.clearRetainingCapacity();
            self.markAllViewsDirty();
            var retired_links = self.link_tracker;
            self.link_tracker = null;
            if (prepared.links) |tracker| {
                self.link_tracker = tracker.*;
                tracker.* = link.LinkTracker.init(tracker.used_ids.allocator, tracker.pool);
            }
            self.mem_registry.replace(prepared.mem_id, prepared.text, true) catch unreachable;
            prepared.registration_pending = false;
            if (retired_links) |*tracker| tracker.deinit();
            return prepared.mem_id;
        }
    };

    pub fn prepareOwnedStyledText(
        self: *Self,
        prepared: *PreparedOwnedStyledText,
        text: []const u8,
        mem_id: ?u8,
        style: *SyntaxStyle,
        chunks: []const OwnedStyledChunk,
        prepared_links: ?*link.LinkTracker,
        retained_style: ?*SyntaxStyle,
    ) TextBufferError!void {
        if (self.syntax_style == style) return TextBufferError.InvalidId;
        if (retained_style != null and self.syntax_style != retained_style) return TextBufferError.InvalidId;
        const style_links: ?*link.LinkTracker = if (retained_style != null) if (style.link_tracker) |*tracker| tracker else null else null;
        for ([_]?*link.LinkTracker{ prepared_links, style_links }) |maybe_tracker| {
            const tracker = maybe_tracker orelse continue;
            if (tracker.pool != self.link_pool) return TextBufferError.InvalidId;
            if (self.link_tracker) |*current| {
                if (tracker == current) return TextBufferError.InvalidId;
            }
            var ids = tracker.used_ids.iterator();
            while (ids.next()) |entry| {
                if (entry.value_ptr.* == 0 or entry.key_ptr.* == 0 or
                    entry.key_ptr.* > ansi.TextAttributes.LINK_ID_PAYLOAD_MASK) return TextBufferError.InvalidId;
                const refs = self.link_pool.getRefcount(entry.key_ptr.*) catch return TextBufferError.InvalidId;
                if (refs == 0) return TextBufferError.InvalidId;
            }
        }
        var definitions = style.id_to_style.valueIterator();
        while (definitions.next()) |definition| {
            const id = ansi.TextAttributes.getLinkId(definition.attributes);
            if (id == 0) continue;
            const tracker = (if (retained_style != null) style_links else prepared_links) orelse return TextBufferError.InvalidId;
            if (!tracker.used_ids.contains(id)) return TextBufferError.InvalidId;
        }
        var byte_count: usize = 0;
        for (chunks) |chunk| {
            if (chunk.byte_count == 0 or chunk.byte_count > text.len - byte_count) {
                return TextBufferError.InvalidIndex;
            }
            if (chunk.style_id != 0 and style.resolveById(chunk.style_id) == null) {
                return TextBufferError.InvalidId;
            }
            byte_count += chunk.byte_count;
        }
        if (byte_count != text.len) return TextBufferError.InvalidIndex;

        prepared.* = .{
            .buffer = self,
            .arena = std.heap.ArenaAllocator.init(self.global_allocator),
            .text = text,
            .previous_buffer_count = self.mem_registry.buffers.items.len,
            .style = style,
            .links = prepared_links,
            .retained_style = retained_style,
        };
        errdefer prepared.deinit();
        const reuse = if (mem_id) |id| self.mem_registry.get(id) != null else false;
        if (reuse) {
            const old = self.mem_registry.buffers.items[mem_id.?];
            const start = @intFromPtr(text.ptr);
            const old_start = @intFromPtr(old.data.ptr);
            if (text.len != 0 and old.owned and start < old_start + old.data.len and old_start < start + text.len) {
                return TextBufferError.InvalidMemId;
            }
        }
        prepared.mem_id = if (reuse) mem_id.? else try self.mem_registry.register(text, false);
        prepared.registration_pending = !reuse;
        try self.prepareOwnedStyledTextContent(prepared, chunks);
    }

    fn replaceTextInternal(
        self: *Self,
        text: []const u8,
        mem_id: ?u8,
        owned: bool,
        replacement_arena: ?*std.heap.ArenaAllocator,
    ) TextBufferError!u8 {
        const reuse = if (mem_id) |id| self.mem_registry.get(id) != null else false;
        if (reuse) {
            const old = self.mem_registry.buffers.items[mem_id.?];
            const start = @intFromPtr(text.ptr);
            const old_start = @intFromPtr(old.data.ptr);
            if (text.len != 0 and old.owned and start < old_start + old.data.len and old_start < start + text.len) {
                return TextBufferError.InvalidMemId;
            }
        }
        const previous_buffer_count = self.mem_registry.buffers.items.len;
        // A provisional registration must not free caller-owned bytes on rejection.
        const id = if (reuse) mem_id.? else try self.mem_registry.register(text, false);
        errdefer if (!reuse) self.mem_registry.cancelLastRegistration(id, previous_buffer_count);
        try self.setPlainText(id, text, null, owned, replacement_arena);
        return id;
    }

    fn prepareOwnedStyledTextContent(
        self: *Self,
        prepared: *PreparedOwnedStyledText,
        chunks: []const OwnedStyledChunk,
    ) TextBufferError!void {
        const text = prepared.text;
        var result = try self.textToSegments(self.global_allocator, text, prepared.mem_id, 0, true);
        defer result.segments.deinit(result.allocator);
        prepared.rope = try UnifiedRope.initWithConfig(prepared.arena.allocator(), self._rope.config);
        prepared.rope.version = self._rope.version;
        try prepared.rope.setSegments(result.segments.items);

        const highlights = &prepared.highlights;
        const spans = &prepared.spans;
        const line_count = prepared.rope.root.metrics().custom.linestart_count;
        try highlights.ensureTotalCapacity(self.global_allocator, line_count);
        try spans.ensureTotalCapacity(self.global_allocator, line_count);

        // Concatenated widths include a split grapheme once, then intersect
        // whole-document lines without counting their separators. Both cursors
        // advance once; these ordered, disjoint ranges need no span boundary sort.
        var width_cursor = utf8.TextWidthCursor{
            .text = text,
            .tab_width = self.tab_width,
            .width_method = self.width_method,
        };
        var chunk_index: usize = 0;
        var byte_offset: usize = 0;
        var remaining_cols: u32 = 0;
        var style_id: u32 = 0;
        var internal_count: usize = 0;
        for (result.segments.items) |segment| {
            if (segment.isLineStart()) {
                highlights.appendAssumeCapacity(.empty);
                spans.appendAssumeCapacity(.empty);
            }
            const line = segment.asText() orelse continue;
            const line_index = highlights.items.len - 1;
            var col: u32 = 0;
            while (col < line.width_cols) {
                while (remaining_cols == 0 and chunk_index < chunks.len) : (chunk_index += 1) {
                    const chunk = chunks[chunk_index];
                    const byte_end = byte_offset + chunk.byte_count;
                    const char_pos = width_cursor.columns;
                    remaining_cols = width_cursor.advanceTo(byte_end) - char_pos;
                    style_id = chunk.style_id;
                    byte_offset = byte_end;
                }
                if (remaining_cols == 0) break;
                const width = @min(remaining_cols, line.width_cols - col);
                try highlights.items[line_index].append(self.global_allocator, .{
                    .col_start = col,
                    .col_end = col + width,
                    .style_id = style_id,
                    .priority = 1,
                    .hl_ref = 0,
                    .internal = true,
                });
                try spans.items[line_index].append(self.global_allocator, .{
                    .col = col,
                    .next_col = col + width,
                    .style_id = style_id,
                });
                internal_count += 1;
                remaining_cols -= width;
                col += width;
            }
            if (col > 0 and col < line.width_cols) {
                try spans.items[line_index].append(self.global_allocator, .{
                    .col = col,
                    .next_col = line.width_cols,
                    .style_id = 0,
                });
            }
        }

        prepared.internal_count = internal_count;
        // Reserve the permanent listener without detaching the accepted style.
        // Abort must unregister it before the candidate style emits Destroy.
        if (prepared.retained_style == null) {
            prepared.style.onDestroy(@ptrCast(self), onSyntaxStyleDestroyed) catch return TextBufferError.OutOfMemory;
            prepared.listener_registered = true;
        }
    }

    fn setPlainText(
        self: *Self,
        mem_id: u8,
        text: []const u8,
        meta: ?[]const u8,
        replacement_owned: ?bool,
        replacement_arena: ?*std.heap.ArenaAllocator,
    ) TextBufferError!void {
        var result = try self.textToSegments(self.global_allocator, text, mem_id, 0, true);
        defer result.segments.deinit(result.allocator);
        // setSegments only changes root/version; do not query this copy's shared cache.
        var candidate = if (replacement_arena) |arena|
            try UnifiedRope.initWithConfig(arena.allocator(), self._rope.config)
        else
            self._rope;
        candidate.version = self._rope.version;
        try candidate.setSegments(result.segments.items);

        var spans: @TypeOf(self.line_spans) = .empty;
        defer {
            for (spans.items) |*list| list.deinit(self.global_allocator);
            spans.deinit(self.global_allocator);
        }
        var highlights: std.ArrayListUnmanaged(Highlight) = .empty;
        defer highlights.deinit(self.global_allocator);
        const span_count = if (self.getHighlightCount() == 0) 0 else self.line_highlights.items.len;
        try spans.ensureTotalCapacity(self.global_allocator, span_count);
        var segment_index: usize = 0;
        for (self.line_highlights.items[0..span_count], 0..) |list, line_idx| {
            var line_width: u32 = 0;
            while (segment_index < result.segments.items.len) {
                const segment = result.segments.items[segment_index];
                segment_index += 1;
                if (segment.isBreak()) break;
                if (segment.asText()) |chunk| line_width += chunk.width_cols;
            }
            highlights.clearRetainingCapacity();
            for (list.items) |hl| {
                if (!hl.internal) try highlights.append(self.global_allocator, hl);
            }
            spans.appendAssumeCapacity(.empty);
            try self.buildLineSpans(highlights.items, line_width, &spans.items[line_idx]);
        }

        // History nodes are shared: publish undo on the live rope, after all preparation.
        if (meta) |value| try self._rope.store_undo(value);
        if (replacement_arena) |arena| {
            // The caller retires the old arena after publication, not during this swap.
            self.layout_cache.clear();
            std.mem.swap(std.heap.ArenaAllocator, self.arena, arena);
            self._rope = candidate;
            self._rope.allocator = self.allocator;
            self._rope.marker_cache = UnifiedRope.MarkerCache.init(self.allocator);
        } else {
            if (replacement_owned != null) self._rope.clear_history();
            self._rope.root = candidate.root;
            self._rope.version = candidate.version;
        }
        for (self.line_highlights.items) |*list| {
            var kept: usize = 0;
            for (list.items) |hl| {
                if (hl.internal) continue;
                list.items[kept] = hl;
                kept += 1;
            }
            list.items.len = kept;
        }
        self.internal_highlight_count = 0;
        std.mem.swap(@TypeOf(self.line_spans), &self.line_spans, &spans);
        // Replacement flushes pending spans even inside a highlight transaction.
        self.dirty_span_lines.clearRetainingCapacity();
        self.markAllViewsDirty();
        // Publish the slot last, before replace frees bytes and allocator callbacks run.
        if (replacement_owned) |owned| self.mem_registry.replace(mem_id, text, owned) catch unreachable;
        self.clearLinkRefs();
    }

    /// Append text to the end of the buffer without clearing
    pub fn append(self: *Self, text: []const u8) TextBufferError!void {
        return self.appendWithOwnership(text, false);
    }

    /// Owned bytes use the registry allocator and transfer only on success.
    pub fn appendWithOwnership(self: *Self, text: []const u8, owned: bool) TextBufferError!void {
        if (text.len == 0) {
            if (owned) self.global_allocator.free(text);
            return;
        }

        const previous_buffer_count = self.mem_registry.buffers.items.len;
        const mem_id = try self.mem_registry.register(text, false);
        errdefer self.mem_registry.cancelLastRegistration(mem_id, previous_buffer_count);
        try self.appendInternal(mem_id, text);
        self.mem_registry.buffers.items[mem_id].owned = owned;
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
        defer result.segments.deinit(result.allocator);

        // Canonical appends preserve the leading linestart, but public rope edits
        // can remove it. Stage the root until fallible end-marker repair finishes.
        // insert_slice changes only root/version; history and caches remain shared.
        var candidate = self._rope;
        try candidate.insert_slice(candidate.count(), result.segments.items);
        self._rope.root = candidate.root;
        self._rope.version = candidate.version;

        self.markAllViewsDirty();
    }

    /// Internal setText that doesn't call clear (for use by setStyledText)
    fn setTextInternal(self: *Self, mem_id: u8, text: []const u8) TextBufferError!void {
        if (text.len == 0) {
            self.markAllViewsDirty();
            return;
        }

        var result = try self.textToSegments(self.global_allocator, text, mem_id, 0, true);
        defer result.segments.deinit(result.allocator);

        try self._rope.setSegments(result.segments.items);

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
        return self.createChunkFromBytes(mem_id, mem_buf[byte_start..byte_end], byte_start);
    }

    fn createChunkFromBytes(self: *const Self, mem_id: u8, chunk_bytes: []const u8, byte_start: u32) TextChunk {
        const is_ascii = utf8.isAsciiOnly(chunk_bytes);

        var flags: u8 = 0;
        if (chunk_bytes.len > 0 and is_ascii) {
            flags |= TextChunk.Flags.ASCII_ONLY;
        }
        if (!is_ascii and std.mem.indexOfScalar(u8, chunk_bytes, '\t') != null) {
            flags |= TextChunk.Flags.HAS_TAB;
        }

        const chunk_width = utf8.calculateTextWidth(chunk_bytes, self.tab_width, is_ascii, self.width_method);

        return .{
            .mem_id = mem_id,
            .byte_start = byte_start,
            .byte_end = byte_start + @as(u32, @intCast(chunk_bytes.len)),
            .width_cols = chunk_width,
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
    ) TextBufferError!struct { segments: std.ArrayListUnmanaged(Segment), total_width_cols: u32, allocator: Allocator } {
        var break_result = utf8.LineBreakResult.init(allocator);
        defer break_result.deinit();
        try utf8.findLineBreaks(text, &break_result);

        var segments: std.ArrayListUnmanaged(Segment) = .empty;
        errdefer segments.deinit(allocator);

        if (prepend_linestart) {
            try segments.append(allocator, .{ .linestart = {} });
        }

        var local_start: u32 = 0;
        var total_width_cols: u32 = 0;

        for (break_result.breaks.items) |line_break| {
            const break_pos: u32 = @intCast(line_break.pos);
            const local_end: u32 = switch (line_break.kind) {
                .CRLF => break_pos - 1,
                .CR, .LF => break_pos,
            };

            if (local_end > local_start) {
                const chunk = self.createChunkFromBytes(mem_id, text[local_start..local_end], byte_offset + local_start);
                try segments.append(allocator, .{ .text = chunk });
                total_width_cols += chunk.width_cols;
            }

            try segments.append(allocator, .{ .brk = {} });
            try segments.append(allocator, .{ .linestart = {} });

            local_start = break_pos + 1;
        }

        if (local_start < text.len) {
            const chunk = self.createChunkFromBytes(mem_id, text[local_start..], byte_offset + local_start);
            try segments.append(allocator, .{ .text = chunk });
            total_width_cols += chunk.width_cols;
        }

        return .{ .segments = segments, .total_width_cols = total_width_cols, .allocator = allocator };
    }

    pub fn getLineCount(self: *const Self) u32 {
        const count = self._rope.count();
        if (count == 0) return 0; // Truly empty (after reset)
        return iter_mod.getLineCount(&self._rope);
    }

    pub fn lineCount(self: *const Self) u32 {
        return self.getLineCount();
    }

    /// Register a memory buffer
    pub fn registerMemBuffer(self: *Self, data: []const u8, owned: bool) TextBufferError!u8 {
        return self.mem_registry.register(data, owned);
    }

    pub fn replaceMemBuffer(self: *Self, mem_id: u8, data: []const u8, owned: bool) TextBufferError!void {
        try self.mem_registry.replace(mem_id, data, owned);
    }

    pub fn clearMemRegistry(self: *Self) void {
        self.mem_registry.clear();
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

        const had_content = self._rope.count() > 1;

        if (had_content) {
            try self._rope.append(.{ .brk = {} });
            try self._rope.append(.{ .linestart = {} });
        }

        try self._rope.append(.{ .text = chunk });

        self.markAllViewsDirty();
    }

    pub fn getArenaAllocatedBytes(self: *const Self) usize {
        return self.arena.queryCapacity();
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

        var ctx: Context = .{
            .buffer = self,
            .out_buffer = out_buffer,
            .out_index = &out_index,
            .line_count = line_count,
        };
        self.walkLinesAndSegments(&ctx, Context.segmentCallback, Context.lineEndCallback);

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

    const HighlightAddition = struct {
        line_idx: usize,
        highlight: Highlight,
        highlights: std.ArrayListUnmanaged(Highlight) = .empty,
        spans: std.ArrayListUnmanaged(StyleSpan) = .empty,

        fn deinit(self: *HighlightAddition, allocator: Allocator) void {
            self.highlights.deinit(allocator);
            self.spans.deinit(allocator);
        }
    };

    fn prepareHighlight(self: *Self, line_idx: usize, hl: Highlight) TextBufferError!HighlightAddition {
        var addition: HighlightAddition = .{ .line_idx = line_idx, .highlight = hl };
        errdefer addition.deinit(self.global_allocator);
        const highlights = if (line_idx < self.line_highlights.items.len)
            &self.line_highlights.items[line_idx]
        else
            &addition.highlights;
        try highlights.ensureUnusedCapacity(self.global_allocator, 1);
        // Stage in spare capacity without publishing the new length or copying accepted highlights.
        highlights.unusedCapacitySlice()[0] = hl;
        if (self.highlight_batch_depth == 0) {
            try self.buildLineSpans(
                highlights.allocatedSlice()[0 .. highlights.items.len + 1],
                self.lineWidthAt(@intCast(line_idx)),
                &addition.spans,
            );
        }
        return addition;
    }

    fn commitHighlights(self: *Self, additions: []HighlightAddition) TextBufferError!void {
        if (additions.len == 0) return;
        const storage_len = additions[additions.len - 1].line_idx + 1;
        try self.line_highlights.ensureTotalCapacity(self.global_allocator, storage_len);
        try self.line_spans.ensureTotalCapacity(self.global_allocator, storage_len);
        if (self.highlight_batch_depth > 0) {
            try self.dirty_span_lines.ensureUnusedCapacity(@intCast(additions.len));
        }

        for (additions, 0..) |*addition, index| {
            const line_idx = addition.line_idx;
            std.debug.assert(index == 0 or additions[index - 1].line_idx < line_idx);
            while (self.line_highlights.items.len <= line_idx) {
                self.line_highlights.appendAssumeCapacity(.empty);
            }
            while (self.line_spans.items.len <= line_idx) {
                self.line_spans.appendAssumeCapacity(.empty);
            }
            if (addition.highlights.capacity > 0) {
                std.mem.swap(@TypeOf(addition.highlights), &self.line_highlights.items[line_idx], &addition.highlights);
            }
            self.line_highlights.items[line_idx].appendAssumeCapacity(addition.highlight);
            if (addition.highlight.internal) self.internal_highlight_count += 1;
            if (self.highlight_batch_depth == 0) {
                std.mem.swap(@TypeOf(addition.spans), &self.line_spans.items[line_idx], &addition.spans);
            } else {
                self.dirty_span_lines.putAssumeCapacity(line_idx, {});
            }
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

        const hl: Highlight = .{
            .col_start = col_start,
            .col_end = col_end,
            .style_id = style_id,
            .priority = priority,
            .hl_ref = hl_ref,
            .internal = false,
        };

        var additions = [_]HighlightAddition{try self.prepareHighlight(line_idx, hl)};
        defer additions[0].deinit(self.global_allocator);
        try self.commitHighlights(&additions);
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

        const highlights = self.getLineHighlights(line_idx);
        const line_width = if (highlights.len == 0) 0 else self.lineWidthAt(@intCast(line_idx));
        try self.buildLineSpans(highlights, line_width, &self.line_spans.items[line_idx]);
    }

    fn buildLineSpans(self: *const Self, highlights: []const Highlight, line_width: u32, spans: *std.ArrayListUnmanaged(StyleSpan)) TextBufferError!void {
        spans.clearRetainingCapacity();
        // Collect all boundary columns
        const Event = struct {
            col: u32,
            is_start: bool,
            hl_idx: usize,
        };

        var events: std.ArrayListUnmanaged(Event) = .empty;
        defer events.deinit(self.global_allocator);

        for (highlights, 0..) |hl, idx| {
            try events.append(self.global_allocator, .{ .col = hl.col_start, .is_start = true, .hl_idx = idx });
            try events.append(self.global_allocator, .{ .col = hl.col_end, .is_start = false, .hl_idx = idx });
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
                try spans.append(self.global_allocator, .{
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
            if (current_col < line_width) {
                try spans.append(self.global_allocator, .{
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
        const char_start = iter_mod.coordsToOffset(&self._rope, start_row, start_col) orelse return TextBufferError.InvalidIndex;
        const char_end = iter_mod.coordsToOffset(&self._rope, end_row, end_col) orelse return TextBufferError.InvalidIndex;
        // Rope offsets include line breaks; highlight offsets do not.
        return self.addHighlightByCharRange(char_start - start_row, char_end - end_row, style_id, priority, hl_ref);
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
        return self.addHighlightByCharRangeInternal(char_start, char_end, style_id, priority, hl_ref, false);
    }

    fn addHighlightByCharRangeInternal(
        self: *Self,
        char_start: u32,
        char_end: u32,
        style_id: u32,
        priority: u8,
        hl_ref: u16,
        internal: bool,
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
            internal: bool,
            additions: std.ArrayListUnmanaged(HighlightAddition) = .empty,
            err: ?TextBufferError = null,

            fn callback(ctx_ptr: *anyopaque, line_info: LineInfo) void {
                const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
                if (ctx.err != null) return;
                ctx.prepareLine(line_info) catch |err| {
                    ctx.err = err;
                };
            }

            fn prepareLine(ctx: *@This(), line_info: LineInfo) TextBufferError!void {
                const line_start_col_offset = line_info.col_offset;
                const line_end_col_offset = line_info.col_offset + line_info.width_cols;

                // Skip lines before the highlight
                if (line_end_col_offset <= ctx.char_start) return;
                // Stop after the highlight ends
                if (line_start_col_offset >= ctx.char_end) return;

                // This line overlaps with the highlight
                const col_start = if (ctx.char_start > line_start_col_offset)
                    ctx.char_start - line_start_col_offset
                else
                    0;

                const col_end = if (ctx.char_end < line_end_col_offset)
                    ctx.char_end - line_start_col_offset
                else
                    line_info.width_cols;

                if (col_start >= col_end) return;
                try ctx.additions.ensureUnusedCapacity(ctx.buffer.global_allocator, 1);
                ctx.additions.appendAssumeCapacity(try ctx.buffer.prepareHighlight(line_info.line_idx, .{
                    .col_start = col_start,
                    .col_end = col_end,
                    .style_id = ctx.style_id,
                    .priority = ctx.priority,
                    .hl_ref = ctx.hl_ref,
                    .internal = ctx.internal,
                }));
            }
        };

        var ctx: Context = .{
            .buffer = self,
            .char_start = char_start,
            .char_end = char_end,
            .style_id = style_id,
            .priority = priority,
            .hl_ref = hl_ref,
            .internal = internal,
        };
        defer {
            for (ctx.additions.items) |*addition| addition.deinit(self.global_allocator);
            ctx.additions.deinit(self.global_allocator);
        }
        iter_mod.walkLines(&self._rope, &ctx, Context.callback, false);
        if (ctx.err) |err| return err;
        try self.commitHighlights(ctx.additions.items);
    }

    /// Remove all highlights with a specific reference ID
    pub fn removeHighlightsByRef(self: *Self, hl_ref: u16) void {
        self.removeHighlightsByRefChecked(hl_ref) catch {};
    }

    pub fn removeHighlightsByRefChecked(self: *Self, hl_ref: u16) TextBufferError!void {
        const Removal = struct {
            line_idx: usize,
            spans: std.ArrayListUnmanaged(StyleSpan) = .empty,
        };
        var removals: std.ArrayListUnmanaged(Removal) = .empty;
        defer {
            for (removals.items) |*removal| removal.spans.deinit(self.global_allocator);
            removals.deinit(self.global_allocator);
        }
        var retained: std.ArrayListUnmanaged(Highlight) = .empty;
        defer retained.deinit(self.global_allocator);

        for (self.line_highlights.items, 0..) |hl_list, line_idx| {
            for (hl_list.items) |hl| {
                if (hl.hl_ref == hl_ref) break;
            } else continue;

            try removals.append(self.global_allocator, .{ .line_idx = line_idx });
            if (self.highlight_batch_depth == 0) {
                retained.clearRetainingCapacity();
                for (hl_list.items) |hl| {
                    if (hl.hl_ref != hl_ref) try retained.append(self.global_allocator, hl);
                }
                const line_width = if (retained.items.len == 0) 0 else self.lineWidthAt(@intCast(line_idx));
                try self.buildLineSpans(retained.items, line_width, &removals.items[removals.items.len - 1].spans);
            }
        }
        if (self.highlight_batch_depth > 0) {
            try self.dirty_span_lines.ensureUnusedCapacity(@intCast(removals.items.len));
        }

        // All affected spans and dirty-line slots are ready before any highlight is removed.
        for (removals.items) |*removal| {
            const hl_list = &self.line_highlights.items[removal.line_idx];
            var kept: usize = 0;
            for (hl_list.items) |hl| {
                if (hl.hl_ref == hl_ref) {
                    if (hl.internal and self.internal_highlight_count > 0) {
                        self.internal_highlight_count -= 1;
                    }
                    continue;
                }
                hl_list.items[kept] = hl;
                kept += 1;
            }
            hl_list.items.len = kept;
            if (self.highlight_batch_depth == 0) {
                std.mem.swap(@TypeOf(removal.spans), &self.line_spans.items[removal.line_idx], &removal.spans);
            } else {
                self.dirty_span_lines.putAssumeCapacity(removal.line_idx, {});
            }
        }
    }

    /// Clear all highlights from a specific line
    pub fn clearLineHighlights(self: *Self, line_idx: usize) void {
        if (line_idx < self.line_highlights.items.len) {
            for (self.line_highlights.items[line_idx].items) |hl| {
                if (hl.internal and self.internal_highlight_count > 0) {
                    self.internal_highlight_count -= 1;
                }
            }
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
        self.internal_highlight_count = 0;
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
            try self.clear();
            self.clearAllHighlights();
            return;
        }

        // Calculate total text length
        var total_len: usize = 0;
        for (chunks) |chunk| {
            total_len += chunk.text_len;
        }

        if (total_len == 0) {
            try self.clear();
            self.clearAllHighlights();
            return;
        }

        // Prepare a valid empty rope before releasing the old arena.
        {
            var replacement_arena = std.heap.ArenaAllocator.init(self.global_allocator);
            errdefer replacement_arena.deinit();
            const replacement_rope = try UnifiedRope.init(replacement_arena.allocator());
            const new_buffer: ?[]u8 = if (total_len > self.styled_capacity)
                try self.global_allocator.alloc(u8, total_len)
            else
                null;
            self.clearLinkRefs();
            self.clearAllHighlights();
            self.layout_cache.clear();
            self.arena.deinit();
            self.arena.* = replacement_arena;
            self._rope = replacement_rope;
            self._rope.allocator = self.allocator;
            self._rope.marker_cache = UnifiedRope.MarkerCache.init(self.allocator);
            if (new_buffer) |new_buf| {
                if (self.styled_buffer) |old_buf| {
                    self.global_allocator.free(old_buf);
                }
                self.styled_buffer = new_buf;
                self.styled_capacity = total_len;
            }
            self.markAllViewsDirty();
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
            var seen_link_ids: std.AutoHashMapUnmanaged(u32, void) = .empty;
            defer seen_link_ids.deinit(self.global_allocator);

            self.startHighlightsTransaction();
            defer self.endHighlightsTransaction();

            var width_cursor = utf8.TextWidthCursor{
                .text = full_text,
                .tab_width = self.tab_width,
                .width_method = self.width_method,
            };
            var byte_end: usize = 0;
            for (chunks, 0..) |chunk, i| {
                const char_pos = width_cursor.columns;
                byte_end += chunk.text_len;
                const char_end = width_cursor.advanceTo(byte_end);

                if (char_end > char_pos) {
                    const fg = if (chunk.fg_ptr) |fgPtr| utils.ptrToRGBA(fgPtr) else null;
                    const bg = if (chunk.bg_ptr) |bgPtr| utils.ptrToRGBA(bgPtr) else null;

                    var attributes = chunk.attributes;
                    if (chunk.link_ptr) |link_ptr| {
                        if (chunk.link_len > 0) {
                            const tracker = self.getLinkTracker();
                            const url = link_ptr[0..chunk.link_len];
                            const link_id = tracker.pool.alloc(url) catch 0;
                            if (link_id != 0) {
                                const maybe_seen = seen_link_ids.getOrPut(self.global_allocator, link_id) catch null;
                                const should_track = if (maybe_seen) |seen| !seen.found_existing else true;
                                if (should_track) {
                                    tracker.addCellRef(link_id);
                                }
                                attributes = ansi.TextAttributes.setLinkId(attributes, link_id);
                            }
                        }
                    }

                    var style_name_buf: [64]u8 = undefined;
                    const style_name = std.fmt.bufPrint(&style_name_buf, "chunk{d}", .{i}) catch continue;
                    const style_id = (@constCast(style)).registerStyleDefinition(style_name, .{
                        .fg = fg,
                        .bg = bg,
                        .attributes = attributes,
                    }) catch continue;

                    self.addHighlightByCharRangeInternal(char_pos, char_end, style_id, 1, 0, true) catch {};
                }
            }
        }
    }

    /// Load text from a file path (relative to cwd)
    /// The file content is allocated in the arena and will be freed when the buffer is destroyed
    pub fn loadFile(self: *Self, path: []const u8) TextBufferError!void {
        const file = std.Io.Dir.cwd().openFile(self.io, path, .{}) catch |err| {
            return switch (err) {
                error.FileNotFound => TextBufferError.InvalidIndex,
                error.AccessDenied => TextBufferError.InvalidIndex,
                else => TextBufferError.OutOfMemory,
            };
        };
        defer file.close(self.io);

        const stat = file.stat(self.io) catch return TextBufferError.OutOfMemory;
        const file_size = std.math.cast(usize, stat.size) orelse return TextBufferError.OutOfMemory;

        try self.clear();

        const content = self.allocator.alloc(u8, file_size) catch return TextBufferError.OutOfMemory;
        var read_buffer: [4096]u8 = undefined;
        var reader = file.reader(self.io, &read_buffer);
        const bytes_read = reader.interface.readSliceShort(content) catch return TextBufferError.OutOfMemory;
        const text = content[0..bytes_read];
        const mem_id = try self.mem_registry.register(text, false);

        try self.setTextInternal(mem_id, text);
    }

    pub fn getTabWidth(self: *const Self) u8 {
        return self.tabWidth();
    }

    /// Set tab width, rounding up to an even value in the u8-safe range [2, 254].
    /// Marks all views dirty if the width actually changes, since tab width
    /// affects measured line widths and virtual line calculations.
    pub fn setTabWidth(self: *Self, width: u8) void {
        const clamped_width = @min(@as(u8, 254), @max(2, width));
        const new_width = if (clamped_width % 2 == 0) clamped_width else clamped_width + 1;
        if (self.tab_width == new_width) return;
        self.tab_width = new_width;
        self.tab_metrics_generation +%= 1;

        self.refreshTabWidthMetrics();
        self.markAllViewsDirty();
    }

    /// Bring the active persistent root to the current tab-width generation.
    /// Widths and branch aggregates are derived state, so this deliberately
    /// updates shared const nodes; stale history roots are repaired when restored.
    fn refreshTabWidthMetrics(self: *Self) void {
        if (self._rope.metricsGeneration() == self.tab_metrics_generation) return;

        const RefreshContext = struct {
            buffer: *Self,

            fn refresh(ctx_ptr: *anyopaque, segment: *const Segment, _: u32) UnifiedRope.Node.WalkerResult {
                const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
                if (segment.asText()) |chunk| {
                    const mutable = @constCast(chunk);
                    const bytes = chunk.getBytes(&ctx.buffer.mem_registry);
                    mutable.width_cols = utf8.calculateTextWidth(
                        bytes,
                        ctx.buffer.tab_width,
                        chunk.isAsciiOnly(),
                        ctx.buffer.width_method,
                    );
                }
                return .{};
            }
        };
        var refresh_ctx: RefreshContext = .{ .buffer = self };
        self._rope.walk(&refresh_ctx, RefreshContext.refresh) catch {};
        self._rope.remeasure();
        self._rope.setMetricsGeneration(self.tab_metrics_generation);
    }

    /// Debug log the rope structure using rope.toText
    pub fn debugLogRope(self: *const Self) void {
        // A synchronous legacy callback can destroy this buffer and its arena.
        // Snapshot everything before the first callback using the outer allocator.
        const log = self.logger;
        const allocator = self.global_allocator;
        const line_count = self.getLineCount();
        const char_count = self.getLength();
        const byte_size = self.getByteSize();
        const rope_text = self._rope.toText(allocator) catch null;
        defer if (rope_text) |bytes| allocator.free(bytes);

        log.debug("=== TextBuffer Rope Debug ===", .{});
        log.debug("Line count: {}", .{line_count});
        log.debug("Char count: {}", .{char_count});
        log.debug("Byte size: {}", .{byte_size});
        const bytes = rope_text orelse {
            log.debug("Failed to generate rope text representation", .{});
            return;
        };
        log.debug("Rope structure: {s}", .{bytes});
        log.debug("=== End Rope Debug ===", .{});
    }

    /// Get text within a range of display-width offsets
    /// Automatically snaps to grapheme boundaries:
    /// Returns number of bytes written to out_buffer
    pub fn getTextRange(self: *const Self, start_offset: u32, end_offset: u32, out_buffer: []u8) usize {
        if (start_offset >= end_offset) return 0;
        if (out_buffer.len == 0) return 0;

        const total_weight = self._rope.totalWeight();
        if (start_offset >= total_weight) return 0;

        const clamped_end = @min(end_offset, total_weight);

        return iter_mod.extractTextBetweenOffsets(
            &self._rope,
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
        const start_offset = iter_mod.coordsToOffset(&self._rope, start_row, start_col) orelse return 0;
        const end_offset = iter_mod.coordsToOffset(&self._rope, end_row, end_col) orelse return 0;
        return self.getTextRange(start_offset, end_offset, out_buffer);
    }
};
