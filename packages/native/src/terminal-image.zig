const std = @import("std");
const native_image = @import("image.zig");

pub const KittyPixelFormat = enum { auto, rgb, rgba };
pub const KittyEncoding = enum(u32) { raw, zlib, png, file };
// Bound optional preparation independently of the image decoder's limits.
pub const KITTY_PREPARE_BYTES_MAX = 64 * 1024 * 1024;

pub fn kittyPayloadSize(image: *native_image.Image) !usize {
    if (image.encoded_png) |png| return png.len;
    const count = try std.math.mul(usize, image.width(), image.height());
    return std.math.mul(usize, count, if (image.metadata.has_alpha == 0) 3 else 4);
}

pub fn writeKittyPayload(writer: anytype, image: *native_image.Image) !void {
    if (image.encoded_png) |png| return writer.writeAll(png);
    const pixels = try image.ensurePixels();
    const count = try std.math.mul(usize, image.width(), image.height());
    if (pixels.len != try std.math.mul(usize, count, 4)) return error.InvalidImageData;
    if (image.metadata.has_alpha != 0) return writer.writeAll(pixels);
    var rgb: [3072]u8 = undefined;
    var offset: usize = 0;
    while (offset < count) {
        const n: usize = @min(count - offset, rgb.len / 3);
        for (0..n) |i| @memcpy(rgb[i * 3 ..][0..3], pixels[(offset + i) * 4 ..][0..3]);
        try writer.writeAll(rgb[0 .. n * 3]);
        offset += n;
    }
}

fn compressKittyPayload(allocator: std.mem.Allocator, image: *native_image.Image, output: *std.Io.Writer) !void {
    const flate = std.compress.flate;
    const compressor = try allocator.create(flate.Compress);
    defer allocator.destroy(compressor);
    const window = try allocator.alloc(u8, flate.max_window_len);
    defer allocator.free(window);
    compressor.* = try flate.Compress.init(output, window, .zlib, .fastest);
    try writeKittyPayload(&compressor.writer, image);
    try compressor.finish();
}

pub fn writeKittyTransmitEncoded(
    allocator: std.mem.Allocator,
    writer: anytype,
    image: *native_image.Image,
    id: u32,
    tmux: bool,
    compress: bool,
) !KittyEncoding {
    const fallback: KittyEncoding = if (image.encoded_png != null) .png else .raw;
    if (compress and fallback == .raw) compressed: {
        const size = try kittyPayloadSize(image);
        if (size <= 8 or size > KITTY_PREPARE_BYTES_MAX) break :compressed;
        // A fixed writer stops expansion before any compressed bytes reach stdout.
        const bytes = allocator.alloc(u8, size) catch break :compressed;
        defer allocator.free(bytes);
        var output: std.Io.Writer = .fixed(bytes);
        compressKittyPayload(allocator, image, &output) catch break :compressed;
        const base64 = std.base64.standard.Encoder;
        if (base64.calcSize(output.buffered().len) + ",o=z".len >= base64.calcSize(size)) break :compressed;
        var offset: usize = 0;
        const payload = output.buffered();
        while (offset < payload.len) {
            const end = @min(offset + 3072, payload.len);
            if (tmux) try writer.writeAll("\x1bPtmux;\x1b\x1b_G") else try writer.writeAll("\x1b_G");
            if (offset == 0) {
                try writer.print("a=t,f={d},s={d},v={d},i={d},o=z,m={d},q=2;", .{
                    @as(u32, if (image.metadata.has_alpha == 0) 24 else 32),
                    image.width(),
                    image.height(),
                    id,
                    @intFromBool(end < payload.len),
                });
            } else {
                try writer.print("m={d},q=2;", .{@intFromBool(end < payload.len)});
            }
            var encoded: [4096]u8 = undefined;
            try writer.writeAll(std.base64.standard.Encoder.encode(&encoded, payload[offset..end]));
            if (tmux) try writer.writeAll("\x1b\x1b\\\x1b\\") else try writer.writeAll("\x1b\\");
            offset = end;
        }
        return .zlib;
    }
    try writeKittyTransmit(writer, image, id, tmux);
    return fallback;
}

