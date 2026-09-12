const std = @import("std");
const bench_utils = @import("../bench-utils.zig");
const ansi = @import("../ansi.zig");
const buffer = @import("../buffer.zig");
const gp = @import("../grapheme.zig");
const image = @import("../image.zig");
const terminal_image = @import("../terminal-image.zig");

pub const benchName = "Terminal Image";

const Scenario = struct {
    name: []const u8,
    width: u32,
    height: u32,
    colors: usize = 255,
    pattern: enum { flat, gradient, baseline, photo, noise, transparent },
};

const scenarios = [_]Scenario{
    .{ .name = "Sixel 160x240 flat", .width = 160, .height = 240, .pattern = .flat },
    .{ .name = "Sixel 160x240 gradient", .width = 160, .height = 240, .pattern = .gradient },
    .{ .name = "Sixel 160x240 original baseline", .width = 160, .height = 240, .pattern = .baseline },
    .{ .name = "Sixel 160x240 original baseline 128 colors", .width = 160, .height = 240, .colors = 128, .pattern = .baseline },
    .{ .name = "Sixel 160x240 original baseline 64 colors", .width = 160, .height = 240, .colors = 64, .pattern = .baseline },
    .{ .name = "Sixel 160x240 photo-like", .width = 160, .height = 240, .pattern = .photo },
    .{ .name = "Sixel 160x240 noise", .width = 160, .height = 240, .pattern = .noise },
    .{ .name = "Sixel 160x240 transparent", .width = 160, .height = 240, .pattern = .transparent },
    .{ .name = "Sixel 320x480 photo-like", .width = 320, .height = 480, .pattern = .photo },
};

fn writeScenario(allocator: std.mem.Allocator, writer: anytype, value: *image.Image, colors: usize) !void {
    if (colors == 255) return terminal_image.writeSixelPayload(allocator, writer, value);
    var quantized = try terminal_image.quantizeSixel(allocator, value, colors);
    defer quantized.deinit();
    try terminal_image.writeSixelIndexedPayload(allocator, writer, quantized.indices, quantized.palette[0..quantized.palette_len], value.width(), value.height());
}

const CountingWriter = struct {
    bytes: usize = 0,

    pub fn writeAll(self: *CountingWriter, value: []const u8) !void {
        self.bytes += value.len;
    }

    pub fn writeByte(self: *CountingWriter, value: u8) !void {
        _ = value;
        self.bytes += 1;
    }

    pub fn print(self: *CountingWriter, comptime format: []const u8, args: anytype) !void {
        self.bytes += std.fmt.count(format, args);
    }
};

fn fillPixels(pixels: []u8, scenario: Scenario) void {
    var random = std.Random.DefaultPrng.init(0x1234_5678_9abc_def0);
    for (0..@as(usize, scenario.width) * scenario.height) |index| {
        const x = index % scenario.width;
        const y = index / scenario.width;
        const offset = index * 4;
        const rgba: [4]u8 = switch (scenario.pattern) {
            .flat => .{ 48, 112, 192, 255 },
            .gradient => .{
                @intCast(x * 255 / (scenario.width - 1)),
                @intCast(y * 255 / (scenario.height - 1)),
                @intCast((x + y) * 255 / (scenario.width + scenario.height - 2)),
                255,
            },
            .baseline => .{
                @truncate(x * 13 + y * 3),
                @truncate(x * 5 + y * 11),
                @truncate(x * 7 + y * 17),
                255,
            },
            .photo => .{
                @truncate(x * 13 + y * 3 + (x * y) / 17),
                @truncate(x * 5 + y * 11 + (x * y) / 29),
                @truncate(x * 7 + y * 17 + (x * y) / 41),
                255,
            },
            .noise => .{ random.random().int(u8), random.random().int(u8), random.random().int(u8), 255 },
            .transparent => .{
                @truncate(x * 13 + y * 3),
                @truncate(x * 5 + y * 11),
                @truncate(x * 7 + y * 17),
                if ((x + y) % 4 == 0) 255 else 0,
            },
        };
        @memcpy(pixels[offset..][0..4], &rgba);
    }
}

