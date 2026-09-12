const std = @import("std");
const terminal_image = @import("../terminal-image.zig");
const image = @import("../image.zig");

const DecodedSixel = struct {
    indices: []u8,
    width: usize,
    height: usize,

    fn deinit(self: DecodedSixel) void {
        std.testing.allocator.free(self.indices);
    }
};

fn quantizeWithAllocator(allocator: std.mem.Allocator) !void {
    const value = try image.createFromRgba(allocator, &[_]u8{
        255, 0, 0,   255, 0,   255, 0,   255,
        0,   0, 255, 255, 255, 255, 255, 255,
    }, 2, 2, 8);
    defer value.deinit();
    var quantized = try terminal_image.quantizeSixel(allocator, value, 4);
    defer quantized.deinit();
}

fn writeIndexedWithAllocator(allocator: std.mem.Allocator) !void {
    const indices = [_]u8{ 0, 1, 1, 0 };
    const palette = [_][3]u8{ .{ 255, 0, 0 }, .{ 0, 255, 0 } };
    var output: std.Io.Writer.Allocating = .init(allocator);
    defer output.deinit();
    terminal_image.writeSixelIndexedPayload(allocator, &output.writer, &indices, &palette, 2, 2) catch |err| {
        if (err == error.WriteFailed) return error.OutOfMemory;
        return err;
    };
}

test "Sixel preparation releases partial allocations on OOM" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, quantizeWithAllocator, .{});
    try std.testing.checkAllAllocationFailures(std.testing.allocator, writeIndexedWithAllocator, .{});
}

fn parseUnsigned(bytes: []const u8, position: *usize) !usize {
    const start = position.*;
    var value: usize = 0;
    while (position.* < bytes.len and std.ascii.isDigit(bytes[position.*])) : (position.* += 1) {
        value = value * 10 + bytes[position.*] - '0';
    }
    if (position.* == start) return error.InvalidSixel;
    return value;
}

fn decodeSixelIndices(payload: []const u8) !DecodedSixel {
    const quote = std.mem.findScalar(u8, payload, '"') orelse return error.InvalidSixel;
    var position = quote + 1;
    _ = try parseUnsigned(payload, &position);
    if (position >= payload.len or payload[position] != ';') return error.InvalidSixel;
    position += 1;
    _ = try parseUnsigned(payload, &position);
    if (position >= payload.len or payload[position] != ';') return error.InvalidSixel;
    position += 1;
    const width = try parseUnsigned(payload, &position);
    if (position >= payload.len or payload[position] != ';') return error.InvalidSixel;
    position += 1;
    const height = try parseUnsigned(payload, &position);
    const indices = try std.testing.allocator.alloc(u8, width * height);
    errdefer std.testing.allocator.free(indices);
    @memset(indices, 255);

    var selected: ?u8 = null;
    var x: usize = 0;
    var band_y: usize = 0;
    while (position < payload.len) {
        const byte = payload[position];
        position += 1;
        switch (byte) {
            '#' => {
                selected = @intCast(try parseUnsigned(payload, &position));
                if (position < payload.len and payload[position] == ';') {
                    // Skip color mode and three color components.
                    for (0..4) |_| {
                        if (position >= payload.len or payload[position] != ';') return error.InvalidSixel;
                        position += 1;
                        _ = try parseUnsigned(payload, &position);
                    }
                }
            },
            '!' => {
                const count = try parseUnsigned(payload, &position);
                if (position >= payload.len) return error.InvalidSixel;
                const data = payload[position];
                position += 1;
                if (data < '?' or data > '~') return error.InvalidSixel;
                for (0..count) |_| {
                    const mask = data - '?';
                    for (0..6) |bit| {
                        const y = band_y + bit;
                        if (selected != null and x < width and y < height and mask & (@as(u8, 1) << @intCast(bit)) != 0) {
                            indices[y * width + x] = selected.?;
                        }
                    }
                    x += 1;
                }
            },
            '$' => x = 0,
            '-' => {
                x = 0;
                band_y += 6;
            },
            '?'...'~' => {
                const mask = byte - '?';
                for (0..6) |bit| {
                    const y = band_y + bit;
                    if (selected != null and x < width and y < height and mask & (@as(u8, 1) << @intCast(bit)) != 0) {
                        indices[y * width + x] = selected.?;
                    }
                }
                x += 1;
            },
            else => {},
        }
    }
    return .{ .indices = indices, .width = width, .height = height };
}