pub fn writeKittyTransmit(writer: anytype, image: *native_image.Image, id: u32, tmux: bool) !void {
    return writeKittyTransmitFormat(writer, image, id, tmux, .auto);
}

pub fn writeKittyTransmitFormat(writer: anytype, image: *native_image.Image, id: u32, tmux: bool, requested_format: KittyPixelFormat) !void {
    const raw_chunk = 3072;
    const pixel_count = std.math.mul(usize, image.width(), image.height()) catch return error.InvalidImageData;
    const rgba_len = std.math.mul(usize, pixel_count, 4) catch return error.InvalidImageData;
    if (requested_format == .auto) {
        if (image.encoded_png) |png| {
            var offset: usize = 0;
            var first = true;
            while (offset < png.len) {
                const end = @min(offset + raw_chunk, png.len);
                const more = end < png.len;
                if (tmux) try writer.writeAll("\x1bPtmux;\x1b\x1b_G") else try writer.writeAll("\x1b_G");
                if (first) {
                    try writer.print("a=t,f=100,i={d},m={d},q=2;", .{ id, @intFromBool(more) });
                } else {
                    try writer.print("m={d},q=2;", .{@intFromBool(more)});
                }
                var encoded: [4096]u8 = undefined;
                const payload = std.base64.standard.Encoder.encode(encoded[0..std.base64.standard.Encoder.calcSize(end - offset)], png[offset..end]);
                try writer.writeAll(payload);
                if (tmux) try writer.writeAll("\x1b\x1b\\\x1b\\") else try writer.writeAll("\x1b\\");
                offset = end;
                first = false;
            }
            return;
        }
    }
    const pixels = image.ensurePixels() catch return error.InvalidImageData;
    if (pixels.len < rgba_len) return error.InvalidImageData;
    const format: KittyPixelFormat = if (requested_format == .auto)
        (if (image.metadata.has_alpha == 0) .rgb else .rgba)
    else
        requested_format;
    if (format == .rgb) {
        var raw: [raw_chunk]u8 = undefined;
        const rgb_len = std.math.mul(usize, pixel_count, 3) catch return error.InvalidImageData;
        var rgb_offset: usize = 0;
        var first = true;
        while (rgb_offset < rgb_len) {
            const chunk_len = @min(raw.len, rgb_len - rgb_offset);
            const first_pixel = rgb_offset / 3;
            const chunk_pixels = chunk_len / 3;
            for (0..chunk_pixels) |index| {
                const source = (first_pixel + index) * 4;
                @memcpy(raw[index * 3 ..][0..3], pixels[source..][0..3]);
            }
            const more = rgb_offset + chunk_len < rgb_len;
            if (tmux) try writer.writeAll("\x1bPtmux;\x1b\x1b_G") else try writer.writeAll("\x1b_G");
            if (first) {
                try writer.print("a=t,f=24,s={d},v={d},i={d},m={d},q=2;", .{ image.width(), image.height(), id, @intFromBool(more) });
            } else {
                try writer.print("m={d},q=2;", .{@intFromBool(more)});
            }
            var encoded: [4096]u8 = undefined;
            const encoded_len = std.base64.standard.Encoder.calcSize(chunk_len);
            const payload = std.base64.standard.Encoder.encode(encoded[0..encoded_len], raw[0..chunk_len]);
            try writer.writeAll(payload);
            if (tmux) try writer.writeAll("\x1b\x1b\\\x1b\\") else try writer.writeAll("\x1b\\");
            rgb_offset += chunk_len;
            first = false;
        }
        return;
    }
    var offset: usize = 0;
    var first = true;
    while (offset < rgba_len) {
        const end = @min(offset + raw_chunk, rgba_len);
        const more = end < rgba_len;
        if (tmux) try writer.writeAll("\x1bPtmux;\x1b\x1b_G") else try writer.writeAll("\x1b_G");
        if (first) {
            try writer.print("a=t,f=32,s={d},v={d},i={d},m={d},q=2;", .{ image.width(), image.height(), id, @intFromBool(more) });
        } else {
            try writer.print("m={d},q=2;", .{@intFromBool(more)});
        }
        var encoded: [4096]u8 = undefined;
        const payload = std.base64.standard.Encoder.encode(encoded[0..std.base64.standard.Encoder.calcSize(end - offset)], pixels[offset..end]);
        try writer.writeAll(payload);
        if (tmux) try writer.writeAll("\x1b\x1b\\\x1b\\") else try writer.writeAll("\x1b\\");
        offset = end;
        first = false;
    }
}

