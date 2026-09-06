const std = @import("std");
const Allocator = std.mem.Allocator;
const rope_mod = @import("rope.zig");
const buffer = @import("buffer.zig");
const mem_registry_mod = @import("mem-registry.zig");

const utf8 = @import("utf8.zig");

pub const RGBA = buffer.RGBA;
pub const TextSelection = buffer.TextSelection;

pub const TextBufferError = error{
    OutOfMemory,
    InvalidDimensions,
    InvalidIndex,
    InvalidId,
    InvalidMemId,
};

const MemRegistry = mem_registry_mod.MemRegistry;

pub const WrapMode = enum {
    none,
    char,
    word,
};

pub const WrapIndent = enum {
    none,
    same,
};

pub const RenderClusterInfo = utf8.RenderClusterInfo;
pub const ChunkLayoutInfo = utf8.ChunkLayoutInfo;
pub const WordLayoutInfo = struct {
    wrap_breaks: []const utf8.LayoutWrapBreak,
    word_classes: struct {
        first: utf8.WordClass,
        last: utf8.WordClass,
    },
};

const CachedMeasure = struct {
    wrap_width: u32,
    first_width: u32,
    tab_width: u8,
    width_method: utf8.WidthMethod,
    result: WordMeasureSummary,
};

pub const TextChunkColdState = struct {
    render_clusters: ?[]RenderClusterInfo = null,
    render_clusters_capacity: usize = 0,
    render_clusters_tab_width: ?u8 = null,
    render_clusters_width_method: ?utf8.WidthMethod = null,
    wrap_breaks: ?[]utf8.LayoutWrapBreak = null,
    wrap_breaks_capacity: usize = 0,
    wrap_breaks_tab_width: ?u8 = null,
    wrap_breaks_width_method: ?utf8.WidthMethod = null,
    word_classes: utf8.WordClassEdges = .{ .first = .other, .last = .other },
    cjk_breaks: std.ArrayListUnmanaged(utf8.LayoutWrapBreak) = .empty,
    next_layout_cache: ?*TextChunkColdState = null,
    layout_used: bool = false,
    line_breaks_ready: bool = false,
    measure_word: ?CachedMeasure = null,
};

/// Layout arrays are disposable; the cold states and rope history remain arena-owned.
/// Each chunk uses one cache, which must be cleared before its arena is reset.
pub const ChunkLayoutCache = struct {
    allocator: Allocator,
    first: ?*TextChunkColdState = null,

    pub fn clear(self: *ChunkLayoutCache) void {
        self.release(false);
    }

    pub fn beginLayout(self: *ChunkLayoutCache) void {
        var entry = self.first;
        while (entry) |cold| : (entry = cold.next_layout_cache) cold.layout_used = false;
    }

    pub fn endLayout(self: *ChunkLayoutCache) void {
        self.release(true);
    }

    fn release(self: *ChunkLayoutCache, comptime only_unused: bool) void {
        var entry = &self.first;
        while (entry.*) |cold| {
            if (only_unused and cold.layout_used) {
                entry = &cold.next_layout_cache;
                continue;
            }
            entry.* = cold.next_layout_cache;
            self.allocator.free(cold.wrap_breaks.?.ptr[0..cold.wrap_breaks_capacity]);
            cold.cjk_breaks.deinit(self.allocator);
            cold.wrap_breaks = null;
            cold.wrap_breaks_capacity = 0;
            cold.wrap_breaks_tab_width = null;
            cold.wrap_breaks_width_method = null;
            cold.cjk_breaks = .empty;
            cold.next_layout_cache = null;
            cold.line_breaks_ready = false;
        }
    }
};

pub const WordMeasureSummary = struct {
    line_count: u32,
    width_max: u32,
};

