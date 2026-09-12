const std = @import("std");
const image = @import("../image.zig");

fn makeImage(pixels: []const u8, width: u32, height: u32) !*image.Image {
    return image.createFromRgba(std.testing.allocator, pixels, width, height, width * 4);
}

test "reusable RGBA updates keep the allocation and reject pinned or invalid writes" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const first = [_]u8{ 1, 2, 3, 255, 4, 5, 6, 255 };
    const second = [_]u8{ 7, 8, 9, 128, 0, 0, 0, 0, 10, 11, 12, 255 };
    const value = try image.createFromRgba(failing.allocator(), &first, 1, 2, 4);
    defer value.deinit();
    failing.fail_index = failing.alloc_index;
    const pointer = value.pixels.ptr;
    const metadata = value.info();

    value.retain();
    try std.testing.expectError(error.Busy, image.updatePixels(value, &second, .{ .stride = 8 }));
    try std.testing.expectError(error.InvalidArgument, image.updatePixels(value, &second, .{ .stride = 3 }));
    try std.testing.expectError(error.InvalidArgument, image.updatePixels(value, second[0..11], .{ .stride = 8 }));
    try std.testing.expectEqualSlices(u8, &first, value.pixels);
    try std.testing.expectEqual(metadata, value.info());
    value.deinit();

    try image.updatePixels(value, &second, .{ .stride = 8 });
    try std.testing.expectEqual(pointer, value.pixels.ptr);
    try std.testing.expectEqualSlices(u8, &[_]u8{ 7, 8, 9, 128, 10, 11, 12, 255 }, value.pixels);
    try std.testing.expectEqual(@as(u32, 1), value.metadata.has_alpha);
    try image.updatePixels(value, &first, .{ .stride = 4 });
    try std.testing.expectEqual(@as(u32, 0), value.metadata.has_alpha);
    try std.testing.expect(!failing.has_induced_failure);
}

test "reusable pixel updates invalidate PNG encoding without changing cloned snapshots" {
    const value = try makeImage(&.{ 255, 0, 0, 255 }, 1, 1);
    defer value.deinit();
    _ = try value.ensureEncodedPng();
    const snapshot = try value.clone();
    defer snapshot.deinit();

    try image.updatePixels(value, &.{ 255, 0, 0, 128 }, .{ .stride = 4, .format = .bgra8 });
    try std.testing.expect(value.encoded_png == null);
    const decoded = try image.decode(std.testing.allocator, try value.ensureEncodedPng(), .{});
    defer decoded.deinit();
    try std.testing.expectEqualSlices(u8, &.{ 0, 0, 255, 128 }, try decoded.ensurePixels());
    try std.testing.expectEqualSlices(u8, &.{ 255, 0, 0, 255 }, snapshot.pixels);
    try std.testing.expect(snapshot.encoded_png != null);
    try std.testing.expectError(error.InvalidArgument, image.updatePixels(decoded, &.{ 1, 2, 3, 4 }, .{ .stride = 4 }));
}

test "reusable pixel updates convert strided 65x3 BGRA without allocating" {
    const width = 65;
    const height = 3;
    const stride = width * 4 + 7;
    var source = [_]u8{0} ** (1 + stride * (height - 1) + width * 4);
    var expected: [width * height * 4]u8 = undefined;
    for (0..height) |y| {
        for (0..width) |x| {
            const pixel: u8 = @intCast(y * width + x);
            source[1 + y * stride + x * 4 ..][0..4].* = .{ pixel, pixel ^ 0x55, 255 - pixel, 255 };
            expected[(y * width + x) * 4 ..][0..4].* = .{ 255 - pixel, pixel ^ 0x55, pixel, 255 };
        }
    }
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const value = try image.createFromPixels(failing.allocator(), source[1..], width, height, .{
        .stride = stride,
        .format = .bgra8,
    });
    defer value.deinit();
    failing.fail_index = failing.alloc_index;
    const pointer = value.pixels.ptr;
    source[source.len - 1] = 128;

    for ([_]image.PixelAlpha{ .straight, .@"opaque" }) |alpha| {
        expected[expected.len - 1] = if (alpha == .straight) 128 else 255;
        try image.updatePixels(value, source[1..], .{ .stride = stride, .format = .bgra8, .alpha = alpha });
        try std.testing.expectEqual(pointer, value.pixels.ptr);
        try std.testing.expectEqualSlices(u8, &expected, value.pixels);
        try std.testing.expectEqual(@intFromBool(alpha == .straight), value.info().has_alpha);
    }
    try std.testing.expect(!failing.has_induced_failure);
}

fn decodeBase64(encoded: []const u8) ![]u8 {
    const size = try std.base64.standard.Decoder.calcSizeForSlice(encoded);
    const decoded = try std.testing.allocator.alloc(u8, size);
    errdefer std.testing.allocator.free(decoded);
    try std.base64.standard.Decoder.decode(decoded, encoded);
    return decoded;
}

fn appendBytes(data: []const u8, suffix: []const u8) ![]u8 {
    const combined = try std.testing.allocator.alloc(u8, data.len + suffix.len);
    @memcpy(combined[0..data.len], data);
    @memcpy(combined[data.len..], suffix);
    return combined;
}

fn pngChunk(kind: *const [4]u8, payload: []const u8) ![]u8 {
    const chunk = try std.testing.allocator.alloc(u8, payload.len + 12);
    std.mem.writeInt(u32, chunk[0..4], @intCast(payload.len), .big);
    @memcpy(chunk[4..8], kind);
    @memcpy(chunk[8 .. 8 + payload.len], payload);
    std.mem.writeInt(u32, chunk[8 + payload.len ..][0..4], std.hash.Crc32.hash(chunk[4 .. 8 + payload.len]), .big);
    return chunk;
}

fn expectMalformedPng(data: []const u8) !void {
    var info: image.Info = .{};
    try std.testing.expectEqual(image.Status.malformed_input, image.probe(data, .{}, &info));
    try std.testing.expectError(error.MalformedInput, image.decode(std.testing.allocator, data, .{}));
}

fn decodePngWithAllocator(allocator: std.mem.Allocator, png: []const u8) !void {
    const decoded = try image.decode(allocator, png, .{});
    defer decoded.deinit();
}

fn clonePngWithAllocator(allocator: std.mem.Allocator, png: []const u8) !void {
    const decoded = try image.decode(allocator, png, .{});
    defer decoded.deinit();
    const cloned = try decoded.clone();
    defer cloned.deinit();
}