pub fn writeKittyPlacement(
    writer: anytype,
    id: u32,
    placement_id: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    source_x: u32,
    source_y: u32,
    source_width: u32,
    source_height: u32,
    z: i32,
    tmux: bool,
) !void {
    try writer.print("\x1b[{d};{d}H", .{ y + 1, x + 1 });
    if (tmux) try writer.writeAll("\x1bPtmux;\x1b\x1b_G") else try writer.writeAll("\x1b_G");
    try writer.print("a=p,i={d},p={d},c={d},r={d},x={d},y={d},w={d},h={d},C=1,z={d},q=2", .{
        id, placement_id, width, height, source_x, source_y, source_width, source_height, z,
    });
    if (tmux) try writer.writeAll("\x1b\x1b\\\x1b\\") else try writer.writeAll("\x1b\\");
}

pub fn writeKittyPlacementAtCursor(
    writer: anytype,
    id: u32,
    placement_id: u32,
    width: u32,
    height: u32,
    z: i32,
    tmux: bool,
) !void {
    if (tmux) try writer.writeAll("\x1bPtmux;\x1b\x1b_G") else try writer.writeAll("\x1b_G");
    try writer.print("a=p,i={d},p={d},c={d},r={d},C=1,z={d},q=2", .{ id, placement_id, width, height, z });
    if (tmux) try writer.writeAll("\x1b\x1b\\\x1b\\") else try writer.writeAll("\x1b\\");
}

pub fn writeKittyDelete(writer: anytype, id: u32, placement_id: ?u32, free_image: bool, tmux: bool) !void {
    if (tmux) try writer.writeAll("\x1bPtmux;\x1b\x1b_G") else try writer.writeAll("\x1b_G");
    try writer.print("a=d,d={c},i={d}", .{ if (free_image) @as(u8, 'I') else @as(u8, 'i'), id });
    if (placement_id) |p| try writer.print(",p={d}", .{p});
    try writer.writeAll(",q=2");
    if (tmux) try writer.writeAll("\x1b\x1b\\\x1b\\") else try writer.writeAll("\x1b\\");
}

const SixelColor = struct { r: u8, g: u8, b: u8 };
const SixelMoment = struct { count: u64 = 0, r: u64 = 0, g: u64 = 0, b: u64 = 0, square: u64 = 0 };
const SixelBox = struct { r0: u8 = 0, r1: u8 = 32, g0: u8 = 0, g1: u8 = 32, b0: u8 = 0, b1: u8 = 32 };
const SixelAxis = enum { r, g, b };
const SixelCut = struct { axis: SixelAxis, at: u8, score: f64 };
const SIXEL_HISTOGRAM_SIDE = 33;
const SIXEL_HISTOGRAM_LEN = SIXEL_HISTOGRAM_SIDE * SIXEL_HISTOGRAM_SIDE * SIXEL_HISTOGRAM_SIDE;

pub const QuantizedSixel = struct {
    allocator: std.mem.Allocator,
    palette: [255][3]u8,
    palette_len: usize,
    indices: []u8,

    pub fn deinit(self: *QuantizedSixel) void {
        self.allocator.free(self.indices);
    }
};