/// A chunk represents a contiguous sequence of UTF-8 bytes from a specific memory buffer
pub const TextChunk = struct {
    mem_id: u8,
    byte_start: u32,
    byte_end: u32,
    width_cols: u32,
    flags: u8 = 0,
    cold: ?*TextChunkColdState = null,

    pub const Flags = struct {
        pub const ASCII_ONLY: u8 = 0b00000001; // Printable ASCII only (32..126).
        pub const HAS_TAB: u8 = 0b00000010;
    };

    pub fn isAsciiOnly(self: *const TextChunk) bool {
        return (self.flags & Flags.ASCII_ONLY) != 0;
    }

    pub fn hasTab(self: *const TextChunk) bool {
        return (self.flags & Flags.HAS_TAB) != 0;
    }

    pub fn empty() TextChunk {
        return .{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 0,
            .width_cols = 0,
        };
    }

    pub fn is_empty(self: *const TextChunk) bool {
        return self.width_cols == 0;
    }

    pub fn getBytes(self: *const TextChunk, mem_registry: *const MemRegistry) []const u8 {
        const mem_buf = mem_registry.get(self.mem_id) orelse return &[_]u8{};
        return mem_buf[self.byte_start..self.byte_end];
    }

    fn getOrCreateCold(self: *const TextChunk, allocator: Allocator) TextBufferError!*TextChunkColdState {
        if (self.cold) |cold| return cold;
        // Derived state lives behind an indirection to keep persistent rope leaves small.
        // Attaching it does not change the chunk's rope metrics.
        const cold = allocator.create(TextChunkColdState) catch return TextBufferError.OutOfMemory;
        cold.* = .{};
        @constCast(self).cold = cold;
        return cold;
    }

    pub fn getCachedLayoutInfo(
        self: *const TextChunk,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
    ) ?ChunkLayoutInfo {
        const cold = self.cold orelse return null;
        cold.layout_used = true;
        if (!cold.line_breaks_ready) return null;
        const cached = cold.wrap_breaks orelse return null;
        if (cold.wrap_breaks_tab_width != tabwidth or cold.wrap_breaks_width_method != width_method) return null;
        return .{
            .wrap_breaks = cached,
            .cjk_breaks = cold.cjk_breaks.items,
            .word_classes = cold.word_classes,
        };
    }

    pub fn getWordMeasureSummary(
        self: *const TextChunk,
        wrap_width: u32,
        first_width: u32,
        tab_width: u8,
        width_method: utf8.WidthMethod,
    ) ?WordMeasureSummary {
        const cold = self.cold orelse return null;
        const cached = cold.measure_word orelse return null;
        if (cached.wrap_width != wrap_width or
            cached.first_width != first_width or
            cached.tab_width != tab_width or
            cached.width_method != width_method) return null;
        return cached.result;
    }

    pub fn setWordMeasureSummary(
        self: *const TextChunk,
        allocator: Allocator,
        wrap_width: u32,
        first_width: u32,
        tab_width: u8,
        width_method: utf8.WidthMethod,
        summary: WordMeasureSummary,
    ) TextBufferError!void {
        const cold = try self.getOrCreateCold(allocator);
        cold.measure_word = .{
            .wrap_width = wrap_width,
            .first_width = first_width,
            .tab_width = tab_width,
            .width_method = width_method,
            .result = summary,
        };
    }

    /// Lazily compute and cache sparse render-cluster metadata for this chunk
    /// Returned storage is arena-owned until reset, but a lookup with different
    /// tab-dependent settings may overwrite it.
    /// For ASCII-only chunks, returns an empty slice (sentinel)
    /// For mixed chunks, returns only multibyte render clusters and tabs with their cell-column starts
    pub fn getRenderClusters(
        self: *const TextChunk,
        allocator: Allocator,
        mem_registry: *const MemRegistry,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
    ) TextBufferError![]const RenderClusterInfo {
        if (self.isAsciiOnly()) return &[_]RenderClusterInfo{};

        const cold = try self.getOrCreateCold(allocator);
        if (cold.render_clusters) |cached| {
            if (cold.render_clusters_tab_width == tabwidth and cold.render_clusters_width_method == width_method) {
                return cached;
            }

            var reusable: std.ArrayListUnmanaged(RenderClusterInfo) = .{
                .items = cached,
                .capacity = cold.render_clusters_capacity,
            };
            reusable.clearRetainingCapacity();
            try utf8.findRenderClusterInfo(allocator, self.getBytes(mem_registry), tabwidth, self.isAsciiOnly(), width_method, &reusable);
            cold.render_clusters = reusable.items;
            cold.render_clusters_capacity = reusable.capacity;
            cold.render_clusters_tab_width = tabwidth;
            cold.render_clusters_width_method = width_method;
            return reusable.items;
        }

        const chunk_bytes = self.getBytes(mem_registry);

        var render_cluster_list: std.ArrayListUnmanaged(RenderClusterInfo) = .empty;
        errdefer render_cluster_list.deinit(allocator);

        try utf8.findRenderClusterInfo(allocator, chunk_bytes, tabwidth, self.isAsciiOnly(), width_method, &render_cluster_list);

        cold.render_clusters = render_cluster_list.items;
        cold.render_clusters_capacity = render_cluster_list.capacity;
        cold.render_clusters_tab_width = tabwidth;
        cold.render_clusters_width_method = width_method;
        return render_cluster_list.items;
    }

    /// Borrowed layout slices remain valid until cache reclamation or a settings change.
    pub fn getLayoutInfo(
        self: *const TextChunk,
        allocator: Allocator,
        cache: *ChunkLayoutCache,
        mem_registry: *const MemRegistry,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
    ) TextBufferError!ChunkLayoutInfo {
        return self.getLayoutInfoForMode(false, allocator, cache, mem_registry, tabwidth, width_method);
    }

    pub fn getWordLayoutInfo(
        self: *const TextChunk,
        allocator: Allocator,
        cache: *ChunkLayoutCache,
        mem_registry: *const MemRegistry,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
    ) TextBufferError!WordLayoutInfo {
        return self.getLayoutInfoForMode(true, allocator, cache, mem_registry, tabwidth, width_method);
    }

    fn getLayoutInfoForMode(
        self: *const TextChunk,
        comptime word_only: bool,
        allocator: Allocator,
        cache: *ChunkLayoutCache,
        mem_registry: *const MemRegistry,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
    ) TextBufferError!(if (word_only) WordLayoutInfo else ChunkLayoutInfo) {
        const cold = try self.getOrCreateCold(allocator);
        if (cold.wrap_breaks == null) {
            cold.next_layout_cache = cache.first;
            cache.first = cold;
            // A non-null slice also marks membership, including after a failed scan.
            cold.wrap_breaks = &.{};
        }
        cold.layout_used = true;
        const cached = cold.wrap_breaks.?;
        if (cold.wrap_breaks_tab_width == tabwidth and cold.wrap_breaks_width_method == width_method and
            (word_only or cold.line_breaks_ready))
        {
            return if (word_only) .{
                .wrap_breaks = cached,
                .word_classes = .{ .first = cold.word_classes.first, .last = cold.word_classes.last },
            } else .{
                .wrap_breaks = cached,
                .cjk_breaks = cold.cjk_breaks.items,
                .word_classes = cold.word_classes,
            };
        }

        const chunk_bytes = self.getBytes(mem_registry);
        var wrap_breaks: std.ArrayListUnmanaged(utf8.LayoutWrapBreak) = .{
            .items = cached,
            .capacity = cold.wrap_breaks_capacity,
        };
        var cjk_breaks = cold.cjk_breaks;
        cjk_breaks.clearRetainingCapacity();
        // Publish owned storage even on OOM so it can be retried or reclaimed.
        cold.wrap_breaks_tab_width = null;
        cold.wrap_breaks_width_method = width_method;
        cold.line_breaks_ready = false;
        defer {
            cold.wrap_breaks = wrap_breaks.items;
            cold.wrap_breaks_capacity = wrap_breaks.capacity;
            cold.cjk_breaks = cjk_breaks;
        }
        // ASCII has no line-only opportunities; both consumers share its scan.
        const word_classes = if (word_only or self.isAsciiOnly())
            try utf8.findWordChunkLayoutInfo(cache.allocator, chunk_bytes, tabwidth, self.isAsciiOnly(), width_method, &wrap_breaks)
        else
            try utf8.findLineAndWordChunkLayoutInfo(cache.allocator, chunk_bytes, tabwidth, false, width_method, &cjk_breaks, &wrap_breaks);
        cold.wrap_breaks_tab_width = tabwidth;
        cold.line_breaks_ready = !word_only or !word_classes.has_cjk_breaks;
        cold.word_classes = word_classes;

        return if (word_only) .{
            .wrap_breaks = wrap_breaks.items,
            .word_classes = .{ .first = word_classes.first, .last = word_classes.last },
        } else .{
            .wrap_breaks = wrap_breaks.items,
            .cjk_breaks = cjk_breaks.items,
            .word_classes = word_classes,
        };
    }
};

