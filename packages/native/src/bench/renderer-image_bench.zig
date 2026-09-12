const std = @import("std");
const bench_utils = @import("../bench-utils.zig");
const renderer = @import("../renderer.zig");
const buffer = @import("../buffer.zig");
const image = @import("../image.zig");
const gp = @import("../grapheme.zig");
const link = @import("../link.zig");
const handles = @import("../handles.zig");
const test_renderer_mod = @import("../tests/test-renderer.zig");

pub const benchName = "Renderer Image";

const TERM_WIDTH = 200;
const TERM_HEIGHT = 50;
const IMAGE_VARIANTS = 24;
const FRAME_ITERATIONS = 96;

const Protocol = enum { kitty, sixel, blocks };

fn makeFrameImage(allocator: std.mem.Allocator, width: u32, height: u32, seed: u8) !*image.Image {
    const pixels = try allocator.alloc(u8, @as(usize, width) * height * 4);
    defer allocator.free(pixels);
    for (0..height) |y| {
        for (0..width) |x| {
            const offset = (y * width + x) * 4;
            pixels[offset] = @truncate(x + seed);
            pixels[offset + 1] = @truncate(y +% seed *% 3);
            pixels[offset + 2] = @truncate(x + y + seed *% 7);
            pixels[offset + 3] = 255;
        }
    }
    return image.createFromRgba(allocator, pixels, width, height, width * 4);
}

fn drawTextBackdrop(target: *buffer.OptimizedBuffer) void {
    var y: u32 = 0;
    while (y < TERM_HEIGHT) : (y += 1) {
        var x: u32 = 0;
        while (x < TERM_WIDTH) : (x += 1) {
            target.setRaw(x, y, .{
                .char = 'A' + (x + y) % 26,
                .fg = .{ 200, 200, 200, 255 },
                .bg = .{ 20, 20, 40, 255 },
                .attributes = 0,
            });
        }
    }
}

const FrameCost = struct {
    stats: bench_utils.BenchStats = .{},
    total_bytes: u64 = 0,
    frames: u64 = 0,

    fn bytesPerFrame(self: *const FrameCost) u64 {
        if (self.frames == 0) return 0;
        return self.total_bytes / self.frames;
    }
};

