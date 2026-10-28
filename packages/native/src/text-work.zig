//! Text work counters for tests. Tests assert how much layout, seek, and scan work an
//! operation does instead of timing it. Outside test builds the record is `void` and
//! every `add` compiles to nothing.
const std = @import("std");
const builtin = @import("builtin");

pub const Counts = struct {
    layouts: u64 = 0,
    /// Logical lines laid out for render.
    lines_laid_out: u64 = 0,
    /// Rope nodes that a layout visits to find the leaves an edit changed.
    rope_diff_nodes: u64 = 0,
    /// Logical lines after an edited range whose stored offsets a layout moves.
    lines_shifted: u64 = 0,
    /// Partial layouts that reach the splice of their staged lines.
    splices: u64 = 0,
    /// Measures that walk lines, and the logical lines they measure.
    measure_passes: u64 = 0,
    measure_lines: u64 = 0,
    /// Line lookups by rope descent, and the branches they visit.
    line_seeks: u64 = 0,
    line_seek_nodes: u64 = 0,
    /// Leaves a highlight walks after it finds its first line.
    highlight_leaves: u64 = 0,
    /// Rope nodes whose metrics a tab-width change recomputes.
    remeasure_nodes: u64 = 0,
    /// Search steps for the first render cluster of each drawn virtual chunk.
    cluster_scan_steps: u64 = 0,
    left_skip_steps: u64 = 0,
    /// Search steps for the style span of each drawn line's first column and truncated suffix.
    span_search_steps: u64 = 0,
    clusters_drawn: u64 = 0,
    /// Seeks that walk from the start of a slice to a width or to a previous grapheme.
    prefix_seeks: u64 = 0,
    grapheme_width_reads: u64 = 0,
    /// Bytes that the scalar (non-ASCII) scan paths walk.
    bytes_scanned: u64 = 0,
    /// Bytes that the ASCII layout scanner walks.
    ascii_bytes: u64 = 0,
    /// Styled-text replacements of one buffer and the bytes each copies.
    styled_text_sets: u64 = 0,
    styled_text_bytes: u64 = 0,
    /// `registerStyleDefinition` calls (new names and overwrites) and new run styles of a
    /// styled replacement.
    style_registrations: u64 = 0,
    /// Context text and edit buffers that borrow a style, checked before its definitions change.
    style_dependent_visits: u64 = 0,
    /// Graphemes rejoined across a chunk boundary, and the bytes copied to rejoin them.
    grapheme_joins: u64 = 0,
    grapheme_join_bytes: u64 = 0,
    /// `buildLineSpans` calls and the highlights they sort.
    line_span_builds: u64 = 0,
    line_span_highlights: u64 = 0,
};

const enabled = builtin.is_test;

threadlocal var counts: if (enabled) Counts else void = if (enabled) .{} else {};

pub inline fn add(comptime field: std.meta.FieldEnum(Counts), n: usize) void {
    if (comptime enabled) @field(counts, @tagName(field)) += n;
}

/// Returns the counts since the last call and resets them.
pub fn take() Counts {
    if (comptime !enabled) @compileError("text work counters exist only in test builds");
    const result = counts;
    counts = .{};
    return result;
}