fn appendDragonGeometryBenchmarks(
    io: std.Io,
    allocator: std.mem.Allocator,
    results: *std.ArrayListUnmanaged(bench_utils.BenchResult),
    show_mem: bool,
    bench_filter: ?[]const u8,
) !void {
    const names = [_][]const u8{
        "Sixel dragon fit 200x300",
        "Sixel dragon cover 300x300",
        "Sixel dragon cover 300x300 128 colors",
        "Sixel dragon cover 300x300 64 colors",
    };
    var run_any = false;
    for (names) |name| run_any = run_any or bench_utils.matchesBenchFilter(name, bench_filter);
    if (!run_any) return;
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const work_allocator = gpa.allocator();
    const encoded = try std.Io.Dir.cwd().readFileAlloc(io, "../examples/src/assets/image-demo.gif", work_allocator, .limited(2 * 1024 * 1024));
    defer work_allocator.free(encoded);
    const decoded = try image.decode(work_allocator, encoded, .{});
    defer decoded.deinit();
    const geometries = [_]struct { x: u32, y: u32, width: u32, height: u32, output_width: u32, output_height: u32, colors: usize }{
        .{ .x = 0, .y = 0, .width = 256, .height = 384, .output_width = 200, .output_height = 300, .colors = 255 },
        .{ .x = 0, .y = 64, .width = 256, .height = 256, .output_width = 300, .output_height = 300, .colors = 255 },
        .{ .x = 0, .y = 64, .width = 256, .height = 256, .output_width = 300, .output_height = 300, .colors = 128 },
        .{ .x = 0, .y = 64, .width = 256, .height = 256, .output_width = 300, .output_height = 300, .colors = 64 },
    };
    for (names, geometries) |name, geometry| {
        if (!bench_utils.matchesBenchFilter(name, bench_filter)) continue;
        var output: std.Io.Writer.Allocating = .init(work_allocator);
        defer output.deinit();
        var stats: bench_utils.BenchStats = .{};
        for (0..10) |_| {
            output.clearRetainingCapacity();
            const timer = bench_utils.BenchTimer.start(io);
            const cropped = try image.extract(work_allocator, decoded, geometry.x, geometry.y, geometry.width, geometry.height);
            defer cropped.deinit();
            const resized = try image.resize(work_allocator, cropped, geometry.output_width, geometry.output_height, .area);
            defer resized.deinit();
            try writeScenario(work_allocator, &output.writer, resized, geometry.colors);
            stats.record(timer.read());
        }
        const mem_stats: ?[]const bench_utils.MemStat = if (show_mem) blk: {
            const values = try allocator.alloc(bench_utils.MemStat, 1);
            values[0] = .{ .name = "Payload", .bytes = output.written().len };
            break :blk values;
        } else null;
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
}

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

fn appendKittyBenchmarks(
    io: std.Io,
    allocator: std.mem.Allocator,
    results: *std.ArrayListUnmanaged(bench_utils.BenchResult),
    show_mem: bool,
    bench_filter: ?[]const u8,
) !void {
    const names = [_][]const u8{
        "Kitty source auto direct",
        "Kitty cover auto direct",
        "Kitty cover auto count-only",
        "Kitty cover placement",
        "Kitty cover forced RGBA direct",
        "Kitty cover forced RGB direct",
        "Kitty photo create+auto direct",
        "Kitty photo create+RGBA direct",
        "Kitty cover opacity preparation",
    };
    var run_any = false;
    for (names) |name| run_any = run_any or bench_utils.matchesBenchFilter(name, bench_filter);
    if (!run_any) return;

    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const work_allocator = gpa.allocator();
    const encoded = try std.Io.Dir.cwd().readFileAlloc(io, "../examples/src/assets/image-demo.gif", work_allocator, .limited(2 * 1024 * 1024));
    defer work_allocator.free(encoded);
    const decoded = try image.decode(work_allocator, encoded, .{});
    defer decoded.deinit();
    const cropped = try image.extract(work_allocator, decoded, 19, 0, 218, 384);
    defer cropped.deinit();
    const cover = try image.resize(work_allocator, cropped, 576, 1015, .area);
    defer cover.deinit();

    for ([_]struct { name: []const u8, source: *image.Image }{
        .{ .name = names[0], .source = decoded },
        .{ .name = names[1], .source = cover },
    }) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        var output: std.Io.Writer.Allocating = .init(work_allocator);
        defer output.deinit();
        try output.ensureTotalCapacity(scenario.source.pixels.len * 4 / 3 + 8192);
        var stats: bench_utils.BenchStats = .{};
        for (0..20) |_| {
            output.clearRetainingCapacity();
            const timer = bench_utils.BenchTimer.start(io);
            try terminal_image.writeKittyTransmit(&output.writer, scenario.source, 7, false);
            stats.record(timer.read());
        }
        const mem_stats: ?[]const bench_utils.MemStat = if (show_mem) blk: {
            const values = try allocator.alloc(bench_utils.MemStat, 1);
            values[0] = .{ .name = "Payload", .bytes = output.written().len };
            break :blk values;
        } else null;
        try appendResult(allocator, results, scenario.name, stats, mem_stats);
    }

    if (bench_utils.matchesBenchFilter(names[2], bench_filter)) {
        var stats: bench_utils.BenchStats = .{};
        for (0..20) |_| {
            var counting: CountingWriter = .{};
            const timer = bench_utils.BenchTimer.start(io);
            try terminal_image.writeKittyTransmit(&counting, cover, 7, false);
            stats.record(timer.read());
        }
        try appendResult(allocator, results, names[2], stats, null);
    }

    if (bench_utils.matchesBenchFilter(names[3], bench_filter)) {
        var output: std.Io.Writer.Allocating = .init(work_allocator);
        defer output.deinit();
        var stats: bench_utils.BenchStats = .{};
        for (0..1000) |_| {
            output.clearRetainingCapacity();
            const timer = bench_utils.BenchTimer.start(io);
            try terminal_image.writeKittyPlacement(&output.writer, 7, 8, 0, 0, 36, 29, 0, 0, 576, 1015, -1, false);
            stats.record(timer.read());
        }
        const mem_stats: ?[]const bench_utils.MemStat = if (show_mem) blk: {
            const values = try allocator.alloc(bench_utils.MemStat, 1);
            values[0] = .{ .name = "Payload", .bytes = output.written().len };
            break :blk values;
        } else null;
        try appendResult(allocator, results, names[3], stats, mem_stats);
    }

    for ([_]struct { name: []const u8, format: terminal_image.KittyPixelFormat }{
        .{ .name = names[4], .format = .rgba },
        .{ .name = names[5], .format = .rgb },
    }) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        var output: std.Io.Writer.Allocating = .init(work_allocator);
        defer output.deinit();
        try output.ensureTotalCapacity(cover.pixels.len * 4 / 3 + 8192);
        var stats: bench_utils.BenchStats = .{};
        for (0..20) |_| {
            output.clearRetainingCapacity();
            const timer = bench_utils.BenchTimer.start(io);
            try terminal_image.writeKittyTransmitFormat(&output.writer, cover, 7, false, scenario.format);
            stats.record(timer.read());
        }
        const mem_stats: ?[]const bench_utils.MemStat = if (show_mem) blk: {
            const values = try allocator.alloc(bench_utils.MemStat, 1);
            values[0] = .{ .name = "Payload", .bytes = output.written().len };
            break :blk values;
        } else null;
        try appendResult(allocator, results, scenario.name, stats, mem_stats);
    }

    const photo_pixels = try work_allocator.alloc(u8, 576 * 1015 * 4);
    defer work_allocator.free(photo_pixels);
    fillPixels(photo_pixels, .{ .name = "", .width = 576, .height = 1015, .pattern = .photo });
    for ([_]struct { name: []const u8, format: terminal_image.KittyPixelFormat }{
        .{ .name = names[6], .format = .auto },
        .{ .name = names[7], .format = .rgba },
    }) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        var output: std.Io.Writer.Allocating = .init(work_allocator);
        defer output.deinit();
        try output.ensureTotalCapacity(photo_pixels.len * 4 / 3 + 8192);
        var stats: bench_utils.BenchStats = .{};
        for (0..20) |_| {
            output.clearRetainingCapacity();
            const timer = bench_utils.BenchTimer.start(io);
            const value = try image.createFromRgba(work_allocator, photo_pixels, 576, 1015, 576 * 4);
            try terminal_image.writeKittyTransmitFormat(&output.writer, value, 7, false, scenario.format);
            value.deinit();
            stats.record(timer.read());
        }
        const mem_stats: ?[]const bench_utils.MemStat = if (show_mem) blk: {
            const values = try allocator.alloc(bench_utils.MemStat, 1);
            values[0] = .{ .name = "Payload", .bytes = output.written().len };
            break :blk values;
        } else null;
        try appendResult(allocator, results, scenario.name, stats, mem_stats);
    }

    if (bench_utils.matchesBenchFilter(names[8], bench_filter)) {
        var stats: bench_utils.BenchStats = .{};
        var checksum: u64 = 0;
        for (0..100) |_| {
            const timer = bench_utils.BenchTimer.start(io);
            const copy = try cover.clone();
            copy.discardEncoded();
            var index: usize = 3;
            while (index < copy.pixels.len) : (index += 4) {
                copy.pixels[index] = @intCast((@as(u16, copy.pixels[index]) * 128 + 127) / 255);
            }
            stats.record(timer.read());
            checksum +%= copy.pixels[3];
            copy.deinit();
        }
        if (checksum == 0) return error.InvalidKittyOpacityBenchmark;
        try appendResult(allocator, results, names[8], stats, null);
    }
}