pub fn decodeKittyChunks(payload: []const u8) ![]u8 {
    var decoded: std.ArrayList(u8) = .empty;
    errdefer decoded.deinit(std.testing.allocator);
    var offset: usize = 0;
    while (std.mem.findPos(u8, payload, offset, "\x1b_G")) |start| {
        const separator = std.mem.findScalarPos(u8, payload, start + 3, ';') orelse return error.InvalidKittyPayload;
        const end = std.mem.findPos(u8, payload, separator + 1, "\x1b\\") orelse return error.InvalidKittyPayload;
        const encoded = payload[separator + 1 .. end];
        const decoded_len = try std.base64.standard.Decoder.calcSizeForSlice(encoded);
        const destination = try decoded.addManyAsSlice(std.testing.allocator, decoded_len);
        try std.base64.standard.Decoder.decode(destination, encoded);
        offset = end + 2;
    }
    return decoded.toOwnedSlice(std.testing.allocator);
}

test "kitty zlib roundtrips RGB and RGBA with a real inflater" {
    for ([_]bool{ false, true }) |alpha| {
        const pixels = try std.testing.allocator.alloc(u8, 256 * 128 * 4);
        defer std.testing.allocator.free(pixels);
        var prng = std.Random.DefaultPrng.init(711);
        prng.random().bytes(pixels);
        for (0..pixels.len / 4) |i| {
            if (i >= pixels.len / 8) @memset(pixels[i * 4 ..][0..3], 90);
            pixels[i * 4 + 3] = if (alpha) 127 else 255;
        }
        const value = try image.createFromRgba(std.testing.allocator, pixels, 256, 128, 1024);
        defer value.deinit();
        var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
        defer output.deinit();
        try std.testing.expectEqual(.zlib, try terminal_image.writeKittyTransmitEncoded(std.testing.allocator, &output.writer, value, 19, alpha, true));
        try std.testing.expect(std.mem.find(u8, output.written(), if (alpha) "f=32" else "f=24") != null);
        try std.testing.expect(std.mem.find(u8, output.written(), "m=1") != null);
        if (alpha) try std.testing.expect(std.mem.startsWith(u8, output.written(), "\x1bPtmux;"));
        const unwrapped = try std.mem.replaceOwned(u8, std.testing.allocator, output.written(), "\x1b\x1b", "\x1b");
        defer std.testing.allocator.free(unwrapped);
        const compressed = try decodeKittyChunks(unwrapped);
        defer std.testing.allocator.free(compressed);
        var input: std.Io.Reader = .fixed(compressed);
        var window: [std.compress.flate.max_window_len]u8 = undefined;
        var inflater = std.compress.flate.Decompress.init(&input, .zlib, &window);
        const decoded = try inflater.reader.allocRemaining(std.testing.allocator, .limited(pixels.len + 1));
        defer std.testing.allocator.free(decoded);
        const channels: usize = if (alpha) 4 else 3;
        try std.testing.expectEqual(pixels.len / 4 * channels, decoded.len);
        for (0..pixels.len / 4) |i| {
            try std.testing.expectEqualSlices(u8, pixels[i * 4 ..][0..channels], decoded[i * channels ..][0..channels]);
        }
        try std.testing.expect(compressed.len < decoded.len);
    }
}

test "kitty zlib expansion falls back to unchanged raw output" {
    var pixels: [64 * 64 * 4]u8 = undefined;
    var prng = std.Random.DefaultPrng.init(18271);
    prng.random().bytes(&pixels);
    const value = try image.createFromRgba(std.testing.allocator, &pixels, 64, 64, 256);
    defer value.deinit();
    var raw: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer raw.deinit();
    try terminal_image.writeKittyTransmit(&raw.writer, value, 20, false);
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try std.testing.expectEqual(.raw, try terminal_image.writeKittyTransmitEncoded(std.testing.allocator, &output.writer, value, 20, false, true));
    try std.testing.expectEqualSlices(u8, raw.written(), output.written());
}