fn resizeWithAllocator(allocator: std.mem.Allocator) !void {
    const source = try image.createFromRgba(allocator, &[_]u8{
        255, 0, 0,   255, 0,   255, 0,   255,
        0,   0, 255, 255, 255, 255, 255, 255,
    }, 2, 2, 8);
    defer source.deinit();
    const resized = try image.resize(allocator, source, 3, 3, .area);
    defer resized.deinit();
}

fn encodePngWithAllocator(allocator: std.mem.Allocator) !void {
    const source = try image.createFromRgba(allocator, &[_]u8{ 1, 2, 3, 255 }, 1, 1, 4);
    defer source.deinit();
    _ = try source.ensureEncodedPng();
}

test "image operations release partial allocations on OOM" {
    const png = try decodeBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==");
    defer std.testing.allocator.free(png);

    try std.testing.checkAllAllocationFailures(std.testing.allocator, decodePngWithAllocator, .{png});
    try std.testing.checkAllAllocationFailures(std.testing.allocator, clonePngWithAllocator, .{png});
    try std.testing.checkAllAllocationFailures(std.testing.allocator, resizeWithAllocator, .{});
    try std.testing.checkAllAllocationFailures(std.testing.allocator, encodePngWithAllocator, .{});
}

test "image inspection does not retain encoded PNG bytes" {
    const png = try decodeBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==");
    defer std.testing.allocator.free(png);
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 2 });
    var info: image.Info = .{};

    try std.testing.expectEqual(image.Status.ok, image.inspect(failing.allocator(), png, .{}, &info));
    try std.testing.expect(!failing.has_induced_failure);
}

test "PNG probe and decode return canonical red RGBA" {
    const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==";
    const png = try decodeBase64(encoded);
    defer std.testing.allocator.free(png);

    var info: image.Info = .{};
    try std.testing.expectEqual(image.Status.ok, image.probe(png, .{}, &info));
    try std.testing.expectEqual(@as(u32, 1), info.width);
    try std.testing.expectEqual(@as(u32, 1), info.height);
    try std.testing.expectEqual(@as(u32, 1), info.has_alpha);

    const decoded = try image.decode(std.testing.allocator, png, .{});
    defer decoded.deinit();
    try std.testing.expectEqualSlices(u8, &[_]u8{ 255, 0, 0, 255 }, decoded.pixels);
}

test "ICC transforms are cached across images and materialization" {
    image.clearIccCache();
    defer image.clearIccCache();
    const rgb_encoded = std.mem.trim(u8, @embedFile("fixtures/display-p3.png.base64"), "\r\n");
    const rgb_png = try decodeBase64(rgb_encoded);
    defer std.testing.allocator.free(rgb_png);

    const first = try image.decode(std.testing.allocator, rgb_png, .{});
    defer first.deinit();
    try std.testing.expectEqual(image.IccCacheStats{ .hits = 0, .misses = 1, .entries = 1 }, image.getIccCacheStats());

    const second = try image.decode(std.testing.allocator, rgb_png, .{});
    defer second.deinit();
    try std.testing.expectEqual(image.IccCacheStats{ .hits = 1, .misses = 1, .entries = 1 }, image.getIccCacheStats());
    _ = try first.ensurePixels();
    try std.testing.expectEqual(image.IccCacheStats{ .hits = 2, .misses = 1, .entries = 1 }, image.getIccCacheStats());

    const rgba_encoded = std.mem.trim(u8, @embedFile("fixtures/display-p3-rgba.png.base64"), "\r\n");
    const rgba_png = try decodeBase64(rgba_encoded);
    defer std.testing.allocator.free(rgba_png);
    const rgba = try image.decode(std.testing.allocator, rgba_png, .{});
    defer rgba.deinit();
    try std.testing.expectEqual(image.IccCacheStats{ .hits = 4, .misses = 1, .entries = 1 }, image.getIccCacheStats());

    image.clearIccCache();
    try std.testing.expectEqual(image.IccCacheStats{ .hits = 0, .misses = 0, .entries = 0 }, image.getIccCacheStats());

    const gray_encoded = std.mem.trim(u8, @embedFile("fixtures/gray-profile.png.base64"), "\r\n");
    const gray_png = try decodeBase64(gray_encoded);
    defer std.testing.allocator.free(gray_png);
    const gray = try image.decode(std.testing.allocator, gray_png, .{});
    defer gray.deinit();

    const gray_alpha_encoded = std.mem.trim(u8, @embedFile("fixtures/gray-alpha-profile.png.base64"), "\r\n");
    const gray_alpha_png = try decodeBase64(gray_alpha_encoded);
    defer std.testing.allocator.free(gray_alpha_png);
    const gray_alpha = try image.decode(std.testing.allocator, gray_alpha_png, .{});
    defer gray_alpha.deinit();
    try std.testing.expectEqual(image.IccCacheStats{ .hits = 2, .misses = 1, .entries = 1 }, image.getIccCacheStats());
}

test "lazy PNG materialization preserves admitted decode limits" {
    const encoded = std.mem.trim(u8, @embedFile("fixtures/wide-opaque.png.base64"), "\r\n");
    const png = try decodeBase64(encoded);
    defer std.testing.allocator.free(png);
    const decoded = try image.decode(std.testing.allocator, png, .{
        .max_width = 20_000,
        .max_pixels = 20_000,
        .max_decoded_bytes = 100_000,
    });
    defer decoded.deinit();
    try std.testing.expectEqual(@as(usize, 0), decoded.pixels.len);
    const pixels = try decoded.ensurePixels();
    try std.testing.expectEqual(@as(usize, 16_385 * 4), pixels.len);
    try std.testing.expectEqualSlices(u8, &[_]u8{ 255, 0, 0, 255 }, pixels[0..4]);
}

test "PNG accepts only ASCII whitespace after IEND and retains the effective PNG range" {
    const png = try decodeBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==");
    defer std.testing.allocator.free(png);

    const suffixes = [_][]const u8{ "", " ", " \t\n\r" };
    for (suffixes) |suffix| {
        const input = try appendBytes(png, suffix);
        defer std.testing.allocator.free(input);

        var info: image.Info = .{};
        try std.testing.expectEqual(image.Status.ok, image.probe(input, .{}, &info));
        const decoded = try image.decode(std.testing.allocator, input, .{});
        defer decoded.deinit();
        try std.testing.expectEqualSlices(u8, &[_]u8{ 255, 0, 0, 255 }, decoded.pixels);
        try std.testing.expectEqualSlices(u8, png, decoded.encoded_png.?);
    }
}

