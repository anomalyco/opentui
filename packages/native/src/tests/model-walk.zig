const std = @import("std");

/// Each replay starts at the same initial state and returns a distinct error per invariant.
/// The alphabet is a dense zero-based enum. Checking each step covers shorter prefixes too.
pub fn explore(comptime Event: type, fixture: anytype, comptime replay: anytype, comptime depth: usize, comptime seeds: usize, comptime steps: usize) !void {
    const alphabet = @typeInfo(Event).@"enum".field_names.len;
    var trace: [steps]Event = undefined;
    comptime {
        std.debug.assert(depth > 0 and depth <= steps);
        for (@typeInfo(Event).@"enum".field_values, 0..) |value, i| std.debug.assert(value == i);
    }
    for (0..seeds) |seed| {
        var rng = std.Random.DefaultPrng.init(seed);
        for (&trace) |*item| item.* = rng.random().enumValue(Event);
        try check(Event, fixture, replay, &trace, steps, seed);
    }
    for (0..std.math.pow(usize, alphabet, depth)) |word| {
        var n = word;
        for (trace[0..depth]) |*item| {
            item.* = @fromBackingInt(@intCast(n % alphabet));
            n /= alphabet;
        }
        try check(Event, fixture, replay, &trace, depth, word);
    }
}

fn check(comptime Event: type, fixture: anytype, comptime replay: anytype, trace: anytype, length: usize, case: usize) !void {
    replay(fixture, trace[0..length]) catch |first| {
        // Delete chunks down to single events; never substitute another failing check.
        var len = length;
        var candidate: [trace.len]Event = undefined;
        var chunk = @max(len / 2, 1);
        while (chunk > 0) : (chunk /= 2) {
            var i: usize = 0;
            while (i + chunk <= len) {
                const next_len = len - chunk;
                @memcpy(candidate[0..i], trace[0..i]);
                @memcpy(candidate[i..next_len], trace[i + chunk .. len]);
                replay(fixture, candidate[0..next_len]) catch |other| {
                    if (other == first) {
                        @memcpy(trace[0..next_len], candidate[0..next_len]);
                        len = next_len;
                        i = 0;
                        continue;
                    }
                };
                i += 1;
            }
        }
        std.debug.print("{s} case {d} ({d} events): {t} after", .{ @typeName(Event), case, length, first });
        for (trace[0..len]) |event| std.debug.print(" {t}", .{event});
        std.debug.print("\n", .{});
        return first;
    };
}
