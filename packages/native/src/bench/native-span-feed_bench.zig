const std = @import("std");
const raw = @import("../native-span-feed.zig");

fn streamErrorToStatus(err: raw.StreamError) i32 {
    return switch (err) {
        raw.StreamError.NoSpace => raw.Status.err_no_space,
        raw.StreamError.MaxBytes => raw.Status.err_max_bytes,
        raw.StreamError.Invalid => raw.Status.err_invalid,
        raw.StreamError.OutOfMemory => raw.Status.err_alloc,
        raw.StreamError.Busy => raw.Status.err_busy,
    };
}

/// Zero-copy benchmark producer (reserve/commit).
pub export fn benchProduce(
    stream: ?*raw.Stream,
    total_bytes: u64,
    pattern_ptr: ?*const u8,
    pattern_len: usize,
    commit_every: u32,
) callconv(.c) i32 {
    if (stream == null) return raw.Status.err_invalid;
    if (total_bytes == 0) return raw.Status.ok;
    const s = stream.?;

    var pattern_slice: []const u8 = raw.default_pattern;
    if (pattern_ptr != null and pattern_len > 0) {
        pattern_slice = @as([*]const u8, @ptrCast(pattern_ptr.?))[0..pattern_len];
    }
    if (pattern_slice.len == 0) return raw.Status.err_invalid;

    var remaining: u64 = total_bytes;
    var reserve_info: raw.ReserveInfo = undefined;

    while (remaining > 0) {
        const remaining_usize = if (remaining > std.math.maxInt(usize))
            std.math.maxInt(usize)
        else
            @as(usize, @intCast(remaining));

        reserve_info = s.reserve(1) catch |err| return streamErrorToStatus(err);

        const available: usize = @intCast(reserve_info.len);
        const to_write = @min(available, remaining_usize);

        const dest = @as([*]u8, @ptrFromInt(reserve_info.ptr))[0..to_write];
        var dest_index: usize = 0;
        while (dest_index < to_write) {
            const copy_len = @min(pattern_slice.len, to_write - dest_index);
            @memcpy(dest[dest_index .. dest_index + copy_len], pattern_slice[0..copy_len]);
            dest_index += copy_len;
        }

        s.commitReserved(@intCast(to_write)) catch |err| return streamErrorToStatus(err);

        remaining -= @as(u64, to_write);
    }

    _ = commit_every;
    return raw.Status.ok;
}

/// Copy benchmark producer (streamWrite).
pub export fn benchProduceWrite(
    stream: ?*raw.Stream,
    total_bytes: u64,
    pattern_ptr: ?*const u8,
    pattern_len: usize,
    commit_every: u32,
) callconv(.c) i32 {
    if (stream == null) return raw.Status.err_invalid;
    if (total_bytes == 0) return raw.Status.ok;
    const s = stream.?;

    var pattern_slice: []const u8 = raw.default_pattern;
    if (pattern_ptr != null and pattern_len > 0) {
        pattern_slice = @as([*]const u8, @ptrCast(pattern_ptr.?))[0..pattern_len];
    }
    if (pattern_slice.len == 0) return raw.Status.err_invalid;

    var remaining: u64 = total_bytes;
    var bytes_since_commit: u64 = 0;

    while (remaining > 0) {
        const remaining_usize = if (remaining > std.math.maxInt(usize))
            std.math.maxInt(usize)
        else
            @as(usize, @intCast(remaining));

        const to_write = @min(pattern_slice.len, remaining_usize);
        s.write(pattern_slice[0..to_write]) catch |err| return streamErrorToStatus(err);

        bytes_since_commit += @as(u64, to_write);
        remaining -= @as(u64, to_write);

        if (commit_every != 0 and bytes_since_commit >= commit_every) {
            s.commit() catch |err| return streamErrorToStatus(err);
            bytes_since_commit = 0;
        }
    }

    if (commit_every != 0 and bytes_since_commit > 0) {
        s.commit() catch |err| return streamErrorToStatus(err);
    }

    return raw.Status.ok;
}