test "PNG rejects non-whitespace data and chunks after IEND" {
    const png = try decodeBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==");
    defer std.testing.allocator.free(png);

    const nul_suffix = try appendBytes(png, &[_]u8{0});
    defer std.testing.allocator.free(nul_suffix);
    try expectMalformedPng(nul_suffix);

    const binary_suffix = try appendBytes(png, &[_]u8{ 0x01, 0xFE, 0x7F });
    defer std.testing.allocator.free(binary_suffix);
    try expectMalformedPng(binary_suffix);

    const extra_chunk = try pngChunk("tEXt", "");
    defer std.testing.allocator.free(extra_chunk);
    const chunk_after_iend = try appendBytes(png, extra_chunk);
    defer std.testing.allocator.free(chunk_after_iend);
    try expectMalformedPng(chunk_after_iend);
}

test "PNG rejects malformed IEND and chunk bounds" {
    const png = try decodeBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==");
    defer std.testing.allocator.free(png);
    const iend_offset = png.len - 12;

    const nonzero_iend = try pngChunk("IEND", &[_]u8{0});
    defer std.testing.allocator.free(nonzero_iend);
    const with_nonzero_iend = try appendBytes(png[0..iend_offset], nonzero_iend);
    defer std.testing.allocator.free(with_nonzero_iend);
    try expectMalformedPng(with_nonzero_iend);

    try expectMalformedPng(png[0 .. png.len - 1]);

    const overflowing_length = try std.testing.allocator.dupe(u8, png);
    defer std.testing.allocator.free(overflowing_length);
    std.mem.writeInt(u32, overflowing_length[iend_offset..][0..4], std.math.maxInt(u32), .big);
    try expectMalformedPng(overflowing_length);
}

test "PNG rejects cICP after image data" {
    const png = try decodeBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==");
    defer std.testing.allocator.free(png);

    var chunk = [_]u8{ 0, 0, 0, 4, 'c', 'I', 'C', 'P', 1, 13, 0, 1, 0, 0, 0, 0 };
    const crc = std.hash.Crc32.hash(chunk[4..12]);
    std.mem.writeInt(u32, chunk[12..16], crc, .big);
    const late = try std.testing.allocator.alloc(u8, png.len + chunk.len);
    defer std.testing.allocator.free(late);
    const iend = png.len - 12;
    @memcpy(late[0..iend], png[0..iend]);
    @memcpy(late[iend .. iend + chunk.len], &chunk);
    @memcpy(late[iend + chunk.len ..], png[iend..]);

    var info: image.Info = .{};
    try std.testing.expectEqual(image.Status.malformed_input, image.probe(late, .{}, &info));
    try std.testing.expectError(error.MalformedInput, image.decode(std.testing.allocator, late, .{}));
}

test "GIF probe and first frame decode preserve logical canvas transparency" {
    const gif = try decodeBase64("R0lGODlhAgACAPAAAAAAAP8AACH5BAEAAAAALAAAAAACAAIAAAIDDBAFADs=");
    defer std.testing.allocator.free(gif);
    var info: image.Info = .{};
    try std.testing.expectEqual(image.Status.ok, image.probe(gif, .{}, &info));
    try std.testing.expectEqual(@as(u32, @intFromEnum(image.Format.gif)), info.format);
    try std.testing.expectEqual(@as(u32, 2), info.width);
    try std.testing.expectEqual(@as(u32, 2), info.height);
    try std.testing.expectEqual(@as(u32, 1), info.has_alpha);

    const decoded = try image.decode(std.testing.allocator, gif, .{});
    defer decoded.deinit();
    try std.testing.expectEqual(info, decoded.info());
    try std.testing.expectEqualSlices(u8, &[_]u8{
        255, 0, 0, 255, 0,   0, 0, 0,
        0,   0, 0, 0,   255, 0, 0, 255,
    }, decoded.pixels);
}

test "GIF first frame offset exposes the logical background palette index" {
    const encoded = "R0lGODlhAwADAPAAAP8AAAAAACH5BAAAAAAALAEAAQABAAEAAAICRAEAOw==";
    const gif = try decodeBase64(encoded);
    defer std.testing.allocator.free(gif);
    gif[11] = 1;

    const decoded = try image.decode(std.testing.allocator, gif, .{});
    defer decoded.deinit();
    try std.testing.expectEqual(@as(u32, 3), decoded.width());
    try std.testing.expectEqual(@as(u32, 3), decoded.height());
    const center = (1 * 3 + 1) * 4;
    try std.testing.expectEqualSlices(u8, &[_]u8{ 0, 0, 0, 255 }, decoded.pixels[0..4]);
    try std.testing.expectEqualSlices(u8, &[_]u8{ 255, 0, 0, 255 }, decoded.pixels[center .. center + 4]);
}

test "animated GIF decode returns only the first displayed frame" {
    const gif = try decodeBase64("R0lGODlhAgACAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAACAoRRACH5BAAKAAAALAAAAAACAAIAgAAA/wAAAAIChFEAOw==");
    defer std.testing.allocator.free(gif);
    const decoded = try image.decode(std.testing.allocator, gif, .{});
    defer decoded.deinit();
    var offset: usize = 0;
    while (offset < decoded.pixels.len) : (offset += 4) {
        try std.testing.expectEqualSlices(u8, &[_]u8{ 255, 0, 0, 255 }, decoded.pixels[offset .. offset + 4]);
    }
}

test "baseline and progressive JPEG decode to opaque RGBA" {
    const fixtures = [_][]const u8{
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==",
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wgARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABUBAQEAAAAAAAAAAAAAAAAAAAYI/9oADAMBAAIQAxAAAAE5C1T/AP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//aAAwDAQACAAMAAAAQ/wD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==",
    };
    for (fixtures) |encoded| {
        const jpeg = try decodeBase64(encoded);
        defer std.testing.allocator.free(jpeg);
        var info: image.Info = .{};
        try std.testing.expectEqual(image.Status.ok, image.probe(jpeg, .{}, &info));
        try std.testing.expectEqual(@as(u32, @intFromEnum(image.Format.jpeg)), info.format);
        try std.testing.expectEqual(@as(u32, 3), info.width);
        try std.testing.expectEqual(@as(u32, 2), info.height);
        try std.testing.expectEqual(@as(u32, 0), info.has_alpha);
        const decoded = try image.decode(std.testing.allocator, jpeg, .{});
        defer decoded.deinit();
        try std.testing.expectEqual(info, decoded.info());
        for (decoded.pixels[3..], 0..) |channel, index| {
            if (index % 4 == 0) try std.testing.expectEqual(@as(u8, 255), channel);
        }
    }
}