test "kitty zlib allocation failures fall back even when the input compresses" {
    const pixels = [_]u8{42} ** (64 * 64 * 4);
    const value = try image.createFromRgba(std.testing.allocator, &pixels, 64, 64, 256);
    defer value.deinit();
    var raw: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer raw.deinit();
    try terminal_image.writeKittyTransmit(&raw.writer, value, 20, false);
    var failure: usize = 0;
    while (true) : (failure += 1) {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = failure });
        var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
        defer output.deinit();
        const encoding = try terminal_image.writeKittyTransmitEncoded(failing.allocator(), &output.writer, value, 20, false, true);
        if (!failing.has_induced_failure) {
            try std.testing.expectEqual(.zlib, encoding);
            break;
        }
        try std.testing.expectEqual(.raw, encoding);
        try std.testing.expectEqualSlices(u8, raw.written(), output.written());
    }
}

test "kitty zlib preserves PNG and propagates output failures without leaking" {
    var pixels: [1024]u8 = @splat(255);
    const value = try image.createFromRgba(std.testing.allocator, &pixels, 16, 16, 64);
    defer value.deinit();
    var failed: std.Io.Writer = .failing;
    try std.testing.expectError(error.WriteFailed, terminal_image.writeKittyTransmitEncoded(std.testing.allocator, &failed, value, 21, false, true));
    const png = try value.ensureEncodedPng();
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try std.testing.expectEqual(.png, try terminal_image.writeKittyTransmitEncoded(std.testing.allocator, &output.writer, value, 21, false, true));
    const decoded = try decodeKittyChunks(output.written());
    defer std.testing.allocator.free(decoded);
    try std.testing.expectEqualSlices(u8, png, decoded);
    try std.testing.expect(std.mem.find(u8, output.written(), "o=z") == null);
}

test "kitty transmission chunks RGBA payloads and places without cursor movement" {
    const pixels = try std.testing.allocator.alloc(u8, 1025 * 4);
    defer std.testing.allocator.free(pixels);
    @memset(pixels, 42);
    var value = image.Image{
        .allocator = std.testing.allocator,
        .pixels = pixels,
        .metadata = .{ .width = 1025, .height = 1, .has_alpha = 1 },
    };
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try terminal_image.writeKittyTransmit(&output.writer, &value, 7, false);
    try terminal_image.writeKittyPlacement(&output.writer, 7, 8, 2, 3, 4, 5, 0, 0, 1, 1, -99, false);
    try std.testing.expect(std.mem.find(u8, output.written(), "i=7,m=1,q=2;") != null);
    try std.testing.expect(std.mem.find(u8, output.written(), "\x1b_Gm=0,q=2;") != null);
    try std.testing.expect(std.mem.find(u8, output.written(), "a=p,i=7,p=8,c=4,r=5,x=0,y=0,w=1,h=1,C=1,z=-99") != null);
}

test "kitty transmission uses RGB only when every pixel is opaque" {
    const opaque_image = try image.createFromRgba(std.testing.allocator, &[_]u8{ 1, 2, 3, 255 }, 1, 1, 4);
    defer opaque_image.deinit();
    var rgb: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer rgb.deinit();
    try terminal_image.writeKittyTransmit(&rgb.writer, opaque_image, 1, false);
    try std.testing.expect(std.mem.find(u8, rgb.written(), "f=24") != null);
    try std.testing.expect(std.mem.find(u8, rgb.written(), ";AQID\x1b\\") != null);

    const transparent = try image.createFromRgba(std.testing.allocator, &[_]u8{ 1, 2, 3, 4 }, 1, 1, 4);
    defer transparent.deinit();
    var rgba: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer rgba.deinit();
    try terminal_image.writeKittyTransmit(&rgba.writer, transparent, 1, false);
    try std.testing.expect(std.mem.find(u8, rgba.written(), "f=32") != null);
    try std.testing.expect(std.mem.find(u8, rgba.written(), ";AQIDBA==\x1b\\") != null);
}

