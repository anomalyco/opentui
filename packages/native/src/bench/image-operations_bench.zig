const std = @import("std");
const bench_utils = @import("../bench-utils.zig");
const image = @import("../image.zig");

pub const benchName = "Image Operations";

const EncodedScenario = struct {
    label: []const u8,
    path: []const u8,
};

const encoded_scenarios = [_]EncodedScenario{
    .{ .label = "PNG", .path = "../examples/src/assets/image-demo.png" },
    .{ .label = "JPEG", .path = "../examples/src/assets/dragon.jpg" },
    .{ .label = "WebP", .path = "../examples/src/assets/image-demo.webp" },
    .{ .label = "GIF", .path = "../examples/src/assets/image-demo.gif" },
};

fn appendResult(
    allocator: std.mem.Allocator,
    results: *std.ArrayListUnmanaged(bench_utils.BenchResult),
    name: []const u8,
    stats: bench_utils.BenchStats,
    mem_stats: ?[]const bench_utils.MemStat,
) !void {
    try results.append(allocator, .{
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

fn runEncodedScenarios(
    io: std.Io,
    allocator: std.mem.Allocator,
    work_allocator: std.mem.Allocator,
    results: *std.ArrayListUnmanaged(bench_utils.BenchResult),
    show_mem: bool,
    bench_filter: ?[]const u8,
) !void {
    for (encoded_scenarios) |scenario| {
        const probe_name = try std.fmt.allocPrint(allocator, "{s} probe", .{scenario.label});
        const inspect_name = try std.fmt.allocPrint(allocator, "{s} inspect", .{scenario.label});
        const decode_name = try std.fmt.allocPrint(allocator, "{s} decode", .{scenario.label});
        const run_probe = bench_utils.matchesBenchFilter(probe_name, bench_filter);
        const run_inspect = bench_utils.matchesBenchFilter(inspect_name, bench_filter);
        const run_decode = bench_utils.matchesBenchFilter(decode_name, bench_filter);
        if (!run_probe and !run_inspect and !run_decode) continue;

        const encoded = try std.Io.Dir.cwd().readFileAlloc(io, scenario.path, work_allocator, .limited(2 * 1024 * 1024));
        defer work_allocator.free(encoded);

        if (run_probe) {
            var info: image.Info = .{};
            for (0..5) |_| if (image.probe(encoded, .{}, &info) != .ok) return error.ImageProbeFailed;
            const batch_size: usize = if (std.mem.eql(u8, scenario.label, "WebP"))
                1000
            else if (std.mem.eql(u8, scenario.label, "GIF"))
                100
            else if (std.mem.eql(u8, scenario.label, "PNG"))
                5
            else
                1;
            var stats: bench_utils.BenchStats = .{};
            var checksum: u64 = 0;
            for (0..30) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                for (0..batch_size) |_| {
                    const status = image.probe(encoded, .{}, &info);
                    if (status != .ok) return error.ImageProbeFailed;
                    checksum +%= info.width + info.height + info.format;
                }
                stats.record(timer.read() / batch_size);
            }
            if (checksum == 0) return error.InvalidImageBenchmark;
            try appendResult(allocator, results, probe_name, stats, null);
        }

        if (run_inspect) {
            var info: image.Info = .{};
            for (0..3) |_| if (image.inspect(work_allocator, encoded, .{}, &info) != .ok) return error.ImageInspectFailed;
            var stats: bench_utils.BenchStats = .{};
            var checksum: u64 = 0;
            for (0..20) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                const status = image.inspect(work_allocator, encoded, .{}, &info);
                stats.record(timer.read());
                if (status != .ok) return error.ImageInspectFailed;
                checksum +%= info.width + info.height + info.has_alpha;
            }
            if (checksum == 0) return error.InvalidImageBenchmark;
            try appendResult(allocator, results, inspect_name, stats, null);
        }

        if (run_decode) {
            for (0..3) |_| {
                const decoded = try image.decode(work_allocator, encoded, .{});
                decoded.deinit();
            }
            var stats: bench_utils.BenchStats = .{};
            var checksum: u64 = 0;
            for (0..20) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                const decoded = try image.decode(work_allocator, encoded, .{});
                stats.record(timer.read());
                checksum +%= decoded.width() + decoded.height() + decoded.pixels.len;
                decoded.deinit();
            }
            if (checksum == 0) return error.InvalidImageBenchmark;
            const mem_stats: ?[]const bench_utils.MemStat = if (show_mem) blk: {
                const values = try allocator.alloc(bench_utils.MemStat, 1);
                const decoded = try image.decode(work_allocator, encoded, .{});
                defer decoded.deinit();
                const encoded_bytes = if (decoded.encoded_png) |png| png.len else 0;
                values[0] = .{ .name = "Image data", .bytes = decoded.pixels.len + encoded_bytes };
                break :blk values;
            } else null;
            try appendResult(allocator, results, decode_name, stats, mem_stats);
        }
    }
}