test "JPEG decode rejects EOI bytes embedded in a comment without a terminal EOI marker" {
    const encoded = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==";
    const jpeg = try decodeBase64(encoded);
    defer std.testing.allocator.free(jpeg);

    const malformed = try std.testing.allocator.alloc(u8, jpeg.len + 4);
    defer std.testing.allocator.free(malformed);
    @memcpy(malformed[0..2], jpeg[0..2]);
    @memcpy(malformed[2..8], &[_]u8{ 0xFF, 0xFE, 0x00, 0x04, 0xFF, 0xD9 });
    @memcpy(malformed[8..], jpeg[2 .. jpeg.len - 2]);

    try std.testing.expectError(error.MalformedInput, image.decode(std.testing.allocator, malformed, .{}));
}

test "JPEG decode rejects EOI before the first scan" {
    const encoded = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==";
    const jpeg = try decodeBase64(encoded);
    defer std.testing.allocator.free(jpeg);
    const sos = std.mem.find(u8, jpeg, &[_]u8{ 0xFF, 0xDA }) orelse return error.TestUnexpectedResult;

    const malformed = try std.testing.allocator.alloc(u8, sos + 2);
    defer std.testing.allocator.free(malformed);
    @memcpy(malformed[0..sos], jpeg[0..sos]);
    @memcpy(malformed[sos..], &[_]u8{ 0xFF, 0xD9 });

    try std.testing.expectError(error.MalformedInput, image.decode(std.testing.allocator, malformed, .{}));
}

test "JPEG decode rejects a scan without entropy data" {
    const encoded = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==";
    const jpeg = try decodeBase64(encoded);
    defer std.testing.allocator.free(jpeg);
    const sos = std.mem.find(u8, jpeg, &[_]u8{ 0xFF, 0xDA }) orelse return error.TestUnexpectedResult;
    const scan_header_length = std.mem.readInt(u16, jpeg[sos + 2 ..][0..2], .big);
    const after_scan_header = sos + 2 + scan_header_length;

    const malformed = try std.testing.allocator.alloc(u8, after_scan_header + 2);
    defer std.testing.allocator.free(malformed);
    @memcpy(malformed[0..after_scan_header], jpeg[0..after_scan_header]);
    @memcpy(malformed[after_scan_header..], &[_]u8{ 0xFF, 0xD9 });

    try std.testing.expectError(error.MalformedInput, image.decode(std.testing.allocator, malformed, .{}));
}

test "JPEG decode rejects an incomplete entropy-coded scan" {
    const encoded = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==";
    const jpeg = try decodeBase64(encoded);
    defer std.testing.allocator.free(jpeg);
    const sos = std.mem.find(u8, jpeg, &[_]u8{ 0xFF, 0xDA }) orelse return error.TestUnexpectedResult;
    const scan_header_length = std.mem.readInt(u16, jpeg[sos + 2 ..][0..2], .big);
    const after_scan_header = sos + 2 + scan_header_length;

    const malformed = try std.testing.allocator.alloc(u8, after_scan_header + 3);
    defer std.testing.allocator.free(malformed);
    @memcpy(malformed[0 .. after_scan_header + 1], jpeg[0 .. after_scan_header + 1]);
    @memcpy(malformed[after_scan_header + 1 ..], &[_]u8{ 0xFF, 0xD9 });

    try std.testing.expectError(error.MalformedInput, image.decode(std.testing.allocator, malformed, .{}));
}

test "JPEG probe applies dimension limits before full scan validation" {
    const encoded = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==";
    const jpeg = try decodeBase64(encoded);
    defer std.testing.allocator.free(jpeg);
    const sos = std.mem.find(u8, jpeg, &[_]u8{ 0xFF, 0xDA }) orelse return error.TestUnexpectedResult;
    const scan_header_length = std.mem.readInt(u16, jpeg[sos + 2 ..][0..2], .big);
    const after_scan_header = sos + 2 + scan_header_length;

    const malformed = try std.testing.allocator.alloc(u8, after_scan_header + 3);
    defer std.testing.allocator.free(malformed);
    @memcpy(malformed[0 .. after_scan_header + 1], jpeg[0 .. after_scan_header + 1]);
    @memcpy(malformed[after_scan_header + 1 ..], &[_]u8{ 0xFF, 0xD9 });

    var info: image.Info = .{};
    try std.testing.expectEqual(image.Status.dimension_limit, image.probe(malformed, .{ .max_pixels = 0 }, &info));
    try std.testing.expectEqual(image.Status.malformed_input, image.probe(malformed, .{}, &info));
}

test "progressive JPEG decode rejects a final scan without entropy data" {
    const encoded = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wgARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABUBAQEAAAAAAAAAAAAAAAAAAAYI/9oADAMBAAIQAxAAAAE5C1T/AP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//aAAwDAQACAAMAAAAQ/wD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==";
    const jpeg = try decodeBase64(encoded);
    defer std.testing.allocator.free(jpeg);

    var search_start: usize = 0;
    var final_sos: ?usize = null;
    while (std.mem.findPos(u8, jpeg, search_start, &[_]u8{ 0xFF, 0xDA })) |sos| {
        final_sos = sos;
        search_start = sos + 2;
    }
    const sos = final_sos orelse return error.TestUnexpectedResult;
    const scan_header_length = std.mem.readInt(u16, jpeg[sos + 2 ..][0..2], .big);
    const after_scan_header = sos + 2 + scan_header_length;

    const malformed = try std.testing.allocator.alloc(u8, after_scan_header + 2);
    defer std.testing.allocator.free(malformed);
    @memcpy(malformed[0..after_scan_header], jpeg[0..after_scan_header]);
    @memcpy(malformed[after_scan_header..], &[_]u8{ 0xFF, 0xD9 });

    try std.testing.expectError(error.MalformedInput, image.decode(std.testing.allocator, malformed, .{}));
}

test "JPEG decode accepts trailing data after a complete stream" {
    const encoded = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==";
    const jpeg = try decodeBase64(encoded);
    defer std.testing.allocator.free(jpeg);

    const with_trailing_data = try std.testing.allocator.alloc(u8, jpeg.len + 3);
    defer std.testing.allocator.free(with_trailing_data);
    @memcpy(with_trailing_data[0..jpeg.len], jpeg);
    @memcpy(with_trailing_data[jpeg.len..], &[_]u8{ 1, 2, 3 });

    const decoded = try image.decode(std.testing.allocator, with_trailing_data, .{});
    defer decoded.deinit();
    try std.testing.expectEqual(@as(u32, 3), decoded.width());
    try std.testing.expectEqual(@as(u32, 2), decoded.height());
}