test "kitty transmission prefers PNG passthrough after ensureEncodedPng" {
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 1, 2, 3, 255 }, 1, 1, 4);
    defer value.deinit();
    var raw: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer raw.deinit();
    try terminal_image.writeKittyTransmit(&raw.writer, value, 5, false);
    try std.testing.expect(std.mem.find(u8, raw.written(), "f=24") != null);

    const encoded = try value.ensureEncodedPng();
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try terminal_image.writeKittyTransmit(&output.writer, value, 5, false);
    try std.testing.expect(std.mem.find(u8, output.written(), "a=t,f=100,i=5") != null);
    const decoded = try decodeKittyChunks(output.written());
    defer std.testing.allocator.free(decoded);
    try std.testing.expectEqualSlices(u8, encoded, decoded);
}

test "kitty transmission sends retained PNG bytes as f=100" {
    const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==";
    const png_len = try std.base64.standard.Decoder.calcSizeForSlice(encoded);
    const png = try std.testing.allocator.alloc(u8, png_len);
    defer std.testing.allocator.free(png);
    try std.base64.standard.Decoder.decode(png, encoded);
    const value = try image.decode(std.testing.allocator, png, .{});
    defer value.deinit();
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();

    try terminal_image.writeKittyTransmit(&output.writer, value, 9, false);
    try std.testing.expect(std.mem.find(u8, output.written(), "a=t,f=100,i=9") != null);
    const decoded = try decodeKittyChunks(output.written());
    defer std.testing.allocator.free(decoded);
    try std.testing.expectEqualSlices(u8, png, decoded);
}

test "kitty transmission passes ICC PNG bytes without materializing pixels" {
    const encoded = std.mem.trim(u8, @embedFile("fixtures/display-p3.png.base64"), "\r\n");
    const png_len = try std.base64.standard.Decoder.calcSizeForSlice(encoded);
    const png = try std.testing.allocator.alloc(u8, png_len);
    defer std.testing.allocator.free(png);
    try std.base64.standard.Decoder.decode(png, encoded);
    const value = try image.decode(std.testing.allocator, png, .{});
    defer value.deinit();
    try std.testing.expectEqual(@as(usize, 0), value.pixels.len);

    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try terminal_image.writeKittyTransmit(&output.writer, value, 11, false);

    const decoded = try decodeKittyChunks(output.written());
    defer std.testing.allocator.free(decoded);
    try std.testing.expectEqualSlices(u8, png, decoded);
    try std.testing.expectEqual(@as(usize, 0), value.pixels.len);
}

test "kitty transmission preserves retained PNG bytes through clone" {
    const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==";
    const png_len = try std.base64.standard.Decoder.calcSizeForSlice(encoded);
    const png = try std.testing.allocator.alloc(u8, png_len);
    defer std.testing.allocator.free(png);
    try std.base64.standard.Decoder.decode(png, encoded);
    const value = try image.decode(std.testing.allocator, png, .{});
    defer value.deinit();
    const cloned = try value.clone();
    defer cloned.deinit();
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();

    try terminal_image.writeKittyTransmit(&output.writer, cloned, 10, false);
    try std.testing.expect(std.mem.find(u8, output.written(), "a=t,f=100,i=10") != null);
    const decoded = try decodeKittyChunks(output.written());
    defer std.testing.allocator.free(decoded);
    try std.testing.expectEqualSlices(u8, png, decoded);
}

test "kitty transmission rejects truncated image storage before writing" {
    var pixels = [_]u8{ 1, 2, 3 };
    var value = image.Image{
        .allocator = std.testing.allocator,
        .pixels = &pixels,
        .metadata = .{ .width = 1, .height = 1 },
    };
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try std.testing.expectError(error.InvalidImageData, terminal_image.writeKittyTransmit(&output.writer, &value, 1, false));
    try std.testing.expectEqual(@as(usize, 0), output.written().len);
}