fn runIccReuseScenarios(
    io: std.Io,
    allocator: std.mem.Allocator,
    work_allocator: std.mem.Allocator,
    results: *std.ArrayListUnmanaged(bench_utils.BenchResult),
    bench_filter: ?[]const u8,
) !void {
    const names = [_][]const u8{
        "ICC repeated profile validation",
        "ICC repeated profile materialization",
    };
    if (!bench_utils.matchesBenchFilter(names[0], bench_filter) and
        !bench_utils.matchesBenchFilter(names[1], bench_filter)) return;

    const encoded = std.mem.trim(u8, @embedFile("../tests/fixtures/display-p3.png.base64"), "\r\n");
    const png_len = try std.base64.standard.Decoder.calcSizeForSlice(encoded);
    const png = try work_allocator.alloc(u8, png_len);
    defer work_allocator.free(png);
    try std.base64.standard.Decoder.decode(png, encoded);

    defer image.clearIccCache();
    for (names, 0..) |name, scenario| {
        if (!bench_utils.matchesBenchFilter(name, bench_filter)) continue;
        image.clearIccCache();
        for (0..3) |_| {
            const decoded = try image.decode(work_allocator, png, .{});
            if (scenario == 1) _ = try decoded.ensurePixels();
            decoded.deinit();
        }
        var stats: bench_utils.BenchStats = .{};
        var checksum: u64 = 0;
        for (0..30) |_| {
            const timer = bench_utils.BenchTimer.start(io);
            const decoded = try image.decode(work_allocator, png, .{});
            if (scenario == 1) _ = try decoded.ensurePixels();
            stats.record(timer.read());
            checksum +%= decoded.width() + decoded.height() + decoded.pixels.len;
            decoded.deinit();
        }
        if (checksum == 0) return error.InvalidImageBenchmark;
        try appendResult(allocator, results, name, stats, null);
    }
}

fn makeImage(allocator: std.mem.Allocator, width: u32, height: u32, seed: u8) !*image.Image {
    const pixels = try allocator.alloc(u8, @as(usize, width) * height * 4);
    defer allocator.free(pixels);
    for (0..@as(usize, width) * height) |index| {
        pixels[index * 4] = @truncate(index + seed);
        pixels[index * 4 + 1] = @truncate(index * 3 + seed);
        pixels[index * 4 + 2] = @truncate(index * 7 + seed);
        pixels[index * 4 + 3] = @truncate(64 + (index + seed) % 192);
    }
    return image.createFromRgba(allocator, pixels, width, height, width * 4);
}

