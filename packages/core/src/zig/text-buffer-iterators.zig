const std = @import("std");
const Allocator = std.mem.Allocator;
const seg_mod = @import("text-buffer-segment.zig");
const mem_registry_mod = @import("mem-registry.zig");
const utf8 = @import("utf8.zig");

const Segment = seg_mod.Segment;
const UnifiedRope = seg_mod.UnifiedRope;
const TextChunk = seg_mod.TextChunk;
const GraphemeInfo = seg_mod.GraphemeInfo;
const MemRegistry = mem_registry_mod.MemRegistry;

pub const LineInfo = struct {
    line_idx: u32,
    col_offset: u32,
    width_cols: u32,
    seg_start: u32,
    seg_end: u32,
};

pub const Coords = struct {
    row: u32,
    col: u32,
};

/// Note: Takes mutable rope for lazy marker cache rebuilding
pub fn walkLines(
    rope: *UnifiedRope,
    ctx: *anyopaque,
    callback: *const fn (ctx: *anyopaque, line_info: LineInfo) void,
    include_newlines_in_offset: bool,
) void {
    const linestart_count = rope.markerCount(.linestart);
    if (linestart_count == 0) return;

    var i: u32 = 0;
    while (i < linestart_count) : (i += 1) {
        const marker = rope.getMarker(.linestart, i) orelse continue;
        const line_start_weight = marker.global_weight;
        const width_cols = lineWidthAt(rope, i);
        const seg_end = if (i + 1 < linestart_count) blk: {
            const next_marker = rope.getMarker(.linestart, i + 1) orelse break :blk marker.leaf_index + 1;
            break :blk next_marker.leaf_index;
        } else blk: {
            break :blk rope.count();
        };

        // Line i has i newlines before it (one after each previous line)
        const col_offset = if (include_newlines_in_offset)
            line_start_weight
        else
            line_start_weight - i;

        callback(ctx, .{
            .line_idx = i,
            .col_offset = col_offset,
            .width_cols = width_cols,
            .seg_start = marker.leaf_index,
            .seg_end = seg_end,
        });
    }
}

/// This is the most efficient way to iterate lines and their content
pub fn walkLinesAndSegments(
    rope: *const UnifiedRope,
    ctx: *anyopaque,
    segment_callback: *const fn (ctx: *anyopaque, line_idx: u32, chunk: *const TextChunk, chunk_idx_in_line: u32) void,
    line_end_callback: *const fn (ctx: *anyopaque, line_info: LineInfo) void,
) void {
    if (rope.count() == 0) {
        return;
    }

    const WalkContext = struct {
        user_ctx: *anyopaque,
        seg_callback: *const fn (ctx: *anyopaque, line_idx: u32, chunk: *const TextChunk, chunk_idx_in_line: u32) void,
        line_callback: *const fn (ctx: *anyopaque, line_info: LineInfo) void,
        current_line_idx: u32 = 0,
        current_col_offset: u32 = 0,
        line_start_seg: u32 = 0,
        current_seg_idx: u32 = 0,
        line_width_cols: u32 = 0,
        chunk_idx_in_line: u32 = 0,

        fn walker(walk_ctx_ptr: *anyopaque, seg: *const Segment, idx: u32) UnifiedRope.Node.WalkerResult {
            const walk_ctx = @as(*@This(), @ptrCast(@alignCast(walk_ctx_ptr)));

            if (seg.asText()) |chunk| {
                walk_ctx.seg_callback(walk_ctx.user_ctx, walk_ctx.current_line_idx, chunk, walk_ctx.chunk_idx_in_line);
                walk_ctx.chunk_idx_in_line += 1;
                walk_ctx.line_width_cols += chunk.width;
            } else if (seg.isBreak()) {
                walk_ctx.line_callback(walk_ctx.user_ctx, .{
                    .line_idx = walk_ctx.current_line_idx,
                    .col_offset = walk_ctx.current_col_offset,
                    .width_cols = walk_ctx.line_width_cols,
                    .seg_start = walk_ctx.line_start_seg,
                    .seg_end = idx, // Don't include the break
                });

                walk_ctx.current_line_idx += 1;
                walk_ctx.current_col_offset += walk_ctx.line_width_cols + 1;
                walk_ctx.line_start_seg = idx + 1;
                walk_ctx.line_width_cols = 0;
                walk_ctx.chunk_idx_in_line = 0;
            }

            walk_ctx.current_seg_idx = idx + 1;
            return .{};
        }
    };

    var walk_ctx: WalkContext = .{
        .user_ctx = ctx,
        .seg_callback = segment_callback,
        .line_callback = line_end_callback,
    };
    rope.walk(&walk_ctx, WalkContext.walker) catch {};

    // Emit final line if we have content after last break OR if we had at least one break
    // (A trailing break creates an empty final line)
    const had_breaks = walk_ctx.current_line_idx > 0;
    const has_content_after_break = walk_ctx.line_start_seg < walk_ctx.current_seg_idx;

    if (has_content_after_break or had_breaks) {
        line_end_callback(ctx, .{
            .line_idx = walk_ctx.current_line_idx,
            .col_offset = walk_ctx.current_col_offset,
            .width_cols = walk_ctx.line_width_cols,
            .seg_start = walk_ctx.line_start_seg,
            .seg_end = walk_ctx.current_seg_idx,
        });
    }
}