test "kitty RGB transmission preserves pixels across chunk boundaries" {
    const width = 2050;
    const height = 1;
    const pixels = try std.testing.allocator.alloc(u8, width * height * 4);
    defer std.testing.allocator.free(pixels);
    const expected = try std.testing.allocator.alloc(u8, width * height * 3);
    defer std.testing.allocator.free(expected);
    for (0..width) |pixel| {
        pixels[pixel * 4] = @truncate(pixel);
        pixels[pixel * 4 + 1] = @truncate(pixel * 3);
        pixels[pixel * 4 + 2] = @truncate(pixel * 7);
        pixels[pixel * 4 + 3] = 255;
        @memcpy(expected[pixel * 3 ..][0..3], pixels[pixel * 4 ..][0..3]);
    }
    const value = try image.createFromRgba(std.testing.allocator, pixels, width, height, width * 4);
    defer value.deinit();
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try terminal_image.writeKittyTransmit(&output.writer, value, 1, false);
    const decoded = try decodeKittyChunks(output.written());
    defer std.testing.allocator.free(decoded);
    try std.testing.expectEqualSlices(u8, expected, decoded);
}

test "sixel encoding writes palette raster and terminator" {
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 255, 0, 0, 255 }, 1, 1, 4);
    defer value.deinit();
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try terminal_image.writeSixel(std.testing.allocator, &output.writer, value, false);
    try std.testing.expect(std.mem.startsWith(u8, output.written(), "\x1bP0;1;0q\"1;1;1;1"));
    try std.testing.expect(std.mem.endsWith(u8, output.written(), "\x1b\\"));
    try std.testing.expect(std.mem.find(u8, output.written(), ";2;100;0;0") != null);
}

test "sixel encoding does not open a DCS when payload generation fails" {
    const pixels = try std.testing.allocator.alloc(u8, 0);
    defer std.testing.allocator.free(pixels);
    var value = image.Image{
        .allocator = std.testing.allocator,
        .pixels = pixels,
        .metadata = .{ .width = 1, .height = 1 },
    };
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try std.testing.expectError(error.InvalidImageData, terminal_image.writeSixel(std.testing.allocator, &output.writer, &value, false));
    try std.testing.expectEqual(@as(usize, 0), output.written().len);
}

test "kitty tmux passthrough doubles inner escape bytes" {
    const value = try image.createFromRgba(std.testing.allocator, &[_]u8{ 1, 2, 3, 4 }, 1, 1, 4);
    defer value.deinit();
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try terminal_image.writeKittyTransmit(&output.writer, value, 11, true);
    try std.testing.expect(std.mem.startsWith(u8, output.written(), "\x1bPtmux;\x1b\x1b_G"));
    try std.testing.expect(std.mem.endsWith(u8, output.written(), "\x1b\x1b\\\x1b\\"));
}

test "sixel encoding uses RLE and omits transparent pixels" {
    const pixels = [_]u8{
        255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
        0,   0, 0, 0,
    };
    const value = try image.createFromRgba(std.testing.allocator, &pixels, 5, 1, 20);
    defer value.deinit();
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try terminal_image.writeSixel(std.testing.allocator, &output.writer, value, false);
    try std.testing.expect(std.mem.find(u8, output.written(), "!4@") != null);
}

test "sixel adaptive palette caps at 255 colors deterministically" {
    const width = 512;
    const pixels = try std.testing.allocator.alloc(u8, width * 4);
    defer std.testing.allocator.free(pixels);
    for (0..width) |index| {
        const offset = index * 4;
        pixels[offset] = @intCast(((index >> 6) & 0x1F) << 3);
        pixels[offset + 1] = @intCast(((index >> 3) & 0x1F) << 3);
        pixels[offset + 2] = @intCast((index & 0x1F) << 3);
        pixels[offset + 3] = 255;
    }
    const value = try image.createFromRgba(std.testing.allocator, pixels, width, 1, width * 4);
    defer value.deinit();
    var first: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer first.deinit();
    var second: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer second.deinit();
    try terminal_image.writeSixel(std.testing.allocator, &first.writer, value, false);
    try terminal_image.writeSixel(std.testing.allocator, &second.writer, value, false);
    try std.testing.expectEqualSlices(u8, first.written(), second.written());
    try std.testing.expectEqual(@as(usize, 255), std.mem.count(u8, first.written(), ";2;"));
}

