const lib = @import("lib.zig");
const bench = @import("bench/native-span-feed_bench.zig");

pub const io = lib.io;

comptime {
    _ = lib;
    _ = bench;
}
