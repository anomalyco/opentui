const std = @import("std");
const builtin = @import("builtin");
const c = @import("context_abi_c");

extern fn otSelftestCxxException() callconv(.c) u32;

pub fn ot_debug_selftest(checks: u32) callconv(.c) u32 {
    var failed = checks & ~c.OT_SELFTEST_ALL;
    if (checks & c.OT_SELFTEST_CXX_EXCEPTION != 0 and otSelftestCxxException() != 0)
        failed |= c.OT_SELFTEST_CXX_EXCEPTION;
    if (checks & c.OT_SELFTEST_THREAD_LOCAL != 0 and !threadLocalsSeparate())
        failed |= c.OT_SELFTEST_THREAD_LOCAL;
    if (checks & c.OT_SELFTEST_UNWIND != 0 and !unwindWorks())
        failed |= c.OT_SELFTEST_UNWIND;
    return failed;
}

// Not zero, so a new thread must get it from the TLS template rather than from zeroed memory.
threadlocal var thread_value: u32 = 0x5e1f;

fn threadLocalsSeparate() bool {
    const Thread = struct {
        fn run(seen: *u32) void {
            seen.* = thread_value;
            thread_value = 2;
        }
    };
    thread_value = 1;
    defer thread_value = 0x5e1f;
    var seen: u32 = 0;
    const thread = std.Thread.spawn(.{}, Thread.run, .{&seen}) catch return false;
    thread.join();
    return seen == 0x5e1f and thread_value == 1;
}

const unwind_depth = 3;

fn unwindWorks() bool {
    var returns: [unwind_depth]usize = undefined;
    var trace: [32]usize = undefined;
    const frames = captureFrom(0, &returns, &trace);
    // Each frame's return address must come out of the unwinder, innermost first.
    std.mem.reverse(usize, &returns);
    if (std.mem.indexOf(usize, frames, &returns) == null) return false;
    // Finding the frame's module is where Windows calls LdrRegisterDllNotification. An ELF executable has no module
    // name, and Zig 0.17's getModuleSlide does not compile for Windows.
    const debug_info = std.debug.getSelfDebugInfo() catch return false;
    const io = std.Options.debug_io;
    if (builtin.os.tag == .windows) {
        _ = debug_info.getModuleName(io, returns[0]) catch return false;
    } else {
        _ = debug_info.getModuleSlide(io, returns[0]) catch return false;
    }
    return true;
}

noinline fn captureFrom(depth: usize, returns: *[unwind_depth]usize, trace: []usize) []const usize {
    returns[depth] = @returnAddress();
    if (depth + 1 < unwind_depth) return @call(.never_tail, captureFrom, .{ depth + 1, returns, trace });
    return std.debug.captureCurrentStackTrace(.{}, trace).return_addresses;
}

test "ot_debug_selftest passes every check and fails unknown ones" {
    try std.testing.expectEqual(@as(u32, 0), ot_debug_selftest(c.OT_SELFTEST_ALL));
    try std.testing.expectEqual(@as(u32, 0), ot_debug_selftest(0));
    try std.testing.expectEqual(@as(u32, 1 << 31 | 8), ot_debug_selftest(1 << 31 | 8 | c.OT_SELFTEST_UNWIND));
}
