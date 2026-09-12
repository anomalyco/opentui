const std = @import("std");

pub fn matchesBenchFilter(bench_name: []const u8, filter: ?[]const u8) bool {
    if (filter == null) return true;
    const filter_str = filter.?;
    if (filter_str.len == 0) return true;

    var i: usize = 0;
    while (i + filter_str.len <= bench_name.len) : (i += 1) {
        var matches = true;
        for (filter_str, 0..) |filter_char, j| {
            const bench_char = bench_name[i + j];
            const filter_lower = if (filter_char >= 'A' and filter_char <= 'Z') filter_char + 32 else filter_char;
            const bench_lower = if (bench_char >= 'A' and bench_char <= 'Z') bench_char + 32 else bench_char;
            if (filter_lower != bench_lower) {
                matches = false;
                break;
            }
        }
        if (matches) return true;
    }
    return false;
}

pub const MemStat = struct {
    name: []const u8,
    bytes: usize,
};

pub const BenchResult = struct {
    name: []const u8,
    min_ns: u64,
    avg_ns: u64,
    max_ns: u64,
    total_ns: u64,
    iterations: usize,
    stddev_ns: ?f64 = null,
    rme_95: ?f64 = null,
    mem_stats: ?[]const MemStat,
};

/// Timing statistics collected during benchmark iterations
pub const BenchStats = struct {
    min_ns: u64 = std.math.maxInt(u64),
    max_ns: u64 = 0,
    total_ns: u64 = 0,
    count: usize = 0,
    mean_ns: f64 = 0,
    m2_ns: f64 = 0,

    pub fn record(self: *BenchStats, elapsed_ns: u64) void {
        self.min_ns = @min(self.min_ns, elapsed_ns);
        self.max_ns = @max(self.max_ns, elapsed_ns);
        self.total_ns += elapsed_ns;
        self.count += 1;
        const value: f64 = @floatFromInt(elapsed_ns);
        const delta = value - self.mean_ns;
        self.mean_ns += delta / @as(f64, @floatFromInt(self.count));
        self.m2_ns += delta * (value - self.mean_ns);
    }

    pub fn avg(self: *const BenchStats) u64 {
        if (self.count == 0) return 0;
        return self.total_ns / self.count;
    }

    pub fn standardDeviation(self: *const BenchStats) ?f64 {
        if (self.count < 2) return null;
        return @sqrt(self.m2_ns / @as(f64, @floatFromInt(self.count - 1)));
    }

    pub fn relativeMarginOfError95(self: *const BenchStats) ?f64 {
        const stddev = self.standardDeviation() orelse return null;
        if (self.mean_ns == 0) return null;
        const degrees_of_freedom = self.count - 1;
        const critical_values = [_]f64{
            0,     12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
            2.201, 2.179,  2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080,
            2.074, 2.069,  2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
        };
        const critical = if (degrees_of_freedom < critical_values.len) critical_values[degrees_of_freedom] else 1.96;
        const standard_error = stddev / @sqrt(@as(f64, @floatFromInt(self.count)));
        return critical * standard_error / self.mean_ns * 100;
    }
};

pub const BenchTimer = struct {
    io: std.Io,
    start_timestamp: std.Io.Timestamp,

    pub fn start(io: std.Io) BenchTimer {
        return .{
            .io = io,
            .start_timestamp = std.Io.Clock.awake.now(io),
        };
    }

    pub fn read(self: BenchTimer) u64 {
        const end_timestamp = std.Io.Clock.awake.now(self.io);
        const elapsed: std.Io.Duration = self.start_timestamp.durationTo(end_timestamp);
        return @intCast(elapsed.toNanoseconds());
    }
};

/// Helper for running benchmark iterations with timing
pub const BenchRunner = struct {
    io: std.Io,
    allocator: std.mem.Allocator,
    results: std.ArrayList(BenchResult),

    pub fn init(io: std.Io, allocator: std.mem.Allocator) BenchRunner {
        return .{
            .io = io,
            .allocator = allocator,
            .results = .empty,
        };
    }

    /// Add a benchmark result from collected stats
    pub fn addResult(
        self: *BenchRunner,
        name: []const u8,
        stats: BenchStats,
        mem_stats: ?[]const MemStat,
    ) !void {
        try self.results.append(self.allocator, .{
            .name = name,
            .min_ns = stats.min_ns,
            .avg_ns = stats.avg(),
            .max_ns = stats.max_ns,
            .total_ns = stats.total_ns,
            .iterations = stats.count,
            .stddev_ns = stats.standardDeviation(),
            .rme_95 = stats.relativeMarginOfError95(),
            .mem_stats = mem_stats,
        });
    }

    /// Convenience: run a simple benchmark with the given function
    pub fn bench(
        self: *BenchRunner,
        name: []const u8,
        iterations: usize,
        comptime benchFn: anytype,
        args: anytype,
    ) !void {
        var stats: BenchStats = .{};
        var iter: usize = 0;
        while (iter < iterations) : (iter += 1) {
            const timer = BenchTimer.start(self.io);
            @call(.auto, benchFn, args);
            stats.record(timer.read());
        }
        try self.addResult(name, stats, null);
    }

    /// Get the results slice (caller owns memory via arena)
    pub fn finish(self: *BenchRunner) ![]BenchResult {
        return self.results.toOwnedSlice(self.allocator);
    }

    /// Append results from another runner or slice
    pub fn appendSlice(self: *BenchRunner, other_results: []const BenchResult) !void {
        try self.results.appendSlice(self.allocator, other_results);
    }
};