test "sixel adaptive palette assigns shorter indices to common colors" {
    const width = 100;
    const pixels = try std.testing.allocator.alloc(u8, width * 4);
    defer std.testing.allocator.free(pixels);
    for (0..width) |index| {
        const offset = index * 4;
        const color: [4]u8 = if (index < 90) .{ 240, 32, 16, 255 } else .{ 8, 64, 224, 255 };
        @memcpy(pixels[offset..][0..4], &color);
    }
    const value = try image.createFromRgba(std.testing.allocator, pixels, width, 1, width * 4);
    defer value.deinit();
    var quantized = try terminal_image.quantizeSixel(std.testing.allocator, value, 2);
    defer quantized.deinit();
    try std.testing.expectEqual(@as(usize, 2), quantized.palette_len);
    try std.testing.expectEqual(@as(usize, 90), std.mem.count(u8, quantized.indices, &[_]u8{0}));
}

test "sixel indexed encoding preserves the supplied palette" {
    const indices = [_]u8{ 0, 1, 0, 1 };
    const palette = [_][3]u8{ .{ 12, 34, 56 }, .{ 210, 180, 90 } };
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try terminal_image.writeSixelIndexedPayload(std.testing.allocator, &output.writer, &indices, &palette, 4, 1);
    try std.testing.expect(std.mem.find(u8, output.written(), "#0;2;5;13;22") != null);
    try std.testing.expect(std.mem.find(u8, output.written(), "#1;2;82;71;35") != null);
    const decoded = try decodeSixelIndices(output.written());
    defer decoded.deinit();
    try std.testing.expectEqualSlices(u8, &indices, decoded.indices);
}

test "sixel indexed encoding reserves index 255 for transparency" {
    const palette = [_][3]u8{.{ 0, 0, 0 }} ** 256;
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try std.testing.expectError(
        error.InvalidImageData,
        terminal_image.writeSixelIndexedPayload(std.testing.allocator, &output.writer, &[_]u8{255}, &palette, 1, 1),
    );
    try std.testing.expectEqual(@as(usize, 0), output.written().len);
}

test "sixel indexed scheduling preserves cursor resets bands and transparency" {
    const width = 65;
    const height = 13;
    const palette = [_][3]u8{ .{ 255, 0, 0 }, .{ 0, 255, 0 }, .{ 0, 0, 255 } };
    const indices = try std.testing.allocator.alloc(u8, width * height);
    defer std.testing.allocator.free(indices);
    @memset(indices, 255);
    indices[0] = 0;
    indices[64] = 1;
    indices[1 * width + 40] = 0;
    indices[2 * width + 40] = 1;
    indices[6 * width + 63] = 2;
    indices[12 * width] = 1;
    indices[12 * width + 64] = 0;

    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try terminal_image.writeSixelIndexedPayload(std.testing.allocator, &output.writer, indices, &palette, width, height);
    const decoded = try decodeSixelIndices(output.written());
    defer decoded.deinit();
    try std.testing.expectEqual(width, decoded.width);
    try std.testing.expectEqual(height, decoded.height);
    try std.testing.expectEqualSlices(u8, indices, decoded.indices);
    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, output.written(), "-"));
    try std.testing.expect(std.mem.findScalar(u8, output.written(), '$') != null);
}

test "sixel indexed scheduling handles cover-sized geometry" {
    const width = 576;
    const height = 1015;
    const palette = [_][3]u8{ .{ 255, 255, 255 }, .{ 64, 128, 255 } };
    const indices = try std.testing.allocator.alloc(u8, width * height);
    defer std.testing.allocator.free(indices);
    @memset(indices, 255);
    indices[0] = 0;
    indices[width - 1] = 1;
    indices[63] = 1;
    indices[64] = 0;
    indices[(height - 1) * width] = 1;
    indices[height * width - 1] = 0;

    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try terminal_image.writeSixelIndexedPayload(std.testing.allocator, &output.writer, indices, &palette, width, height);
    const decoded = try decodeSixelIndices(output.written());
    defer decoded.deinit();
    try std.testing.expectEqualSlices(u8, indices, decoded.indices);
    try std.testing.expect(output.written().len < 10_000);
}