pub fn getLineCount(rope: *const UnifiedRope) u32 {
    const metrics = rope.root.metrics();
    return metrics.custom.linestart_count;
}

pub fn getMaxLineWidth(rope: *const UnifiedRope) u32 {
    const metrics = rope.root.metrics();
    return metrics.custom.max_line_width;
}

pub fn getTotalWidth(rope: *const UnifiedRope) u32 {
    const metrics = rope.root.metrics();
    return metrics.custom.total_width;
}

/// Optimized O(1) implementation using linestart marker lookups
/// Note: Rope weight includes newlines (each .brk adds +1), but col is still display width
/// Takes mutable rope for lazy marker cache rebuilding
pub fn coordsToOffset(rope: *UnifiedRope, row: u32, col: u32) ?u32 {
    const linestart_count = rope.markerCount(.linestart);
    if (row >= linestart_count) return null;

    const marker = rope.getMarker(.linestart, row) orelse return null;
    const line_start_weight = marker.global_weight;
    const line_width = lineWidthAt(rope, row);

    if (col > line_width) return null;

    return line_start_weight + col;
}

/// Optimized O(log n) implementation using binary search on linestart markers
/// Note: Rope weight includes newlines, so valid offsets are 0..totalWeight() inclusive
/// Takes mutable rope for lazy marker cache rebuilding
/// TODO: Should clamp to min/max offset and always return valid coords
pub fn offsetToCoords(rope: *UnifiedRope, offset: u32) ?Coords {
    const linestart_count = rope.markerCount(.linestart);
    if (linestart_count == 0) return null;

    const total_weight = rope.totalWeight();
    if (offset > total_weight) return null;

    var left: u32 = 0;
    var right: u32 = linestart_count;

    while (left < right) {
        const mid = left + (right - left) / 2;
        const marker = rope.getMarker(.linestart, mid) orelse return null;
        const line_start_weight = marker.global_weight;

        if (offset < line_start_weight) {
            right = mid;
        } else {
            const next_line_start_weight = if (mid + 1 < linestart_count) blk: {
                const next_marker = rope.getMarker(.linestart, mid + 1) orelse return null;
                break :blk next_marker.global_weight;
            } else blk: {
                // Last line: ends at total weight
                break :blk total_weight;
            };

            // Offset belongs to this line if it's before the next line starts
            // (newline offset at end of non-final line maps to col==line_width)
            if (offset < next_line_start_weight or (offset == total_weight and mid + 1 == linestart_count)) {
                return .{
                    .row = mid,
                    .col = offset - line_start_weight,
                };
            }
            left = mid + 1;
        }
    }

    return null;
}