fn appendKittyPngBenchmarks(
    io: std.Io,
    allocator: std.mem.Allocator,
    results: *std.ArrayListUnmanaged(bench_utils.BenchResult),
    show_mem: bool,
    bench_filter: ?[]const u8,
) !void {
    const names = [_][]const u8{ "Kitty PNG passthrough auto", "Kitty PNG decoded RGBA" };
    var run_any = false;
    for (names) |name| run_any = run_any or bench_utils.matchesBenchFilter(name, bench_filter);
    if (!run_any) return;

    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const work_allocator = gpa.allocator();
    const encoded = try std.Io.Dir.cwd().readFileAlloc(io, "../examples/src/assets/image-demo.png", work_allocator, .limited(2 * 1024 * 1024));
    defer work_allocator.free(encoded);
    const decoded = try image.decode(work_allocator, encoded, .{});
    defer decoded.deinit();

    for ([_]struct { name: []const u8, format: terminal_image.KittyPixelFormat }{
        .{ .name = names[0], .format = .auto },
        .{ .name = names[1], .format = .rgba },
    }) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        var output: std.Io.Writer.Allocating = .init(work_allocator);
        defer output.deinit();
        try output.ensureTotalCapacity(@max(encoded.len, decoded.pixels.len) * 4 / 3 + 8192);
        try terminal_image.writeKittyTransmitFormat(&output.writer, decoded, 7, false, scenario.format);
        var stats: bench_utils.BenchStats = .{};
        var checksum: usize = 0;
        for (0..50) |_| {
            output.clearRetainingCapacity();
            const timer = bench_utils.BenchTimer.start(io);
            try terminal_image.writeKittyTransmitFormat(&output.writer, decoded, 7, false, scenario.format);
            stats.record(timer.read());
            checksum +%= output.written().len + output.written()[output.written().len / 2];
        }
        if (checksum == 0) return error.InvalidKittyPngBenchmark;
        const mem_stats: ?[]const bench_utils.MemStat = if (show_mem) blk: {
            const values = try allocator.alloc(bench_utils.MemStat, 1);
            values[0] = .{ .name = "Payload", .bytes = output.written().len };
            break :blk values;
        } else null;
        try appendResult(allocator, results, scenario.name, stats, mem_stats);
    }
}

