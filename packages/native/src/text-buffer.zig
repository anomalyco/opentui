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
const text_work = @import("text-work.zig");
const hl = @import("highlight-layers.zig");
const edit_marks = @import("edit-marks.zig");

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

pub const StyleDefinition = ss.StyleDefinition;
pub const no_style: StyleDefinition = .{ .fg = null, .bg = null, .attributes = 0 };
/// Style ids with this bit index the buffer's run styles; the rest are SyntaxStyle ids.
pub const run_style_flag = ss.id_limit;
/// Run styles by value; a ref is `run_style_flag | (index + 1)`.
pub const RunStyles = std.AutoArrayHashMapUnmanaged(StyleDefinition, void);

/// Consecutive nonempty ranges of the copied text, with their style values.
pub const OwnedStyledChunk = struct {
    byte_count: u32,
    style: StyleDefinition = no_style,
};

// A static empty document, so releasing a rope never allocates. Every buffer shares
// these read-only nodes; rope code mutates only branches and counted text leaves.
const empty_document_line: UnifiedRope.Node = .{ .leaf = .{ .data = .{ .linestart = {} } } };
const empty_document_sentinel: UnifiedRope.Node = .{ .leaf = .{ .data = Segment.empty(), .is_sentinel = true } };

pub const LayerRun = hl.LayerRun;

pub const LineSpans = struct {
    spans: std.ArrayListUnmanaged(StyleSpan) = .empty,
    /// 0 never matches a buffer's `span_generation`, so a new entry is stale.
    generation: u64 = 0,
    /// The style binding's `changes` when the spans depend on definitions (a layer run over
    /// another input, which shows if the run's set supplies nothing), else null.
    style_changes: ?u32 = null,
};

/// One input of a line's span build: a legacy record or a layer run, in columns.
const SpanInput = struct {
    col_start: u32,
    col_end: u32,
    style_id: u32,
    link_id_and_kind: u32,
    priority: u8,
    ended: bool = false,
};

const SpanEvent = struct {
    col: u32,
    is_start: bool,
    input_index: u32,
};

/// A text chunk of the line being built, with its first byte and column in the line.
const LineChunk = struct {
    chunk: *const TextChunk,
    start_byte: u32,
    start_col: u32,
};

/// A styled edit mark's part on one line, in the line's columns.
pub const LineMark = struct {
    mark: edit_marks.Mark,
    col_start: u32,
    col_end: u32,

    fn idLessThan(_: void, a: LineMark, b: LineMark) bool {
        return a.mark.id < b.mark.id;
    }
};