/// Create a stdout writer with buffer for benchmark output
pub const StdoutWriter = struct {
    buffer: [4096]u8 = undefined,
    writer: std.Io.File.Writer = undefined,

    pub fn init(io: std.Io) StdoutWriter {
        var self: StdoutWriter = .{};
        self.writer = std.Io.File.stdout().writerStreaming(io, &self.buffer);
        return self;
    }

    pub fn interface(self: *StdoutWriter) *std.Io.Writer {
        return &self.writer.interface;
    }

    pub fn print(self: *StdoutWriter, comptime fmt: []const u8, args: anytype) !void {
        try self.writer.interface.print(fmt, args);
    }

    pub fn flush(self: *StdoutWriter) !void {
        try self.writer.interface.flush();
    }
};

pub fn formatDuration(ns: u64) struct { value: f64, unit: []const u8, color: []const u8 } {
    if (ns < 1_000) {
        // Bright green for nanoseconds
        return .{ .value = @as(f64, @floatFromInt(ns)), .unit = "ns", .color = "\x1b[92m" };
    } else if (ns < 1_000_000) {
        // Normal green for microseconds
        return .{ .value = @as(f64, @floatFromInt(ns)) / 1_000.0, .unit = "us", .color = "\x1b[32m" };
    } else if (ns < 1_000_000_000) {
        const ms = @as(f64, @floatFromInt(ns)) / 1_000_000.0;
        if (ms < 1.0) {
            // Normal green for < 1ms
            return .{ .value = ms, .unit = "ms", .color = "\x1b[32m" };
        } else if (ms < 3.0) {
            // Yellow to red gradient from 1ms to 3ms
            if (ms < 1.5) {
                return .{ .value = ms, .unit = "ms", .color = "\x1b[33m" }; // Yellow
            } else if (ms < 2.0) {
                return .{ .value = ms, .unit = "ms", .color = "\x1b[38;5;208m" }; // Orange
            } else if (ms < 2.5) {
                return .{ .value = ms, .unit = "ms", .color = "\x1b[38;5;202m" }; // Dark orange
            } else {
                return .{ .value = ms, .unit = "ms", .color = "\x1b[31m" }; // Red
            }
        } else {
            // Full red for >= 3ms
            return .{ .value = ms, .unit = "ms", .color = "\x1b[31m" };
        }
    } else {
        // Red for seconds
        return .{ .value = @as(f64, @floatFromInt(ns)) / 1_000_000_000.0, .unit = "s", .color = "\x1b[31m" };
    }
}

pub fn formatBytes(bytes: usize) struct { value: f64, unit: []const u8 } {
    if (bytes < 1024) {
        return .{ .value = @as(f64, @floatFromInt(bytes)), .unit = "B" };
    } else if (bytes < 1024 * 1024) {
        return .{ .value = @as(f64, @floatFromInt(bytes)) / 1024.0, .unit = "KiB" };
    } else {
        return .{ .value = @as(f64, @floatFromInt(bytes)) / (1024.0 * 1024.0), .unit = "MiB" };
    }
}