fn runTransformScenarios(
    io: std.Io,
    allocator: std.mem.Allocator,
    work_allocator: std.mem.Allocator,
    results: *std.ArrayListUnmanaged(bench_utils.BenchResult),
    bench_filter: ?[]const u8,
) !void {
    const names = [_][]const u8{
        "512x512 rotate 90",
        "512x512 extend",
        "512x512 copy RGBA",
        "512x512 copy BGRA",
        "512x512 source-over composite",
    };
    var run_any = false;
    for (names) |name| run_any = run_any or bench_utils.matchesBenchFilter(name, bench_filter);
    if (!run_any) return;

    const base = try makeImage(work_allocator, 512, 512, 11);
    defer base.deinit();
    const overlay = try makeImage(work_allocator, 512, 512, 37);
    defer overlay.deinit();

    if (bench_utils.matchesBenchFilter(names[0], bench_filter)) {
        for (0..3) |_| {
            const output = try image.transform(work_allocator, base, .rotate_90);
            output.deinit();
        }
        var stats: bench_utils.BenchStats = .{};
        var checksum: u64 = 0;
        for (0..20) |_| {
            const timer = bench_utils.BenchTimer.start(io);
            const output = try image.transform(work_allocator, base, .rotate_90);
            stats.record(timer.read());
            checksum +%= output.width() + output.height() + output.pixels[0];
            output.deinit();
        }
        if (checksum == 0) return error.InvalidImageBenchmark;
        try appendResult(allocator, results, names[0], stats, null);
    }

    if (bench_utils.matchesBenchFilter(names[1], bench_filter)) {
        for (0..3) |_| {
            const output = try image.extend(work_allocator, base, 16, 16, 16, 16, .{ 8, 16, 24, 128 });
            output.deinit();
        }
        var stats: bench_utils.BenchStats = .{};
        var checksum: u64 = 0;
        for (0..20) |_| {
            const timer = bench_utils.BenchTimer.start(io);
            const output = try image.extend(work_allocator, base, 16, 16, 16, 16, .{ 8, 16, 24, 128 });
            stats.record(timer.read());
            checksum +%= output.width() + output.height() + output.pixels[3];
            output.deinit();
        }
        if (checksum == 0) return error.InvalidImageBenchmark;
        try appendResult(allocator, results, names[1], stats, null);
    }

    const destination = try work_allocator.alloc(u8, base.pixels.len);
    defer work_allocator.free(destination);
    for ([_]struct { name: []const u8, bgra: bool }{
        .{ .name = names[2], .bgra = false },
        .{ .name = names[3], .bgra = true },
    }) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        for (0..5) |_| if (image.copyPixels(base, destination, base.width() * 4, scenario.bgra) != .ok) return error.ImageCopyFailed;
        const batch_size: usize = if (scenario.bgra) 5 else 10;
        var stats: bench_utils.BenchStats = .{};
        var checksum: u64 = 0;
        for (0..50) |_| {
            const timer = bench_utils.BenchTimer.start(io);
            for (0..batch_size) |_| {
                const status = image.copyPixels(base, destination, base.width() * 4, scenario.bgra);
                if (status != .ok) return error.ImageCopyFailed;
                checksum +%= destination[0] + destination[destination.len - 1];
            }
            stats.record(timer.read() / batch_size);
        }
        if (checksum == 0) return error.InvalidImageBenchmark;
        try appendResult(allocator, results, scenario.name, stats, null);
    }

    if (bench_utils.matchesBenchFilter(names[4], bench_filter)) {
        for (0..2) |_| {
            const output = try image.composite(work_allocator, base, overlay, 0, 0, .source_over, 192);
            output.deinit();
        }
        var stats: bench_utils.BenchStats = .{};
        var checksum: u64 = 0;
        for (0..20) |_| {
            const timer = bench_utils.BenchTimer.start(io);
            const output = try image.composite(work_allocator, base, overlay, 0, 0, .source_over, 192);
            stats.record(timer.read());
            checksum +%= output.pixels[0] + output.pixels[output.pixels.len - 1];
            output.deinit();
        }
        if (checksum == 0) return error.InvalidImageBenchmark;
        try appendResult(allocator, results, names[4], stats, null);
    }
}

pub fn run(io: std.Io, allocator: std.mem.Allocator, show_mem: bool, bench_filter: ?[]const u8) ![]bench_utils.BenchResult {
    var results: std.ArrayListUnmanaged(bench_utils.BenchResult) = .empty;
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const work_allocator = gpa.allocator();

    try runEncodedScenarios(io, allocator, work_allocator, &results, show_mem, bench_filter);
    try runIccReuseScenarios(io, allocator, work_allocator, &results, bench_filter);
    try runTransformScenarios(io, allocator, work_allocator, &results, bench_filter);
    return results.toOwnedSlice(allocator);
}
