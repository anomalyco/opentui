const std = @import("std");

/// `items` repeated `count` times, as `items ** count` gave before Zig 0.17
/// removed array multiplication. The result is comptime-known.
pub inline fn repeat(comptime T: type, comptime items: []const T, comptime count: usize) *const [items.len * count]T {
    comptime {
        const parts: [count][items.len]T = @splat(items[0..items.len].*);
        const flat: [items.len * count]T = @bitCast(parts);
        return &flat;
    }
}

test "repeat concatenates copies in order" {
    try std.testing.expectEqualStrings("abab", repeat(u8, "ab", 2));
    try std.testing.expectEqualStrings("e\u{301}\u{301}B", "e" ++ repeat(u8, "\u{301}", 2) ++ "B");
    try std.testing.expectEqualSlices(f32, &.{ 0.25, -0.5, 0.25, -0.5 }, repeat(f32, &.{ 0.25, -0.5 }, 2));
    try std.testing.expectEqual(0, repeat(u8, "x", 0).len);
}

/// `@intCast(value)` for a signed `value` and an unsigned `T` narrower than it.
/// Zig 0.17.0 lowers that cast to LLVM's `trunc nsw`, which leaves a result in
/// the top half of `T` undefined (ziglang/zig#37127). Casting to the unsigned
/// type of `value`'s width first lowers to `trunc nuw`.
pub inline fn unsigned(comptime T: type, value: anytype) T {
    comptime std.debug.assert(@typeInfo(T).int.signedness == .unsigned);
    const Same = @Int(.unsigned, @typeInfo(@TypeOf(value)).int.bits);
    return @intCast(@as(Same, @intCast(value)));
}

noinline fn pastHalf(offset: i64) bool {
    return unsigned(u32, offset) > std.math.maxInt(i32);
}

test "unsigned narrows into the top half of an unsigned type" {
    var offsets = [_]i64{ std.math.maxInt(i32), std.math.maxInt(i32) + 1 };
    std.mem.doNotOptimizeAway(&offsets);
    try std.testing.expect(!pastHalf(offsets[0]));
    try std.testing.expect(pastHalf(offsets[1]));
}

/// `@max(value, 0)` for a signed `value`, in the type of `value`. Zig narrows
/// `@max(value, 0)` to an unsigned type, and Zig 0.17.0 leaves a result in the
/// top half of that type undefined (ziglang/zig#37127).
pub inline fn nonNegative(value: anytype) @TypeOf(value) {
    return if (value < 0) 0 else value;
}

noinline fn columnPastHalf(x: i32) bool {
    return nonNegative(x) >= 1 << 30;
}

test "nonNegative keeps a value in the top half of the narrowed type" {
    var columns = [_]i32{ std.math.minInt(i32), (1 << 30) + 5 };
    std.mem.doNotOptimizeAway(&columns);
    try std.testing.expect(!columnPastHalf(columns[0]));
    try std.testing.expect(columnPastHalf(columns[1]));
}

/// `std.mem.eql` for slices of integers. Zig 0.17.0's LLVM backend splits the
/// array `@bitCast` that `std.mem.eql` loads each chunk with into single bytes
/// (ziglang/zig#37120), which makes a large comparison about 90 times slower.
/// Coercing an array to a vector loads it at once.
pub fn eql(comptime T: type, a: []const T, b: []const T) bool {
    comptime std.debug.assert(@typeInfo(T) == .int);
    const left = std.mem.sliceAsBytes(a);
    const right = std.mem.sliceAsBytes(b);
    if (left.len != right.len) return false;
    const lanes = comptime std.simd.suggestVectorLength(u8) orelse @sizeOf(usize);
    const Chunk = @Vector(lanes, u8);
    var index: usize = 0;
    while (left.len - index >= lanes) : (index += lanes) {
        const left_chunk: Chunk = left[index..][0..lanes].*;
        const right_chunk: Chunk = right[index..][0..lanes].*;
        if (@reduce(.Or, left_chunk != right_chunk)) return false;
    }
    return std.mem.eql(u8, left[index..], right[index..]);
}

test "eql agrees with std.mem.eql at every length and difference" {
    var a: [300]u32 = undefined;
    var b: [300]u32 = undefined;
    for (&a, 0..) |*value, index| value.* = @intCast(index * 2654435761 % 4093);
    for (0..a.len + 1) |len| {
        b = a;
        try std.testing.expect(eql(u32, a[0..len], b[0..len]));
        for (0..len) |index| {
            b[index] ^= 1 << 17;
            try std.testing.expectEqual(std.mem.eql(u32, a[0..len], b[0..len]), eql(u32, a[0..len], b[0..len]));
            b[index] = a[index];
        }
        if (len > 0) try std.testing.expect(!eql(u32, a[0..len], b[0 .. len - 1]));
    }
}

/// `std.base64.standard.Encoder.encode`. That encoder reads 16 bytes at a time
/// through `std.mem.readInt`, whose array `@bitCast` Zig 0.17.0's LLVM backend
/// splits into single bytes (ziglang/zig#37120). This reads them in one load.
pub fn base64Encode(dest: []u8, source: []const u8) []const u8 {
    const encoder = std.base64.standard.Encoder;
    std.debug.assert(dest.len >= encoder.calcSize(source.len));
    var index: usize = 0;
    var out_index: usize = 0;
    while (index + 15 < source.len) : (index += 12) {
        const bits = std.mem.bigToNative(u128, std.mem.bytesToValue(u128, source[index..][0..16]));
        inline for (0..16) |i| {
            dest[out_index + i] = encoder.alphabet_chars[@as(u6, @truncate(bits >> (122 - i * 6)))];
        }
        out_index += 16;
    }
    // The rest is shorter than one block, and 12 source bytes encode on their own.
    const rest = encoder.encode(dest[out_index..], source[index..]);
    return dest[0 .. out_index + rest.len];
}

test "base64Encode matches the standard encoder at every length" {
    var source: [100]u8 = undefined;
    for (&source, 0..) |*byte, index| byte.* = @truncate(index *% 151 +% 7);
    var expected: [136]u8 = undefined;
    var actual: [136]u8 = undefined;
    for (0..source.len + 1) |len| {
        try std.testing.expectEqualStrings(
            std.base64.standard.Encoder.encode(&expected, source[0..len]),
            base64Encode(&actual, source[0..len]),
        );
    }
}

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