pub fn printResults(writer: anytype, results: []const BenchResult) !void {
    if (results.len == 0) return;

    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    // Collect all unique memory stat names
    var mem_stat_names: std.ArrayList([]const u8) = .empty;
    for (results) |result| {
        if (result.mem_stats) |stats| {
            for (stats) |stat| {
                // Check if we already have this name
                var found = false;
                for (mem_stat_names.items) |existing_name| {
                    if (std.mem.eql(u8, existing_name, stat.name)) {
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    try mem_stat_names.append(allocator, stat.name);
                }
            }
        }
    }

    // Calculate column widths
    var max_name_len: usize = 20; // minimum
    var min_col_width: usize = 3; // minimum for "Min"
    var avg_col_width: usize = 3; // minimum for "Avg"
    var max_col_width: usize = 3; // minimum for "Max"
    var rme_col_width: usize = 6; // minimum for "RME95%"

    // Create a map to store column widths for each memory stat
    var mem_col_widths: std.ArrayList(usize) = .empty;
    for (mem_stat_names.items) |name| {
        try mem_col_widths.append(allocator, name.len); // minimum is the name length
    }

    // First pass: calculate maximum widths
    for (results) |result| {
        if (result.name.len > max_name_len) {
            max_name_len = result.name.len;
        }

        const min = formatDuration(result.min_ns);
        const avg = formatDuration(result.avg_ns);
        const max = formatDuration(result.max_ns);
        var rme_buf: [32]u8 = undefined;
        const rme_str = if (result.rme_95) |rme|
            std.fmt.bufPrint(&rme_buf, "{d:.2}%", .{rme}) catch unreachable
        else
            "-";
        if (rme_str.len > rme_col_width) rme_col_width = rme_str.len;

        var min_buf: [32]u8 = undefined;
        const min_str = std.fmt.bufPrint(&min_buf, "{d:.2}{s}", .{ min.value, min.unit }) catch unreachable;
        if (min_str.len > min_col_width) min_col_width = min_str.len;

        var avg_buf: [32]u8 = undefined;
        const avg_str = std.fmt.bufPrint(&avg_buf, "{d:.2}{s}", .{ avg.value, avg.unit }) catch unreachable;
        if (avg_str.len > avg_col_width) avg_col_width = avg_str.len;

        var max_buf: [32]u8 = undefined;
        const max_str = std.fmt.bufPrint(&max_buf, "{d:.2}{s}", .{ max.value, max.unit }) catch unreachable;
        if (max_str.len > max_col_width) max_col_width = max_str.len;

        if (result.mem_stats) |stats| {
            for (stats) |stat| {
                const mem = formatBytes(stat.bytes);
                var mem_buf: [32]u8 = undefined;
                const mem_str = std.fmt.bufPrint(&mem_buf, "{d:.2} {s}", .{ mem.value, mem.unit }) catch unreachable;

                // Find the index of this stat name
                for (mem_stat_names.items, 0..) |name, i| {
                    if (std.mem.eql(u8, name, stat.name)) {
                        if (mem_str.len > mem_col_widths.items[i]) {
                            mem_col_widths.items[i] = mem_str.len;
                        }
                        break;
                    }
                }
            }
        }
    }

    // Print header
    var total_width = max_name_len + 3 + min_col_width + 3 + avg_col_width + 3 + max_col_width + 3 + rme_col_width;
    for (mem_col_widths.items) |width| {
        total_width += 3 + width;
    }
    try writer.writeAll("\x1b[2m");
    try writer.splatByteAll('-', total_width);
    try writer.writeAll("\x1b[0m\n");

    // Column headers
    try writer.writeAll("\x1b[36m");
    try writer.writeAll("Benchmark");
    try writer.splatByteAll(' ', max_name_len - 9);
    try writer.writeAll("\x1b[0m\x1b[2m | \x1b[0m");

    try writer.writeAll("\x1b[36m");
    try writer.writeAll("Min");
    try writer.splatByteAll(' ', min_col_width - 3);
    try writer.writeAll("\x1b[0m\x1b[2m | \x1b[0m");

    try writer.writeAll("\x1b[36m");
    try writer.writeAll("Avg");
    try writer.splatByteAll(' ', avg_col_width - 3);
    try writer.writeAll("\x1b[0m\x1b[2m | \x1b[0m");

    try writer.writeAll("\x1b[36m");
    try writer.writeAll("Max");
    try writer.splatByteAll(' ', max_col_width - 3);
    try writer.writeAll("\x1b[0m\x1b[2m | \x1b[0m");

    try writer.writeAll("\x1b[36m");
    try writer.writeAll("RME95%");
    try writer.splatByteAll(' ', rme_col_width - 6);
    try writer.writeAll("\x1b[0m");

    // Dynamic memory stat headers
    for (mem_stat_names.items, 0..) |name, i| {
        try writer.writeAll("\x1b[2m | \x1b[0m");
        try writer.writeAll("\x1b[36m");
        try writer.writeAll(name);
        if (name.len < mem_col_widths.items[i]) {
            try writer.splatByteAll(' ', mem_col_widths.items[i] - name.len);
        }
        try writer.writeAll("\x1b[0m");
    }

    try writer.writeByte('\n');

    try writer.writeAll("\x1b[2m");
    try writer.splatByteAll('-', total_width);
    try writer.writeAll("\x1b[0m\n");

    // Print each result
    for (results, 0..) |result, row_idx| {
        const min = formatDuration(result.min_ns);
        const avg = formatDuration(result.avg_ns);
        const max = formatDuration(result.max_ns);
        var rme_buf: [32]u8 = undefined;
        const rme_str = if (result.rme_95) |rme| try std.fmt.bufPrint(&rme_buf, "{d:.2}%", .{rme}) else "-";

        // Format duration strings
        var min_buf: [32]u8 = undefined;
        const min_str = try std.fmt.bufPrint(&min_buf, "{d:.2}{s}", .{ min.value, min.unit });

        var avg_buf: [32]u8 = undefined;
        const avg_str = try std.fmt.bufPrint(&avg_buf, "{d:.2}{s}", .{ avg.value, avg.unit });

        var max_buf: [32]u8 = undefined;
        const max_str = try std.fmt.bufPrint(&max_buf, "{d:.2}{s}", .{ max.value, max.unit });

        if (row_idx % 2 == 1) {
            try writer.writeAll("\x1b[48;5;234m");
        }

        // Benchmark name
        try writer.writeAll(result.name);
        try writer.splatByteAll(' ', max_name_len - result.name.len);
        try writer.writeAll("\x1b[2m | \x1b[0m");
        if (row_idx % 2 == 1) {
            try writer.writeAll("\x1b[48;5;234m");
        }

        // Min (right-aligned with color)
        if (min_str.len < min_col_width) {
            try writer.splatByteAll(' ', min_col_width - min_str.len);
        }
        try writer.writeAll(min.color);
        try writer.writeAll(min_str);
        try writer.writeAll("\x1b[0m");
        try writer.writeAll("\x1b[2m | \x1b[0m");
        if (row_idx % 2 == 1) {
            try writer.writeAll("\x1b[48;5;234m");
        }

        // Avg (right-aligned with color)
        if (avg_str.len < avg_col_width) {
            try writer.splatByteAll(' ', avg_col_width - avg_str.len);
        }
        try writer.writeAll(avg.color);
        try writer.writeAll(avg_str);
        try writer.writeAll("\x1b[0m");
        try writer.writeAll("\x1b[2m | \x1b[0m");
        if (row_idx % 2 == 1) {
            try writer.writeAll("\x1b[48;5;234m");
        }

        // Max (right-aligned with color)
        if (max_str.len < max_col_width) {
            try writer.splatByteAll(' ', max_col_width - max_str.len);
        }
        try writer.writeAll(max.color);
        try writer.writeAll(max_str);
        try writer.writeAll("\x1b[0m");

        try writer.writeAll("\x1b[2m | \x1b[0m");
        if (row_idx % 2 == 1) {
            try writer.writeAll("\x1b[48;5;234m");
        }
        if (rme_str.len < rme_col_width) {
            try writer.splatByteAll(' ', rme_col_width - rme_str.len);
        }
        try writer.writeAll(rme_str);

        // Dynamic memory stats columns
        for (mem_stat_names.items, 0..) |stat_name, i| {
            try writer.writeAll("\x1b[2m | \x1b[0m");
            if (row_idx % 2 == 1) {
                try writer.writeAll("\x1b[48;5;234m");
            }

            // Look for this stat in the result's memory stats
            var found_stat: ?usize = null;
            if (result.mem_stats) |stats| {
                for (stats) |stat| {
                    if (std.mem.eql(u8, stat.name, stat_name)) {
                        found_stat = stat.bytes;
                        break;
                    }
                }
            }

            if (found_stat) |bytes| {
                const mem = formatBytes(bytes);
                var mem_buf: [32]u8 = undefined;
                const mem_str = std.fmt.bufPrint(&mem_buf, "{d:.2} {s}", .{ mem.value, mem.unit }) catch unreachable;

                // Right-aligned
                if (mem_str.len < mem_col_widths.items[i]) {
                    try writer.splatByteAll(' ', mem_col_widths.items[i] - mem_str.len);
                }
                try writer.writeAll(mem_str);
            } else {
                // Empty column
                try writer.splatByteAll(' ', mem_col_widths.items[i]);
            }
        }

        if (row_idx % 2 == 1) {
            try writer.writeAll("\x1b[0m");
        }
        try writer.writeByte('\n');
    }

    try writer.writeAll("\x1b[2m");
    try writer.splatByteAll('-', total_width);
    try writer.writeAll("\x1b[0m\n");
    try writer.flush();
}

const BenchResultsJson = struct {
    benchmark: []const u8,
    results: []const BenchResult,
};

pub fn printResultsJson(writer: anytype, results: []const BenchResult, bench_name: []const u8) !void {
    const output: BenchResultsJson = .{
        .benchmark = bench_name,
        .results = results,
    };
    try std.json.Stringify.value(output, .{ .emit_null_optional_fields = false }, writer);
    try writer.writeByte('\n');
}