test "lossy lossless and alpha WebP decode to canonical RGBA" {
    const fixtures = [_]struct {
        encoded: []const u8,
        width: u32,
        height: u32,
        has_alpha: u32,
        pixels: []const u8,
    }{
        .{
            .encoded = "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoDAAIAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=",
            .width = 3,
            .height = 2,
            .has_alpha = 0,
            .pixels = &([_]u8{ 255, 1, 0, 255 } ** 6),
        },
        .{
            .encoded = "UklGRhwAAABXRUJQVlA4TA8AAAAvAkAAAAcQ/Y/+ByKi/wEA",
            .width = 3,
            .height = 2,
            .has_alpha = 0,
            .pixels = &([_]u8{ 255, 0, 0, 255 } ** 6),
        },
        .{
            .encoded = "UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAEA8Q8x/zH4wViOh/CAA=",
            .width = 2,
            .height = 2,
            .has_alpha = 1,
            .pixels = &[_]u8{
                255, 0, 0, 255, 0,   0, 0, 0,
                0,   0, 0, 0,   255, 0, 0, 255,
            },
        },
    };
    for (fixtures) |fixture| {
        const webp = try decodeBase64(fixture.encoded);
        defer std.testing.allocator.free(webp);
        var info: image.Info = .{};
        try std.testing.expectEqual(image.Status.ok, image.probe(webp, .{}, &info));
        try std.testing.expectEqual(@as(u32, @intFromEnum(image.Format.webp)), info.format);
        try std.testing.expectEqual(fixture.width, info.width);
        try std.testing.expectEqual(fixture.height, info.height);
        try std.testing.expectEqual(fixture.has_alpha, info.has_alpha);
        const decoded = try image.decode(std.testing.allocator, webp, .{});
        defer decoded.deinit();
        try std.testing.expectEqual(info, decoded.info());
        try std.testing.expectEqual(@as(usize, fixture.width * fixture.height * 4), decoded.pixels.len);
        try std.testing.expectEqualSlices(u8, fixture.pixels, decoded.pixels);
    }
}

test "PNG probe distinguishes unsupported input, corruption, and limits" {
    var info: image.Info = .{};
    try std.testing.expectEqual(image.Status.unsupported_format, image.probe("not png", .{}, &info));

    const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==";
    const png = try decodeBase64(encoded);
    defer std.testing.allocator.free(png);
    png[29] ^= 1;
    try std.testing.expectEqual(image.Status.malformed_input, image.probe(png, .{}, &info));
    png[29] ^= 1;
    try std.testing.expectEqual(image.Status.memory_limit, image.probe(png, .{ .max_encoded_bytes = 1 }, &info));
    try std.testing.expectEqual(image.Status.dimension_limit, image.probe(png, .{ .max_pixels = 0 }, &info));
}

test "image creation copies strided RGBA input" {
    const pixels = [_]u8{
        1, 2,  3,  4,  5,  6,  7,  8,  99, 99, 99, 99,
        9, 10, 11, 12, 13, 14, 15, 16, 99, 99, 99, 99,
    };
    const value = try image.createFromRgba(std.testing.allocator, &pixels, 2, 2, 12);
    defer value.deinit();
    try std.testing.expectEqualSlices(u8, &[_]u8{ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 }, value.pixels);
}

test "image creation records actual transparency" {
    const opaque_image = try image.createFromRgba(std.testing.allocator, &[_]u8{ 1, 2, 3, 255 }, 1, 1, 4);
    defer opaque_image.deinit();
    try std.testing.expectEqual(@as(u32, 0), opaque_image.metadata.has_alpha);

    const transparent = try image.createFromRgba(std.testing.allocator, &[_]u8{ 1, 2, 3, 254 }, 1, 1, 4);
    defer transparent.deinit();
    try std.testing.expectEqual(@as(u32, 1), transparent.metadata.has_alpha);
}

test "image creation rejects invalid stride and short input" {
    const pixels = [_]u8{0} ** 16;
    try std.testing.expectError(error.InvalidArgument, image.createFromRgba(std.testing.allocator, &pixels, 2, 2, 7));
    try std.testing.expectError(error.InvalidArgument, image.createFromRgba(std.testing.allocator, pixels[0..15], 2, 2, 8));
}

test "pixel import converts strided RGBA and BGRA into owned straight RGBA" {
    const allocator = std.testing.allocator;
    const expected = [_]u8{ 255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 7, 11, 23, 254 };
    for ([_]image.PixelFormat{ .rgba8, .bgra8 }) |format| {
        for ([_]image.PixelAlpha{ .straight, .@"opaque" }) |alpha| {
            var source = [_]u8{99} ** 24;
            for (0..4) |index| {
                const src = index * 4;
                const dst = 1 + (index / 2) * 11 + (index % 2) * 4;
                source[dst..][0..4].* = .{
                    expected[src + @as(usize, if (format == .bgra8) 2 else 0)],
                    expected[src + 1],
                    expected[src + @as(usize, if (format == .bgra8) 0 else 2)],
                    expected[src + 3],
                };
            }
            // The view starts unaligned and omits the final row's padding.
            const value = try image.createFromPixels(allocator, source[1..20], 2, 2, .{
                .stride = 11,
                .format = format,
                .alpha = alpha,
            });
            defer value.deinit();
            @memset(&source, 0);
            var output = expected;
            if (alpha == .@"opaque") {
                for (0..4) |index| output[index * 4 + 3] = 255;
            }
            try std.testing.expectEqualSlices(u8, &output, value.pixels);
            try std.testing.expectEqual(image.Info{
                .width = 2,
                .height = 2,
                .source_width = 2,
                .source_height = 2,
                .format = @intFromEnum(image.Format.raw_rgba),
                .color_status = @intFromEnum(image.ColorStatus.explicit_srgb),
                .has_alpha = @intFromBool(alpha == .straight),
            }, value.info());
        }
    }
}

test "pixel import ignores padding when detecting transparency" {
    const pixels = [_]u8{ 1, 2, 3, 255, 0, 0, 0, 0, 4, 5, 6, 255 };
    const value = try image.createFromPixels(std.testing.allocator, &pixels, 1, 2, .{ .stride = 8 });
    defer value.deinit();
    try std.testing.expectEqualSlices(u8, &[_]u8{ 1, 2, 3, 255, 4, 5, 6, 255 }, value.pixels);
    try std.testing.expectEqual(@as(u32, 0), value.info().has_alpha);
}

