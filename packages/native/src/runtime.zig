const std = @import("std");
const build_options = @import("build_options");

/// Process-wide allocator and I/O for standalone native resources.
/// These live until process exit. Context, heap-owned Yoga configs, and
/// NativeSpanFeed streams are created and destroyed independently of this state.
pub var gpa: std.heap.DebugAllocator(.{
    .enable_memory_limit = build_options.gpa_safe_stats,
    .safety = build_options.gpa_safe_stats,
}) = .init;

pub var io_threaded: std.Io.Threaded = .init_single_threaded;

pub fn allocator() std.mem.Allocator {
    return gpa.allocator();
}

pub fn io() std.Io {
    return io_threaded.io();
}