// Wu's fixed RGB moment cube gives a deterministic adaptive palette; tagging its final boxes maps
// pixels without a nearest-color search: https://github.com/erich666/GraphicsGems/blob/master/gemsii/quantizer.c
fn momentIndex(r: usize, g: usize, b: usize) usize {
    return (r * SIXEL_HISTOGRAM_SIDE + g) * SIXEL_HISTOGRAM_SIDE + b;
}

fn addMoment(target: *SixelMoment, value: SixelMoment) void {
    target.count += value.count;
    target.r += value.r;
    target.g += value.g;
    target.b += value.b;
    target.square += value.square;
}

fn volumeValue(comptime field: []const u8, moments: []const SixelMoment, box: SixelBox) u64 {
    const value = @as(i128, @field(moments[momentIndex(box.r1, box.g1, box.b1)], field)) -
        @as(i128, @field(moments[momentIndex(box.r1, box.g1, box.b0)], field)) -
        @as(i128, @field(moments[momentIndex(box.r1, box.g0, box.b1)], field)) +
        @as(i128, @field(moments[momentIndex(box.r1, box.g0, box.b0)], field)) -
        @as(i128, @field(moments[momentIndex(box.r0, box.g1, box.b1)], field)) +
        @as(i128, @field(moments[momentIndex(box.r0, box.g1, box.b0)], field)) +
        @as(i128, @field(moments[momentIndex(box.r0, box.g0, box.b1)], field)) -
        @as(i128, @field(moments[momentIndex(box.r0, box.g0, box.b0)], field));
    return @intCast(value);
}

const BoxStats = struct { count: u64, r: u64, g: u64, b: u64 };

fn volumeStats(moments: []const SixelMoment, box: SixelBox) BoxStats {
    const corners = [_]*const SixelMoment{
        &moments[momentIndex(box.r1, box.g1, box.b1)], &moments[momentIndex(box.r1, box.g1, box.b0)],
        &moments[momentIndex(box.r1, box.g0, box.b1)], &moments[momentIndex(box.r1, box.g0, box.b0)],
        &moments[momentIndex(box.r0, box.g1, box.b1)], &moments[momentIndex(box.r0, box.g1, box.b0)],
        &moments[momentIndex(box.r0, box.g0, box.b1)], &moments[momentIndex(box.r0, box.g0, box.b0)],
    };
    var result = BoxStats{ .count = 0, .r = 0, .g = 0, .b = 0 };
    inline for (.{ "count", "r", "g", "b" }) |field| {
        const value = @as(i128, @field(corners[0], field)) - @as(i128, @field(corners[1], field)) -
            @as(i128, @field(corners[2], field)) + @as(i128, @field(corners[3], field)) -
            @as(i128, @field(corners[4], field)) + @as(i128, @field(corners[5], field)) +
            @as(i128, @field(corners[6], field)) - @as(i128, @field(corners[7], field));
        @field(result, field) = @intCast(value);
    }
    return result;
}

fn statsEnergy(stats: BoxStats) f64 {
    if (stats.count == 0) return 0;
    const r: f64 = @floatFromInt(stats.r);
    const g: f64 = @floatFromInt(stats.g);
    const b: f64 = @floatFromInt(stats.b);
    return (2.0 * r * r + 4.0 * g * g + 3.0 * b * b) / (8.0 * @as(f64, @floatFromInt(stats.count)));
}

fn boxVariance(moments: []const SixelMoment, box: SixelBox) f64 {
    return @max(0, @as(f64, @floatFromInt(volumeValue("square", moments, box))) - statsEnergy(volumeStats(moments, box)));
}