/// Note: Returns display width only (excludes newline weight)
/// Takes mutable rope for lazy marker cache rebuilding
pub fn lineWidthAt(rope: *UnifiedRope, row: u32) u32 {
    const linestart_count = rope.markerCount(.linestart);
    if (row >= linestart_count) return 0;

    const line_marker = rope.getMarker(.linestart, row) orelse return 0;
    const line_start_weight = line_marker.global_weight;
    if (row + 1 < linestart_count) {
        // Non-final line: width = (next_line_start - current_start - 1_for_newline)
        const next_marker = rope.getMarker(.linestart, row + 1) orelse return 0;
        const next_line_start_weight = next_marker.global_weight;
        // Guard against underflow (adjacent linestart markers or empty line)
        if (next_line_start_weight <= line_start_weight) return 0;
        return next_line_start_weight - line_start_weight - 1;
    } else {
        // Final line: width = total_weight - line_start (total weight includes all previous newlines)
        const total_weight = rope.totalWeight();
        return total_weight - line_start_weight;
    }
}

/// Takes mutable rope for lazy marker cache rebuilding
pub fn getGraphemeWidthAt(rope: *UnifiedRope, mem_registry: *const MemRegistry, row: u32, col: u32, tab_width: u8, width_method: utf8.WidthMethod) u32 {
    const line_width = lineWidthAt(rope, row);
    if (col >= line_width) return 0;

    const linestart = rope.getMarker(.linestart, row) orelse return 0;
    var seg_idx = linestart.leaf_index + 1;
    var cols_before: u32 = 0;

    while (seg_idx < rope.count()) : (seg_idx += 1) {
        const seg = rope.get(seg_idx) orelse break;
        if (seg.isBreak() or seg.isLineStart()) break;
        if (seg.asText()) |chunk| {
            const next_cols = cols_before + chunk.width;
            if (col < next_cols) {
                const local_col: u32 = col - cols_before;
                const bytes = chunk.getBytes(mem_registry);
                const is_ascii = (chunk.flags & TextChunk.Flags.ASCII_ONLY) != 0;
                const pos = utf8.findPosByWidth(bytes, local_col, tab_width, is_ascii, false, width_method);
                if (pos.byte_offset >= bytes.len) return 0; // at end of chunk
                const grapheme_start_col = pos.columns_used;
                const width = utf8.getWidthAt(bytes, pos.byte_offset, tab_width, width_method);

                // Calculate remaining width: if cursor is in the middle of a wide grapheme,
                // return only the remaining columns to reach the end of the grapheme
                const grapheme_end_col = grapheme_start_col + width;
                const remaining_width = grapheme_end_col - local_col;
                return remaining_width;
            }
            cols_before = next_cols;
        }
    }
    return 0;
}

