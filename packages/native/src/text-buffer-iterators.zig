const std = @import("std");
const Allocator = std.mem.Allocator;
const seg_mod = @import("text-buffer-segment.zig");
const mem_registry_mod = @import("mem-registry.zig");
const utf8 = @import("utf8.zig");

const Segment = seg_mod.Segment;
const UnifiedRope = seg_mod.UnifiedRope;
const TextChunk = seg_mod.TextChunk;
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
                walk_ctx.line_width_cols += chunk.width_cols;
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
    return rope.root.metrics().custom.lineWidthMax();
}

pub fn getTotalWidth(rope: *const UnifiedRope) u32 {
    const metrics = rope.root.metrics();
    return metrics.custom.total_width_cols;
}

fn linestarts(metrics: *const UnifiedRope.Metrics) u32 {
    return metrics.custom.linestart_count;
}

fn newlines(metrics: *const UnifiedRope.Metrics) u32 {
    return metrics.custom.newline_count;
}

fn weight(metrics: *const UnifiedRope.Metrics) u32 {
    return metrics.weight();
}

fn cells(metrics: *const UnifiedRope.Metrics) u32 {
    return metrics.custom.total_width_cols;
}

/// The linestart leaf of `row` and the rope weight before it, by one descent.
pub fn lineStart(rope: *const UnifiedRope, row: u32) ?UnifiedRope.Position {
    return rope.seekCount(linestarts, row);
}

/// Display width of `row`, whose line starts at weight `start`; a break weighs one.
fn lineWidthFrom(rope: *const UnifiedRope, row: u32, start: u32) u32 {
    const next = lineStart(rope, row + 1) orelse return rope.totalWeight() - start;
    std.debug.assert(next.weight > start);
    return next.weight - start - 1;
}

/// Note: Rope weight includes newlines (each .brk adds +1), but col is still display width
pub fn coordsToOffset(rope: *const UnifiedRope, row: u32, col: u32) ?u32 {
    const start = lineStart(rope, row) orelse return null;
    if (col > lineWidthFrom(rope, row, start.weight)) return null;
    return start.weight + col;
}

/// Valid offsets are 0..totalWeight() inclusive. A break's offset belongs to the line it ends.
/// TODO: Should clamp to min/max offset and always return valid coords
pub fn offsetToCoords(rope: *const UnifiedRope, offset: u32) ?Coords {
    if (offset > rope.totalWeight()) return null;
    // Every rope starts with a linestart leaf at weight 0.
    const starts = rope.countThrough(weight, linestarts, offset);
    std.debug.assert(starts > 0);
    const row = starts - 1;
    return .{ .row = row, .col = offset - lineStart(rope, row).?.weight };
}

/// Note: Returns display width only (excludes newline weight)
pub fn lineWidthAt(rope: *const UnifiedRope, row: u32) u32 {
    const start = lineStart(rope, row) orelse return 0;
    return lineWidthFrom(rope, row, start.weight);
}

/// The first line whose end, in cells that exclude breaks, is past `cell`; the last line if none.
pub fn firstLineEndingAfter(rope: *const UnifiedRope, cell: u32) u32 {
    return rope.countThrough(cells, newlines, cell);
}

pub const GraphemeBounds = struct {
    start: u32,
    end: u32,
};

fn getTextUnitBoundsAt(rope: *const UnifiedRope, mem_registry: *const MemRegistry, row: u32, col: u32, tab_width: u8, control_display: utf8.ControlDisplay, width_method: utf8.WidthMethod, cluster_graphemes: bool) ?GraphemeBounds {
    const line_width = lineWidthAt(rope, row);
    if (col >= line_width) return null;

    var seg_idx = (lineStart(rope, row) orelse return null).leaf_index + 1;
    var cols_before: u32 = 0;

    while (seg_idx < rope.count()) : (seg_idx += 1) {
        const seg = rope.get(seg_idx) orelse break;
        if (seg.isBreak() or seg.isLineStart()) break;
        if (seg.asText()) |chunk| {
            const next_cols = cols_before + chunk.width_cols;
            if (col < next_cols) {
                const local_col: u32 = col - cols_before;
                const bytes = chunk.getBytes(mem_registry);
                const is_ascii = (chunk.flags & TextChunk.Flags.ASCII_ONLY) != 0;
                const pos = if (cluster_graphemes)
                    utf8.findGraphemePosByWidth(bytes, local_col, tab_width, control_display, is_ascii, false, width_method)
                else
                    utf8.findPosByWidth(bytes, local_col, tab_width, control_display, is_ascii, false, width_method);
                if (pos.byte_offset >= bytes.len) return null;
                const width = if (cluster_graphemes)
                    utf8.getGraphemeWidthAt(bytes, pos.byte_offset, tab_width, control_display, width_method)
                else
                    utf8.getWidthAt(bytes, pos.byte_offset, tab_width, control_display, width_method);
                const start = cols_before + pos.columns_used;
                return .{ .start = start, .end = start + width };
            }
            cols_before = next_cols;
        }
    }
    return null;
}