test "pixel import handles vector boundaries and transparency in the final pixel" {
    for ([_]u32{ 3, 4, 5, 8 }) |width| {
        const len = width * 4;
        var pixels = [_]u8{255} ** (8 * 4);
        for ([_]image.PixelFormat{ .rgba8, .bgra8 }) |format| {
            for ([_]image.PixelAlpha{ .straight, .@"opaque" }) |alpha| {
                for ([_]u8{ 255, 0, 128, 254 }) |last_alpha| {
                    pixels[len - 4 ..][0..4].* = .{ 1, 2, 3, last_alpha };
                    const value = try image.createFromPixels(std.testing.allocator, pixels[0..len], width, 1, .{
                        .stride = len + 3,
                        .format = format,
                        .alpha = alpha,
                    });
                    defer value.deinit();
                    const expected_alpha: u8 = if (alpha == .@"opaque") 255 else last_alpha;
                    const expected: [4]u8 = if (format == .bgra8)
                        .{ 3, 2, 1, expected_alpha }
                    else
                        .{ 1, 2, 3, expected_alpha };
                    try std.testing.expectEqualSlices(u8, &expected, value.pixels[len - 4 ..]);
                    try std.testing.expectEqual(@intFromBool(expected_alpha != 255), value.info().has_alpha);
                }
            }
        }
    }
}

test "pixel import rejects invalid geometry and short input before allocation" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    const allocator = failing.allocator();
    const pixels = [_]u8{0} ** 20;
    for ([_]struct { width: u32, height: u32, stride: u32, len: usize, err: anyerror }{
        .{ .width = 0, .height = 1, .stride = 4, .len = 4, .err = error.DimensionLimit },
        .{ .width = 1, .height = 0, .stride = 4, .len = 4, .err = error.DimensionLimit },
        .{ .width = std.math.maxInt(u32), .height = 1, .stride = 4, .len = 4, .err = error.InvalidArgument },
        .{ .width = 1, .height = std.math.maxInt(u32), .stride = std.math.maxInt(u32), .len = 4, .err = error.InvalidArgument },
        .{ .width = 2, .height = 2, .stride = 7, .len = 20, .err = error.InvalidArgument },
        .{ .width = 2, .height = 2, .stride = 12, .len = 19, .err = error.InvalidArgument },
        .{ .width = 1, .height = 1, .stride = 4, .len = 0, .err = error.InvalidArgument },
    }) |case| {
        try std.testing.expectError(case.err, image.createFromPixels(
            allocator,
            pixels[0..case.len],
            case.width,
            case.height,
            .{ .stride = case.stride },
        ));
    }
    const wide = try std.testing.allocator.alloc(u8, 16_385 * 4);
    defer std.testing.allocator.free(wide);
    try std.testing.expectError(error.DimensionLimit, image.createFromPixels(allocator, wide, 16_385, 1, .{ .stride = 16_385 * 4 }));
    try std.testing.expect(!failing.has_induced_failure);
}

test "ensureEncodedPng round-trips opaque pixels through the RGB path" {
    const pixels = [_]u8{
        1, 2, 3, 255, 4,  5,  6,  255,
        7, 8, 9, 255, 10, 11, 12, 255,
    };
    const source = try makeImage(&pixels, 2, 2);
    defer source.deinit();
    try std.testing.expectEqual(@as(u32, 0), source.metadata.has_alpha);

    const encoded = try source.ensureEncodedPng();
    try std.testing.expectEqual(encoded, source.encoded_png.?);

    var info: image.Info = .{};
    try std.testing.expectEqual(image.Status.ok, image.probe(encoded, .{}, &info));
    try std.testing.expectEqual(@as(u32, 2), info.width);
    try std.testing.expectEqual(@as(u32, 2), info.height);
    try std.testing.expectEqual(@as(u32, 0), info.has_alpha);

    const decoded = try image.decode(std.testing.allocator, encoded, .{});
    defer decoded.deinit();
    try std.testing.expectEqualSlices(u8, &pixels, try decoded.ensurePixels());
}

test "ensureEncodedPng round-trips transparent pixels through the RGBA path" {
    const pixels = [_]u8{
        1, 2, 3, 254, 4,  5,  6,  0,
        7, 8, 9, 128, 10, 11, 12, 255,
    };
    const source = try makeImage(&pixels, 2, 2);
    defer source.deinit();
    try std.testing.expectEqual(@as(u32, 1), source.metadata.has_alpha);

    const encoded = try source.ensureEncodedPng();
    var info: image.Info = .{};
    try std.testing.expectEqual(image.Status.ok, image.probe(encoded, .{}, &info));
    try std.testing.expectEqual(@as(u32, 1), info.has_alpha);

    const decoded = try image.decode(std.testing.allocator, encoded, .{});
    defer decoded.deinit();
    try std.testing.expectEqualSlices(u8, &pixels, try decoded.ensurePixels());
}

test "ensureEncodedPng is a no-op when an encoding is already attached" {
    const source = try makeImage(&[_]u8{ 1, 2, 3, 255 }, 1, 1);
    defer source.deinit();
    const first = try source.ensureEncodedPng();
    const second = try source.ensureEncodedPng();
    try std.testing.expectEqual(first.ptr, second.ptr);
    try std.testing.expectEqual(first.len, second.len);
}

test "extract copies the exact requested rectangle" {
    const pixels = [_]u8{
        1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255,
        4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255,
    };
    const source = try makeImage(&pixels, 3, 2);
    defer source.deinit();
    const output = try image.extract(std.testing.allocator, source, 1, 0, 2, 2);
    defer output.deinit();
    try std.testing.expectEqualSlices(u8, &[_]u8{
        2, 0, 0, 255, 3, 0, 0, 255,
        5, 0, 0, 255, 6, 0, 0, 255,
    }, output.pixels);
    try std.testing.expectError(error.InvalidArgument, image.extract(std.testing.allocator, source, 2, 0, 2, 1));
}

test "extend fills every edge and preserves source pixels" {
    const source = try makeImage(&[_]u8{ 10, 20, 30, 40 }, 1, 1);
    defer source.deinit();
    const output = try image.extend(std.testing.allocator, source, 1, 2, 1, 1, .{ 1, 2, 3, 4 });
    defer output.deinit();
    try std.testing.expectEqual(@as(u32, 4), output.width());
    try std.testing.expectEqual(@as(u32, 3), output.height());
    try std.testing.expectEqualSlices(u8, &[_]u8{
        1, 2, 3, 4, 1,  2,  3,  4,  1, 2, 3, 4, 1, 2, 3, 4,
        1, 2, 3, 4, 10, 20, 30, 40, 1, 2, 3, 4, 1, 2, 3, 4,
        1, 2, 3, 4, 1,  2,  3,  4,  1, 2, 3, 4, 1, 2, 3, 4,
    }, output.pixels);
}