/// Takes mutable rope for lazy marker cache rebuilding
pub fn getPrevGraphemeWidth(rope: *UnifiedRope, mem_registry: *const MemRegistry, row: u32, col: u32, tab_width: u8, width_method: utf8.WidthMethod) u32 {
    if (col == 0) return 0;

    const line_width = lineWidthAt(rope, row);
    const clamped_col: u32 = @min(col, line_width);

    const linestart = rope.getMarker(.linestart, row) orelse return 0;
    var seg_idx = linestart.leaf_index + 1;
    var cols_before: u32 = 0;
    var prev_chunk: ?struct { chunk: TextChunk, cols_before: u32 } = null;

    while (seg_idx < rope.count()) : (seg_idx += 1) {
        const seg = rope.get(seg_idx) orelse break;
        if (seg.isBreak() or seg.isLineStart()) break;
        if (seg.asText()) |chunk| {
            const next_cols = cols_before + chunk.width;

            if (clamped_col <= next_cols) {
                if (clamped_col == cols_before and prev_chunk != null) {
                    // Exactly at chunk boundary - get last grapheme from previous chunk
                    const pc = prev_chunk.?;
                    const bytes = pc.chunk.getBytes(mem_registry);
                    const prev = utf8.getPrevGraphemeStart(bytes, bytes.len, tab_width, width_method);
                    if (prev) |res| {
                        return res.width;
                    }
                    return 0;
                }

                const bytes = chunk.getBytes(mem_registry);
                const is_ascii = (chunk.flags & TextChunk.Flags.ASCII_ONLY) != 0;
                const local_col: u32 = clamped_col - cols_before;

                const here = utf8.findPosByWidth(bytes, local_col, tab_width, is_ascii, false, width_method);

                const grapheme_start_col = here.columns_used;

                // Check for integer underflow: if grapheme_start_col > local_col, we're in the middle of a grapheme
                // that spans beyond local_col. This can happen with multi-codepoint graphemes.
                if (grapheme_start_col > local_col) {
                    // We're in the middle of a wide grapheme cluster - need to look at previous chunk or grapheme
                    if (prev_chunk) |pc| {
                        const prev_bytes = pc.chunk.getBytes(mem_registry);
                        const prev = utf8.getPrevGraphemeStart(prev_bytes, prev_bytes.len, tab_width, width_method);
                        if (prev) |res| return res.width;
                    }
                    return 0;
                }

                const offset_into_grapheme = local_col - grapheme_start_col;

                if (offset_into_grapheme > 0) {
                    // We need to jump back: offset_into_grapheme + width of previous grapheme
                    const prev = utf8.getPrevGraphemeStart(bytes, @intCast(here.byte_offset), tab_width, width_method);
                    if (prev) |res| {
                        const total_distance = offset_into_grapheme + res.width;
                        return total_distance;
                    }
                    return offset_into_grapheme;
                }

                const prev = utf8.getPrevGraphemeStart(bytes, @intCast(here.byte_offset), tab_width, width_method);
                if (prev) |res| {
                    return res.width;
                }
                return 0;
            }

            prev_chunk = .{ .chunk = chunk.*, .cols_before = cols_before };
            cols_before = next_cols;
        }
    }
    return 0;
}

pub const CharOffsetColumnInfo = struct {
    col: u32,
    width: u32,
};

/// char_offset is grapheme-count based (not raw codepoint)
/// grapheme_idx and col_delta carry incremental state across calls
pub fn charOffsetToColumn(
    char_offset: u32,
    graphemes: []const GraphemeInfo,
    grapheme_idx: *usize,
    col_delta: *i64,
) CharOffsetColumnInfo {
    while (grapheme_idx.* < graphemes.len) {
        const info = graphemes[grapheme_idx.*];
        const info_char_offset = @as(i64, info.col_offset) - col_delta.*;
        if (info_char_offset >= @as(i64, char_offset)) break;
        col_delta.* += @as(i64, info.width) - 1;
        grapheme_idx.* += 1;
    }

    var break_col_i64 = @as(i64, char_offset) + col_delta.*;
    if (break_col_i64 < 0) break_col_i64 = 0;
    const break_col = @as(u32, @intCast(break_col_i64));

    var width: u32 = 1;
    if (grapheme_idx.* < graphemes.len) {
        const info = graphemes[grapheme_idx.*];
        const info_char_offset = @as(i64, info.col_offset) - col_delta.*;
        if (info_char_offset == @as(i64, char_offset)) {
            width = @as(u32, info.width);
        }
    }

    return .{ .col = break_col, .width = width };
}

