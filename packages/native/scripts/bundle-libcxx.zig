//! Writes a copy of a Linux libopentui.a with Zig's libc++ and libc++abi merged
//! in, so a C, Rust, or Zig program links it without a system libc++.
//!
//! Usage: bundle-libcxx <zig> <target> <optimize> <probe.cpp> <in.a> <out.a>
//!
//! A static library never carries libc++, and the build API offers no path to
//! the archives Zig builds. So this links a stripped C++ probe for the same
//! target and mode, takes both archives from the probe's linker line, and
//! appends their members to the copy. libunwind and compiler-rt stay out: the
//! program's own toolchain supplies unwinding and builtins.

const std = @import("std");

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const io = init.io;
    const args = try init.minimal.args.toSlice(arena);
    if (args.len != 7) return error.Usage;
    const zig, const target, const optimize, const probe, const input, const output =
        .{ args[1], args[2], args[3], args[4], args[5], args[6] };

    // An explicit -femit-bin links on every run, so the linker line prints even when Zig's cache has the probe.
    const emit = try std.fmt.allocPrint(arena, "-femit-bin={s}.so", .{output});
    const link = try run(arena, io, &.{
        zig, "build-lib", "-dynamic", "-lc++", "-fstrip", "-fPIC", "--verbose-link", "-target", target, "-O", optimize, probe, emit,
    });
    var libcxx: ?[]const u8 = null;
    var libcxxabi: ?[]const u8 = null;
    var lines = std.mem.splitScalar(u8, link, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, "ld.lld ")) continue;
        var words = std.mem.splitScalar(u8, line, ' ');
        while (words.next()) |word| {
            const name = std.fs.path.basename(word);
            if (std.mem.eql(u8, name, "libc++.a")) libcxx = word;
            if (std.mem.eql(u8, name, "libc++abi.a")) libcxxabi = word;
        }
    }
    if (libcxx == null or libcxxabi == null) {
        std.debug.print("bundle-libcxx: no libc++.a and libc++abi.a in the probe's linker line:\n{s}\n", .{link});
        return error.LibcxxNotFound;
    }

    // ar q appends, so start from no file; L adds an archive's members instead of nesting the archive.
    std.Io.Dir.cwd().deleteFile(io, output) catch |err| switch (err) {
        error.FileNotFound => {},
        else => return err,
    };
    _ = try run(arena, io, &.{ zig, "ar", "qcsL", output, input, libcxx.?, libcxxabi.? });
}

/// Runs a command and returns its stderr; fails unless it exits with 0.
fn run(arena: std.mem.Allocator, io: std.Io, argv: []const []const u8) ![]const u8 {
    const result = try std.process.run(arena, io, .{ .argv = argv });
    if (result.term != .exited or result.term.exited != 0) {
        std.debug.print("bundle-libcxx: {s} failed:\n{s}\n", .{ argv[1], result.stderr });
        return error.CommandFailed;
    }
    return result.stderr;
}
