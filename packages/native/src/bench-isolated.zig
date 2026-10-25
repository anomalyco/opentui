// Benches compiled as their own unit and linked into `opentui-bench`, which calls them through the
// exports below. Inlining and code placement in a unit depend on all of its code, so in the shared
// unit a change to another bench could move these rows by about 15%. The exports are page-aligned,
// so the unit's code keeps its offsets within a page when the code before it grows.

const std = @import("std");
const bench_utils = @import("bench-utils.zig");
const renderer_image_bench = @import("bench/renderer-image_bench.zig");
const buffer_cell_drawing_bench = @import("bench/buffer-cell-drawing_bench.zig");
const buffer_image_overlap_bench = @import("bench/buffer-image-overlap_bench.zig");

var io_threaded: std.Io.Threaded = .init_single_threaded;
pub const io = io_threaded.io();

fn unitFn(comptime bench: type) bench_utils.UnitFn {
    return &struct {
        fn run(json_output: bool, show_mem: bool, bench_filter: [*]const u8, bench_filter_len: usize) align(4096) callconv(.c) bench_utils.UnitStatus {
            var gpa: std.heap.DebugAllocator(.{}) = .init;
            defer _ = gpa.deinit();
            var stdout_buffer: [4096]u8 = undefined;
            var stdout_writer = std.Io.File.stdout().writerStreaming(io, &stdout_buffer);
            const filter = bench_filter[0..bench_filter_len];
            const ran = bench_utils.runCategory(io, gpa.allocator(), &stdout_writer.interface, bench.benchName, bench.run, json_output, show_mem, filter) catch |err| {
                std.debug.print("{s} failed: {s}\n", .{ bench.benchName, @errorName(err) });
                return .failed;
            };
            stdout_writer.interface.flush() catch return .failed;
            return if (ran) .ran else .empty;
        }
    }.run;
}

comptime {
    @export(unitFn(renderer_image_bench), .{ .name = "opentui_bench_renderer_image" });
    @export(unitFn(buffer_cell_drawing_bench), .{ .name = "opentui_bench_buffer_cell_drawing" });
    @export(unitFn(buffer_image_overlap_bench), .{ .name = "opentui_bench_buffer_image_overlap" });
}