fn appendImageSwitchBenchmarks(
    io: std.Io,
    allocator: std.mem.Allocator,
    results: *std.ArrayListUnmanaged(bench_utils.BenchResult),
    show_mem: bool,
    bench_filter: ?[]const u8,
) !void {
    const names = [_][]const u8{
        "Image switch fit extract full",
        "Image switch cover extract crop",
        "Image switch fit area resize",
        "Image switch cover area resize",
        "Image switch fit extract+resize",
        "Image switch cover extract+resize",
        "Image switch fit Sixel encode",
        "Image switch cover Sixel encode",
        "Image switch fit cold pipeline",
        "Image switch cover cold pipeline",
        "Image switch fit warm payload",
        "Image switch cover warm payload",
        "Image switch fit draw placement",
        "Image switch cover draw placement",
        "Image switch cover Sixel encode 128 colors",
        "Image switch cover Sixel encode 64 colors",
    };
    var run_any = false;
    for (names) |name| run_any = run_any or bench_utils.matchesBenchFilter(name, bench_filter);
    if (!run_any) return;

    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const work_allocator = gpa.allocator();
    const encoded = try std.Io.Dir.cwd().readFileAlloc(io, "../examples/src/assets/image-demo.gif", work_allocator, .limited(2 * 1024 * 1024));
    defer work_allocator.free(encoded);
    const decoded = try image.decode(work_allocator, encoded, .{});
    defer decoded.deinit();

    const Geometry = struct { x: u32, y: u32, width: u32, height: u32, output_width: u32, output_height: u32 };
    const fit = Geometry{ .x = 0, .y = 0, .width = 256, .height = 384, .output_width = 576, .output_height = 875 };
    const cover = Geometry{ .x = 19, .y = 0, .width = 218, .height = 384, .output_width = 576, .output_height = 1015 };
    const iterations: usize = 50;

    const fit_crop = try image.extract(work_allocator, decoded, fit.x, fit.y, fit.width, fit.height);
    defer fit_crop.deinit();
    const cover_crop = try image.extract(work_allocator, decoded, cover.x, cover.y, cover.width, cover.height);
    defer cover_crop.deinit();
    const fit_resized = try image.resize(work_allocator, fit_crop, fit.output_width, fit.output_height, .area);
    defer fit_resized.deinit();
    const cover_resized = try image.resize(work_allocator, cover_crop, cover.output_width, cover.output_height, .area);
    defer cover_resized.deinit();
    var fit_payload: std.Io.Writer.Allocating = .init(work_allocator);
    defer fit_payload.deinit();
    try terminal_image.writeSixelPayload(work_allocator, &fit_payload.writer, fit_resized);
    var cover_payload: std.Io.Writer.Allocating = .init(work_allocator);
    defer cover_payload.deinit();
    try terminal_image.writeSixelPayload(work_allocator, &cover_payload.writer, cover_resized);

    for ([_]struct { name: []const u8, geometry: Geometry }{
        .{ .name = names[0], .geometry = fit },
        .{ .name = names[1], .geometry = cover },
    }) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        var stats: bench_utils.BenchStats = .{};
        for (0..20) |_| {
            const extracted = try image.extract(work_allocator, decoded, scenario.geometry.x, scenario.geometry.y, scenario.geometry.width, scenario.geometry.height);
            extracted.deinit();
        }
        for (0..100) |_| {
            const timer = bench_utils.BenchTimer.start(io);
            const extracted = try image.extract(work_allocator, decoded, scenario.geometry.x, scenario.geometry.y, scenario.geometry.width, scenario.geometry.height);
            stats.record(timer.read());
            extracted.deinit();
        }
        try appendResult(allocator, results, scenario.name, stats, null);
    }

    for ([_]struct { name: []const u8, source: *image.Image, geometry: Geometry }{
        .{ .name = names[2], .source = fit_crop, .geometry = fit },
        .{ .name = names[3], .source = cover_crop, .geometry = cover },
    }) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        var stats: bench_utils.BenchStats = .{};
        for (0..iterations) |_| {
            const timer = bench_utils.BenchTimer.start(io);
            const resized = try image.resize(work_allocator, scenario.source, scenario.geometry.output_width, scenario.geometry.output_height, .area);
            stats.record(timer.read());
            resized.deinit();
        }
        try appendResult(allocator, results, scenario.name, stats, null);
    }

    for ([_]struct { name: []const u8, geometry: Geometry }{
        .{ .name = names[4], .geometry = fit },
        .{ .name = names[5], .geometry = cover },
    }) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        var stats: bench_utils.BenchStats = .{};
        for (0..iterations) |_| {
            const timer = bench_utils.BenchTimer.start(io);
            const extracted = try image.extract(work_allocator, decoded, scenario.geometry.x, scenario.geometry.y, scenario.geometry.width, scenario.geometry.height);
            const resized = try image.resize(work_allocator, extracted, scenario.geometry.output_width, scenario.geometry.output_height, .area);
            stats.record(timer.read());
            resized.deinit();
            extracted.deinit();
        }
        try appendResult(allocator, results, scenario.name, stats, null);
    }

    for ([_]struct { name: []const u8, source: *image.Image, payload_bytes: usize }{
        .{ .name = names[6], .source = fit_resized, .payload_bytes = fit_payload.written().len },
        .{ .name = names[7], .source = cover_resized, .payload_bytes = cover_payload.written().len },
    }) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        var output: std.Io.Writer.Allocating = .init(work_allocator);
        defer output.deinit();
        try output.ensureTotalCapacity(scenario.payload_bytes);
        var stats: bench_utils.BenchStats = .{};
        for (0..iterations) |_| {
            output.clearRetainingCapacity();
            const timer = bench_utils.BenchTimer.start(io);
            try terminal_image.writeSixelPayload(work_allocator, &output.writer, scenario.source);
            stats.record(timer.read());
        }
        const mem_stats: ?[]const bench_utils.MemStat = if (show_mem) blk: {
            const values = try allocator.alloc(bench_utils.MemStat, 1);
            values[0] = .{ .name = "Payload", .bytes = output.written().len };
            break :blk values;
        } else null;
        try appendResult(allocator, results, scenario.name, stats, mem_stats);
    }

    for ([_]struct { name: []const u8, colors: usize }{
        .{ .name = names[14], .colors = 128 },
        .{ .name = names[15], .colors = 64 },
    }) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        var output: std.Io.Writer.Allocating = .init(work_allocator);
        defer output.deinit();
        try writeScenario(work_allocator, &output.writer, cover_resized, scenario.colors);
        var stats: bench_utils.BenchStats = .{};
        for (0..iterations) |_| {
            output.clearRetainingCapacity();
            const timer = bench_utils.BenchTimer.start(io);
            try writeScenario(work_allocator, &output.writer, cover_resized, scenario.colors);
            stats.record(timer.read());
        }
        const mem_stats: ?[]const bench_utils.MemStat = if (show_mem) blk: {
            const values = try allocator.alloc(bench_utils.MemStat, 1);
            values[0] = .{ .name = "Payload", .bytes = output.written().len };
            break :blk values;
        } else null;
        try appendResult(allocator, results, scenario.name, stats, mem_stats);
    }

    for ([_]struct { name: []const u8, geometry: Geometry, payload_bytes: usize }{
        .{ .name = names[8], .geometry = fit, .payload_bytes = fit_payload.written().len },
        .{ .name = names[9], .geometry = cover, .payload_bytes = cover_payload.written().len },
    }) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        var output: std.Io.Writer.Allocating = .init(work_allocator);
        defer output.deinit();
        try output.ensureTotalCapacity(scenario.payload_bytes);
        var stats: bench_utils.BenchStats = .{};
        for (0..iterations) |_| {
            output.clearRetainingCapacity();
            const timer = bench_utils.BenchTimer.start(io);
            const extracted = try image.extract(work_allocator, decoded, scenario.geometry.x, scenario.geometry.y, scenario.geometry.width, scenario.geometry.height);
            const resized = try image.resize(work_allocator, extracted, scenario.geometry.output_width, scenario.geometry.output_height, .area);
            try terminal_image.writeSixelPayload(work_allocator, &output.writer, resized);
            stats.record(timer.read());
            resized.deinit();
            extracted.deinit();
        }
        const mem_stats: ?[]const bench_utils.MemStat = if (show_mem) blk: {
            const values = try allocator.alloc(bench_utils.MemStat, 1);
            values[0] = .{ .name = "Payload", .bytes = output.written().len };
            break :blk values;
        } else null;
        try appendResult(allocator, results, scenario.name, stats, mem_stats);
    }

    for ([_]struct { name: []const u8, payload: []const u8 }{
        .{ .name = names[10], .payload = fit_payload.written() },
        .{ .name = names[11], .payload = cover_payload.written() },
    }) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        var stats: bench_utils.BenchStats = .{};
        var output: std.Io.Writer.Allocating = .init(work_allocator);
        defer output.deinit();
        try output.ensureTotalCapacity(scenario.payload.len + 32);
        var checksum: usize = 0;
        for (0..500) |_| {
            output.clearRetainingCapacity();
            const timer = bench_utils.BenchTimer.start(io);
            try terminal_image.writeSixelFramedPayload(&output.writer, scenario.payload, false);
            stats.record(timer.read());
            checksum +%= output.written().len + output.written()[output.written().len / 2];
        }
        if (checksum == 0) return error.InvalidWarmPayloadBenchmark;
        const mem_stats: ?[]const bench_utils.MemStat = if (show_mem) blk: {
            const values = try allocator.alloc(bench_utils.MemStat, 1);
            values[0] = .{ .name = "Payload", .bytes = scenario.payload.len };
            break :blk values;
        } else null;
        try appendResult(allocator, results, scenario.name, stats, mem_stats);
    }

    const draw_buffer = try buffer.OptimizedBuffer.init(work_allocator, 40, 32, .{
        .pool = gp.initGlobalPool(work_allocator),
        .id = "image-switch-bench",
    });
    defer draw_buffer.deinit();
    for ([_]struct {
        name: []const u8,
        cell_width: u32,
        cell_height: u32,
        geometry: Geometry,
    }{
        .{ .name = names[12], .cell_width = 36, .cell_height = 25, .geometry = fit },
        .{ .name = names[13], .cell_width = 36, .cell_height = 29, .geometry = cover },
    }) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        var stats: bench_utils.BenchStats = .{};
        for (0..100) |_| {
            draw_buffer.clear(ansi.rgbColor(0, 0, 0, 0), null);
            const timer = bench_utils.BenchTimer.start(io);
            if (!try draw_buffer.drawImage(
                decoded,
                1,
                0,
                0,
                scenario.cell_width,
                scenario.cell_height,
                scenario.geometry.output_width,
                scenario.geometry.output_height,
                scenario.geometry.x,
                scenario.geometry.y,
                scenario.geometry.width,
                scenario.geometry.height,
                .sixel,
            )) return error.ImagePlacementFailed;
            stats.record(timer.read());
        }
        try appendResult(allocator, results, scenario.name, stats, null);
    }
}