/// A highlight represents a styled region on a line
pub const Highlight = struct {
    col_start: u32,
    col_end: u32,
    style_id: u32,
    priority: u8,
    hl_ref: u16 = 0,
    internal: bool = false,
};

/// Pre-computed style span for efficient rendering
/// Represents a contiguous region with a single style
pub const StyleSpan = struct {
    col: u32,
    style_id: u32,
    next_col: u32,
};

/// A segment in the unified rope - either text content or a line break marker
pub const Segment = union(enum) {
    text: TextChunk,
    brk: void,
    linestart: void,

    /// Define which union tags are markers (for O(1) line lookup)
    pub const MarkerTypes = &[_]std.meta.Tag(Segment){ .brk, .linestart };

    /// Metrics for aggregation in the rope tree
    /// These enable O(log n) row/col coordinate mapping and efficient line queries
    pub const Metrics = struct {
        total_width_cols: u32 = 0,
        total_bytes: u32 = 0,
        linestart_count: u32 = 0,
        newline_count: u32 = 0,
        max_line_width_cols: u32 = 0,
        /// Whether all text segments in subtree are ASCII-only (for fast wrapping paths)
        ascii_only: bool = true,
        has_tabs: bool = false,

        pub fn add(self: *Metrics, other: Metrics) void {
            self.total_width_cols += other.total_width_cols;
            self.total_bytes += other.total_bytes;
            self.linestart_count += other.linestart_count;
            self.newline_count += other.newline_count;

            self.max_line_width_cols = @max(self.max_line_width_cols, other.max_line_width_cols);

            self.ascii_only = self.ascii_only and other.ascii_only;
            self.has_tabs = self.has_tabs or other.has_tabs;
        }

        /// Get the balancing weight for the rope
        /// We use total_width_cols + newline_count to give each break a weight of 1
        /// This eliminates boundary ambiguity in coordinate/offset conversions
        pub fn weight(self: *const Metrics) u32 {
            return self.total_width_cols + self.newline_count;
        }
    };

    /// Measure this segment to produce its metrics
    pub fn measure(self: *const Segment) Metrics {
        return switch (self.*) {
            .text => |chunk| blk: {
                const is_ascii = (chunk.flags & TextChunk.Flags.ASCII_ONLY) != 0;
                const byte_len = chunk.byte_end - chunk.byte_start;
                break :blk Metrics{
                    .total_width_cols = chunk.width_cols,
                    .total_bytes = byte_len,
                    .linestart_count = 0,
                    .newline_count = 0,
                    .max_line_width_cols = chunk.width_cols,
                    .ascii_only = is_ascii,
                    .has_tabs = chunk.hasTab(),
                };
            },
            .brk => Metrics{
                .total_width_cols = 0,
                .total_bytes = 0,
                .linestart_count = 0,
                .newline_count = 1,
                .max_line_width_cols = 0,
                .ascii_only = true,
            },
            .linestart => Metrics{
                .total_width_cols = 0,
                .total_bytes = 0,
                .linestart_count = 1,
                .newline_count = 0,
                .max_line_width_cols = 0,
                .ascii_only = true,
            },
        };
    }

    pub fn empty() Segment {
        return .{ .text = TextChunk.empty() };
    }

    pub fn is_empty(self: *const Segment) bool {
        return switch (self.*) {
            .text => |chunk| chunk.is_empty(),
            .brk => false,
            .linestart => false,
        };
    }

    pub fn getBytes(self: *const Segment, mem_registry: *const MemRegistry) []const u8 {
        return switch (self.*) {
            .text => |chunk| chunk.getBytes(mem_registry),
            .brk => &[_]u8{},
            .linestart => &[_]u8{},
        };
    }

    pub fn isBreak(self: *const Segment) bool {
        return switch (self.*) {
            .brk => true,
            else => false,
        };
    }

    pub fn isLineStart(self: *const Segment) bool {
        return switch (self.*) {
            .linestart => true,
            else => false,
        };
    }

    pub fn isText(self: *const Segment) bool {
        return switch (self.*) {
            .text => true,
            else => false,
        };
    }

    pub fn asText(self: *const Segment) ?*const TextChunk {
        return switch (self.*) {
            .text => |*chunk| chunk,
            else => null,
        };
    }

    /// Two text chunks can be merged if they reference contiguous memory in the same buffer
    pub fn canMerge(left: *const Segment, right: *const Segment) bool {
        if (!left.isText() or !right.isText()) return false;

        const left_chunk = left.asText() orelse return false;
        const right_chunk = right.asText() orelse return false;

        if (left_chunk.mem_id != right_chunk.mem_id) return false;
        if (left_chunk.byte_end != right_chunk.byte_start) return false;
        if ((left_chunk.flags & ~TextChunk.Flags.HAS_TAB) != (right_chunk.flags & ~TextChunk.Flags.HAS_TAB)) return false;

        return true;
    }

    pub fn merge(allocator: Allocator, left: *const Segment, right: *const Segment) Segment {
        _ = allocator;

        const left_chunk = left.asText().?;
        const right_chunk = right.asText().?;

        // TODO: could clear the caches on the original chunks,
        // as the original chunks are only kept for history purposes.

        return .{
            .text = TextChunk{
                .mem_id = left_chunk.mem_id,
                .byte_start = left_chunk.byte_start,
                .byte_end = right_chunk.byte_end,
                .width_cols = left_chunk.width_cols + right_chunk.width_cols,
                .flags = left_chunk.flags | right_chunk.flags,
            },
        };
    }

    /// Boundary normalization action
    pub const BoundaryAction = struct {
        delete_left: bool = false,
        delete_right: bool = false,
        insert_between: []const Segment = &[_]Segment{},
    };

    /// Rewrite boundary between two adjacent segments to enforce invariants
    ///
    /// Document invariants enforced at join boundaries:
    /// - Every line starts with a linestart marker
    /// - Line breaks must be followed by linestart markers
    /// - No duplicate linestart markers (deduplicated automatically)
    /// - When joining lines, orphaned linestart markers are removed
    /// - Empty lines are represented as [linestart, brk] with no text, or [linestart] if final
    /// - Consecutive breaks [brk, brk] get a linestart inserted between (empty line)
    ///
    /// Rules applied locally at O(log n) join points:
    /// - [linestart, linestart] → delete right (dedup)
    /// - [brk, text] → insert linestart between (ensure line starts with marker)
    /// - [brk, brk] → insert linestart between (represents empty line)
    /// - [text, linestart] → delete right (remove orphaned linestart when joining lines)
    ///
    /// Valid patterns (no action needed):
    /// - [text, brk] (line content followed by break)
    /// - [linestart, text] (line marker followed by content)
    /// - [linestart, brk] (empty line before another line)
    /// - [linestart] alone (empty final line or empty buffer)
    /// - [brk, linestart, brk] (empty line between two lines, normalized from [brk, brk])
    ///
    /// These rules preserve linestart markers when deleting at col=0 within a line,
    /// since the deletion splits around the marker, and [text, linestart] only triggers
    /// when actually joining lines (deleting the break between them).
    pub fn rewriteBoundary(allocator: Allocator, left: ?*const Segment, right: ?*const Segment) !BoundaryAction {
        _ = allocator;

        // Deleting the final line's contents can also remove its zero-weight marker.
        if (right == null and left != null and left.?.isBreak()) {
            const linestart_segment: Segment = .{ .linestart = {} };
            return .{ .insert_between = &[_]Segment{linestart_segment} };
        }

        if (left == null or right == null) return .{};

        const left_seg = left.?;
        const right_seg = right.?;

        // [linestart, linestart] -> delete right (dedup)
        if (left_seg.isLineStart() and right_seg.isLineStart()) {
            return .{ .delete_right = true };
        }

        // [brk, brk] -> insert linestart between (represents empty line)
        if (left_seg.isBreak() and right_seg.isBreak()) {
            const linestart_segment: Segment = .{ .linestart = {} };
            const insert_slice = &[_]Segment{linestart_segment};
            return .{ .insert_between = insert_slice };
        }

        // [brk, text] -> insert linestart between
        if (left_seg.isBreak() and right_seg.isText()) {
            const linestart_segment: Segment = .{ .linestart = {} };
            const insert_slice = &[_]Segment{linestart_segment};
            return .{ .insert_between = insert_slice };
        }

        // [text, linestart] -> delete right (remove orphaned linestart when joining lines)
        if (left_seg.isText() and right_seg.isLineStart()) {
            return .{ .delete_right = true };
        }

        return .{};
    }

    /// Rewrite rope ends to enforce invariants
    /// Rules:
    /// - Rope must start with linestart (even when empty - ensures at least one line)
    pub fn rewriteEnds(allocator: Allocator, first: ?*const Segment, last: ?*const Segment) !BoundaryAction {
        _ = allocator;
        _ = last;

        // Ensure rope starts with linestart (insert even if empty)
        if (first) |first_seg| {
            if (!first_seg.isLineStart()) {
                const linestart_segment: Segment = .{ .linestart = {} };
                const insert_slice = &[_]Segment{linestart_segment};
                return .{ .insert_between = insert_slice };
            }
        } else {
            // Empty rope - insert linestart to ensure at least one line
            const linestart_segment: Segment = .{ .linestart = {} };
            const insert_slice = &[_]Segment{linestart_segment};
            return .{ .insert_between = insert_slice };
        }

        return .{};
    }
};

pub const UnifiedRope = rope_mod.Rope(Segment);
