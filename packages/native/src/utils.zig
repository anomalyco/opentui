const std = @import("std");

// Prevent constant-zero specialization back to Zig's byte-store memset.
pub noinline fn fillU32(destination: []u32, value: u32) void {
    const lanes = std.simd.suggestVectorLength(u32) orelse 1;
    const repeated: @Vector(lanes, u32) = @splat(value);
    var index: usize = 0;
    while (destination.len - index >= lanes) : (index += lanes) {
        destination[index..][0..lanes].* = repeated;
    }
    @memset(destination[index..], value);
}

test "fillU32 preserves unaligned prefixes and tails" {
    var actual: [129]u32 = undefined;
    var expected: [129]u32 = undefined;
    for ([_]u32{ 0, 32, 0x12345678, 0xffffffff }) |value| {
        for (0..16) |start| {
            for (start..actual.len + 1) |end| {
                @memset(&actual, 0xaabbccdd);
                @memset(&expected, 0xaabbccdd);
                @memset(expected[start..end], value);
                fillU32(actual[start..end], value);
                try std.testing.expectEqualSlices(u32, &expected, &actual);
            }
        }
    }
}