pub fn run(io: std.Io, allocator: std.mem.Allocator, show_mem: bool, bench_filter: ?[]const u8) ![]bench_utils.BenchResult {
    var results: std.ArrayListUnmanaged(bench_utils.BenchResult) = .empty;
    for (scenarios) |scenario| {
        const count_name = try std.fmt.allocPrint(allocator, "{s} count-only", .{scenario.name});
        const quantize_name = "Sixel 160x240 original baseline quantize-only";
        const run_materialized = bench_utils.matchesBenchFilter(scenario.name, bench_filter);
        const run_counted = bench_utils.matchesBenchFilter(count_name, bench_filter);
        const run_quantized = scenario.pattern == .baseline and scenario.colors == 255 and bench_utils.matchesBenchFilter(quantize_name, bench_filter);
        if (!run_materialized and !run_counted and !run_quantized) continue;
        var gpa: std.heap.DebugAllocator(.{}) = .init;
        defer _ = gpa.deinit();
        const work_allocator = gpa.allocator();
        const pixels = try work_allocator.alloc(u8, @as(usize, scenario.width) * scenario.height * 4);
        defer work_allocator.free(pixels);
        fillPixels(pixels, scenario);
        const value = try image.createFromRgba(work_allocator, pixels, scenario.width, scenario.height, scenario.width * 4);
        defer value.deinit();
        var output: std.Io.Writer.Allocating = .init(work_allocator);
        defer output.deinit();

        try writeScenario(work_allocator, &output.writer, value, scenario.colors);
        const iterations: usize = if (scenario.width > 160) 20 else 50;
        if (run_materialized) {
            var stats: bench_utils.BenchStats = .{};
            for (0..iterations) |_| {
                output.clearRetainingCapacity();
                const timer = bench_utils.BenchTimer.start(io);
                try writeScenario(work_allocator, &output.writer, value, scenario.colors);
                stats.record(timer.read());
            }
            const mem_stats: ?[]const bench_utils.MemStat = if (show_mem) blk: {
                const values = try allocator.alloc(bench_utils.MemStat, 1);
                values[0] = .{ .name = "Payload", .bytes = output.written().len };
                break :blk values;
            } else null;
            try results.append(allocator, .{
                .name = scenario.name,
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

        if (run_counted) {
            var count_stats: bench_utils.BenchStats = .{};
            for (0..iterations) |_| {
                var counting: CountingWriter = .{};
                const timer = bench_utils.BenchTimer.start(io);
                try writeScenario(work_allocator, &counting, value, scenario.colors);
                count_stats.record(timer.read());
                if (counting.bytes != output.written().len) return error.IncorrectSixelByteCount;
            }
            try results.append(allocator, .{
                .name = count_name,
                .min_ns = count_stats.min_ns,
                .avg_ns = count_stats.avg(),
                .max_ns = count_stats.max_ns,
                .total_ns = count_stats.total_ns,
                .iterations = count_stats.count,
                .stddev_ns = count_stats.standardDeviation(),
                .rme_95 = count_stats.relativeMarginOfError95(),
                .mem_stats = null,
            });
        }
        if (run_quantized) {
            var quantize_stats: bench_utils.BenchStats = .{};
            var checksum: usize = 0;
            for (0..iterations) |_| {
                const timer = bench_utils.BenchTimer.start(io);
                var quantized = try terminal_image.quantizeSixel(work_allocator, value, scenario.colors);
                quantize_stats.record(timer.read());
                checksum +%= quantized.palette_len + quantized.indices[0];
                quantized.deinit();
            }
            if (checksum == 0) return error.InvalidQuantizeBenchmark;
            try results.append(allocator, .{
                .name = quantize_name,
                .min_ns = quantize_stats.min_ns,
                .avg_ns = quantize_stats.avg(),
                .max_ns = quantize_stats.max_ns,
                .total_ns = quantize_stats.total_ns,
                .iterations = quantize_stats.count,
                .stddev_ns = quantize_stats.standardDeviation(),
                .rme_95 = quantize_stats.relativeMarginOfError95(),
                .mem_stats = null,
            });
        }
    }
    try appendKittyBenchmarks(io, allocator, &results, show_mem, bench_filter);
    try appendKittyPngBenchmarks(io, allocator, &results, show_mem, bench_filter);
    try appendDragonGeometryBenchmarks(io, allocator, &results, show_mem, bench_filter);
    try appendImageSwitchBenchmarks(io, allocator, &results, show_mem, bench_filter);
    return results.toOwnedSlice(allocator);
}
