//! Text work counters for tests. Tests assert how much layout, seek, and scan work an
//! operation does instead of timing it. Outside test builds the record is `void` and
//! every `add` compiles to nothing.
const std = @import("std");
const builtin = @import("builtin");

pub const Counts = struct {
    /// Full virtual-line layouts.
    layouts: u64 = 0,
    /// Logical lines laid out for render.
    lines_laid_out: u64 = 0,
    /// `measureForDimensions` calls that miss the measure cache.
    measure_passes: u64 = 0,
    /// Logical lines that a measure visits.
    measure_lines: u64 = 0,
    marker_rebuilds: u64 = 0,
    /// Rope leaves that marker rebuilds walk.
    marker_leaves: u64 = 0,
    marker_lookups: u64 = 0,
    /// Linear steps over render-cluster records before each drawn virtual chunk.
    cluster_scan_steps: u64 = 0,
    /// Clusters skipped left of the horizontal draw offset.
    left_skip_steps: u64 = 0,
    clusters_drawn: u64 = 0,
    /// Seeks that walk from the start of a slice to a width or to a previous grapheme.
    prefix_seeks: u64 = 0,
    /// Width reads of one grapheme forward from an offset.
    grapheme_width_reads: u64 = 0,
    /// Bytes that the scalar (non-ASCII) scan paths walk.
    bytes_scanned: u64 = 0,
    /// Bytes that whole-slice scanners cover on their ASCII path.
    ascii_bytes: u64 = 0,
};

pub const enabled = builtin.is_test;

threadlocal var counts: if (enabled) Counts else void = if (enabled) .{} else {};

pub inline fn add(comptime field: std.meta.FieldEnum(Counts), n: usize) void {
    if (comptime enabled) @field(counts, @tagName(field)) += n;
}

/// Bytes a whole-slice scanner covers, on its ASCII or scalar path.
pub inline fn addScan(is_ascii_only: bool, n: usize) void {
    if (comptime enabled) {
        if (is_ascii_only) counts.ascii_bytes += n else counts.bytes_scanned += n;
    }
}

/// Returns the counts since the last call and resets them.
pub fn take() Counts {
    if (comptime !enabled) @compileError("text work counters exist only in test builds");
    const result = counts;
    counts = .{};
    return result;
}