/// Extract text between display-width offsets into a buffer
/// Automatically snaps to grapheme boundaries:
/// - start_offset excludes graphemes that start before it
/// - end_offset includes graphemes that start before it
/// Returns number of bytes written to out_buffer
pub fn extractTextBetweenOffsets(
    rope: *const UnifiedRope,
    mem_registry: *const MemRegistry,
    tab_width: u8,
    start_offset: u32,
    end_offset: u32,
    out_buffer: []u8,
    width_method: utf8.WidthMethod,
) usize {
    if (start_offset >= end_offset) return 0;
    if (out_buffer.len == 0) return 0;

    const line_count = rope.root.metrics().custom.linestart_count;

    var out_index: usize = 0;
    var col_offset: u32 = 0;

    _ = width_method; // Just ignore for now, will use .unicode as default

    const Context = struct {
        rope: *const UnifiedRope,
        mem_registry: *const MemRegistry,
        tab_width: u8,
        out_buffer: []u8,
        out_index: *usize,
        col_offset: *u32,
        start: u32,
        end: u32,
        line_count: u32,

        fn segment_callback(ctx_ptr: *anyopaque, line_idx: u32, chunk: *const TextChunk, chunk_idx_in_line: u32) void {
            _ = line_idx;
            _ = chunk_idx_in_line;
            const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));

            const chunk_start_offset = ctx.col_offset.*;
            const chunk_end_offset = chunk_start_offset + chunk.width;

            // Skip chunk if it's entirely outside range
            if (chunk_end_offset <= ctx.start or chunk_start_offset >= ctx.end) {
                ctx.col_offset.* = chunk_end_offset;
                return;
            }

            const chunk_bytes = chunk.getBytes(ctx.mem_registry);
            const is_ascii_only = (chunk.flags & TextChunk.Flags.ASCII_ONLY) != 0;

            const local_start_col: u32 = if (ctx.start > chunk_start_offset) ctx.start - chunk_start_offset else 0;
            const local_end_col: u32 = @min(ctx.end - chunk_start_offset, chunk.width);

            var byte_start: u32 = 0;
            var byte_end: u32 = @intCast(chunk_bytes.len);

            if (local_start_col > 0) {
                const start_result = utf8.findPosByWidth(chunk_bytes, local_start_col, ctx.tab_width, is_ascii_only, false, .unicode);
                byte_start = start_result.byte_offset;
            }

            if (local_end_col < chunk.width) {
                const end_result = utf8.findPosByWidth(chunk_bytes, local_end_col, ctx.tab_width, is_ascii_only, true, .unicode);
                byte_end = end_result.byte_offset;
            }

            if (byte_start < byte_end and byte_start < chunk_bytes.len) {
                const actual_end = @min(byte_end, @as(u32, @intCast(chunk_bytes.len)));
                const selected_bytes = chunk_bytes[byte_start..actual_end];
                const copy_len = @min(selected_bytes.len, ctx.out_buffer.len - ctx.out_index.*);

                if (copy_len > 0) {
                    @memcpy(ctx.out_buffer[ctx.out_index.* .. ctx.out_index.* + copy_len], selected_bytes[0..copy_len]);
                    ctx.out_index.* += copy_len;
                }
            }

            ctx.col_offset.* = chunk_end_offset;
        }

        fn line_end_callback(ctx_ptr: *anyopaque, line_info: LineInfo) void {
            const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));

            // Add newline when the newline offset is inside the selected range,
            // even for empty logical lines.
            const newline_offset = ctx.col_offset.*;
            if (line_info.line_idx < ctx.line_count - 1 and newline_offset >= ctx.start and newline_offset < ctx.end and ctx.out_index.* < ctx.out_buffer.len) {
                ctx.out_buffer[ctx.out_index.*] = '\n';
                ctx.out_index.* += 1;
            }

            // Account for newline in display offset
            ctx.col_offset.* += 1;
        }
    };

    var ctx: Context = .{
        .rope = rope,
        .mem_registry = mem_registry,
        .tab_width = tab_width,
        .out_buffer = out_buffer,
        .out_index = &out_index,
        .col_offset = &col_offset,
        .start = start_offset,
        .end = end_offset,
        .line_count = line_count,
    };

    walkLinesAndSegments(rope, &ctx, Context.segment_callback, Context.line_end_callback);

    return out_index;
}