fn bestBoxCut(moments: []const SixelMoment, box: SixelBox) ?SixelCut {
    var best: ?SixelCut = null;
    inline for ([_]SixelAxis{ .r, .g, .b }) |axis| {
        const low = switch (axis) {
            .r => box.r0,
            .g => box.g0,
            .b => box.b0,
        };
        const high = switch (axis) {
            .r => box.r1,
            .g => box.g1,
            .b => box.b1,
        };
        var at = low + 1;
        while (at < high) : (at += 1) {
            var first = box;
            var second = box;
            switch (axis) {
                .r => {
                    first.r1 = at;
                    second.r0 = at;
                },
                .g => {
                    first.g1 = at;
                    second.g0 = at;
                },
                .b => {
                    first.b1 = at;
                    second.b0 = at;
                },
            }
            const first_stats = volumeStats(moments, first);
            const second_stats = volumeStats(moments, second);
            if (first_stats.count == 0 or second_stats.count == 0) continue;
            const score = statsEnergy(first_stats) + statsEnergy(second_stats);
            if (best == null or score > best.?.score) best = .{ .axis = axis, .at = at, .score = score };
        }
    }
    return best;
}

pub fn quantizeSixel(allocator: std.mem.Allocator, image: *native_image.Image, max_colors: usize) !QuantizedSixel {
    if (max_colors == 0 or max_colors > 255) return error.InvalidArgument;
    const pixel_count = std.math.mul(usize, image.width(), image.height()) catch return error.InvalidImageData;
    _ = image.ensurePixels() catch return error.InvalidImageData;
    if (image.pixels.len < std.math.mul(usize, pixel_count, 4) catch return error.InvalidImageData) return error.InvalidImageData;
    const moments = try allocator.alloc(SixelMoment, SIXEL_HISTOGRAM_LEN);
    defer allocator.free(moments);
    @memset(moments, .{});
    var active_bins: usize = 0;
    for (0..pixel_count) |pixel| {
        const offset = pixel * 4;
        if (image.pixels[offset + 3] < 128) continue;
        const r = image.pixels[offset];
        const g = image.pixels[offset + 1];
        const b = image.pixels[offset + 2];
        const bin = &moments[momentIndex(@as(usize, r >> 3) + 1, @as(usize, g >> 3) + 1, @as(usize, b >> 3) + 1)];
        if (bin.count == 0) active_bins += 1;
        bin.count += 1;
        bin.r += r;
        bin.g += g;
        bin.b += b;
        bin.square += (2 * @as(u64, r) * r + 4 * @as(u64, g) * g + 3 * @as(u64, b) * b + 4) >> 3;
    }
    for (1..SIXEL_HISTOGRAM_SIDE) |r| {
        var area = [_]SixelMoment{.{}} ** SIXEL_HISTOGRAM_SIDE;
        for (1..SIXEL_HISTOGRAM_SIDE) |g| {
            var line: SixelMoment = .{};
            for (1..SIXEL_HISTOGRAM_SIDE) |b| {
                addMoment(&line, moments[momentIndex(r, g, b)]);
                addMoment(&area[b], line);
                var cumulative = moments[momentIndex(r - 1, g, b)];
                addMoment(&cumulative, area[b]);
                moments[momentIndex(r, g, b)] = cumulative;
            }
        }
    }
    var result = QuantizedSixel{ .allocator = allocator, .palette = undefined, .palette_len = 0, .indices = try allocator.alloc(u8, pixel_count) };
    errdefer allocator.free(result.indices);
    if (active_bins == 0) {
        @memset(result.indices, 255);
        return result;
    }
    var boxes: [255]SixelBox = undefined;
    var variances = [_]f64{0} ** 255;
    boxes[0] = .{};
    variances[0] = boxVariance(moments, boxes[0]);
    var box_count: usize = 1;
    while (box_count < @min(active_bins, max_colors)) {
        var split_index: ?usize = null;
        var highest: f64 = 0;
        for (variances[0..box_count], 0..) |variance, index| if (variance > highest) {
            highest = variance;
            split_index = index;
        };
        if (split_index == null) break;
        const cut = bestBoxCut(moments, boxes[split_index.?]) orelse {
            variances[split_index.?] = 0;
            continue;
        };
        var second = boxes[split_index.?];
        switch (cut.axis) {
            .r => {
                boxes[split_index.?].r1 = cut.at;
                second.r0 = cut.at;
            },
            .g => {
                boxes[split_index.?].g1 = cut.at;
                second.g0 = cut.at;
            },
            .b => {
                boxes[split_index.?].b1 = cut.at;
                second.b0 = cut.at;
            },
        }
        boxes[box_count] = second;
        variances[split_index.?] = boxVariance(moments, boxes[split_index.?]);
        variances[box_count] = boxVariance(moments, second);
        box_count += 1;
    }
    result.palette_len = box_count;
    // Common colors get shorter palette selectors, reducing repeated #N designations in each band.
    var box_counts: [255]u64 = undefined;
    for (boxes[0..box_count], 0..) |box, index| box_counts[index] = volumeStats(moments, box).count;
    for (1..box_count) |index| {
        const box = boxes[index];
        const count = box_counts[index];
        var destination = index;
        while (destination > 0 and box_counts[destination - 1] < count) : (destination -= 1) {
            boxes[destination] = boxes[destination - 1];
            box_counts[destination] = box_counts[destination - 1];
        }
        boxes[destination] = box;
        box_counts[destination] = count;
    }
    var tags = [_]u8{0} ** (32 * 32 * 32);
    for (boxes[0..box_count], 0..) |box, palette_index| {
        const stats = volumeStats(moments, box);
        result.palette[palette_index] = .{
            @intCast((stats.r + stats.count / 2) / stats.count),
            @intCast((stats.g + stats.count / 2) / stats.count),
            @intCast((stats.b + stats.count / 2) / stats.count),
        };
        for (box.r0..box.r1) |r| {
            for (box.g0..box.g1) |g| {
                for (box.b0..box.b1) |b| tags[(r << 10) | (g << 5) | b] = @intCast(palette_index);
            }
        }
    }
    for (0..image.height()) |y| {
        for (0..image.width()) |x| {
            const pixel = y * image.width() + x;
            const offset = pixel * 4;
            result.indices[pixel] = if (image.pixels[offset + 3] < 128) 255 else tags[
                (@as(usize, image.pixels[offset] >> 3) << 10) |
                    (@as(usize, image.pixels[offset + 1] >> 3) << 5) |
                    (image.pixels[offset + 2] >> 3)
            ];
        }
    }

    return result;
}

