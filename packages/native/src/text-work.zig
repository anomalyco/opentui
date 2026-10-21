//! Text work counters for tests. Tests assert how much layout, seek, and scan work an
//! operation does instead of timing it. Outside test builds the record is `void` and
//! every `add` compiles to nothing.
const std = @import("std");
const builtin = @import("builtin");

pub const Counts = struct {
    layouts: u64 = 0,
    /// Logical lines laid out for render.
    lines_laid_out: u64 = 0,
    /// `measureForDimensions` calls that miss the measure cache.
    measure_passes: u64 = 0,
    measure_lines: u64 = 0,
    marker_rebuilds: u64 = 0,
    marker_leaves: u64 = 0,
    marker_lookups: u64 = 0,
    /// Linear steps over render-cluster records before each drawn virtual chunk.
    cluster_scan_steps: u64 = 0,
    left_skip_steps: u64 = 0,
    clusters_drawn: u64 = 0,
    /// Seeks that walk from the start of a slice to a width or to a previous grapheme.
    prefix_seeks: u64 = 0,
    grapheme_width_reads: u64 = 0,
    /// Bytes that the scalar (non-ASCII) scan paths walk.
    bytes_scanned: u64 = 0,
    /// Bytes that the ASCII layout scanner walks.
    ascii_bytes: u64 = 0,
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