pub fn getGraphemeBoundsAt(rope: *const UnifiedRope, mem_registry: *const MemRegistry, row: u32, col: u32, tab_width: u8, control_display: utf8.ControlDisplay, width_method: utf8.WidthMethod) ?GraphemeBounds {
    return getTextUnitBoundsAt(rope, mem_registry, row, col, tab_width, control_display, width_method, true);
}

pub fn getCursorUnitBoundsAt(rope: *const UnifiedRope, mem_registry: *const MemRegistry, row: u32, col: u32, tab_width: u8, control_display: utf8.ControlDisplay, width_method: utf8.WidthMethod) ?GraphemeBounds {
    return getTextUnitBoundsAt(rope, mem_registry, row, col, tab_width, control_display, width_method, false);
}

pub fn getGraphemeWidthAt(rope: *const UnifiedRope, mem_registry: *const MemRegistry, row: u32, col: u32, tab_width: u8, control_display: utf8.ControlDisplay, width_method: utf8.WidthMethod) u32 {
    const bounds = getCursorUnitBoundsAt(rope, mem_registry, row, col, tab_width, control_display, width_method) orelse return 0;
    return bounds.end -| col;
}

pub fn getPrevGraphemeWidth(rope: *const UnifiedRope, mem_registry: *const MemRegistry, row: u32, col: u32, tab_width: u8, control_display: utf8.ControlDisplay, width_method: utf8.WidthMethod) u32 {
    if (col == 0) return 0;

    const line_width = lineWidthAt(rope, row);
    const clamped_col: u32 = @min(col, line_width);

    var seg_idx = (lineStart(rope, row) orelse return 0).leaf_index + 1;
    var cols_before: u32 = 0;
    var prev_chunk: ?struct { chunk: TextChunk, cols_before: u32 } = null;

    while (seg_idx < rope.count()) : (seg_idx += 1) {
        const seg = rope.get(seg_idx) orelse break;
        if (seg.isBreak() or seg.isLineStart()) break;
        if (seg.asText()) |chunk| {
            const next_cols = cols_before + chunk.width_cols;

            if (clamped_col <= next_cols) {
                if (clamped_col == cols_before and prev_chunk != null) {
                    // Exactly at chunk boundary - get last grapheme from previous chunk
                    const pc = prev_chunk.?;
                    const bytes = pc.chunk.getBytes(mem_registry);
                    const prev = utf8.getPrevGraphemeStart(bytes, bytes.len, tab_width, control_display, width_method);
                    if (prev) |res| {
                        return res.width;
                    }
                    return 0;
                }

                const bytes = chunk.getBytes(mem_registry);
                const is_ascii = (chunk.flags & TextChunk.Flags.ASCII_ONLY) != 0;
                const local_col: u32 = clamped_col - cols_before;

                const here = utf8.findPosByWidth(bytes, local_col, tab_width, control_display, is_ascii, false, width_method);

                const grapheme_start_col = here.columns_used;

                // Check for integer underflow: if grapheme_start_col > local_col, we're in the middle of a grapheme
                // that spans beyond local_col. This can happen with multi-codepoint graphemes.
                if (grapheme_start_col > local_col) {
                    // We're in the middle of a wide grapheme cluster - need to look at previous chunk or grapheme
                    if (prev_chunk) |pc| {
                        const prev_bytes = pc.chunk.getBytes(mem_registry);
                        const prev = utf8.getPrevGraphemeStart(prev_bytes, prev_bytes.len, tab_width, control_display, width_method);
                        if (prev) |res| return res.width;
                    }
                    return 0;
                }

                const offset_into_grapheme = local_col - grapheme_start_col;

                if (offset_into_grapheme > 0) {
                    // We need to jump back: offset_into_grapheme + width of previous grapheme
                    const prev = utf8.getPrevGraphemeStart(bytes, @intCast(here.byte_offset), tab_width, control_display, width_method);
                    if (prev) |res| {
                        const total_distance = offset_into_grapheme + res.width;
                        return total_distance;
                    }
                    return offset_into_grapheme;
                }

                const prev = utf8.getPrevGraphemeStart(bytes, @intCast(here.byte_offset), tab_width, control_display, width_method);
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

/// Extract text between display-width offsets into a buffer
/// Automatically snaps to grapheme boundaries:
/// - start_offset snaps backward to the containing grapheme
/// - end_offset snaps forward to include a partially selected grapheme
/// Returns bytes written, or the exact byte count when out_buffer is null.
pub fn extractTextBetweenOffsets(
    rope: *const UnifiedRope,
    mem_registry: *const MemRegistry,
    tab_width: u8,
    control_display: utf8.ControlDisplay,
    start_offset: u32,
    end_offset: u32,
    out_buffer: ?[]u8,
    width_method: utf8.WidthMethod,
) usize {
    if (start_offset >= end_offset) return 0;
    if (out_buffer) |out| if (out.len == 0) return 0;

    const first = rope.findByWeight(start_offset) orelse return 0;

    const Context = struct {
        mem_registry: *const MemRegistry,
        tab_width: u8,
        control_display: utf8.ControlDisplay,
        out_buffer: ?[]u8,
        out_index: usize = 0,
        col_offset: u32,
        start: u32,
        end: u32,
        width_method: utf8.WidthMethod,

        fn walk(ctx_ptr: *anyopaque, segment: *const Segment, _: u32) UnifiedRope.Node.WalkerResult {
            const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
            if (ctx.col_offset >= ctx.end) return .{ .keep_walking = false };
            if (segment.asText()) |chunk| {
                ctx.text(chunk);
            } else if (segment.isBreak()) {
                if (ctx.col_offset >= ctx.start) ctx.append("\n");
                ctx.col_offset += 1;
            }
            return .{};
        }

        fn text(ctx: *@This(), chunk: *const TextChunk) void {
            const chunk_start_offset = ctx.col_offset;
            const chunk_end_offset = chunk_start_offset + chunk.width_cols;
            ctx.col_offset = chunk_end_offset;

            if (chunk_end_offset <= ctx.start) return;

            const chunk_bytes = chunk.getBytes(ctx.mem_registry);
            const is_ascii_only = (chunk.flags & TextChunk.Flags.ASCII_ONLY) != 0;

            const local_start_col: u32 = if (ctx.start > chunk_start_offset) ctx.start - chunk_start_offset else 0;
            const local_end_col: u32 = @min(ctx.end - chunk_start_offset, chunk.width_cols);

            var byte_start: u32 = 0;
            var byte_end: u32 = @intCast(chunk_bytes.len);

            if (local_start_col > 0) {
                const start_result = utf8.findGraphemePosByWidth(chunk_bytes, local_start_col, ctx.tab_width, ctx.control_display, is_ascii_only, false, ctx.width_method);
                byte_start = start_result.byte_offset;
            }

            if (local_end_col < chunk.width_cols) {
                const end_result = utf8.findGraphemePosByWidth(chunk_bytes, local_end_col, ctx.tab_width, ctx.control_display, is_ascii_only, true, ctx.width_method);
                byte_end = end_result.byte_offset;
            }

            if (byte_start < byte_end and byte_start < chunk_bytes.len) {
                const actual_end = @min(byte_end, @as(u32, @intCast(chunk_bytes.len)));
                ctx.append(chunk_bytes[byte_start..actual_end]);
            }
        }

        fn append(ctx: *@This(), bytes: []const u8) void {
            if (ctx.out_buffer) |out| {
                const count = @min(bytes.len, out.len - ctx.out_index);
                @memcpy(out[ctx.out_index..][0..count], bytes[0..count]);
                ctx.out_index += count;
            } else {
                ctx.out_index += bytes.len;
            }
        }
    };

    var ctx: Context = .{
        .mem_registry = mem_registry,
        .tab_width = tab_width,
        .control_display = control_display,
        .out_buffer = out_buffer,
        .col_offset = first.start_weight,
        .start = start_offset,
        .end = end_offset,
        .width_method = width_method,
    };

    rope.walk_from(first.leaf_index, &ctx, Context.walk) catch unreachable;

    return ctx.out_index;
}