fn runPlacementScenario(
    io: std.Io,
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    protocol: Protocol,
    image_width: u32,
    image_height: u32,
    animate: bool,
    text_change: bool,
) !FrameCost {
    var test_renderer = try test_renderer_mod.TestRenderer.create(allocator, TERM_WIDTH, TERM_HEIGHT, pool);
    defer test_renderer.deinit();
    switch (protocol) {
        .kitty => test_renderer.renderer.terminal.caps.kitty_graphics = true,
        .sixel => test_renderer.renderer.terminal.caps.sixel = true,
        .blocks => {},
    }

    var images: [IMAGE_VARIANTS]*image.Image = undefined;
    var image_handles: [IMAGE_VARIANTS]u32 = undefined;
    for (0..IMAGE_VARIANTS) |index| {
        images[index] = try makeFrameImage(allocator, image_width, image_height, @truncate(index * 5));
        image_handles[index] = try handles.insert(.image, @ptrCast(images[index]));
    }
    defer for (image_handles) |handle| {
        const token = handles.beginDestroy(handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    };

    var cost = FrameCost{};
    if (protocol == .sixel and animate) {
        for (images, image_handles) |value, handle| {
            const next = test_renderer.renderer.getNextBuffer();
            drawTextBackdrop(next);
            _ = try next.drawImage(value, handle, 5, 5, 40, 20, 320, 200, 0, 0, image_width, image_height, .auto);
            _ = test_renderer.renderer.render(true);
        }
    }
    var frame: usize = 0;
    while (frame < FRAME_ITERATIONS) : (frame += 1) {
        const index = if (animate) frame % IMAGE_VARIANTS else 0;
        const next = test_renderer.renderer.getNextBuffer();
        drawTextBackdrop(next);
        if (text_change) {
            next.setRaw(0, 0, .{
                .char = '0' + @as(u32, @intCast(frame % 10)),
                .fg = .{ 255, 255, 0, 255 },
                .bg = .{ 0, 0, 0, 255 },
                .attributes = 0,
            });
        }
        _ = try next.drawImage(images[index], image_handles[index], 5, 5, 40, 20, 320, 200, 0, 0, image_width, image_height, .auto);

        test_renderer.memory.bytes.clearRetainingCapacity();
        test_renderer.memory.last_write_start = 0;
        test_renderer.memory.last_write_len = 0;
        const timer = bench_utils.BenchTimer.start(io);
        _ = test_renderer.renderer.render(false);
        cost.stats.record(timer.read());
        // Skip the first frame: it pays the initial full paint for every scenario.
        if (frame == 0) {
            cost.stats = .{};
            continue;
        }
        cost.total_bytes += test_renderer.memory.bytes.items.len;
        cost.frames += 1;
    }
    return cost;
}

fn runLargeStillTransmit(io: std.Io, allocator: std.mem.Allocator, pool: *gp.GraphemePool) !FrameCost {
    var test_renderer = try test_renderer_mod.TestRenderer.create(allocator, TERM_WIDTH, TERM_HEIGHT, pool);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.kitty_graphics = true;

    const first = try makeFrameImage(allocator, 1600, 1200, 11);
    const first_handle = handles.insert(.image, @ptrCast(first)) catch |err| {
        first.deinit();
        return err;
    };
    defer {
        const token = handles.beginDestroy(first_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    const second = try makeFrameImage(allocator, 1600, 1200, 37);
    const second_handle = handles.insert(.image, @ptrCast(second)) catch |err| {
        second.deinit();
        return err;
    };
    defer {
        const token = handles.beginDestroy(second_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    const stills = [_]*image.Image{ first, second };
    const still_handles = [_]u32{ first_handle, second_handle };

    var cost = FrameCost{};
    // Alternate content so every iteration exercises crop, downscale, and transmission.
    var frame: usize = 0;
    while (frame < 8) : (frame += 1) {
        const index = frame % stills.len;
        const next = test_renderer.renderer.getNextBuffer();
        _ = try next.drawImage(stills[index], still_handles[index], 5, 5, 40, 20, 320, 200, 0, 0, 1600, 1200, .auto);
        test_renderer.memory.bytes.clearRetainingCapacity();
        test_renderer.memory.last_write_start = 0;
        test_renderer.memory.last_write_len = 0;
        const timer = bench_utils.BenchTimer.start(io);
        _ = test_renderer.renderer.render(false);
        cost.stats.record(timer.read());
        // Match the other renderer scenarios by excluding initial full paint.
        if (frame == 0) {
            cost.stats = .{};
            continue;
        }
        cost.total_bytes += test_renderer.memory.bytes.items.len;
        cost.frames += 1;
    }
    return cost;
}

fn runDrawFrameBuffer(io: std.Io, allocator: std.mem.Allocator, with_image: bool) !FrameCost {
    var pool = gp.GraphemePool.init(allocator);
    defer pool.deinit();
    var link_pool = link.LinkPool.init(allocator);
    defer link_pool.deinit();
    const source = try buffer.OptimizedBuffer.init(allocator, TERM_WIDTH, TERM_HEIGHT, .{ .pool = &pool, .link_pool = &link_pool });
    defer source.deinit();
    const target = try buffer.OptimizedBuffer.init(allocator, TERM_WIDTH, TERM_HEIGHT, .{ .pool = &pool, .link_pool = &link_pool });
    defer target.deinit();
    drawTextBackdrop(source);

    const dot = if (with_image) try makeFrameImage(allocator, 8, 8, 3) else null;
    defer if (dot) |value| value.deinit();
    if (dot) |value| _ = try source.drawImage(value, 51, 2, 2, 4, 2, 8, 8, 0, 0, 8, 8, .auto);

    var cost = FrameCost{};
    var iteration: usize = 0;
    while (iteration < 400) : (iteration += 1) {
        const timer = bench_utils.BenchTimer.start(io);
        target.drawFrameBuffer(0, 0, source, null, null, null, null);
        cost.stats.record(timer.read());
        cost.frames += 1;
        target.clear(.{ 0, 0, 0, 255 }, null);
    }
    return cost;
}

fn drawStaticKittyPlacements(target: *buffer.OptimizedBuffer, value: *image.Image, image_handle: u32, count: usize) !void {
    for (0..count) |index| {
        const x: i32 = @intCast(index % TERM_WIDTH);
        const y: i32 = @intCast(index / TERM_WIDTH);
        _ = try target.drawImage(value, image_handle, x, y, 1, 1, 1, 1, 0, 0, 1, 1, .kitty);
    }
}

fn runStaticKittyPlacementCount(
    io: std.Io,
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    count: usize,
) !FrameCost {
    var test_renderer = try test_renderer_mod.TestRenderer.create(allocator, TERM_WIDTH, TERM_HEIGHT, pool);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.kitty_graphics = true;

    const value = try makeFrameImage(allocator, 1, 1, 7);
    const image_handle = handles.insert(.image, @ptrCast(value)) catch |err| {
        value.deinit();
        return err;
    };
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }

    try drawStaticKittyPlacements(test_renderer.renderer.getNextBuffer(), value, image_handle, count);
    if (test_renderer.renderer.render(true) != .rendered) return error.RenderFailed;

    const iterations: usize = if (count <= 128) 100 else if (count <= 512) 50 else if (count <= 2048) 20 else 30;
    var cost = FrameCost{};
    for (0..iterations) |_| {
        try drawStaticKittyPlacements(test_renderer.renderer.getNextBuffer(), value, image_handle, count);
        test_renderer.memory.bytes.clearRetainingCapacity();
        test_renderer.memory.last_write_start = 0;
        test_renderer.memory.last_write_len = 0;
        const timer = bench_utils.BenchTimer.start(io);
        if (test_renderer.renderer.render(false) == .failed) return error.RenderFailed;
        cost.stats.record(timer.read());
        cost.total_bytes += test_renderer.memory.bytes.items.len;
        cost.frames += 1;
    }
    return cost;
}

fn drawOverlappingSixelPlacements(
    target: *buffer.OptimizedBuffer,
    base: *image.Image,
    base_handle: u32,
    replacement: *image.Image,
    replacement_handle: u32,
    replace_first: bool,
    count: usize,
) !void {
    for (0..count) |index| {
        const value = if (replace_first and index == 0) replacement else base;
        const image_handle = if (replace_first and index == 0) replacement_handle else base_handle;
        _ = try target.drawImage(value, image_handle, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, .sixel);
    }
}

fn runDirtySixelOverlapCount(
    io: std.Io,
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    count: usize,
) !FrameCost {
    var test_renderer = try test_renderer_mod.TestRenderer.create(allocator, 1, 1, pool);
    defer test_renderer.deinit();
    test_renderer.renderer.terminal.caps.sixel = true;

    const transparent = [_]u8{ 0, 0, 0, 0 };
    const base = try image.createFromRgba(allocator, &transparent, 1, 1, 4);
    const base_handle = handles.insert(.image, @ptrCast(base)) catch |err| {
        base.deinit();
        return err;
    };
    defer {
        const token = handles.beginDestroy(base_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }
    const replacement = try image.createFromRgba(allocator, &transparent, 1, 1, 4);
    const replacement_handle = handles.insert(.image, @ptrCast(replacement)) catch |err| {
        replacement.deinit();
        return err;
    };
    defer {
        const token = handles.beginDestroy(replacement_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }

    try drawOverlappingSixelPlacements(
        test_renderer.renderer.getNextBuffer(),
        base,
        base_handle,
        replacement,
        replacement_handle,
        false,
        count,
    );
    if (test_renderer.renderer.render(true) != .rendered) return error.RenderFailed;
    try drawOverlappingSixelPlacements(
        test_renderer.renderer.getNextBuffer(),
        base,
        base_handle,
        replacement,
        replacement_handle,
        true,
        count,
    );
    if (test_renderer.renderer.render(false) == .failed) return error.RenderFailed;

    const iterations: usize = if (count <= 128) 100 else if (count <= 512) 50 else if (count <= 2048) 20 else 30;
    var cost = FrameCost{};
    for (0..iterations) |iteration| {
        try drawOverlappingSixelPlacements(
            test_renderer.renderer.getNextBuffer(),
            base,
            base_handle,
            replacement,
            replacement_handle,
            iteration % 2 != 0,
            count,
        );
        test_renderer.memory.bytes.clearRetainingCapacity();
        test_renderer.memory.last_write_start = 0;
        test_renderer.memory.last_write_len = 0;
        const timer = bench_utils.BenchTimer.start(io);
        if (test_renderer.renderer.render(false) == .failed) return error.RenderFailed;
        cost.stats.record(timer.read());
        cost.total_bytes += test_renderer.memory.bytes.items.len;
        cost.frames += 1;
    }
    return cost;
}

fn runSplitImageCommit(
    io: std.Io,
    allocator: std.mem.Allocator,
    pool: *gp.GraphemePool,
    protocol: Protocol,
    placement_count: usize,
) !FrameCost {
    var test_renderer = try test_renderer_mod.TestRenderer.create(allocator, TERM_WIDTH, TERM_HEIGHT, pool);
    defer test_renderer.deinit();
    switch (protocol) {
        .kitty => test_renderer.renderer.terminal.caps.kitty_graphics = true,
        .sixel => test_renderer.renderer.terminal.caps.sixel = true,
        .blocks => {},
    }

    const image_width: u32 = if (placement_count == 1) 320 else 1;
    const image_height: u32 = if (placement_count == 1) 200 else 1;
    const value = try makeFrameImage(allocator, image_width, image_height, 19);
    const image_handle = handles.insert(.image, @ptrCast(value)) catch |err| {
        value.deinit();
        return err;
    };
    defer {
        const token = handles.beginDestroy(image_handle, .image, image.Image).?;
        token.ptr.deinit();
        handles.finishDestroy(token.handle);
    }

    const snapshot = try buffer.OptimizedBuffer.init(allocator, 40, 20, .{ .pool = pool });
    defer snapshot.deinit();
    const render_protocol: image.RenderProtocol = switch (protocol) {
        .kitty => .kitty,
        .sixel => .sixel,
        .blocks => .blocks,
    };
    if (placement_count == 1) {
        _ = try snapshot.drawImage(value, image_handle, 0, 0, 40, 20, 320, 200, 0, 0, 320, 200, render_protocol);
    } else {
        for (0..placement_count) |index| {
            _ = try snapshot.drawImage(
                value,
                image_handle,
                @intCast(index % 40),
                @intCast(index / 40),
                1,
                1,
                1,
                1,
                0,
                0,
                1,
                1,
                render_protocol,
            );
        }
    }

    const iterations: usize = switch (protocol) {
        .kitty => 100,
        .sixel => 30,
        .blocks => 100,
    };
    var cost = FrameCost{};
    for (0..iterations + 10) |iteration| {
        if (protocol == .blocks) {
            snapshot.clear(.{ 0, 0, 0, 255 }, null);
            _ = try snapshot.drawImage(value, image_handle, 0, 0, 40, 20, 320, 200, 0, 0, 320, 200, render_protocol);
        }
        _ = test_renderer.renderer.resetSplitScrollback(TERM_HEIGHT, TERM_HEIGHT);
        test_renderer.memory.bytes.clearRetainingCapacity();
        test_renderer.memory.last_write_start = 0;
        test_renderer.memory.last_write_len = 0;
        const timer = bench_utils.BenchTimer.start(io);
        const result = test_renderer.renderer.commitSplitFooterSnapshotBatched(
            snapshot,
            snapshot.width,
            false,
            true,
            TERM_HEIGHT,
            false,
            true,
            true,
        );
        const elapsed = timer.read();
        if (result.status == .failed) return error.RenderFailed;
        const output = test_renderer.memory.bytes.items;
        switch (protocol) {
            .kitty => if (std.mem.find(u8, output, "\x1b_Ga=t") == null) return error.MissingKittyImageOutput,
            .sixel => if (std.mem.find(u8, output, "\x1bP0;1;0q") == null) return error.MissingSixelImageOutput,
            .blocks => if (snapshot.image_placements.items.len != 0) return error.MissingBlockImageFallback,
        }
        if (iteration < 10) continue;
        cost.stats.record(elapsed);
        cost.total_bytes += test_renderer.memory.bytes.items.len;
        cost.frames += 1;
    }
    return cost;
}

pub fn run(io: std.Io, allocator: std.mem.Allocator, show_mem: bool, bench_filter: ?[]const u8) ![]bench_utils.BenchResult {
    _ = show_mem;
    const pool = gp.initGlobalPool(allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();

    var results: std.ArrayListUnmanaged(bench_utils.BenchResult) = .empty;

    const Scenario = struct {
        name: []const u8,
        protocol: Protocol,
        animate: bool,
        text_change: bool,
    };
    const scenarios = [_]Scenario{
        .{ .name = "kitty image replacements", .protocol = .kitty, .animate = true, .text_change = false },
        .{ .name = "kitty static image one text change", .protocol = .kitty, .animate = false, .text_change = true },
        .{ .name = "kitty static image no changes", .protocol = .kitty, .animate = false, .text_change = false },
        .{ .name = "sixel cached image replacements", .protocol = .sixel, .animate = true, .text_change = false },
        .{ .name = "sixel static image no changes", .protocol = .sixel, .animate = false, .text_change = false },
        .{ .name = "blocks image replacements", .protocol = .blocks, .animate = true, .text_change = false },
    };
    for (scenarios) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        const cost = try runPlacementScenario(io, allocator, pool, scenario.protocol, 320, 200, scenario.animate, scenario.text_change);
        try results.append(allocator, .{
            .name = try std.fmt.allocPrint(allocator, "{s} ({d} bytes/frame)", .{ scenario.name, cost.bytesPerFrame() }),
            .min_ns = cost.stats.min_ns,
            .avg_ns = cost.stats.avg(),
            .max_ns = cost.stats.max_ns,
            .total_ns = cost.stats.total_ns,
            .iterations = cost.stats.count,
            .stddev_ns = cost.stats.standardDeviation(),
            .rme_95 = cost.stats.relativeMarginOfError95(),
            .mem_stats = null,
        });
    }

    if (bench_utils.matchesBenchFilter("kitty large still transmit", bench_filter)) {
        const cost = try runLargeStillTransmit(io, allocator, pool);
        try results.append(allocator, .{
            .name = try std.fmt.allocPrint(allocator, "kitty large still transmit ({d} bytes/frame)", .{cost.bytesPerFrame()}),
            .min_ns = cost.stats.min_ns,
            .avg_ns = cost.stats.avg(),
            .max_ns = cost.stats.max_ns,
            .total_ns = cost.stats.total_ns,
            .iterations = cost.stats.count,
            .stddev_ns = cost.stats.standardDeviation(),
            .rme_95 = cost.stats.relativeMarginOfError95(),
            .mem_stats = null,
        });
    }

    const framebuffer_scenarios = [_]struct { name: []const u8, with_image: bool }{
        .{ .name = "drawFrameBuffer no images", .with_image = false },
        .{ .name = "drawFrameBuffer one image", .with_image = true },
    };
    for (framebuffer_scenarios) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        const cost = try runDrawFrameBuffer(io, allocator, scenario.with_image);
        try results.append(allocator, .{
            .name = scenario.name,
            .min_ns = cost.stats.min_ns,
            .avg_ns = cost.stats.avg(),
            .max_ns = cost.stats.max_ns,
            .total_ns = cost.stats.total_ns,
            .iterations = cost.stats.count,
            .stddev_ns = cost.stats.standardDeviation(),
            .rme_95 = cost.stats.relativeMarginOfError95(),
            .mem_stats = null,
        });
    }

    for ([_]usize{ 8, 32, 128, 512, 2048, 4096 }) |count| {
        const name = try std.fmt.allocPrint(allocator, "kitty static {d} placements", .{count});
        if (!bench_utils.matchesBenchFilter(name, bench_filter)) continue;
        const cost = try runStaticKittyPlacementCount(io, allocator, pool, count);
        try results.append(allocator, .{
            .name = try std.fmt.allocPrint(allocator, "{s} ({d} bytes/frame)", .{ name, cost.bytesPerFrame() }),
            .min_ns = cost.stats.min_ns,
            .avg_ns = cost.stats.avg(),
            .max_ns = cost.stats.max_ns,
            .total_ns = cost.stats.total_ns,
            .iterations = cost.stats.count,
            .stddev_ns = cost.stats.standardDeviation(),
            .rme_95 = cost.stats.relativeMarginOfError95(),
            .mem_stats = null,
        });
    }

    for ([_]usize{ 8, 32, 128, 512, 2048, 4096 }) |count| {
        const name = try std.fmt.allocPrint(allocator, "sixel dirty overlap {d} transparent placements", .{count});
        if (!bench_utils.matchesBenchFilter(name, bench_filter)) continue;
        const cost = try runDirtySixelOverlapCount(io, allocator, pool, count);
        try results.append(allocator, .{
            .name = try std.fmt.allocPrint(allocator, "{s} ({d} bytes/frame)", .{ name, cost.bytesPerFrame() }),
            .min_ns = cost.stats.min_ns,
            .avg_ns = cost.stats.avg(),
            .max_ns = cost.stats.max_ns,
            .total_ns = cost.stats.total_ns,
            .iterations = cost.stats.count,
            .stddev_ns = cost.stats.standardDeviation(),
            .rme_95 = cost.stats.relativeMarginOfError95(),
            .mem_stats = null,
        });
    }

    const split_scenarios = [_]struct {
        name: []const u8,
        protocol: Protocol,
        placements: usize,
    }{
        .{ .name = "split Kitty image commit", .protocol = .kitty, .placements = 1 },
        .{ .name = "split Sixel image commit", .protocol = .sixel, .placements = 1 },
        .{ .name = "split block fallback image commit", .protocol = .blocks, .placements = 1 },
        .{ .name = "split Kitty 128 image placements", .protocol = .kitty, .placements = 128 },
    };
    for (split_scenarios) |scenario| {
        if (!bench_utils.matchesBenchFilter(scenario.name, bench_filter)) continue;
        const cost = try runSplitImageCommit(io, allocator, pool, scenario.protocol, scenario.placements);
        try results.append(allocator, .{
            .name = try std.fmt.allocPrint(allocator, "{s} ({d} bytes/frame)", .{ scenario.name, cost.bytesPerFrame() }),
            .min_ns = cost.stats.min_ns,
            .avg_ns = cost.stats.avg(),
            .max_ns = cost.stats.max_ns,
            .total_ns = cost.stats.total_ns,
            .iterations = cost.stats.count,
            .stddev_ns = cost.stats.standardDeviation(),
            .rme_95 = cost.stats.relativeMarginOfError95(),
            .mem_stats = null,
        });
    }

    return results.toOwnedSlice(allocator);
}