test "orthogonal transforms map pixels exactly" {
    const pixels = [_]u8{
        1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255,
        4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255,
    };
    const source = try makeImage(&pixels, 3, 2);
    defer source.deinit();

    const rotated = try image.transform(std.testing.allocator, source, .rotate_90);
    defer rotated.deinit();
    try std.testing.expectEqual(@as(u32, 2), rotated.width());
    try std.testing.expectEqual(@as(u32, 3), rotated.height());
    try std.testing.expectEqualSlices(u8, &[_]u8{
        4, 0, 0, 255, 1, 0, 0, 255,
        5, 0, 0, 255, 2, 0, 0, 255,
        6, 0, 0, 255, 3, 0, 0, 255,
    }, rotated.pixels);

    const flopped = try image.transform(std.testing.allocator, source, .flop);
    defer flopped.deinit();
    try std.testing.expectEqualSlices(u8, &[_]u8{
        3, 0, 0, 255, 2, 0, 0, 255, 1, 0, 0, 255,
        6, 0, 0, 255, 5, 0, 0, 255, 4, 0, 0, 255,
    }, flopped.pixels);

    const rotated_180 = try image.transform(std.testing.allocator, source, .rotate_180);
    defer rotated_180.deinit();
    try std.testing.expectEqualSlices(u8, &[_]u8{
        6, 0, 0, 255, 5, 0, 0, 255, 4, 0, 0, 255,
        3, 0, 0, 255, 2, 0, 0, 255, 1, 0, 0, 255,
    }, rotated_180.pixels);

    const flipped = try image.transform(std.testing.allocator, source, .flip);
    defer flipped.deinit();
    try std.testing.expectEqualSlices(u8, &[_]u8{
        4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255,
        1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255,
    }, flipped.pixels);
}

test "copyPixels supports RGBA, BGRA, and padded rows" {
    const source = try makeImage(&[_]u8{
        1, 2,  3,  4,  5,  6,  7,  8,
        9, 10, 11, 12, 13, 14, 15, 16,
    }, 2, 2);
    defer source.deinit();
    var rgba = [_]u8{99} ** 24;
    try std.testing.expectEqual(image.Status.ok, image.copyPixels(source, &rgba, 12, false));
    try std.testing.expectEqualSlices(u8, &[_]u8{
        1, 2,  3,  4,  5,  6,  7,  8,  99, 99, 99, 99,
        9, 10, 11, 12, 13, 14, 15, 16, 99, 99, 99, 99,
    }, &rgba);

    var bgra: [16]u8 = undefined;
    try std.testing.expectEqual(image.Status.ok, image.copyPixels(source, &bgra, 8, true));
    try std.testing.expectEqualSlices(u8, &[_]u8{
        3,  2,  1, 4,  7,  6,  5,  8,
        11, 10, 9, 12, 15, 14, 13, 16,
    }, &bgra);
}

test "source-over composite uses linear light and correct alpha" {
    const base = try makeImage(&[_]u8{ 0, 0, 0, 255 }, 1, 1);
    defer base.deinit();
    const overlay = try makeImage(&[_]u8{ 255, 255, 255, 128 }, 1, 1);
    defer overlay.deinit();
    const output = try image.composite(std.testing.allocator, base, overlay, 0, 0, .source_over, 255);
    defer output.deinit();
    try std.testing.expect(@abs(@as(i16, output.pixels[0]) - 188) <= 1);
    try std.testing.expectEqual(@as(u8, 255), output.pixels[3]);
}

test "composite clips negative offsets and supports source mode" {
    const base = try makeImage(&([_]u8{ 0, 0, 0, 255 } ** 4), 2, 2);
    defer base.deinit();
    const overlay = try makeImage(&([_]u8{ 255, 0, 0, 255 } ** 4), 2, 2);
    defer overlay.deinit();
    const output = try image.composite(std.testing.allocator, base, overlay, -1, -1, .source, 128);
    defer output.deinit();
    try std.testing.expectEqualSlices(u8, &[_]u8{ 255, 0, 0, 128 }, output.pixels[0..4]);
    try std.testing.expectEqualSlices(u8, &[_]u8{ 0, 0, 0, 255 }, output.pixels[4..8]);
}

test "resize performs alpha-aware sRGB reduction" {
    const source = try makeImage(&[_]u8{
        255, 0, 0, 0,
        0,   0, 0, 255,
    }, 2, 1);
    defer source.deinit();
    const output = try image.resize(std.testing.allocator, source, 1, 1, .area);
    defer output.deinit();
    try std.testing.expect(output.pixels[0] <= 2);
    try std.testing.expect(@abs(@as(i16, output.pixels[3]) - 128) <= 1);
}

fn injectJpegExifOrientation(
    allocator: std.mem.Allocator,
    jpeg: []const u8,
    orientation: u16,
    endian: std.builtin.Endian,
) ![]u8 {
    const tiff_le = [_]u8{
        'I', 'I', 42,                     0,                           8, 0, 0, 0,
        1,   0,   0x12,                   0x01,                        3, 0, 1, 0,
        0,   0,   @truncate(orientation), @truncate(orientation >> 8), 0, 0, 0, 0,
        0,   0,
    };
    const tiff_be = [_]u8{
        'M', 'M', 0,                           42,                     0, 0, 0, 8,
        0,   1,   0x01,                        0x12,                   0, 3, 0, 0,
        0,   1,   @truncate(orientation >> 8), @truncate(orientation), 0, 0, 0, 0,
        0,   0,
    };
    const tiff = if (endian == .little) &tiff_le else &tiff_be;
    const identifier = "Exif\x00\x00";
    const segment_length: u16 = @intCast(2 + identifier.len + tiff.len);
    var output = try allocator.alloc(u8, jpeg.len + 4 + identifier.len + tiff.len);
    errdefer allocator.free(output);
    @memcpy(output[0..2], jpeg[0..2]);
    output[2] = 0xFF;
    output[3] = 0xE1;
    output[4] = @truncate(segment_length >> 8);
    output[5] = @truncate(segment_length);
    @memcpy(output[6 .. 6 + identifier.len], identifier);
    @memcpy(output[6 + identifier.len .. 6 + identifier.len + tiff.len], tiff);
    @memcpy(output[6 + identifier.len + tiff.len ..], jpeg[2..]);
    return output;
}

