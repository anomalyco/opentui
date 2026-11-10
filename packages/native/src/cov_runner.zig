//! Test runner for `zig build test-cov`: runs every unit test, then writes the raw
//! SanitizerCoverage tables to the file named by `OT_COV_OUT`.
//!
//! The build compiles the test module with `fuzz = true`, which makes LLVM emit one 8-bit
//! counter per basic block (so per branch arm, error return, and switch case) in
//! `__sancov_cntrs`, plus PC tables: `__sancov_pcs` for Zig code and `__sancov_pcs1` for the
//! C/C++ sources. The counter order is not guaranteed to match the PC tables across both
//! languages, so the runner dumps all three sections and `scripts/branch-cov.ts` resolves
//! counters to PCs by matching the `lock incb` increments in the binary.
const std = @import("std");
const builtin = @import("builtin");

extern const __start___sancov_cntrs: u8;
extern const __stop___sancov_cntrs: u8;
extern const __start___sancov_pcs: usize;
extern const __stop___sancov_pcs: usize;
extern const __start___sancov_pcs1: usize;
extern const __stop___sancov_pcs1: usize;

// `-ffuzz` links libfuzzer, which expects the stock test runner to export these.
export fn runner_futex_wait() void {}
export fn runner_futex_wake() void {}
export fn runner_broadcast_input() void {}
export fn runner_test_name() void {}
export fn runner_start_input_poller() void {}
export fn runner_stop_input_poller() void {}
export fn runner_test_run() void {}

// `-ffuzz` also instruments the C/C++ sources (Yoga, image codecs) with trace-cmp hooks.
// libfuzzer only implements the 8-bit counters, so the runner provides the rest as no-ops.
export fn __sanitizer_cov_trace_cmp1(_: u8, _: u8) void {}
export fn __sanitizer_cov_trace_cmp2(_: u16, _: u16) void {}
export fn __sanitizer_cov_trace_cmp4(_: u32, _: u32) void {}
export fn __sanitizer_cov_trace_cmp8(_: u64, _: u64) void {}
export fn __sanitizer_cov_trace_const_cmp1(_: u8, _: u8) void {}
export fn __sanitizer_cov_trace_const_cmp2(_: u16, _: u16) void {}
export fn __sanitizer_cov_trace_const_cmp4(_: u32, _: u32) void {}
export fn __sanitizer_cov_trace_const_cmp8(_: u64, _: u64) void {}
export fn __sanitizer_cov_trace_switch(_: u64, _: [*]const u64) void {}
export fn __sanitizer_cov_trace_div4(_: u32) void {}
export fn __sanitizer_cov_trace_div8(_: u64) void {}
export fn __sanitizer_cov_trace_gep(_: usize) void {}

pub fn main(init: std.process.Init.Minimal) !void {
    @disableInstrumentation();
    const io = std.testing.io;
    var passed: usize = 0;
    var skipped: usize = 0;
    var failed: usize = 0;
    for (builtin.test_functions) |t| {
        std.testing.allocator_instance = .init(std.heap.page_allocator, .{});
        defer if (std.testing.allocator_instance.deinit() != 0) {
            std.debug.print("LEAK {s}\n", .{t.name});
            failed += 1;
        };
        t.func() catch |err| switch (err) {
            error.SkipZigTest => skipped += 1,
            else => {
                std.debug.print("FAIL {s}: {t}\n", .{ t.name, err });
                failed += 1;
                continue;
            },
        };
        passed += 1;
    }
    std.debug.print("{d} passed, {d} skipped, {d} failed\n", .{ passed, skipped, failed });

    const out_path = init.environ.getPosix("OT_COV_OUT") orelse {
        if (failed != 0) std.process.exit(1);
        return;
    };
    var file = try std.Io.Dir.cwd().createFile(io, out_path, .{});
    defer file.close(io);
    var buf: [64 * 1024]u8 = undefined;
    var w = file.writer(io, &buf);
    const cntrs_start = @intFromPtr(&__start___sancov_cntrs);
    const cntrs_len = @intFromPtr(&__stop___sancov_cntrs) - cntrs_start;
    try w.interface.print("cntrs {x} {d}\n", .{ cntrs_start, cntrs_len });
    try w.interface.writeAll(@as([*]const u8, @ptrCast(&__start___sancov_cntrs))[0..cntrs_len]);
    try w.interface.writeAll("\n");
    try dumpPcs(&w.interface, "pcs", &__start___sancov_pcs, &__stop___sancov_pcs);
    try dumpPcs(&w.interface, "pcs1", &__start___sancov_pcs1, &__stop___sancov_pcs1);
    try w.interface.flush();
    if (failed != 0) std.process.exit(1);
}

fn dumpPcs(w: *std.Io.Writer, name: []const u8, start: *const usize, stop: *const usize) !void {
    const pairs = (@intFromPtr(stop) - @intFromPtr(start)) / (2 * @sizeOf(usize));
    const table = @as([*]const usize, @ptrCast(start))[0 .. pairs * 2];
    try w.print("{s} {d}\n", .{ name, pairs });
    var i: usize = 0;
    while (i < table.len) : (i += 2) try w.print("{x}\n", .{table[i]});
}