fn writeUnsigned(writer: anytype, value: usize) !void {
    var buffer: [20]u8 = undefined;
    var index = buffer.len;
    var remaining = value;
    while (true) {
        index -= 1;
        buffer[index] = @intCast('0' + remaining % 10);
        remaining /= 10;
        if (remaining == 0) break;
    }
    try writer.writeAll(buffer[index..]);
}

fn BufferedWriter(comptime Writer: type) type {
    return struct {
        writer: Writer,
        buffer: [8192]u8 = undefined,
        len: usize = 0,

        fn writeByte(self: *@This(), value: u8) !void {
            if (self.len == self.buffer.len) try self.flush();
            self.buffer[self.len] = value;
            self.len += 1;
        }

        fn writeAll(self: *@This(), value: []const u8) !void {
            if (value.len >= self.buffer.len) {
                try self.flush();
                try self.writer.writeAll(value);
                return;
            }
            if (self.len + value.len > self.buffer.len) try self.flush();
            @memcpy(self.buffer[self.len..][0..value.len], value);
            self.len += value.len;
        }

        fn flush(self: *@This()) !void {
            if (self.len == 0) return;
            try self.writer.writeAll(self.buffer[0..self.len]);
            self.len = 0;
        }
    };
}

pub fn writeSixelPayload(allocator: std.mem.Allocator, writer: anytype, image: *native_image.Image) !void {
    var quantized = try quantizeSixel(allocator, image, 255);
    defer quantized.deinit();
    try writeSixelIndexedPayload(
        allocator,
        writer,
        quantized.indices,
        quantized.palette[0..quantized.palette_len],
        image.width(),
        image.height(),
    );
}