test "JPEG EXIF orientation swaps probe and decode dimensions" {
    const jpeg = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, "../core/src/tests/fixtures/images/orientation.jpg", std.testing.allocator, .limited(1 << 20));
    defer std.testing.allocator.free(jpeg);
    const plain = try image.decode(std.testing.allocator, jpeg, .{});
    defer plain.deinit();

    var plain_info: image.Info = .{};
    try std.testing.expectEqual(image.Status.ok, image.probe(jpeg, .{}, &plain_info));
    try std.testing.expectEqual(@as(u32, 16), plain_info.width);
    try std.testing.expectEqual(@as(u32, 8), plain_info.height);
    try std.testing.expectEqual(@as(u32, 1), plain_info.orientation);

    for ([_]std.builtin.Endian{ .little, .big }) |endian| {
        const rotated = try injectJpegExifOrientation(std.testing.allocator, jpeg, 6, endian);
        defer std.testing.allocator.free(rotated);

        var info: image.Info = .{};
        try std.testing.expectEqual(image.Status.ok, image.probe(rotated, .{}, &info));
        try std.testing.expectEqual(@as(u32, 6), info.orientation);
        try std.testing.expectEqual(@as(u32, 8), info.width);
        try std.testing.expectEqual(@as(u32, 16), info.height);
        try std.testing.expectEqual(@as(u32, 16), info.source_width);
        try std.testing.expectEqual(@as(u32, 8), info.source_height);

        const decoded = try image.decode(std.testing.allocator, rotated, .{});
        defer decoded.deinit();
        try std.testing.expectEqual(@as(u32, 8), decoded.width());
        try std.testing.expectEqual(@as(u32, 16), decoded.height());
        try std.testing.expectEqual(@as(u32, 1), decoded.metadata.orientation);
        // Orientation 6: output (dx, dy) = source (dy, srcH - 1 - dx).
        const source_top = (@as(usize, 7) * 16) * 4;
        const source_bottom = (@as(usize, 7) * 16 + 15) * 4;
        const bottom_offset = (@as(usize, 15) * 8) * 4;
        try std.testing.expectEqualSlices(u8, plain.pixels[source_top .. source_top + 4], decoded.pixels[0..4]);
        try std.testing.expectEqualSlices(
            u8,
            plain.pixels[source_bottom .. source_bottom + 4],
            decoded.pixels[bottom_offset .. bottom_offset + 4],
        );
    }
}

test "JPEG EXIF orientation 180 keeps dimensions" {
    const jpeg = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, "../core/src/tests/fixtures/images/orientation.jpg", std.testing.allocator, .limited(1 << 20));
    defer std.testing.allocator.free(jpeg);
    const plain = try image.decode(std.testing.allocator, jpeg, .{});
    defer plain.deinit();
    const flipped = try injectJpegExifOrientation(std.testing.allocator, jpeg, 3, .little);
    defer std.testing.allocator.free(flipped);

    var info: image.Info = .{};
    try std.testing.expectEqual(image.Status.ok, image.probe(flipped, .{}, &info));
    try std.testing.expectEqual(@as(u32, 3), info.orientation);
    try std.testing.expectEqual(@as(u32, 16), info.width);
    try std.testing.expectEqual(@as(u32, 8), info.height);

    const decoded = try image.decode(std.testing.allocator, flipped, .{});
    defer decoded.deinit();
    try std.testing.expectEqual(@as(u32, 16), decoded.width());
    // Orientation 3: output (dx, dy) = source (srcW - 1 - dx, srcH - 1 - dy).
    const source_left = (@as(usize, 7) * 16 + 15) * 4;
    const source_right = (@as(usize, 7) * 16) * 4;
    const right_offset = (@as(usize, 15)) * 4;
    try std.testing.expectEqualSlices(u8, plain.pixels[source_left .. source_left + 4], decoded.pixels[0..4]);
    try std.testing.expectEqualSlices(
        u8,
        plain.pixels[source_right .. source_right + 4],
        decoded.pixels[right_offset .. right_offset + 4],
    );
}

test "JPEG EXIF orientation ignores invalid values and uses the default" {
    const jpeg = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, "../core/src/tests/fixtures/images/orientation.jpg", std.testing.allocator, .limited(1 << 20));
    defer std.testing.allocator.free(jpeg);
    for ([_]u16{ 0, 9, 200 }) |invalid| {
        const bytes = try injectJpegExifOrientation(std.testing.allocator, jpeg, invalid, .little);
        defer std.testing.allocator.free(bytes);
        var info: image.Info = .{};
        try std.testing.expectEqual(image.Status.ok, image.probe(bytes, .{}, &info));
        try std.testing.expectEqual(@as(u32, 1), info.orientation);
        try std.testing.expectEqual(@as(u32, 16), info.width);
    }
}

test "PNG eXIf orientation applies during decode" {
    // 2x1 PNG (left red, right green) carrying an eXIf chunk with orientation 6.
    const png = try decodeBase64(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAGmVYSWZJSSoACAAAAAEAEgEDAAEAAAAGAAAAAAAAALdIESkAAAAOSURBVHicY/jPwPAfBAEQ+AP9TpXBbwAAAABJRU5ErkJggg==",
    );
    defer std.testing.allocator.free(png);

    var info: image.Info = .{};
    try std.testing.expectEqual(image.Status.ok, image.probe(png, .{}, &info));
    try std.testing.expectEqual(@as(u32, 6), info.orientation);
    try std.testing.expectEqual(@as(u32, 1), info.width);
    try std.testing.expectEqual(@as(u32, 2), info.height);
    try std.testing.expectEqual(@as(u32, 2), info.source_width);
    try std.testing.expectEqual(@as(u32, 1), info.source_height);

    const decoded = try image.decode(std.testing.allocator, png, .{});
    defer decoded.deinit();
    try std.testing.expectEqual(@as(u32, 1), decoded.width());
    try std.testing.expectEqual(@as(u32, 2), decoded.height());
    try std.testing.expectEqual(@as(u32, 1), decoded.metadata.orientation);
    // Orientation 6 rotates the row into a column: red on top, green below.
    try std.testing.expectEqualSlices(u8, &[_]u8{ 255, 0, 0, 255, 0, 255, 0, 255 }, decoded.pixels);
}

test "area resize upscales tiny sources exactly" {
    // Regression: bounds instrumentation aborts on stb's upstream sRGB
    // table-bias idiom. On supported native x86_64/aarch64 builds, the first
    // case reaches the SIMD RGBA sRGB path and checks every output pixel. This
    // is evidence for the scoped exception, not a general stb safety proof.
    const source = try makeImage(&[_]u8{ 200, 40, 10, 255 }, 1, 1);
    defer source.deinit();
    const output = try image.resize(std.testing.allocator, source, 12, 2, .area);
    defer output.deinit();
    try std.testing.expectEqual(@as(u32, 12), output.width());
    for (0..12 * 2) |pixel| {
        try std.testing.expectEqualSlices(u8, &[_]u8{ 200, 40, 10, 255 }, output.pixels[pixel * 4 ..][0..4]);
    }

    const mixed = try image.resize(std.testing.allocator, source, 1, 7, .area);
    defer mixed.deinit();
    try std.testing.expectEqual(@as(u32, 7), mixed.height());
    try std.testing.expectEqual(@as(u8, 200), mixed.pixels[0]);
}