/// Build scratch, retained between builds so paint allocates only while it grows.
const SpanScratch = struct {
    inputs: std.ArrayListUnmanaged(SpanInput) = .empty,
    events: std.ArrayListUnmanaged(SpanEvent) = .empty,
    heap: std.ArrayListUnmanaged(u32) = .empty,
    chunks: std.ArrayListUnmanaged(LineChunk) = .empty,
    marks: std.ArrayListUnmanaged(LineMark) = .empty,

    fn deinit(self: *SpanScratch, allocator: Allocator) void {
        self.inputs.deinit(allocator);
        self.events.deinit(allocator);
        self.heap.deinit(allocator);
        self.chunks.deinit(allocator);
        self.marks.deinit(allocator);
        self.* = .{};
    }
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
    style_binding: ss.Borrower,

    pool: *gp.GraphemePool,
    link_pool: *link.LinkPool,
    link_tracker: ?link.LinkTracker,

    width_method: utf8.WidthMethod,
    /// Fixed at creation: chunk layout caches omit it from their keys.
    control_display: utf8.ControlDisplay,

    view_dirty_flags: std.ArrayListUnmanaged(bool),
    next_view_id: u32,
    free_view_ids: std.ArrayListUnmanaged(u32),

    /// Monotonic counter that increments on every content change. Views use this
    /// to detect stale caches even after clearViewDirty() runs.
    content_epoch: u64,

    /// Legacy highlight records per line, in display columns (overlapping, refs, ref 0 = styled
    /// text), exactly as `ot_*_highlight` sets and `get_highlights` reports them.
    line_highlights: std.ArrayListUnmanaged(std.ArrayListUnmanaged(Highlight)),
    /// Derived paint cache: a line's spans and the `span_generation` they were built at.
    line_spans: std.AutoHashMapUnmanaged(u32, LineSpans),
    /// Increments on every highlight or text change; a line whose spans carry an older stamp is
    /// rebuilt when a view reads it.
    span_generation: u64,
    span_scratch: SpanScratch,
    internal_highlight_count: usize,
    /// Styles of styled text, replaced with it; the attached SyntaxStyle is never written.
    run_styles: RunStyles,
    /// clear() released the run styles' link refs while their highlights stay.
    run_links_retired: bool,
    /// Styles of edit marks by value, never removed: undo can restore a mark that names any.
    mark_styles: RunStyles,
    /// Byte-addressed provider layers; their runs name group sets in `group_sets`.
    layers: hl.Layers,
    /// The owning Context's group sets; null until the Context attaches it, and then no layer
    /// can be set.
    group_sets: ?*const hl.GroupSets,

    tab_width: u8,
    // Persistent roots carry the tab-width generation used for their cached
    // chunk and branch metrics, so only stale history roots are rescanned.
    tab_metrics_generation: u64,

    /// The whole text after the last `replaceTail`, in one growable slot the buffer owns, valid
    /// while `content_epoch` is still `tail_epoch`: a tail write copies only its new bytes and
    /// takes no registry slot.
    tail_slot: ?u8,
    tail_bytes: std.ArrayListUnmanaged(u8),
    tail_epoch: u64,

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

    pub fn controlDisplay(self: *const Self) utf8.ControlDisplay {
        return self.control_display;
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
        // History keeps roots, not byte splices, so layers cannot follow a restored root.
        self.resetLayers();
        return previous_meta;
    }

    /// Restore a redo root with metrics valid for the current tab width.
    pub fn redo(self: *Self) ![]const u8 {
        const next_meta = try self._rope.redo();
        self.refreshTabWidthMetrics();
        self.resetLayers();
        return next_meta;
    }

    /// Accessor: get line width at a given row.
    pub fn lineWidthAt(self: *const Self, row: u32) u32 {
        return iter_mod.lineWidthAt(&self._rope, row);
    }

    /// Accessor: get maximum line width across all lines.
    pub fn lineWidthColsMax(self: *const Self) u32 {
        return iter_mod.getMaxLineWidth(&self._rope);
    }

    pub fn getGraphemeWidthAt(self: *const Self, row: u32, col: u32) u32 {
        return iter_mod.getGraphemeWidthAt(&self._rope, &self.mem_registry, row, col, self.tab_width, self.control_display, self.width_method);
    }

    pub fn getPrevGraphemeWidth(self: *const Self, row: u32, col: u32) u32 {
        return iter_mod.getPrevGraphemeWidth(&self._rope, &self.mem_registry, row, col, self.tab_width, self.control_display, self.width_method);
    }

    pub fn textEndOffset(self: *const Self) u32 {
        return self._rope.totalWeight();
    }

    pub fn graphemeBoundsAtOffset(self: *const Self, offset: u32) ?struct { start: u32, end: u32 } {
        const rope_ptr = &self._rope;
        const coords = iter_mod.offsetToCoords(rope_ptr, offset) orelse return null;
        const bounds = iter_mod.getGraphemeBoundsAt(
            rope_ptr,
            &self.mem_registry,
            coords.row,
            coords.col,
            self.tab_width,
            self.control_display,
            self.width_method,
        ) orelse return null;
        const line_start = offset - coords.col;
        return .{ .start = line_start + bounds.start, .end = line_start + bounds.end };
    }

    pub fn cursorUnitBoundsAtOffset(self: *const Self, offset: u32) ?struct { start: u32, end: u32 } {
        const rope_ptr = &self._rope;
        const coords = iter_mod.offsetToCoords(rope_ptr, offset) orelse return null;
        const bounds = iter_mod.getCursorUnitBoundsAt(
            rope_ptr,
            &self.mem_registry,
            coords.row,
            coords.col,
            self.tab_width,
            self.control_display,
            self.width_method,
        ) orelse return null;
        const line_start = offset - coords.col;
        return .{ .start = line_start + bounds.start, .end = line_start + bounds.end };
    }

    pub fn getLayoutInfoFor(self: *const Self, chunk: *const TextChunk) TextBufferError!seg_mod.ChunkLayoutInfo {
        return chunk.getLayoutInfo(self.allocator, @constCast(&self.layout_cache), &self.mem_registry, self.tab_width, self.control_display, self.width_method);
    }

    pub fn getWordLayoutInfoFor(self: *const Self, chunk: *const TextChunk) TextBufferError!seg_mod.WordLayoutInfo {
        return chunk.getWordLayoutInfo(self.allocator, @constCast(&self.layout_cache), &self.mem_registry, self.tab_width, self.control_display, self.width_method);
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
        logger: *const logger.Logger = logger.processLogger(),
        control_display: utf8.ControlDisplay = .hidden,
        group_sets: ?*const hl.GroupSets = null,
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
            .style_binding = .{},
            .pool = pool,
            .link_pool = link_pool,
            .link_tracker = null,
            .width_method = width_method,
            .control_display = options.control_display,
            .view_dirty_flags = view_dirty_flags,
            .next_view_id = 0,
            .free_view_ids = free_view_ids,
            .content_epoch = 0,
            .line_highlights = .empty,
            .line_spans = .empty,
            .span_generation = 1,
            .span_scratch = .{},
            .internal_highlight_count = 0,
            .run_styles = .empty,
            .run_links_retired = false,
            .mark_styles = .empty,
            .layers = .{},
            .group_sets = options.group_sets,
            .tab_width = 2,
            .tab_metrics_generation = 1,
            .tail_slot = null,
            .tail_bytes = .empty,
            .tail_epoch = 0,
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
        self.style_binding.bind(null);

        self.view_dirty_flags.clearRetainingCapacity();
        self.free_view_ids.clearRetainingCapacity();
        self.next_view_id = 0;

        // Free highlight/span caches
        for (self.line_highlights.items) |*hl_list| {
            hl_list.deinit(self.global_allocator);
        }
        self.line_highlights.deinit(self.global_allocator);
        self.line_highlights = .empty;

        self.freeLineSpans();
        self.span_scratch.deinit(self.global_allocator);
        self.resetLayers();

        if (self.link_tracker) |*tracker| {
            tracker.deinit();
        }
        self.link_tracker = null;
        self.dropRunStyles();
        self.mark_styles.deinit(self.global_allocator);
        self.mark_styles = .empty;

        self.layout_cache.clear();
        self.mem_registry.clear();
        self.dropTail();
        // The next owned replacement discards the empty rope, so do not consolidate its old backing.
        _ = self.arena.reset(.free_all);
    }

    /// Forgets the tail slot after the registry was cleared.
    fn dropTail(self: *Self) void {
        self.tail_bytes.deinit(self.global_allocator);
        self.tail_bytes = .empty;
        self.tail_slot = null;
    }

    pub fn reinitStorage(self: *Self, width_method: utf8.WidthMethod) TextBufferError!void {
        std.debug.assert(self.next_view_id == 0 and self.style_binding.style == null and self.link_tracker == null);
        // retireStorage left only capacity behind.
        std.debug.assert(self.mem_registry.buffers.items.len == 0 and self.view_dirty_flags.items.len == 0);
        std.debug.assert(self.line_highlights.items.len == 0 and self.line_spans.count() == 0);
        std.debug.assert(self.run_styles.count() == 0 and self.run_styles.capacity() == 0);
        const registry = self.mem_registry;
        const view_dirty_flags = self.view_dirty_flags;
        const free_view_ids = self.free_view_ids;
        std.debug.assert(self.layers.isEmpty());
        try self.initStorage(self.global_allocator, self.pool, self.link_pool, width_method, .{
            .io = self.io,
            .logger = self.logger,
            .control_display = self.control_display,
            .group_sets = self.group_sets,
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
        // Text changes move columns under layer runs, so painted lines rebuild their spans.
        self.span_generation += 1;
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
        return utf8.calculateTextWidth(text, self.tab_width, self.control_display, is_ascii, self.width_method);
    }

    /// Clear text while preserving highlights, registered bytes, and undo history.
    pub fn clear(self: *Self) TextBufferError!void {
        try self.clearWithUndo(null);
    }

    fn clearWithUndo(self: *Self, meta: ?[]const u8) TextBufferError!void {
        try self._rope.clearWithUndo(meta);
        self.clearLinkRefs();
        self.resetLayers();
        self.layout_cache.clear();
        if (!self._rope.hasHistory()) {
            // Rope nodes are never freed one at a time, so resetting the arena is how
            // replaced text releases memory. Cold layout states belong to its chunks.
            std.debug.assert(self.layout_cache.first == null);
            const previous = self._rope;
            _ = self.arena.reset(.retain_capacity);
            self._rope = .{
                .root = &empty_document_line,
                .allocator = self.allocator,
                .empty_leaf = &empty_document_sentinel,
                .config = previous.config,
            };
        }
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
        self.dropRunStyles();
        self.resetLayers();

        self.layout_cache.clear();
        self.arena.deinit();
        self.arena.* = replacement_arena;
        self._rope = replacement_rope;
        self._rope.allocator = self.allocator;

        self.mem_registry.clear();
        self.dropTail();

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

    pub fn setSyntaxStyle(self: *Self, syntax_style: ?*SyntaxStyle) void {
        self.style_binding.bind(syntax_style);
    }

    pub fn getSyntaxStyle(self: *const Self) ?*const SyntaxStyle {
        return self.style_binding.style;
    }

    fn clearLinkRefs(self: *Self) void {
        if (self.link_tracker) |*tracker| {
            tracker.clear();
        }
        // Map keys stay as they are: stripping links could make two keys equal.
        self.run_links_retired = self.run_styles.count() > 0;
    }

    fn dropRunStyles(self: *Self) void {
        self.run_styles.deinit(self.global_allocator);
        self.run_styles = .empty;
        self.run_links_retired = false;
    }

    /// Resolves a span or highlight style: run refs through the run styles, the rest through the
    /// attached SyntaxStyle.
    pub fn resolveStyle(self: *const Self, id: u32) ?StyleDefinition {
        if (id == 0) return null;
        if (id & run_style_flag == 0) return (self.style_binding.style orelse return null).resolveById(id);
        const index = id & ~run_style_flag;
        // Run refs come only from this buffer's styled text, which replaces them with the map.
        std.debug.assert(index != 0 and index <= self.run_styles.count());
        var definition = self.run_styles.keys()[index - 1];
        if (self.run_links_retired) definition.attributes = ansi.TextAttributes.setLinkId(definition.attributes, 0);
        return definition;
    }

    /// Set the text content using SIMD-optimized line break detection
    pub fn setText(self: *Self, text: []const u8) TextBufferError!void {
        const previous_buffer_count = self.mem_registry.buffers.items.len;
        const mem_id = try self.mem_registry.register(text, false);
        errdefer self.mem_registry.cancelLastRegistration(mem_id, previous_buffer_count);
        try self.setPlainText(mem_id, text, 0, null, null, null);
    }

    /// Set text from a pre-registered memory ID
    pub fn setTextFromMemId(self: *Self, mem_id: u8) TextBufferError!void {
        try self.setTextFromMemIdWithUndo(mem_id, null);
    }

    pub fn setTextFromMemIdWithUndo(self: *Self, mem_id: u8, meta: ?[]const u8) TextBufferError!void {
        const text = self.mem_registry.get(mem_id) orelse return TextBufferError.InvalidMemId;
        try self.setPlainText(mem_id, text, 0, meta, null, null);
    }

    /// Replace the text with `byte_start..byte_end` of a live slot. An editor can copy each
    /// history-preserving replacement into its append slot instead of taking one slot per call.
    pub fn setTextFromMemRangeWithUndo(self: *Self, mem_id: u8, byte_start: u32, byte_end: u32, meta: ?[]const u8) TextBufferError!void {
        const bytes = self.mem_registry.get(mem_id) orelse return TextBufferError.InvalidMemId;
        if (byte_start > byte_end or byte_end > bytes.len) return TextBufferError.InvalidIndex;
        try self.setPlainText(mem_id, bytes[byte_start..byte_end], byte_start, meta, null, null);
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

    /// Consume registry-allocator bytes only on success.
    /// The caller validates UTF-8 and bounds, retaining all inputs on failure.
    /// Success moves prepared link ownership into the buffer and empties the input tracker.
    pub fn replaceOwnedStyledText(
        self: *Self,
        text: []const u8,
        mem_id: ?u8,
        chunks: []const OwnedStyledChunk,
        prepared_links: ?*link.LinkTracker,
    ) TextBufferError!u8 {
        var prepared: PreparedOwnedStyledText = undefined;
        try self.prepareOwnedStyledText(&prepared, text, mem_id, chunks, prepared_links);
        defer prepared.deinit();
        return prepared.commit();
    }

    /// The arena's address must remain stable from preparation through commit or abort.
    /// Text and links remain caller-owned until commit; deinit also handles abort.
    pub const PreparedOwnedStyledText = struct {
        buffer: *Self,
        arena: std.heap.ArenaAllocator,
        rope: UnifiedRope = undefined,
        highlights: std.ArrayListUnmanaged(std.ArrayListUnmanaged(Highlight)) = .empty,
        internal_count: usize = 0,
        text: []const u8,
        mem_id: u8 = undefined,
        previous_buffer_count: usize,
        registration_pending: bool = false,
        run_styles: RunStyles = .empty,
        links: ?*link.LinkTracker,

        pub fn deinit(prepared: *PreparedOwnedStyledText) void {
            const self = prepared.buffer;
            prepared.run_styles.deinit(self.global_allocator);
            if (prepared.registration_pending) {
                self.mem_registry.cancelLastRegistration(prepared.mem_id, prepared.previous_buffer_count);
            }
            for (prepared.highlights.items) |*list| list.deinit(self.global_allocator);
            prepared.highlights.deinit(self.global_allocator);
            prepared.arena.deinit();
        }

        pub fn commit(prepared: *PreparedOwnedStyledText) u8 {
            const self = prepared.buffer;
            std.mem.swap(RunStyles, &self.run_styles, &prepared.run_styles);
            self.run_links_retired = false;
            self.layout_cache.clear();
            std.mem.swap(std.heap.ArenaAllocator, self.arena, &prepared.arena);
            self._rope = prepared.rope;
            self._rope.allocator = self.allocator;
            std.mem.swap(@TypeOf(self.line_highlights), &self.line_highlights, &prepared.highlights);
            self.internal_highlight_count = prepared.internal_count;
            self.resetLayers();
            self.trimLineSpans(self.line_highlights.items.len);
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
        chunks: []const OwnedStyledChunk,
        prepared_links: ?*link.LinkTracker,
    ) TextBufferError!void {
        if (prepared_links) |tracker| {
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
        var byte_count: usize = 0;
        for (chunks) |chunk| {
            if (chunk.byte_count == 0 or chunk.byte_count > text.len - byte_count) {
                return TextBufferError.InvalidIndex;
            }
            // Every link a run style draws is held by the tracker that commit moves into the buffer.
            const link_id = ansi.TextAttributes.getLinkId(chunk.style.attributes);
            if (link_id != 0 and !(prepared_links orelse return TextBufferError.InvalidId).used_ids.contains(link_id)) {
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
            .links = prepared_links,
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
        try self.setPlainText(id, text, 0, null, owned, replacement_arena);
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
        prepared.rope = try UnifiedRope.from_sliceWithConfig(
            prepared.arena.allocator(),
            result.segments.items,
            self._rope.config,
        );

        const highlights = &prepared.highlights;
        const line_count = prepared.rope.root.metrics().custom.linestart_count;
        try highlights.ensureTotalCapacity(self.global_allocator, line_count);

        // Concatenated widths include a split grapheme once, then intersect
        // whole-document lines without counting their separators. Both cursors
        // advance once; these ordered, disjoint ranges need no span boundary sort.
        var width_cursor = utf8.TextWidthCursor{
            .text = text,
            .tab_width = self.tab_width,
            .control_display = self.control_display,
            .width_method = self.width_method,
        };
        var chunk_index: usize = 0;
        var byte_offset: usize = 0;
        var remaining_cols: u32 = 0;
        var style_id: u32 = 0;
        var internal_count: usize = 0;
        for (result.segments.items) |segment| {
            if (segment.isLineStart()) highlights.appendAssumeCapacity(.empty);
            const line = segment.asText() orelse continue;
            const line_index = highlights.items.len - 1;
            var col: u32 = 0;
            while (col < line.width_cols) {
                while (remaining_cols == 0 and chunk_index < chunks.len) : (chunk_index += 1) {
                    const chunk = chunks[chunk_index];
                    const byte_end = byte_offset + chunk.byte_count;
                    const char_pos = width_cursor.columns;
                    remaining_cols = width_cursor.advanceTo(byte_end) - char_pos;
                    // A chunk without width draws nothing, so it interns no style.
                    style_id = if (remaining_cols == 0) 0 else try internRunStyle(&prepared.run_styles, self.global_allocator, chunk.style);
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
                internal_count += 1;
                remaining_cols -= width;
                col += width;
            }
        }

        prepared.internal_count = internal_count;
    }

    /// Equal values share one ref; a style that sets nothing is no style (0).
    fn internRunStyle(run_styles: *RunStyles, allocator: Allocator, style: StyleDefinition) TextBufferError!u32 {
        if (std.meta.eql(style, no_style)) return 0;
        const entry = run_styles.getOrPut(allocator, style) catch return TextBufferError.OutOfMemory;
        if (!entry.found_existing) text_work.add(.style_registrations, 1);
        std.debug.assert(entry.index < run_style_flag - 1);
        return run_style_flag | @as(u32, @intCast(entry.index + 1));
    }

    /// `text` starts at `byte_offset` in slot `mem_id`. A replacement publishes `text` as the
    /// whole slot, so it starts at offset zero.
    fn setPlainText(
        self: *Self,
        mem_id: u8,
        text: []const u8,
        byte_offset: u32,
        meta: ?[]const u8,
        replacement_owned: ?bool,
        provided_arena: ?*std.heap.ArenaAllocator,
    ) TextBufferError!void {
        std.debug.assert(replacement_owned == null or byte_offset == 0);
        var retired_arena = std.heap.ArenaAllocator.init(self.global_allocator);
        defer retired_arena.deinit();
        const replacement_arena = provided_arena orelse
            if (meta == null and (replacement_owned != null or !self._rope.hasHistory())) &retired_arena else null;
        var result = try self.textToSegments(self.global_allocator, text, mem_id, byte_offset, true);
        defer result.segments.deinit(result.allocator);
        // The segments are the document. Do not build an empty rope just to replace it.
        const candidate = if (replacement_arena) |arena|
            try UnifiedRope.from_sliceWithConfig(arena.allocator(), result.segments.items, self._rope.config)
        else blk: {
            var next = self._rope;
            try next.setSegments(result.segments.items);
            break :blk next;
        };

        var highlights: @TypeOf(self.line_highlights) = .empty;
        defer {
            for (highlights.items) |*list| list.deinit(self.global_allocator);
            highlights.deinit(self.global_allocator);
        }
        // User highlights stay only on lines that the new text still has.
        const line_count = if (self.getHighlightCount() == 0) 0 else @min(self.line_highlights.items.len, candidate.root.metrics().custom.linestart_count);
        try highlights.ensureTotalCapacity(self.global_allocator, line_count);
        for (self.line_highlights.items[0..line_count], 0..) |list, line_idx| {
            highlights.appendAssumeCapacity(.empty);
            for (list.items) |record| {
                if (!record.internal) try highlights.items[line_idx].append(self.global_allocator, record);
            }
        }

        // History nodes are shared: publish undo on the live rope, after all preparation.
        if (meta) |value| try self._rope.store_undo(value);
        if (replacement_arena) |arena| {
            // The caller retires the old arena after publication, not during this swap.
            self.layout_cache.clear();
            std.mem.swap(std.heap.ArenaAllocator, self.arena, arena);
            self._rope = candidate;
            self._rope.allocator = self.allocator;
        } else {
            if (replacement_owned != null) self._rope.clear_history();
            self._rope.root = candidate.root;
        }
        self.internal_highlight_count = 0;
        self.dropRunStyles();
        std.mem.swap(@TypeOf(self.line_highlights), &self.line_highlights, &highlights);
        self.resetLayers();
        self.trimLineSpans(self._rope.root.metrics().custom.linestart_count);
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
        return self.appendBytes(text, if (owned) .own else .borrow);
    }

    /// Append a copy of `text`, which the caller keeps.
    pub fn appendCopy(self: *Self, text: []const u8) TextBufferError!void {
        return self.appendBytes(text, .copy);
    }

    const AppendSource = union(enum) { borrow, own, copy, slot: u8 };

    /// A grapheme that the last chunk and `text` split moves whole into the appended bytes, so
    /// the chunk boundary stays a grapheme boundary. Its tail then precedes `text` in a new owned
    /// copy, as every `.copy` append does.
    fn appendBytes(self: *Self, text: []const u8, source: AppendSource) TextBufferError!void {
        if (text.len == 0) {
            if (source == .own) self.global_allocator.free(text);
            return;
        }
        var candidate = self._rope;
        var tail: []const u8 = &.{};
        const last_index = candidate.count() -| 1;
        if (candidate.get(last_index)) |last| if (last.asText()) |chunk| {
            const bytes = chunk.getBytes(&self.mem_registry);
            if (Segment.findJunction(bytes, text, self.width_method)) |at| {
                tail = bytes[at.tail..];
                text_work.add(.grapheme_joins, 1);
                if (at.tail == 0) try candidate.delete(last_index) else try candidate.replace(last_index, .{ .text = self.createChunk(chunk.mem_id, chunk.byte_start, chunk.byte_start + at.tail) });
            }
        };
        const copied = source == .copy or tail.len > 0;
        if (tail.len > 0) text_work.add(.grapheme_join_bytes, if (source == .copy) tail.len else tail.len + text.len);
        if (!copied and source == .slot) return self.appendInternal(&candidate, source.slot, text);

        const data = if (copied) try self.global_allocator.alloc(u8, tail.len + text.len) else text;
        errdefer if (copied) self.global_allocator.free(data);
        if (copied) {
            @memcpy(@constCast(data[0..tail.len]), tail);
            @memcpy(@constCast(data[tail.len..]), text);
        }
        const previous_buffer_count = self.mem_registry.buffers.items.len;
        const mem_id = try self.mem_registry.register(data, false);
        errdefer self.mem_registry.cancelLastRegistration(mem_id, previous_buffer_count);
        try self.appendInternal(&candidate, mem_id, data);
        self.mem_registry.buffers.items[mem_id].owned = copied or source == .own;
        if (copied and source == .own) self.global_allocator.free(text);
    }

    /// Copy every chunk's bytes, in document order, into one owned slot 0 and rebuild the rope
    /// over it. Chunk boundaries and widths are kept, so highlights, spans, and links stay valid.
    /// Every other slot is released, so the caller must hold no other memory ID. Requires empty
    /// history, because history roots would still reference the released slots.
    pub fn flattenMemRegistry(self: *Self) TextBufferError!void {
        std.debug.assert(!self._rope.hasHistory());
        const byte_count = self._rope.root.metrics().custom.total_bytes;
        const bytes = self.global_allocator.alloc(u8, byte_count) catch return TextBufferError.OutOfMemory;
        errdefer self.global_allocator.free(bytes);
        const segments = self._rope.to_array(self.global_allocator) catch return TextBufferError.OutOfMemory;
        defer self.global_allocator.free(segments);
        var offset: u32 = 0;
        for (segments) |*segment| {
            const chunk = switch (segment.*) {
                .text => |*chunk| chunk,
                else => continue,
            };
            const chunk_bytes = chunk.getBytes(&self.mem_registry);
            @memcpy(bytes[offset..][0..chunk_bytes.len], chunk_bytes);
            // Cold layout state lives in the retired arena.
            chunk.* = .{
                .mem_id = 0,
                .byte_start = offset,
                .byte_end = offset + @as(u32, @intCast(chunk_bytes.len)),
                .width_cols = chunk.width_cols,
                .flags = chunk.flags,
            };
            offset = chunk.byte_end;
        }
        std.debug.assert(offset == byte_count);

        var replacement_arena = std.heap.ArenaAllocator.init(self.global_allocator);
        defer replacement_arena.deinit();
        const candidate = UnifiedRope.from_sliceWithConfig(replacement_arena.allocator(), segments, self._rope.config) catch
            return TextBufferError.OutOfMemory;
        self.mem_registry.buffers.ensureTotalCapacity(self.global_allocator, 1) catch return TextBufferError.OutOfMemory;

        self.layout_cache.clear();
        std.mem.swap(std.heap.ArenaAllocator, self.arena, &replacement_arena);
        self._rope = candidate;
        self._rope.allocator = self.allocator;
        self.mem_registry.clear();
        self.dropTail();
        self.mem_registry.buffers.appendAssumeCapacity(.{ .data = bytes, .owned = true, .active = true });
        self.markAllViewsDirty();
    }

    /// Append text from a pre-registered memory ID
    pub fn appendFromMemId(self: *Self, mem_id: u8) TextBufferError!void {
        const text = self.mem_registry.get(mem_id) orelse return TextBufferError.InvalidMemId;
        try self.appendBytes(text, .{ .slot = mem_id });
    }

    /// Replaces the text from byte `from` (bytes of the text as `getPlainText` returns it) to
    /// the end with `bytes` (C4's internal tail primitive). The head's rope and bytes stay: the
    /// buffer keeps the whole text in one growable slot it owns, so a tail write copies only its
    /// new bytes, takes no registry slot, and drops only the rope leaves past `from`. Layers clip
    /// at `from`. A write from 0, or after any other change to the text, replaces it whole (and
    /// resets layers and styles). The rope's arena is rebuilt when it outgrows the live rope.
    /// The caller validates UTF-8 and the text limit.
    pub fn replaceTail(self: *Self, from: u32, bytes: []const u8) TextBufferError!void {
        std.debug.assert(!self._rope.hasHistory());
        const current = self.tail_slot != null and self.tail_epoch == self.content_epoch;
        if (!current or from == 0) return self.replaceWhole(from, bytes);
        std.debug.assert(from <= self.tail_bytes.items.len and self.tail_bytes.items.len == self.getByteSize());
        if (std.mem.indexOfScalar(u8, bytes, '\r') != null) return self.replaceWhole(from, bytes);
        // A write that starts inside a code point rewrites it whole.
        var start = from;
        while (start > 0 and start < self.tail_bytes.items.len and self.tail_bytes.items[start] & 0xC0 == 0x80) start -= 1;
        const slot = self.tail_slot.?;
        const end = from + @as(u32, @intCast(bytes.len));
        // Grow first: the old rope reads its bytes through the registry, which follows the move.
        if (end > self.tail_bytes.capacity) {
            self.tail_bytes.ensureTotalCapacity(self.global_allocator, @max(end, self.tail_bytes.capacity * 2)) catch return TextBufferError.OutOfMemory;
            self.mem_registry.buffers.items[slot].data = self.tail_bytes.items;
        }
        const head = self.tail_bytes.items;
        var candidate = self._rope;
        // Leaves past `start` go; a text leaf that crosses it keeps its head.
        if (self._rope.seekKey(iter_mod.textBytes, start)) |found| {
            var first = found.leaf_index;
            if (found.leaf.asText()) |chunk| if (found.before < start) {
                try candidate.replace(first, .{ .text = self.createChunkFromBytes(slot, head[chunk.byte_start .. chunk.byte_start + (start - found.before)], chunk.byte_start) });
                first += 1;
            };
            if (first < candidate.count()) try candidate.delete_range(first, candidate.count());
        }
        // A grapheme the kept text and the new bytes share is laid out again from its start
        // (its bytes are already in the slot, before `start`).
        var joined = start;
        const piece = if (from > start) try std.mem.concat(self.global_allocator, u8, &.{ head[start..from], bytes }) else bytes;
        defer if (from > start) self.global_allocator.free(piece);
        if (piece.len > 0) {
            const last_index = candidate.count() -| 1;
            if (candidate.get(last_index)) |last| if (last.asText()) |chunk| {
                if (Segment.findJunction(head[chunk.byte_start..chunk.byte_end], piece, self.width_method)) |at| {
                    joined = chunk.byte_start + at.tail;
                    text_work.add(.grapheme_joins, 1);
                    if (at.tail == 0) try candidate.delete(last_index) else try candidate.replace(last_index, .{ .text = self.createChunkFromBytes(slot, head[chunk.byte_start..joined], chunk.byte_start) });
                }
            };
            const laid = if (joined < start) try std.mem.concat(self.global_allocator, u8, &.{ head[joined..start], piece }) else piece;
            defer if (joined < start) self.global_allocator.free(laid);
            var result = try self.textToSegments(self.global_allocator, laid, slot, joined, false);
            defer result.segments.deinit(result.allocator);
            try candidate.insert_slice(candidate.count(), result.segments.items);
        }
        // Publish: the rope, then the bytes it reads, then the layers and caches.
        const old_len: u32 = @intCast(head.len);
        self._rope.root = candidate.root;
        self.tail_bytes.items.len = start;
        self.tail_bytes.appendSliceAssumeCapacity(piece);
        self.mem_registry.buffers.items[slot].data = self.tail_bytes.items;
        self.layers.deleteBytes(self.global_allocator, self.link_pool, start, old_len);
        self.dropLinesFrom(self._rope.root.metrics().custom.linestart_count);
        self.markAllViewsDirty();
        self.tail_epoch = self.content_epoch;
        text_work.add(.tail_writes, 1);
        text_work.add(.tail_write_bytes, piece.len);
        self.reclaimRopeArena() catch {};
    }

    /// The whole text replaced by `head[0..from] ++ bytes` in a new tail slot.
    fn replaceWhole(self: *Self, from: u32, bytes: []const u8) TextBufferError!void {
        var next: std.ArrayListUnmanaged(u8) = .empty;
        errdefer next.deinit(self.global_allocator);
        if (from > 0) {
            // The head as the text holds it now (another write may have replaced the tail slot).
            const size = self.getByteSize();
            std.debug.assert(from <= size);
            next.ensureTotalCapacity(self.global_allocator, @max(size, from + bytes.len)) catch return TextBufferError.OutOfMemory;
            next.items.len = size;
            _ = self.getPlainTextIntoBuffer(next.items);
            next.items.len = from;
        }
        next.appendSlice(self.global_allocator, bytes) catch return TextBufferError.OutOfMemory;
        const new_slot = self.tail_slot == null;
        const previous_buffer_count = self.mem_registry.buffers.items.len;
        const slot = self.tail_slot orelse try self.mem_registry.register(next.items, false);
        errdefer if (new_slot) self.mem_registry.cancelLastRegistration(slot, previous_buffer_count);
        var replacement_arena = std.heap.ArenaAllocator.init(self.global_allocator);
        defer replacement_arena.deinit();
        try self.setPlainText(slot, next.items, 0, null, false, &replacement_arena);
        self.tail_bytes.deinit(self.global_allocator);
        self.tail_bytes = next;
        self.tail_slot = slot;
        // Text with a carriage return counts a CRLF as one byte, so its slot offsets are not the
        // text's: the next tail write replaces it whole.
        self.tail_epoch = if (std.mem.indexOfScalar(u8, next.items, '\r') == null) self.content_epoch else self.content_epoch -% 1;
        text_work.add(.tail_writes, 1);
        text_work.add(.tail_write_bytes, next.items.len);
    }

    /// Legacy records and span caches of lines the text no longer has go.
    fn dropLinesFrom(self: *Self, line_count: usize) void {
        if (self.line_highlights.items.len > line_count) {
            for (self.line_highlights.items[line_count..]) |*list| {
                for (list.items) |record| self.internal_highlight_count -= @intFromBool(record.internal);
                list.deinit(self.global_allocator);
            }
            self.line_highlights.items.len = line_count;
        }
        self.trimLineSpans(line_count);
    }

    /// Old rope paths stay in the arena until it resets. Past twice the live rope plus 64 KiB,
    /// the rope is rebuilt from its leaves into a new arena and the old one is released.
    fn reclaimRopeArena(self: *Self) TextBufferError!void {
        const live = @as(usize, self._rope.count()) * 2 * @sizeOf(UnifiedRope.Node);
        if (self.arena.queryCapacity() <= 2 * live + (64 << 10)) return;
        const segments = self._rope.to_array(self.global_allocator) catch return TextBufferError.OutOfMemory;
        defer self.global_allocator.free(segments);
        // Cold layout state lives in the arena that goes.
        for (segments) |*segment| switch (segment.*) {
            .text => |*chunk| chunk.cold = null,
            else => {},
        };
        var replacement_arena = std.heap.ArenaAllocator.init(self.global_allocator);
        defer replacement_arena.deinit();
        const candidate = UnifiedRope.from_sliceWithConfig(replacement_arena.allocator(), segments, self._rope.config) catch
            return TextBufferError.OutOfMemory;
        self.layout_cache.clear();
        std.mem.swap(std.heap.ArenaAllocator, self.arena, &replacement_arena);
        self._rope = candidate;
        self._rope.allocator = self.allocator;
        text_work.add(.rope_rebuilds, 1);
        self.markAllViewsDirty();
        self.tail_epoch = self.content_epoch;
    }

    /// Internal append that doesn't register memory
    fn appendInternal(self: *Self, candidate: *UnifiedRope, mem_id: u8, text: []const u8) TextBufferError!void {
        // The rope's boundary rewrite will handle normalization at join points
        var result = try self.textToSegments(self.global_allocator, text, mem_id, 0, false);
        defer result.segments.deinit(result.allocator);

        // Canonical appends preserve the leading linestart, but public rope edits
        // can remove it. Stage the root until fallible end-marker repair finishes.
        // insert_slice changes only the root; history remains shared.
        try candidate.insert_slice(candidate.count(), result.segments.items);
        self._rope.root = candidate.root;

        self.markAllViewsDirty();
    }

    /// Replace rope content from an already-registered memory id without clearing.
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

        const chunk_width = utf8.calculateTextWidth(chunk_bytes, self.tab_width, self.control_display, is_ascii, self.width_method);

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
        self.dropTail();
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

    const LineHighlight = struct { line_idx: usize, highlight: Highlight };

    /// Publishes every record or none. `additions` are in ascending line order, one per line.
    fn appendHighlights(self: *Self, additions: []const LineHighlight) TextBufferError!void {
        if (additions.len == 0) return;
        const allocator = self.global_allocator;
        const old_len = self.line_highlights.items.len;
        const storage_len = @max(old_len, additions[additions.len - 1].line_idx + 1);
        try self.line_highlights.ensureTotalCapacity(allocator, storage_len);
        // Lines past the end get their lists here, published only once every allocation succeeded.
        var added_lists: std.ArrayListUnmanaged(std.ArrayListUnmanaged(Highlight)) = .empty;
        defer {
            for (added_lists.items) |*list| list.deinit(allocator);
            added_lists.deinit(allocator);
        }
        try added_lists.ensureTotalCapacity(allocator, storage_len - old_len);
        for (old_len..storage_len) |_| added_lists.appendAssumeCapacity(.empty);
        for (additions, 0..) |addition, index| {
            std.debug.assert(index == 0 or additions[index - 1].line_idx < addition.line_idx);
            // Only styled text replacement creates internal highlights, and it builds them in one pass.
            std.debug.assert(!addition.highlight.internal);
            const list = if (addition.line_idx < old_len) &self.line_highlights.items[addition.line_idx] else &added_lists.items[addition.line_idx - old_len];
            try list.ensureUnusedCapacity(allocator, 1);
        }
        self.line_highlights.appendSliceAssumeCapacity(added_lists.items);
        added_lists.clearRetainingCapacity();
        for (additions) |addition| self.line_highlights.items[addition.line_idx].appendAssumeCapacity(addition.highlight);
        self.span_generation += 1;
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

        try self.appendHighlights(&.{.{ .line_idx = line_idx, .highlight = .{
            .col_start = col_start,
            .col_end = col_end,
            .style_id = style_id,
            .priority = priority,
            .hl_ref = hl_ref,
            .internal = false,
        } }});
    }

    pub fn getLineHighlights(self: *const Self, line_idx: usize) []const Highlight {
        if (line_idx < self.line_highlights.items.len) {
            return self.line_highlights.items[line_idx].items;
        }
        return &[_]Highlight{};
    }

    /// The spans that paint `line_idx`, rebuilt from its legacy records and the layers when they
    /// are older than the buffer's `span_generation`. Only lines read get an entry, and a line
    /// without inputs gets none. Only a newly read line allocates, so warm paints do not.
    pub fn getLineSpans(self: *Self, line_idx: usize) TextBufferError![]const StyleSpan {
        const row: u32 = @intCast(line_idx);
        const entry = self.line_spans.getPtr(row) orelse entry: {
            const has_records = line_idx < self.line_highlights.items.len and self.line_highlights.items[line_idx].items.len > 0;
            if (!has_records and self.layers.isEmpty() and self.marks().len == 0) return &.{};
            try self.line_spans.ensureUnusedCapacity(self.global_allocator, 1);
            const added = self.line_spans.getOrPutAssumeCapacity(row);
            added.value_ptr.* = .{};
            break :entry added.value_ptr;
        };
        const restyled = if (entry.style_changes) |changes| changes != self.style_binding.changes else false;
        if (entry.generation != self.span_generation or restyled) {
            entry.style_changes = try self.buildLineSpans(line_idx, &entry.spans);
            entry.generation = self.span_generation;
        }
        return entry.spans.items;
    }

    /// The style a span paints: legacy ids through `resolveStyle`, group sets composed against the
    /// bound SyntaxStyle, with the span's link.
    pub fn resolveSpan(self: *const Self, span: StyleSpan) ?StyleDefinition {
        switch (span.kind()) {
            .legacy => return self.resolveStyle(span.style_id),
            .group_set => {
                // Group-set spans come only from layers, which need the group sets.
                var definition = no_style;
                if (self.style_binding.style) |style| definition = style.resolveGroupSet(self.group_sets.?, span.style_id);
                if (span.linkId() != 0) definition.attributes = ansi.TextAttributes.setLinkId(definition.attributes, span.linkId());
                return definition;
            },
            .mark_style => return self.mark_styles.keys()[span.style_id],
        }
    }

    /// The edit marks of the live text, sorted by start byte and id.
    pub fn marks(self: *const Self) []const edit_marks.Mark {
        return edit_marks.live(self._rope.aux);
    }

    /// The mark style table index of `style`, added on first use; at most 4,096 styles.
    pub fn internMarkStyle(self: *Self, style: StyleDefinition) error{ OutOfMemory, ObjectLimit }!u32 {
        if (self.mark_styles.getIndex(style)) |index| return @intCast(index);
        if (self.mark_styles.count() == mark_style_count_max) return error.ObjectLimit;
        try self.mark_styles.put(self.global_allocator, style, {});
        return @intCast(self.mark_styles.count() - 1);
    }

    pub const mark_style_count_max = 4096;

    fn suppliesNothing(self: *Self, group_set: u32) bool {
        const style = self.style_binding.style orelse return true;
        return hl.suppliesNothing(style.resolveGroupSet(self.group_sets.?, group_set));
    }

    fn freeLineSpans(self: *Self) void {
        var entries = self.line_spans.valueIterator();
        while (entries.next()) |entry| entry.spans.deinit(self.global_allocator);
        self.line_spans.deinit(self.global_allocator);
        self.line_spans = .empty;
    }

    /// Releases the span storage of lines a replaced text no longer has.
    fn trimLineSpans(self: *Self, line_count: usize) void {
        var entries = self.line_spans.iterator();
        while (entries.next()) |entry| {
            if (entry.key_ptr.* < line_count) continue;
            entry.value_ptr.spans.deinit(self.global_allocator);
            self.line_spans.removeByPtr(entry.key_ptr);
        }
    }

    /// One sweep over the line's inputs: the highest priority wins each column; on a tie the later
    /// input wins (records in line order, styled marks in id order, then layers in `layer_id`
    /// order). A layer run whose set
    /// supplies nothing and has no link is left out when other inputs could show under it. Spans
    /// start at column 0, include gaps, and end with a default tail that unstyles text added later.
    /// Returns the binding's `changes` when the spans depend on definitions.
    fn buildLineSpans(self: *Self, line_idx: usize, out: *std.ArrayListUnmanaged(StyleSpan)) TextBufferError!?u32 {
        const allocator = self.global_allocator;
        const scratch = &self.span_scratch;
        scratch.inputs.clearRetainingCapacity();
        const records = self.getLineHighlights(line_idx);
        try scratch.inputs.ensureTotalCapacity(allocator, records.len);
        for (records) |record| scratch.inputs.appendAssumeCapacity(.{
            .col_start = record.col_start,
            .col_end = record.col_end,
            .style_id = record.style_id,
            .link_id_and_kind = 0,
            .priority = record.priority,
        });
        if (self.marks().len > 0) {
            const mark_kind = @as(u32, @backingInt(StyleSpan.Kind.mark_style)) << 24;
            for (try self.lineMarks(@intCast(line_idx))) |entry| try scratch.inputs.append(allocator, .{
                .col_start = entry.col_start,
                .col_end = entry.col_end,
                .style_id = entry.mark.style,
                .link_id_and_kind = if (entry.mark.style_value) mark_kind else 0,
                .priority = entry.mark.priority,
            });
        }
        const restylable = !self.layers.isEmpty() and try self.appendLayerInputs(@intCast(line_idx));
        text_work.add(.line_span_builds, 1);
        text_work.add(.line_span_highlights, scratch.inputs.items.len);
        try sweepSpans(allocator, scratch, out);
        return if (restylable) self.style_binding.changes else null;
    }

    fn sweepSpans(allocator: Allocator, scratch: *SpanScratch, out: *std.ArrayListUnmanaged(StyleSpan)) TextBufferError!void {
        out.clearRetainingCapacity();
        const inputs = scratch.inputs.items;
        if (inputs.len == 0) return;
        const input_count: u32 = @intCast(inputs.len);
        // k inputs give at most 2k events, 2k + 1 spans, and k heap entries.
        try scratch.events.ensureTotalCapacity(allocator, 2 * inputs.len);
        try scratch.heap.ensureTotalCapacity(allocator, inputs.len);
        try out.ensureTotalCapacity(allocator, 2 * inputs.len + 1);
        scratch.events.clearRetainingCapacity();
        scratch.heap.clearRetainingCapacity();
        var index: u32 = 0;
        while (index < input_count) : (index += 1) {
            std.debug.assert(inputs[index].col_start < inputs[index].col_end);
            scratch.events.appendAssumeCapacity(.{ .col = inputs[index].col_start, .is_start = true, .input_index = index });
            scratch.events.appendAssumeCapacity(.{ .col = inputs[index].col_end, .is_start = false, .input_index = index });
        }
        std.mem.sort(SpanEvent, scratch.events.items, {}, spanEventLessThan);

        var current_col: u32 = 0;
        for (scratch.events.items) |event| {
            if (event.col > current_col) {
                const winner = activeTop(scratch);
                out.appendAssumeCapacity(if (winner) |top| .{
                    .end_col_exclusive = event.col,
                    .style_id = inputs[top].style_id,
                    .link_id_and_kind = inputs[top].link_id_and_kind,
                } else StyleSpan.legacy(event.col, 0));
                current_col = event.col;
            }
            if (event.is_start) heapPush(scratch, event.input_index) else inputs[event.input_index].ended = true;
        }
        std.debug.assert(activeTop(scratch) == null);
        std.debug.assert(out.items.len <= 2 * inputs.len);
        out.appendAssumeCapacity(StyleSpan.legacy(std.math.maxInt(u32), 0));
    }

    /// Every input is nonempty and a span is emitted only when the column advances, so the order
    /// of events at one column does not matter.
    fn spanEventLessThan(_: void, a: SpanEvent, b: SpanEvent) bool {
        return a.col < b.col;
    }

    fn spanInputWins(inputs: []const SpanInput, a: u32, b: u32) bool {
        if (inputs[a].priority != inputs[b].priority) return inputs[a].priority > inputs[b].priority;
        return a > b;
    }

    /// The winning live input; ended inputs leave the heap lazily, here.
    fn activeTop(scratch: *SpanScratch) ?u32 {
        const heap = &scratch.heap;
        while (heap.items.len > 0 and scratch.inputs.items[heap.items[0]].ended) heapPopTop(scratch);
        return if (heap.items.len > 0) heap.items[0] else null;
    }

    fn heapPush(scratch: *SpanScratch, input_index: u32) void {
        const heap = &scratch.heap;
        heap.appendAssumeCapacity(input_index);
        var child = heap.items.len - 1;
        while (child > 0) {
            text_work.add(.span_heap_steps, 1);
            const parent = (child - 1) / 2;
            if (!spanInputWins(scratch.inputs.items, heap.items[child], heap.items[parent])) break;
            std.mem.swap(u32, &heap.items[child], &heap.items[parent]);
            child = parent;
        }
    }

    fn heapPopTop(scratch: *SpanScratch) void {
        const heap = &scratch.heap;
        const inputs = scratch.inputs.items;
        heap.items[0] = heap.items[heap.items.len - 1];
        heap.items.len -= 1;
        var parent: usize = 0;
        while (true) {
            text_work.add(.span_heap_steps, 1);
            var best = parent;
            for ([_]usize{ 2 * parent + 1, 2 * parent + 2 }) |child| {
                if (child < heap.items.len and spanInputWins(inputs, heap.items[child], heap.items[best])) best = child;
            }
            if (best == parent) return;
            std.mem.swap(u32, &heap.items[parent], &heap.items[best]);
            parent = best;
        }
    }

    /// Adds the layer runs that cover line `row`, converted from bytes to columns in one forward
    /// walk of the line's chunks per layer. Over nothing, a run that supplies nothing paints as no
    /// run, so it is left out only over earlier inputs of the line. Returns whether such a run could
    /// be left out, so that the line's spans depend on definitions.
    fn appendLayerInputs(self: *Self, row: u32) TextBufferError!bool {
        const line_start_byte = iter_mod.lineStartByte(&self._rope, row) orelse return false;
        try self.collectLineChunks(row);
        const chunks = self.span_scratch.chunks.items;
        const line_end_byte = line_start_byte + lineByteCount(chunks);
        const group_set_kind = @as(u32, @backingInt(StyleSpan.Kind.group_set)) << 24;
        var restylable = false;
        for (self.layers.slice()) |layer| {
            const lower = self.span_scratch.inputs.items.len != 0;
            var cursor: ColumnCursor = .{ .buffer = self, .chunks = chunks };
            const runs = layer.runs.items;
            var index = hl.Layers.firstEndingAfter(runs, line_start_byte);
            while (index < runs.len and runs[index].start_byte < line_end_byte) : (index += 1) {
                const run = runs[index];
                const col_start = cursor.colAt(@max(run.start_byte, line_start_byte) - line_start_byte);
                // A run past the line ends at its last column.
                const col_end = cursor.colAt(run.end_byte - line_start_byte);
                if (col_start >= col_end) continue;
                if (lower and run.link_id == 0) {
                    restylable = true;
                    if (self.suppliesNothing(run.group_set)) continue;
                }
                std.debug.assert(run.link_id & ~StyleSpan.link_id_mask == 0);
                try self.span_scratch.inputs.append(self.global_allocator, .{
                    .col_start = col_start,
                    .col_end = col_end,
                    .style_id = run.group_set,
                    .link_id_and_kind = run.link_id | group_set_kind,
                    .priority = 0,
                });
            }
        }
        return restylable;
    }

    fn lineByteCount(chunks: []const LineChunk) u32 {
        if (chunks.len == 0) return 0;
        const last = chunks[chunks.len - 1];
        return last.start_byte + last.chunk.byte_end - last.chunk.byte_start;
    }

    /// The styled marks over line `row` in its columns, in id order: the records that one legacy
    /// highlight per mark, added in id order, would give the line. Reuses the span scratch.
    pub fn lineMarks(self: *Self, row: u32) TextBufferError![]const LineMark {
        const out = &self.span_scratch.marks;
        out.clearRetainingCapacity();
        const line_start_byte = iter_mod.lineStartByte(&self._rope, row) orelse return out.items;
        try self.collectLineChunks(row);
        const chunks = self.span_scratch.chunks.items;
        const line_end_byte = line_start_byte + lineByteCount(chunks);
        const line_start_weight = iter_mod.lineStart(&self._rope, row).?.weight;
        for (self.marks()) |mark| {
            if (mark.start_byte >= line_end_byte) break;
            if (!mark.styled() or mark.end_byte <= line_start_byte) continue;
            // A start inside a grapheme (after a join) takes the grapheme, as `weightAtByte` reports it.
            const col_start = if (mark.start_byte <= line_start_byte) 0 else self.weightAtByte(mark.start_byte, true) - line_start_weight;
            var cursor: ColumnCursor = .{ .buffer = self, .chunks = chunks };
            const col_end = cursor.colAt(@min(mark.end_byte, line_end_byte) - line_start_byte);
            if (col_start >= col_end) continue;
            try out.append(self.global_allocator, .{ .mark = mark, .col_start = col_start, .col_end = col_end });
        }
        std.mem.sort(LineMark, out.items, {}, LineMark.idLessThan);
        return out.items;
    }

    /// Fills the scratch with the text chunks of line `row`, with line-relative bytes and columns.
    fn collectLineChunks(self: *Self, row: u32) TextBufferError!void {
        const chunks = &self.span_scratch.chunks;
        chunks.clearRetainingCapacity();
        const start = iter_mod.lineStart(&self._rope, row) orelse return;
        const Walk = struct {
            chunks: *std.ArrayListUnmanaged(LineChunk),
            allocator: Allocator,
            byte: u32 = 0,
            col: u32 = 0,

            fn visit(ctx: *anyopaque, segment: *const Segment, _: u32) UnifiedRope.Node.WalkerResult {
                const walk: *@This() = @ptrCast(@alignCast(ctx));
                if (segment.isBreak()) return .{ .keep_walking = false };
                const chunk = segment.asText() orelse return .{};
                walk.chunks.append(walk.allocator, .{ .chunk = chunk, .start_byte = walk.byte, .start_col = walk.col }) catch |err| return .{ .err = err };
                walk.byte += chunk.byte_end - chunk.byte_start;
                walk.col += chunk.width_cols;
                return .{};
            }
        };
        var walk: Walk = .{ .chunks = chunks, .allocator = self.global_allocator };
        self._rope.walk_from(start.leaf_index + 1, &walk, Walk.visit) catch |err| return @as(TextBufferError, @errorCast(err));
    }

    /// Columns of rising line-relative bytes, within one line's chunks.
    const ColumnCursor = struct {
        buffer: *const Self,
        chunks: []const LineChunk,
        index: usize = 0,
        width: ?utf8.TextWidthCursor = null,

        fn colAt(self: *ColumnCursor, byte: u32) u32 {
            while (self.index < self.chunks.len) {
                const current = self.chunks[self.index];
                if (byte < current.start_byte + current.chunk.byte_end - current.chunk.byte_start) break;
                self.index += 1;
                self.width = null;
            }
            if (self.index == self.chunks.len) {
                if (self.chunks.len == 0) return 0;
                const last = self.chunks[self.chunks.len - 1];
                return last.start_col + last.chunk.width_cols;
            }
            const current = self.chunks[self.index];
            if (byte <= current.start_byte) return current.start_col;
            if (self.width == null) self.width = .{
                .text = current.chunk.getBytes(&self.buffer.mem_registry),
                .tab_width = self.buffer.tab_width,
                .control_display = self.buffer.control_display,
                .width_method = self.buffer.width_method,
            };
            return current.start_col + self.width.?.advanceTo(byte - current.start_byte);
        }
    };

    /// Replaces layer `layer_id` inside `[start_byte, end_byte)` with `runs`, in bytes of the text
    /// as `getPlainText` returns it. Runs must name live group sets and lie on UTF-8 boundaries
    /// inside the text, and the range ends inside the text must too, since the runs it cuts keep
    /// their outside parts; see `highlight-layers.zig` for the rest. Rejection changes nothing.
    pub fn setLayer(self: *Self, layer_id: u32, start_byte: u32, end_byte: u32, runs: []const LayerRun) TextBufferError!void {
        return self.setLayerWithSpare(layer_id, start_byte, end_byte, runs, null);
    }

    /// Storage for layer `layer_id` after a set of `run_count` runs: with it, `setLayerWithSpare`
    /// needs no memory (Markdown writes reserve it before they change the text).
    pub fn reserveLayer(self: *Self, layer_id: u32, run_count: usize) TextBufferError!std.ArrayListUnmanaged(LayerRun) {
        var spare: std.ArrayListUnmanaged(LayerRun) = .empty;
        spare.ensureTotalCapacity(self.global_allocator, run_count + self.layers.runCount(layer_id) + 2) catch return TextBufferError.OutOfMemory;
        return spare;
    }

    pub fn freeLayerSpare(self: *Self, spare: *std.ArrayListUnmanaged(LayerRun)) void {
        spare.deinit(self.global_allocator);
    }

    pub fn setLayerWithSpare(self: *Self, layer_id: u32, start_byte: u32, end_byte: u32, runs: []const LayerRun, spare: ?*std.ArrayListUnmanaged(LayerRun)) TextBufferError!void {
        const sets = self.group_sets orelse return TextBufferError.InvalidId;
        const byte_count = self.getByteSize();
        for ([_]u32{ start_byte, end_byte }) |edge| {
            if (edge < byte_count and !self.isCharBoundary(edge)) return TextBufferError.InvalidIndex;
        }
        for (runs) |run| {
            if (run.group_set == 0 or run.group_set > sets.count()) return TextBufferError.InvalidId;
            if (run.end_byte > byte_count) return TextBufferError.InvalidIndex;
            if (!self.isCharBoundary(run.start_byte) or !self.isCharBoundary(run.end_byte)) return TextBufferError.InvalidIndex;
        }
        const changed = self.layers.setWithSpare(self.global_allocator, self.link_pool, layer_id, start_byte, end_byte, runs, spare) catch |err| return switch (err) {
            error.OutOfMemory => TextBufferError.OutOfMemory,
            error.InvalidIndex => TextBufferError.InvalidIndex,
            error.InvalidId => TextBufferError.InvalidId,
            error.LayerLimit => TextBufferError.LayerLimit,
            error.GroupSetLimit => unreachable,
        };
        self.assertLayerBoundaries();
        if (changed) self.span_generation += 1;
    }

    /// Every layer run starts and ends on a code point boundary inside the text. Debug builds check
    /// it after each layer change and edit.
    pub fn assertLayerBoundaries(self: *const Self) void {
        if (!std.debug.runtime_safety) return;
        const byte_count = self.getByteSize();
        for (self.layers.slice()) |layer| for (layer.runs.items) |run| {
            std.debug.assert(run.end_byte <= byte_count);
            std.debug.assert(self.isCharBoundary(run.start_byte) and self.isCharBoundary(run.end_byte));
        };
    }

    /// Every edit mark lies inside the text, on code point boundaries, in order. Debug builds check
    /// it after each mark change and edit.
    pub fn assertMarks(self: *const Self) void {
        if (!std.debug.runtime_safety) return;
        edit_marks.assertValid(self._rope.aux, self.getByteSize());
        for (self.marks()) |mark| std.debug.assert(self.isCharBoundary(mark.start_byte) and self.isCharBoundary(mark.end_byte));
    }

    /// Whether text byte `byte` starts a code point, a line break, or the end of the text.
    fn isCharBoundary(self: *const Self, byte: u32) bool {
        const found = self._rope.seekKey(iter_mod.textBytes, byte) orelse return byte == self.getByteSize();
        const chunk = found.leaf.asText() orelse return true;
        return chunk.getBytes(&self.mem_registry)[byte - found.before] & 0xC0 != 0x80;
    }

    /// Text bytes before rope weight `weight` (cells plus one per break), where an editor edit at
    /// that weight away from a line start splits the text: after zero-width text, and after a
    /// whole grapheme. Matches `EditBuffer.splitChunkAtWeight`.
    pub fn byteOffsetAtWeight(self: *const Self, weight: u32) u32 {
        const found = self._rope.findByWeight(weight) orelse return self.getByteSize();
        const before = (self._rope.seekCountSum(iter_mod.leafCount, iter_mod.textBytes, found.leaf_index) orelse unreachable).sum;
        const chunk = found.leaf.asText() orelse return before;
        const target_col = weight - found.start_weight;
        if (target_col == 0) return before;
        const ascii_only = (chunk.flags & TextChunk.Flags.ASCII_ONLY) != 0;
        const split = utf8.findPosByWidth(chunk.getBytes(&self.mem_registry), target_col, self.tab_width, self.control_display, ascii_only, false, self.width_method);
        return before + split.byte_offset;
    }

    /// The cursor offset at text byte `byte`: the weight before it, where a byte inside a grapheme
    /// rounds to the grapheme's end, or its start with `round_down`. The inverse of
    /// `byteOffsetAtWeight` on cursor stops.
    pub fn weightAtByte(self: *const Self, byte: u32, round_down: bool) u32 {
        const found = self._rope.seekKey(iter_mod.textBytes, byte) orelse return self._rope.totalWeight();
        const before = (self._rope.seekCountSum(iter_mod.leafCount, iter_mod.weight, found.leaf_index) orelse unreachable).sum;
        // A break's byte is the end of its line.
        const chunk = found.leaf.asText() orelse return before;
        const target = byte - found.before;
        var cursor: utf8.TextWidthCursor = .{
            .text = chunk.getBytes(&self.mem_registry),
            .tab_width = self.tab_width,
            .control_display = self.control_display,
            .width_method = self.width_method,
        };
        // Each one-byte advance takes at least one whole grapheme.
        var columns_before: u32 = 0;
        while (cursor.byte_offset < target) {
            columns_before = cursor.columns;
            _ = cursor.advanceTo(cursor.byte_offset + 1);
        }
        return before + if (round_down and cursor.byte_offset > target) columns_before else cursor.columns;
    }

    /// The text byte where an edit at cursor offset `offset` starts: a line start's first byte, or
    /// where `byteOffsetAtWeight` splits the text elsewhere.
    pub fn byteAtOffset(self: *const Self, offset: u32) u32 {
        const coords = iter_mod.offsetToCoords(&self._rope, @min(offset, self._rope.totalWeight())).?;
        return if (coords.col == 0) self.lineStartByte(coords.row) else self.byteOffsetAtWeight(offset);
    }

    /// The text byte where line `row` starts.
    pub fn lineStartByte(self: *const Self, row: u32) u32 {
        return iter_mod.lineStartByte(&self._rope, row) orelse unreachable;
    }

    /// Empties the layers, as every whole-text change does. Its callers advance the span stamp.
    fn resetLayers(self: *Self) void {
        self.layers.reset(self.global_allocator, self.link_pool);
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
        const line_count = self.getLineCount();
        if (char_start >= char_end or line_count == 0) {
            return;
        }

        var additions: std.ArrayListUnmanaged(LineHighlight) = .empty;
        defer additions.deinit(self.global_allocator);
        // Highlight offsets exclude newlines, unlike rope weights and offsetToCoords.
        // Seek by line end so empty lines at the starting boundary are skipped too.
        const first_row = iter_mod.firstLineEndingAfter(&self._rope, char_start);
        const first = iter_mod.lineStart(&self._rope, first_row).?;
        // One walk over the covered leaves: each break ends a line.
        const Walk = struct {
            buffer: *Self,
            additions: *std.ArrayListUnmanaged(LineHighlight),
            highlight: Highlight,
            char_start: u32,
            char_end: u32,
            row: u32,
            line_weight: u32,
            weight: u32,
            done: bool = false,

            fn visit(ctx: *anyopaque, segment: *const Segment, _: u32) UnifiedRope.Node.WalkerResult {
                const walk: *@This() = @ptrCast(@alignCast(ctx));
                text_work.add(.highlight_leaves, 1);
                if (!segment.isBreak()) {
                    walk.weight += segment.measure().weight();
                    return .{};
                }
                walk.endLine() catch |err| return .{ .err = err };
                walk.row += 1;
                walk.weight += 1;
                walk.line_weight = walk.weight;
                return .{ .keep_walking = !walk.done };
            }

            fn endLine(walk: *@This()) TextBufferError!void {
                const line_start = walk.line_weight - walk.row;
                const width = walk.weight - walk.line_weight;
                walk.done = line_start + width >= walk.char_end;
                if (line_start >= walk.char_end) return;
                var highlight = walk.highlight;
                highlight.col_start = walk.char_start -| line_start;
                highlight.col_end = @min(walk.char_end - line_start, width);
                if (highlight.col_start >= highlight.col_end) return;
                try walk.additions.append(walk.buffer.global_allocator, .{ .line_idx = walk.row, .highlight = highlight });
            }
        };
        var walk: Walk = .{
            .buffer = self,
            .additions = &additions,
            .highlight = .{ .col_start = 0, .col_end = 0, .style_id = style_id, .priority = priority, .hl_ref = hl_ref, .internal = false },
            .char_start = char_start,
            .char_end = char_end,
            .row = first_row,
            .line_weight = first.weight,
            .weight = first.weight,
        };
        self._rope.walk_from(first.leaf_index, &walk, Walk.visit) catch |err| return @as(TextBufferError, @errorCast(err));
        if (!walk.done) try walk.endLine();
        try self.appendHighlights(additions.items);
    }

    /// Remove all highlights with a specific reference ID
    pub fn removeHighlightsByRef(self: *Self, hl_ref: u16) void {
        self.removeHighlightsByRefChecked(hl_ref) catch {};
    }

    /// Filters in place, so it cannot fail; the error union keeps the checked call sites.
    pub fn removeHighlightsByRefChecked(self: *Self, hl_ref: u16) TextBufferError!void {
        var removed = false;
        for (self.line_highlights.items) |*hl_list| {
            var kept: usize = 0;
            for (hl_list.items) |record| {
                if (record.hl_ref == hl_ref) {
                    if (record.internal and self.internal_highlight_count > 0) {
                        self.internal_highlight_count -= 1;
                    }
                    removed = true;
                    continue;
                }
                hl_list.items[kept] = record;
                kept += 1;
            }
            hl_list.items.len = kept;
        }
        if (removed) self.span_generation += 1;
    }

    /// Clear all highlights from a specific line
    pub fn clearLineHighlights(self: *Self, line_idx: usize) void {
        if (line_idx < self.line_highlights.items.len) {
            for (self.line_highlights.items[line_idx].items) |record| {
                if (record.internal and self.internal_highlight_count > 0) {
                    self.internal_highlight_count -= 1;
                }
            }
            self.line_highlights.items[line_idx].clearRetainingCapacity();
        }
        self.span_generation += 1;
    }

    /// Clear all highlights, the layers included (`CLEAR_ALL`).
    pub fn clearAllHighlights(self: *Self) void {
        for (self.line_highlights.items) |*hl_list| {
            hl_list.clearRetainingCapacity();
        }
        self.internal_highlight_count = 0;
        self.resetLayers();
        self.span_generation += 1;
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

    /// Load text from a file path (relative to cwd)
    /// The memory registry owns the file content; replacing the text does not free it.
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

        const text = blk: {
            var content = self.global_allocator.alloc(u8, file_size) catch return TextBufferError.OutOfMemory;
            errdefer self.global_allocator.free(content);
            var read_buffer: [4096]u8 = undefined;
            var reader = file.reader(self.io, &read_buffer);
            const bytes_read = reader.interface.readSliceShort(content) catch return TextBufferError.OutOfMemory;
            content = self.global_allocator.realloc(content, bytes_read) catch return TextBufferError.OutOfMemory;
            break :blk content;
        };
        const mem_id = self.mem_registry.register(text, true) catch |err| {
            self.global_allocator.free(text);
            return err;
        };

        try self.setTextInternal(mem_id, text);
    }

    pub fn getTabWidth(self: *const Self) u8 {
        return self.tabWidth();
    }

    /// Set tab width, rounding up to an even value in the u8-safe range [2, 254].
    /// Marks all views dirty if the width actually changes, since tab width
    /// affects measured line widths and virtual line calculations.
    pub fn setTabWidth(self: *Self, width: u8) void {
        const new_width = effectiveTabWidth(width);
        if (self.tab_width == new_width) return;
        self.tab_width = new_width;
        self.tab_metrics_generation +%= 1;

        self.refreshTabWidthMetrics();
        self.markAllViewsDirty();
    }

    pub fn effectiveTabWidth(width: u8) u8 {
        const clamped_width = @min(@as(u8, 254), @max(2, width));
        return clamped_width + clamped_width % 2;
    }

    /// Reject a tab width under which the text could exceed the u32 cell bound that
    /// Context text validation applies (every byte as one tab).
    pub fn checkTabWidth(self: *const Self, width: u8) error{TextLimit}!void {
        if (self.getByteSize() > (std.math.maxInt(u32) - 1) / @as(u32, effectiveTabWidth(width))) return error.TextLimit;
    }

    /// Bring the active persistent root to the current tab-width generation.
    /// Widths and branch aggregates are derived state, so this deliberately
    /// updates shared const nodes; stale history roots are repaired when restored.
    fn refreshTabWidthMetrics(self: *Self) void {
        if (self._rope.metricsGeneration() == self.tab_metrics_generation) return;

        // Tab presence is content-derived, so even a stale persistent root can
        // use this aggregate to prove that its widths remain valid.
        if (!self._rope.root.metrics().custom.has_tabs) {
            self._rope.setMetricsGeneration(self.tab_metrics_generation);
            return;
        }

        const RefreshContext = struct {
            buffer: *Self,

            fn refresh(ctx_ptr: *anyopaque, segment: *const Segment, _: u32) UnifiedRope.Node.WalkerResult {
                const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
                if (segment.asText()) |chunk| {
                    if (!chunk.hasTab()) return .{};
                    const mutable = @constCast(chunk);
                    const bytes = chunk.getBytes(&ctx.buffer.mem_registry);
                    mutable.width_cols = utf8.calculateTextWidth(
                        bytes,
                        ctx.buffer.tab_width,
                        ctx.buffer.control_display,
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
            self.control_display,
            start_offset,
            clamped_end,
            out_buffer,
            self.width_method,
        );
    }

    /// Zero capacity queries the exact UTF-8 byte count. Short copies fail before writing.
    pub fn copyTextRange(self: *const Self, start_offset: u32, end_offset: u32, out: []u8) !u32 {
        const count = iter_mod.extractTextBetweenOffsets(
            &self._rope,
            &self.mem_registry,
            self.tab_width,
            self.control_display,
            start_offset,
            @min(end_offset, self._rope.totalWeight()),
            null,
            self.width_method,
        );
        std.debug.assert(count <= self.getByteSize());
        if (out.len != 0) {
            if (out.len < count) return error.BufferTooSmall;
            const written = self.getTextRange(start_offset, end_offset, out);
            std.debug.assert(written == count);
        }
        return @intCast(count);
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