pub fn writeSixelIndexedPayload(
    allocator: std.mem.Allocator,
    writer: anytype,
    indices: []const u8,
    palette: []const [3]u8,
    width: u32,
    height: u32,
) !void {
    if (palette.len == 0 or palette.len > 255) return error.InvalidImageData;
    const pixel_count = std.math.mul(usize, width, height) catch return error.InvalidImageData;
    if (indices.len < pixel_count) return error.InvalidImageData;
    const mask_count = std.math.mul(usize, palette.len, width) catch return error.InvalidImageData;
    const masks = try allocator.alloc(u8, mask_count);
    defer allocator.free(masks);
    var buffered = BufferedWriter(@TypeOf(writer)){ .writer = writer };
    const output = &buffered;
    var generations = [_]u32{0} ** 256;
    var last_nonzero = [_]usize{0} ** 256;
    try output.writeAll("0;1;0q\"1;1;");
    try writeUnsigned(output, width);
    try output.writeByte(';');
    try writeUnsigned(output, height);
    for (palette, 0..) |color, index| {
        try output.writeByte('#');
        try writeUnsigned(output, index);
        try output.writeAll(";2;");
        for (color, 0..) |channel, channel_index| {
            try writeUnsigned(output, (@as(u16, channel) * 100 + 127) / 255);
            if (channel_index < 2) try output.writeByte(';');
        }
    }

    const output_height: usize = height;
    var band_y: usize = 0;
    var generation: u32 = 0;
    while (band_y < output_height) : (band_y += 6) {
        generation += 1;
        for (0..6) |bit| {
            const y = band_y + bit;
            if (y >= output_height) continue;
            for (0..width) |x| {
                const palette_index = indices[y * width + x];
                if (palette_index == 255) continue;
                if (palette_index >= palette.len) return error.InvalidImageData;
                if (generations[palette_index] != generation) {
                    generations[palette_index] = generation;
                    @memset(masks[@as(usize, palette_index) * width ..][0..width], 0);
                    last_nonzero[palette_index] = 0;
                }
                masks[@as(usize, palette_index) * width + x] |= @as(u8, 1) << @intCast(bit);
                last_nonzero[palette_index] = @max(last_nonzero[palette_index], x + 1);
            }
        }
        var first_plane = true;
        for (0..palette.len) |palette_index| {
            if (generations[palette_index] != generation) continue;
            const plane = masks[palette_index * width ..][0..last_nonzero[palette_index]];
            if (!first_plane) try output.writeByte('$');
            first_plane = false;
            try output.writeByte('#');
            try writeUnsigned(output, palette_index);
            var x: usize = 0;
            while (x < plane.len) {
                const mask = plane[x];
                const char: u8 = '?' + mask;
                var run: usize = 1;
                while (x + run < plane.len and plane[x + run] == mask) : (run += 1) {}
                if (run >= 4) {
                    try output.writeByte('!');
                    try writeUnsigned(output, run);
                    try output.writeByte(char);
                } else for (0..run) |_| try output.writeByte(char);
                x += run;
            }
        }
        if (band_y + 6 < output_height) try output.writeByte('-');
    }
    try output.flush();
}

pub fn writeSixelFramedPayload(writer: anytype, payload: []const u8, tmux: bool) !void {
    if (tmux) try writer.writeAll("\x1bPtmux;\x1b\x1bP") else try writer.writeAll("\x1bP");
    try writer.writeAll(payload);
    if (tmux) try writer.writeAll("\x1b\x1b\\\x1b\\") else try writer.writeAll("\x1b\\");
}

pub fn writeSixel(allocator: std.mem.Allocator, writer: anytype, image: *native_image.Image, tmux: bool) !void {
    var payload: std.Io.Writer.Allocating = .init(allocator);
    defer payload.deinit();
    try writeSixelPayload(allocator, &payload.writer, image);
    try writeSixelFramedPayload(writer, payload.written(), tmux);
}