test "sixel indexed scheduling handles width and band boundaries" {
    const palette = [_][3]u8{ .{ 255, 255, 255 }, .{ 32, 96, 192 } };
    for ([_]usize{ 1, 5, 6, 7, 12, 13 }) |height| {
        for ([_]usize{ 1, 63, 64, 65, 127, 128, 129 }) |width| {
            const indices = try std.testing.allocator.alloc(u8, width * height);
            defer std.testing.allocator.free(indices);
            @memset(indices, 255);
            indices[0] = 0;
            indices[width - 1] = 1;
            indices[(height - 1) * width] = 1;
            indices[height * width - 1] = 0;
            if (width > 64) {
                indices[63] = 1;
                indices[64] = 0;
            }

            var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
            defer output.deinit();
            try terminal_image.writeSixelIndexedPayload(
                std.testing.allocator,
                &output.writer,
                indices,
                &palette,
                @intCast(width),
                @intCast(height),
            );
            const decoded = try decodeSixelIndices(output.written());
            defer decoded.deinit();
            try std.testing.expectEqualSlices(u8, indices, decoded.indices);
            try std.testing.expect(std.mem.find(u8, output.written(), "$-") == null);
        }
    }
}

test "adaptive Sixel palette quality by color limit" {
    const width = 160;
    const height = 240;
    const pixels = try std.testing.allocator.alloc(u8, width * height * 4);
    defer std.testing.allocator.free(pixels);
    for (0..width * height) |index| {
        const x = index % width;
        const y = index / width;
        const offset = index * 4;
        pixels[offset] = @truncate(x * 13 + y * 3);
        pixels[offset + 1] = @truncate(x * 5 + y * 11);
        pixels[offset + 2] = @truncate(x * 7 + y * 17);
        pixels[offset + 3] = 255;
    }
    const value = try image.createFromRgba(std.testing.allocator, pixels, width, height, width * 4);
    defer value.deinit();
    const weights = [_]u64{ 2, 4, 3 };
    for ([_]usize{ 64, 128, 255 }) |color_limit| {
        var quantized = try terminal_image.quantizeSixel(std.testing.allocator, value, color_limit);
        defer quantized.deinit();
        var error_sum: u64 = 0;
        for (quantized.indices, 0..) |palette_index, pixel| {
            const color = quantized.palette[palette_index];
            const offset = pixel * 4;
            for (0..3) |channel| {
                const difference = @as(i32, pixels[offset + channel]) - color[channel];
                error_sum += @as(u64, @intCast(difference * difference)) * weights[channel];
            }
        }
        const rmse = @sqrt(@as(f64, @floatFromInt(error_sum)) / (width * height * 9));
        var filtered_error: f64 = 0;
        var blocks: usize = 0;
        var block_y: usize = 0;
        while (block_y < height) : (block_y += 4) {
            var block_x: usize = 0;
            while (block_x < width) : (block_x += 4) {
                for (0..3) |channel| {
                    var source_sum: i32 = 0;
                    var output_sum: i32 = 0;
                    for (block_y..@min(block_y + 4, height)) |y| {
                        for (block_x..@min(block_x + 4, width)) |x| {
                            const pixel = y * width + x;
                            source_sum += pixels[pixel * 4 + channel];
                            output_sum += quantized.palette[quantized.indices[pixel]][channel];
                        }
                    }
                    const difference = @as(f64, @floatFromInt(source_sum - output_sum)) / 16.0;
                    filtered_error += difference * difference * @as(f64, @floatFromInt(weights[channel]));
                }
                blocks += 1;
            }
        }
        const filtered_rmse = @sqrt(filtered_error / @as(f64, @floatFromInt(blocks * 9)));
        const maximum_rmse: f64 = switch (color_limit) {
            64 => 19,
            128 => 15.5,
            255 => 12.2,
            else => unreachable,
        };
        const maximum_filtered_rmse: f64 = switch (color_limit) {
            64 => 4.3,
            128 => 2.7,
            255 => 2.5,
            else => unreachable,
        };
        try std.testing.expect(rmse <= maximum_rmse);
        try std.testing.expect(filtered_rmse <= maximum_filtered_rmse);
    }
}

test "kitty transmits decoded JPEG images as raw RGB pixels" {
    const jpeg = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, "../core/src/tests/fixtures/images/halves.jpg", std.testing.allocator, .limited(1 << 20));
    defer std.testing.allocator.free(jpeg);
    const decoded = try image.decode(std.testing.allocator, jpeg, .{});
    defer decoded.deinit();
    try std.testing.expect(decoded.encoded_png == null);
    try std.testing.expectEqual(@as(u32, 0), decoded.metadata.has_alpha);

    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try terminal_image.writeKittyTransmit(&output.writer, decoded, 21, false);
    try std.testing.expect(std.mem.find(u8, output.written(), "a=t,f=24,s=16,v=8,i=21") != null);

    const transmitted = try decodeKittyChunks(output.written());
    defer std.testing.allocator.free(transmitted);
    try std.testing.expectEqual(@as(usize, 16 * 8 * 3), transmitted.len);
    for (0..16 * 8) |pixel| {
        try std.testing.expectEqual(decoded.pixels[pixel * 4], transmitted[pixel * 3]);
        try std.testing.expectEqual(decoded.pixels[pixel * 4 + 1], transmitted[pixel * 3 + 1]);
        try std.testing.expectEqual(decoded.pixels[pixel * 4 + 2], transmitted[pixel * 3 + 2]);
    }
}

test "kitty transmits decoded WebP alpha images as raw RGBA pixels" {
    const webp = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, "../core/src/tests/fixtures/images/alpha.webp", std.testing.allocator, .limited(1 << 20));
    defer std.testing.allocator.free(webp);
    const decoded = try image.decode(std.testing.allocator, webp, .{});
    defer decoded.deinit();
    try std.testing.expect(decoded.encoded_png == null);
    try std.testing.expectEqual(@as(u32, 1), decoded.metadata.has_alpha);

    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try terminal_image.writeKittyTransmit(&output.writer, decoded, 22, false);
    try std.testing.expect(std.mem.find(u8, output.written(), "f=32") != null);

    const transmitted = try decodeKittyChunks(output.written());
    defer std.testing.allocator.free(transmitted);
    try std.testing.expectEqualSlices(u8, decoded.pixels, transmitted);
}

test "kitty tmux passthrough wraps placement and delete frames" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try terminal_image.writeKittyPlacement(&output.writer, 5, 6, 1, 2, 3, 4, 0, 0, 3, 4, -7, true);
    // The cursor move stays outside the passthrough; the graphics frame is wrapped.
    try std.testing.expect(std.mem.startsWith(u8, output.written(), "\x1b[3;2H\x1bPtmux;\x1b\x1b_G"));
    try std.testing.expect(std.mem.endsWith(u8, output.written(), "\x1b\x1b\\\x1b\\"));
    try std.testing.expect(std.mem.find(u8, output.written(), "a=p,i=5,p=6") != null);

    output.clearRetainingCapacity();
    try terminal_image.writeKittyDelete(&output.writer, 5, 6, true, true);
    try std.testing.expect(std.mem.startsWith(u8, output.written(), "\x1bPtmux;\x1b\x1b_G"));
    try std.testing.expect(std.mem.endsWith(u8, output.written(), "\x1b\x1b\\\x1b\\"));
    try std.testing.expect(std.mem.find(u8, output.written(), "a=d,d=I,i=5,p=6") != null);

    output.clearRetainingCapacity();
    try terminal_image.writeKittyDelete(&output.writer, 9, null, false, true);
    try std.testing.expect(std.mem.find(u8, output.written(), "a=d,d=i,i=9") != null);
    try std.testing.expect(std.mem.find(u8, output.written(), "p=") == null);
}

test "sixel tmux passthrough wraps the framed payload" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try terminal_image.writeSixelFramedPayload(&output.writer, "0;1;0qPAYLOAD", true);
    try std.testing.expectEqualStrings("\x1bPtmux;\x1b\x1bP0;1;0qPAYLOAD\x1b\x1b\\\x1b\\", output.written());

    output.clearRetainingCapacity();
    try terminal_image.writeSixelFramedPayload(&output.writer, "0;1;0qPAYLOAD", false);
    try std.testing.expectEqualStrings("\x1bP0;1;0qPAYLOAD\x1b\\", output.written());
}
