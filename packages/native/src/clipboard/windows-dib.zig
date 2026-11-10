const std = @import("std");
const clipboard_clock = @import("clock.zig");

const Allocator = std.mem.Allocator;

const BI_RGB: u32 = 0;
const BI_BITFIELDS: u32 = 3;
const BI_ALPHABITFIELDS: u32 = 6;
const LCS_WINDOWS_COLOR_SPACE: u32 = 0x57696e20;
const LCS_SRGB: u32 = 0x73524742;
const CONVERSION_STOP_INTERVAL: usize = 4096;
const PNG_CHUNK_LENGTH_MAX: usize = 0x7fff_ffff;
const PNG_SIGNATURE = "\x89PNG\r\n\x1a\n";

pub const ConvertError = error{
    InvalidData,
    Unsupported,
    LimitExceeded,
    OutOfMemory,
    Cancelled,
    TimedOut,
};

pub const ConvertOptions = struct {
    max_output_bytes: u32,
    max_image_pixels: u32,
    max_conversion_bytes: u32,
    cancel_requested: ?*const std.atomic.Value(bool) = null,
    deadline_ns: i128,
};

const ChannelMask = struct {
    mask: u32,
    shift: u5,
    maximum: u32,
};

const DibInfo = struct {
    width: u32,
    height: u32,
    top_down: bool,
    bits_per_pixel: u16,
    row_stride: usize,
    pixel_offset: usize,
    red: ?ChannelMask,
    green: ?ChannelMask,
    blue: ?ChannelMask,
    alpha: ?ChannelMask,

    fn channelCount(info: DibInfo) u8 {
        return if (info.alpha == null) 3 else 4;
    }
};

const BoundedOutput = struct {
    allocator: Allocator,
    bytes: std.ArrayListUnmanaged(u8) = .empty,
    max_bytes: usize,

    fn deinit(output: *BoundedOutput) void {
        output.bytes.deinit(output.allocator);
    }

    fn append(output: *BoundedOutput, data: []const u8) ConvertError!void {
        try output.ensureUnusedCapacity(data.len);
        output.bytes.appendSliceAssumeCapacity(data);
    }

    fn appendByte(output: *BoundedOutput, byte: u8) ConvertError!void {
        try output.ensureUnusedCapacity(1);
        output.bytes.appendAssumeCapacity(byte);
    }

    fn appendInt(output: *BoundedOutput, value: u32) ConvertError!void {
        var bytes: [4]u8 = undefined;
        std.mem.writeInt(u32, &bytes, value, .big);
        try output.append(&bytes);
    }

    fn ensureUnusedCapacity(output: *BoundedOutput, additional: usize) ConvertError!void {
        const required = std.math.add(usize, output.bytes.items.len, additional) catch return error.LimitExceeded;
        if (required > output.max_bytes) return error.LimitExceeded;
        if (required <= output.bytes.capacity) return;

        const doubled = std.math.mul(usize, output.bytes.capacity, 2) catch output.max_bytes;
        const preferred = @max(required, @max(@as(usize, 256), doubled));
        const capacity = @min(output.max_bytes, preferred);
        output.bytes.ensureTotalCapacityPrecise(output.allocator, capacity) catch return error.OutOfMemory;
    }

    fn toOwnedSlice(output: *BoundedOutput) ConvertError![]u8 {
        return output.bytes.toOwnedSlice(output.allocator) catch error.OutOfMemory;
    }
};

const DeflateWriter = struct {
    output: *BoundedOutput,
    bits: u64 = 0,
    bit_count: u6 = 0,
    adler: std.hash.Adler32 = .{},
    previous_byte: u8 = 0,
    has_previous_byte: bool = false,

    fn init(output: *BoundedOutput) ConvertError!DeflateWriter {
        try output.append(&.{ 0x78, 0x01 });
        var writer = DeflateWriter{ .output = output };
        try writer.writeBits(1, 1); // Final block.
        try writer.writeBits(1, 2); // Fixed Huffman block.
        return writer;
    }

    fn writeData(writer: *DeflateWriter, data: []const u8, options: ConvertOptions) ConvertError!void {
        try writer.updateAdler(data, options);
        var index: usize = 0;
        var next_stop: usize = 0;
        while (index < data.len) {
            if (index >= next_stop) {
                try checkStop(options);
                next_stop = std.math.add(usize, index, CONVERSION_STOP_INTERVAL) catch std.math.maxInt(usize);
            }
            if (writer.has_previous_byte and data[index] == writer.previous_byte) {
                var run_length: usize = 1;
                while (run_length < 258 and index + run_length < data.len and data[index + run_length] == writer.previous_byte) {
                    run_length += 1;
                }
                if (run_length >= 3) {
                    try writer.writeRun(@intCast(run_length));
                    index += run_length;
                    continue;
                }
            }

            try writer.writeFixedSymbol(data[index]);
            writer.previous_byte = data[index];
            writer.has_previous_byte = true;
            index += 1;
        }
    }

    fn finish(writer: *DeflateWriter) ConvertError!void {
        try writer.writeFixedSymbol(256);
        try writer.flushBits();
        try writer.output.appendInt(writer.adler.adler);
    }

    fn writeRun(writer: *DeflateWriter, length: u16) ConvertError!void {
        const bases = [_]u16{ 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258 };
        const extra_bits = [_]u5{ 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0 };
        std.debug.assert(length >= 3 and length <= 258);

        var index: usize = 0;
        while (index + 1 < bases.len and length >= bases[index + 1]) : (index += 1) {}
        try writer.writeFixedSymbol(@intCast(257 + index));
        const count = extra_bits[index];
        if (count > 0) try writer.writeBits(length - bases[index], count);
        try writer.writeBits(0, 5); // Distance one.
    }

    fn writeFixedSymbol(writer: *DeflateWriter, symbol: u16) ConvertError!void {
        const code: u16, const count: u5 = if (symbol <= 143)
            .{ 0x30 + symbol, 8 }
        else if (symbol <= 255)
            .{ 0x190 + symbol - 144, 9 }
        else if (symbol <= 279)
            .{ symbol - 256, 7 }
        else
            .{ 0xc0 + symbol - 280, 8 };
        try writer.writeBits(reverseBits(code, count), count);
    }

    fn writeBits(writer: *DeflateWriter, value: anytype, count: u5) ConvertError!void {
        std.debug.assert(count <= 16);
        const typed_value: u64 = @intCast(value);
        const mask: u64 = if (count == 0) 0 else (@as(u64, 1) << count) - 1;
        writer.bits |= (typed_value & mask) << writer.bit_count;
        writer.bit_count += count;
        while (writer.bit_count >= 8) {
            try writer.output.appendByte(@truncate(writer.bits));
            writer.bits >>= 8;
            writer.bit_count -= 8;
        }
    }

    fn flushBits(writer: *DeflateWriter) ConvertError!void {
        if (writer.bit_count > 0) try writer.output.appendByte(@truncate(writer.bits));
        writer.bits = 0;
        writer.bit_count = 0;
    }

    fn updateAdler(writer: *DeflateWriter, data: []const u8, options: ConvertOptions) ConvertError!void {
        var offset: usize = 0;
        while (offset < data.len) {
            try checkStop(options);
            const end = @min(data.len, offset + CONVERSION_STOP_INTERVAL);
            writer.adler.update(data[offset..end]);
            offset = end;
        }
    }
};

pub fn convertToPng(
    allocator: Allocator,
    dib: []const u8,
    options: ConvertOptions,
) ConvertError![]u8 {
    try checkStop(options);
    const info = try parseDib(dib, null, options);
    return convertDibToPng(allocator, dib, info, options);
}

pub fn convertBmpToPng(
    allocator: Allocator,
    bmp: []const u8,
    options: ConvertOptions,
) ConvertError![]u8 {
    try checkStop(options);
    if (bmp.len < 14) return error.InvalidData;
    if (!std.mem.eql(u8, bmp[0..2], "BM")) return error.InvalidData;
    if ((readInt(u16, bmp, 6) catch return error.InvalidData) != 0 or
        (readInt(u16, bmp, 8) catch return error.InvalidData) != 0)
    {
        return error.InvalidData;
    }

    const file_size = std.math.cast(usize, readInt(u32, bmp, 2) catch return error.InvalidData) orelse
        return error.InvalidData;
    if (file_size != bmp.len) return error.InvalidData;
    const pixel_offset = std.math.cast(usize, readInt(u32, bmp, 10) catch return error.InvalidData) orelse
        return error.InvalidData;
    if (pixel_offset < 14 or pixel_offset > file_size) return error.InvalidData;

    const dib = bmp[14..];
    const info = try parseDib(dib, pixel_offset - 14, options);
    return convertDibToPng(allocator, dib, info, options);
}

fn convertDibToPng(
    allocator: Allocator,
    dib: []const u8,
    info: DibInfo,
    options: ConvertOptions,
) ConvertError![]u8 {
    const channel_count = info.channelCount();
    const row_size = std.math.mul(usize, info.width, channel_count) catch return error.LimitExceeded;
    const filtered_size = std.math.add(usize, row_size, 1) catch return error.LimitExceeded;
    const filtered = allocator.alloc(u8, filtered_size) catch return error.OutOfMemory;
    defer allocator.free(filtered);

    var output = BoundedOutput{
        .allocator = allocator,
        .max_bytes = options.max_output_bytes,
    };
    defer output.deinit();
    try output.append(PNG_SIGNATURE);

    var ihdr: [13]u8 = @splat(0);
    std.mem.writeInt(u32, ihdr[0..4], info.width, .big);
    std.mem.writeInt(u32, ihdr[4..8], info.height, .big);
    ihdr[8] = 8;
    ihdr[9] = if (channel_count == 3) 2 else 6;
    try appendChunk(&output, "IHDR", &ihdr);

    const idat_length_offset = output.bytes.items.len;
    try output.append(&.{ 0, 0, 0, 0 });
    try output.append("IDAT");
    const idat_data_offset = output.bytes.items.len;
    const final_chunk_bytes = 4 + 12; // IDAT CRC and IEND chunk.
    if (options.max_output_bytes < final_chunk_bytes) return error.LimitExceeded;
    const configured_body_limit = options.max_output_bytes - final_chunk_bytes;
    const png_body_limit = std.math.add(usize, idat_data_offset, PNG_CHUNK_LENGTH_MAX) catch unreachable;
    output.max_bytes = @min(configured_body_limit, png_body_limit);
    var deflate = try DeflateWriter.init(&output);

    var output_y: usize = 0;
    while (output_y < info.height) : (output_y += 1) {
        try checkStop(options);
        const source_y = if (info.top_down) output_y else info.height - 1 - output_y;
        const source_offset = info.pixel_offset + source_y * info.row_stride;
        try filterRow(dib[source_offset..][0..info.row_stride], filtered, info, options);
        try deflate.writeData(filtered, options);
    }
    try checkStop(options);
    try deflate.finish();

    const idat_length = output.bytes.items.len - idat_data_offset;
    std.debug.assert(idat_length <= PNG_CHUNK_LENGTH_MAX);
    const idat_length_u32: u32 = @intCast(idat_length);
    std.mem.writeInt(u32, output.bytes.items[idat_length_offset..][0..4], idat_length_u32, .big);
    var crc = std.hash.Crc32.init();
    crc.update("IDAT");
    var crc_offset = idat_data_offset;
    while (crc_offset < output.bytes.items.len) {
        try checkStop(options);
        const crc_end = @min(output.bytes.items.len, crc_offset + CONVERSION_STOP_INTERVAL);
        crc.update(output.bytes.items[crc_offset..crc_end]);
        crc_offset = crc_end;
    }
    output.max_bytes = options.max_output_bytes;
    try output.appendInt(crc.final());
    try appendChunk(&output, "IEND", &.{});
    return output.toOwnedSlice();
}

fn parseDib(dib: []const u8, explicit_pixel_offset: ?usize, options: ConvertOptions) ConvertError!DibInfo {
    if (dib.len < 4) return error.InvalidData;
    const header_size_u32 = readInt(u32, dib, 0) catch return error.InvalidData;
    if (header_size_u32 < 40) return error.Unsupported;
    const header_size = std.math.cast(usize, header_size_u32) orelse return error.InvalidData;
    if (header_size > dib.len) return error.InvalidData;
    switch (header_size_u32) {
        40, 52, 56, 108, 124 => {},
        else => return error.Unsupported,
    }
    if (header_size_u32 >= 108) {
        const color_space = readInt(u32, dib, 56) catch return error.InvalidData;
        if (color_space != LCS_SRGB and color_space != LCS_WINDOWS_COLOR_SPACE) return error.Unsupported;
    }

    const width_signed = readInt(i32, dib, 4) catch return error.InvalidData;
    const height_signed = readInt(i32, dib, 8) catch return error.InvalidData;
    if (width_signed <= 0 or height_signed == 0 or height_signed == std.math.minInt(i32)) return error.InvalidData;
    if ((readInt(u16, dib, 12) catch return error.InvalidData) != 1) return error.InvalidData;
    const bits_per_pixel = readInt(u16, dib, 14) catch return error.InvalidData;
    if (bits_per_pixel != 16 and bits_per_pixel != 24 and bits_per_pixel != 32) return error.Unsupported;
    const compression = readInt(u32, dib, 16) catch return error.InvalidData;
    if (compression != BI_RGB and compression != BI_BITFIELDS and compression != BI_ALPHABITFIELDS) {
        return error.Unsupported;
    }
    if (bits_per_pixel == 24 and compression != BI_RGB) return error.Unsupported;
    if (height_signed < 0 and compression == BI_ALPHABITFIELDS) return error.InvalidData;

    const width: u32 = @intCast(width_signed);
    const height: u32 = @intCast(if (height_signed < 0) -height_signed else height_signed);
    const pixel_count = std.math.mul(u64, width, height) catch return error.LimitExceeded;
    if (pixel_count > options.max_image_pixels) return error.LimitExceeded;
    const rgba_size = std.math.mul(u64, pixel_count, 4) catch return error.LimitExceeded;
    if (rgba_size > options.max_conversion_bytes) return error.LimitExceeded;

    var external_mask_bytes: usize = 0;
    var red_mask: u32 = 0;
    var green_mask: u32 = 0;
    var blue_mask: u32 = 0;
    var alpha_mask: u32 = 0;
    if (compression == BI_RGB) {
        if (bits_per_pixel == 16) {
            red_mask = 0x7c00;
            green_mask = 0x03e0;
            blue_mask = 0x001f;
        } else if (bits_per_pixel == 32 and header_size_u32 >= 108) {
            alpha_mask = readInt(u32, dib, 52) catch return error.InvalidData;
            if (alpha_mask != 0) {
                red_mask = 0x00ff0000;
                green_mask = 0x0000ff00;
                blue_mask = 0x000000ff;
            }
        }
    } else if (header_size_u32 == 40) {
        external_mask_bytes = if (compression == BI_ALPHABITFIELDS) 16 else 12;
        red_mask = readInt(u32, dib, 40) catch return error.InvalidData;
        green_mask = readInt(u32, dib, 44) catch return error.InvalidData;
        blue_mask = readInt(u32, dib, 48) catch return error.InvalidData;
        if (external_mask_bytes == 16) alpha_mask = readInt(u32, dib, 52) catch return error.InvalidData;
    } else {
        if (header_size_u32 < 52) return error.Unsupported;
        red_mask = readInt(u32, dib, 40) catch return error.InvalidData;
        green_mask = readInt(u32, dib, 44) catch return error.InvalidData;
        blue_mask = readInt(u32, dib, 48) catch return error.InvalidData;
        if (compression == BI_ALPHABITFIELDS and header_size_u32 < 56) return error.Unsupported;
        if (header_size_u32 >= 56) alpha_mask = readInt(u32, dib, 52) catch return error.InvalidData;
    }

    var red: ?ChannelMask = null;
    var green: ?ChannelMask = null;
    var blue: ?ChannelMask = null;
    var alpha: ?ChannelMask = null;
    if (bits_per_pixel == 16 or compression != BI_RGB or alpha_mask != 0) {
        red = try parseMask(red_mask, bits_per_pixel, false);
        green = try parseMask(green_mask, bits_per_pixel, false);
        blue = try parseMask(blue_mask, bits_per_pixel, false);
        alpha = try parseMask(alpha_mask, bits_per_pixel, true);
        if (red.?.mask & green.?.mask != 0 or red.?.mask & blue.?.mask != 0 or green.?.mask & blue.?.mask != 0) {
            return error.InvalidData;
        }
        if (alpha) |alpha_value| {
            if ((alpha_value.mask & red.?.mask) != 0 or
                (alpha_value.mask & green.?.mask) != 0 or
                (alpha_value.mask & blue.?.mask) != 0) return error.InvalidData;
        }
    }

    const color_count = readInt(u32, dib, 32) catch return error.InvalidData;
    const color_table_bytes = std.math.mul(usize, color_count, 4) catch return error.InvalidData;
    const masks_end = std.math.add(usize, header_size, external_mask_bytes) catch return error.InvalidData;
    const minimum_pixel_offset = std.math.add(usize, masks_end, color_table_bytes) catch return error.InvalidData;
    const pixel_offset = explicit_pixel_offset orelse minimum_pixel_offset;
    if (pixel_offset < minimum_pixel_offset) return error.InvalidData;
    const row_bits = std.math.mul(u64, width, bits_per_pixel) catch return error.InvalidData;
    const row_words = std.math.divCeil(u64, row_bits, 32) catch return error.InvalidData;
    const row_stride_u64 = std.math.mul(u64, row_words, 4) catch return error.InvalidData;
    const row_stride = std.math.cast(usize, row_stride_u64) orelse return error.LimitExceeded;
    const pixel_bytes = std.math.mul(usize, row_stride, height) catch return error.InvalidData;
    const pixel_end = std.math.add(usize, pixel_offset, pixel_bytes) catch return error.InvalidData;
    if (pixel_end > dib.len) return error.InvalidData;

    return .{
        .width = width,
        .height = height,
        .top_down = height_signed < 0,
        .bits_per_pixel = bits_per_pixel,
        .row_stride = row_stride,
        .pixel_offset = pixel_offset,
        .red = red,
        .green = green,
        .blue = blue,
        .alpha = alpha,
    };
}

fn parseMask(mask: u32, bits_per_pixel: u16, optional: bool) ConvertError!?ChannelMask {
    if (mask == 0) return if (optional) null else error.InvalidData;
    if (bits_per_pixel < 32 and mask >= (@as(u32, 1) << @intCast(bits_per_pixel))) return error.InvalidData;
    const shift: u5 = @intCast(@ctz(mask));
    const maximum = mask >> shift;
    if (maximum != std.math.maxInt(u32) and maximum & (maximum + 1) != 0) return error.InvalidData;
    return .{ .mask = mask, .shift = shift, .maximum = maximum };
}

fn filterRow(source: []const u8, filtered: []u8, info: DibInfo, options: ConvertOptions) ConvertError!void {
    filtered[0] = 1; // Sub filter.
    var left = [_]u8{ 0, 0, 0, 0 };
    const channel_count = info.channelCount();
    var x: usize = 0;
    var output_offset: usize = 1;
    while (x < info.width) : (x += 1) {
        if (x % CONVERSION_STOP_INTERVAL == 0) try checkStop(options);
        var channels: [4]u8 = undefined;
        if (info.bits_per_pixel == 24) {
            const source_offset = x * 3;
            channels = .{ source[source_offset + 2], source[source_offset + 1], source[source_offset], 255 };
        } else if (info.bits_per_pixel == 32 and info.red == null) {
            const source_offset = x * 4;
            channels = .{ source[source_offset + 2], source[source_offset + 1], source[source_offset], 255 };
        } else {
            const value: u32 = if (info.bits_per_pixel == 16)
                readInt(u16, source, x * 2) catch unreachable
            else
                readInt(u32, source, x * 4) catch unreachable;
            channels[0] = extractChannel(value, info.red.?);
            channels[1] = extractChannel(value, info.green.?);
            channels[2] = extractChannel(value, info.blue.?);
            channels[3] = if (info.alpha) |alpha| extractChannel(value, alpha) else 255;
        }
        for (0..channel_count) |channel| {
            filtered[output_offset] = channels[channel] -% left[channel];
            left[channel] = channels[channel];
            output_offset += 1;
        }
    }
    std.debug.assert(output_offset == filtered.len);
}

fn extractChannel(value: u32, channel: ChannelMask) u8 {
    const sample = (value & channel.mask) >> channel.shift;
    const scaled = @as(u64, sample) * 255 + channel.maximum / 2;
    return @intCast(scaled / channel.maximum);
}

fn appendChunk(output: *BoundedOutput, chunk_type: *const [4]u8, data: []const u8) ConvertError!void {
    const length = std.math.cast(u32, data.len) orelse return error.LimitExceeded;
    try output.appendInt(length);
    try output.append(chunk_type);
    try output.append(data);
    var crc = std.hash.Crc32.init();
    crc.update(chunk_type);
    crc.update(data);
    try output.appendInt(crc.final());
}

fn reverseBits(value: u16, count: u5) u16 {
    var result: u16 = 0;
    var index: u5 = 0;
    while (index < count) : (index += 1) {
        result = (result << 1) | ((value >> @as(u4, @intCast(index))) & 1);
    }
    return result;
}

fn readInt(comptime T: type, data: []const u8, offset: usize) error{InvalidData}!T {
    if (offset > data.len or data.len - offset < @sizeOf(T)) return error.InvalidData;
    return std.mem.readInt(T, data[offset..][0..@sizeOf(T)], .little);
}

fn checkStop(options: ConvertOptions) ConvertError!void {
    if (options.cancel_requested) |cancelled| {
        if (cancelled.load(.acquire)) return error.Cancelled;
    }
    if (options.deadline_ns == std.math.maxInt(i128)) return;
    if (clipboard_clock.nowNs() >= options.deadline_ns) return error.TimedOut;
}

fn testOptions() ConvertOptions {
    return .{
        .max_output_bytes = 1024 * 1024,
        .max_image_pixels = 1024,
        .max_conversion_bytes = 4096,
        .deadline_ns = std.math.maxInt(i128),
    };
}

fn expectPngPixels(png: []const u8, width: u32, height: u32, expected: []const u8) !void {
    try std.testing.expectEqualStrings(PNG_SIGNATURE, png[0..8]);
    try std.testing.expectEqual(@as(u32, 13), std.mem.readInt(u32, png[8..12], .big));
    try std.testing.expectEqualStrings("IHDR", png[12..16]);
    try std.testing.expectEqual(width, std.mem.readInt(u32, png[16..20], .big));
    try std.testing.expectEqual(height, std.mem.readInt(u32, png[20..24], .big));
    const channel_count: usize = if (png[25] == 2) 3 else 4;
    try std.testing.expectEqual(width * height * channel_count, expected.len);

    const idat_offset: usize = 33;
    const idat_length = std.mem.readInt(u32, png[idat_offset..][0..4], .big);
    try std.testing.expectEqualStrings("IDAT", png[idat_offset + 4 ..][0..4]);
    const compressed = png[idat_offset + 8 ..][0..idat_length];
    var idat_crc = std.hash.Crc32.init();
    idat_crc.update("IDAT");
    idat_crc.update(compressed);
    try std.testing.expectEqual(
        idat_crc.final(),
        std.mem.readInt(u32, png[idat_offset + 8 + idat_length ..][0..4], .big),
    );
    var input: std.Io.Reader = .fixed(compressed);
    var decompressed: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer decompressed.deinit();
    var inflater: std.compress.flate.Decompress = .init(&input, .zlib, &.{});
    _ = try inflater.reader.streamRemaining(&decompressed.writer);

    const row_size = width * channel_count;
    try std.testing.expectEqual(height * (row_size + 1), decompressed.written().len);
    const pixels = try std.testing.allocator.alloc(u8, expected.len);
    defer std.testing.allocator.free(pixels);
    var y: usize = 0;
    while (y < height) : (y += 1) {
        const row = decompressed.written()[y * (row_size + 1) ..][0 .. row_size + 1];
        try std.testing.expectEqual(@as(u8, 1), row[0]);
        for (0..row_size) |index| {
            const left = if (index < channel_count) 0 else pixels[y * row_size + index - channel_count];
            pixels[y * row_size + index] = row[index + 1] +% left;
        }
    }
    try std.testing.expectEqualSlices(u8, expected, pixels);
}

fn dibFixture() [56]u8 {
    var dib: [56]u8 = @splat(0);
    std.mem.writeInt(u32, dib[0..4], 40, .little);
    std.mem.writeInt(i32, dib[4..8], 2, .little);
    std.mem.writeInt(i32, dib[8..12], 2, .little);
    std.mem.writeInt(u16, dib[12..14], 1, .little);
    std.mem.writeInt(u16, dib[14..16], 24, .little);
    std.mem.writeInt(u32, dib[20..24], 16, .little);
    dib[40..48].* = .{ 255, 0, 0, 255, 255, 255, 0, 0 };
    dib[48..56].* = .{ 0, 0, 255, 0, 255, 0, 0, 0 };
    return dib;
}

fn bmpFixture() [77]u8 {
    const dib = dibFixture();
    var bmp: [77]u8 = @splat(0);
    bmp[0..2].* = "BM".*;
    std.mem.writeInt(u32, bmp[2..6], bmp.len, .little);
    std.mem.writeInt(u32, bmp[10..14], 61, .little);
    @memcpy(bmp[14..54], dib[0..40]);
    @memcpy(bmp[61..77], dib[40..56]);
    return bmp;
}

fn dibV5Fixture() [132]u8 {
    var dib: [132]u8 = @splat(0);
    std.mem.writeInt(u32, dib[0..4], 124, .little);
    std.mem.writeInt(i32, dib[4..8], 2, .little);
    std.mem.writeInt(i32, dib[8..12], -1, .little);
    std.mem.writeInt(u16, dib[12..14], 1, .little);
    std.mem.writeInt(u16, dib[14..16], 32, .little);
    std.mem.writeInt(u32, dib[16..20], BI_BITFIELDS, .little);
    std.mem.writeInt(u32, dib[20..24], 8, .little);
    std.mem.writeInt(u32, dib[40..44], 0x00ff0000, .little);
    std.mem.writeInt(u32, dib[44..48], 0x0000ff00, .little);
    std.mem.writeInt(u32, dib[48..52], 0x000000ff, .little);
    std.mem.writeInt(u32, dib[52..56], 0xff000000, .little);
    std.mem.writeInt(u32, dib[56..60], LCS_SRGB, .little);
    dib[124..132].* = .{ 10, 20, 30, 40, 50, 60, 70, 255 };
    return dib;
}

fn dibV5RgbFixture(alpha_mask: u32) [132]u8 {
    var dib: [132]u8 = @splat(0);
    std.mem.writeInt(u32, dib[0..4], 124, .little);
    std.mem.writeInt(i32, dib[4..8], 2, .little);
    std.mem.writeInt(i32, dib[8..12], 1, .little);
    std.mem.writeInt(u16, dib[12..14], 1, .little);
    std.mem.writeInt(u16, dib[14..16], 32, .little);
    std.mem.writeInt(u32, dib[16..20], BI_RGB, .little);
    std.mem.writeInt(u32, dib[52..56], alpha_mask, .little);
    std.mem.writeInt(u32, dib[56..60], LCS_WINDOWS_COLOR_SPACE, .little);
    dib[124..132].* = .{ 10, 20, 30, 40, 50, 60, 70, 255 };
    return dib;
}

test "Windows CF_DIB converts bottom-up padded BGR pixels to PNG" {
    const dib = dibFixture();
    const png = try convertToPng(std.testing.allocator, &dib, testOptions());
    defer std.testing.allocator.free(png);
    try expectPngPixels(png, 2, 2, &.{
        255, 0, 0,   0,   255, 0,
        0,   0, 255, 255, 255, 255,
    });
}

test "Windows CF_DIBV5 converts top-down bitfields and alpha to PNG" {
    const dib = dibV5Fixture();
    const png = try convertToPng(std.testing.allocator, &dib, testOptions());
    defer std.testing.allocator.free(png);
    try expectPngPixels(png, 2, 1, &.{ 30, 20, 10, 40, 70, 60, 50, 255 });
}

test "Windows CF_DIBV5 honors an explicit BI_RGB alpha mask" {
    const dib = dibV5RgbFixture(0xff000000);
    const png = try convertToPng(std.testing.allocator, &dib, testOptions());
    defer std.testing.allocator.free(png);
    try expectPngPixels(png, 2, 1, &.{ 30, 20, 10, 40, 70, 60, 50, 255 });
}

test "Windows CF_DIBV5 keeps BI_RGB padding opaque without an alpha mask" {
    const dib = dibV5RgbFixture(0);
    const png = try convertToPng(std.testing.allocator, &dib, testOptions());
    defer std.testing.allocator.free(png);
    try expectPngPixels(png, 2, 1, &.{ 30, 20, 10, 70, 60, 50 });
}

test "Windows DIB conversion honors a noncanonical BMP pixel gap" {
    const bmp = bmpFixture();
    const png = try convertBmpToPng(std.testing.allocator, &bmp, testOptions());
    defer std.testing.allocator.free(png);
    try expectPngPixels(png, 2, 2, &.{
        255, 0, 0,   0,   255, 0,
        0,   0, 255, 255, 255, 255,
    });
}

test "Windows DIB conversion rejects invalid BMP file headers and offsets" {
    var bmp = bmpFixture();
    try std.testing.expectError(error.InvalidData, convertBmpToPng(std.testing.allocator, bmp[0..13], testOptions()));

    bmp[0] = 'Z';
    try std.testing.expectError(error.InvalidData, convertBmpToPng(std.testing.allocator, &bmp, testOptions()));
    bmp = bmpFixture();
    std.mem.writeInt(u32, bmp[2..6], bmp.len - 1, .little);
    try std.testing.expectError(error.InvalidData, convertBmpToPng(std.testing.allocator, &bmp, testOptions()));
    bmp = bmpFixture();
    std.mem.writeInt(u16, bmp[6..8], 1, .little);
    try std.testing.expectError(error.InvalidData, convertBmpToPng(std.testing.allocator, &bmp, testOptions()));
    bmp = bmpFixture();
    std.mem.writeInt(u32, bmp[10..14], 13, .little);
    try std.testing.expectError(error.InvalidData, convertBmpToPng(std.testing.allocator, &bmp, testOptions()));
    bmp = bmpFixture();
    std.mem.writeInt(u32, bmp[10..14], 53, .little);
    try std.testing.expectError(error.InvalidData, convertBmpToPng(std.testing.allocator, &bmp, testOptions()));
    bmp = bmpFixture();
    std.mem.writeInt(u32, bmp[10..14], 62, .little);
    try std.testing.expectError(error.InvalidData, convertBmpToPng(std.testing.allocator, &bmp, testOptions()));
    bmp = bmpFixture();
    std.mem.writeInt(u32, bmp[10..14], 78, .little);
    try std.testing.expectError(error.InvalidData, convertBmpToPng(std.testing.allocator, &bmp, testOptions()));
}

test "Windows DIB conversion rejects malformed and unsupported headers" {
    var dib = dibFixture();
    try std.testing.expectError(error.InvalidData, convertToPng(std.testing.allocator, dib[0..39], testOptions()));
    try std.testing.expectError(error.InvalidData, convertToPng(std.testing.allocator, dib[0 .. dib.len - 1], testOptions()));
    std.mem.writeInt(i32, dib[4..8], 0, .little);
    try std.testing.expectError(error.InvalidData, convertToPng(std.testing.allocator, &dib, testOptions()));
    dib = dibFixture();
    std.mem.writeInt(u16, dib[12..14], 2, .little);
    try std.testing.expectError(error.InvalidData, convertToPng(std.testing.allocator, &dib, testOptions()));
    dib = dibFixture();
    std.mem.writeInt(u32, dib[16..20], 1, .little);
    try std.testing.expectError(error.Unsupported, convertToPng(std.testing.allocator, &dib, testOptions()));

    var dib_v5 = dibV5Fixture();
    std.mem.writeInt(u32, dib_v5[40..44], 0x00ff00ff, .little);
    try std.testing.expectError(error.InvalidData, convertToPng(std.testing.allocator, &dib_v5, testOptions()));
    dib_v5 = dibV5Fixture();
    std.mem.writeInt(u32, dib_v5[56..60], 0, .little);
    try std.testing.expectError(error.Unsupported, convertToPng(std.testing.allocator, &dib_v5, testOptions()));
    var alpha_bitfields = dibV5Fixture();
    std.mem.writeInt(u32, alpha_bitfields[16..20], BI_ALPHABITFIELDS, .little);
    try std.testing.expectError(error.InvalidData, convertToPng(std.testing.allocator, &alpha_bitfields, testOptions()));
}

test "Windows DIB conversion enforces pixel conversion and output limits" {
    const dib = dibFixture();
    var options = testOptions();
    options.max_image_pixels = 3;
    try std.testing.expectError(error.LimitExceeded, convertToPng(std.testing.allocator, &dib, options));
    options = testOptions();
    options.max_conversion_bytes = 15;
    try std.testing.expectError(error.LimitExceeded, convertToPng(std.testing.allocator, &dib, options));
    options = testOptions();
    options.max_output_bytes = 64;
    try std.testing.expectError(error.LimitExceeded, convertToPng(std.testing.allocator, &dib, options));
}

test "Windows DIB conversion observes cancellation and deadlines" {
    try clipboard_clock.init();
    const dib = dibFixture();
    var cancelled = std.atomic.Value(bool).init(true);
    var options = testOptions();
    options.cancel_requested = &cancelled;
    try std.testing.expectError(error.Cancelled, convertToPng(std.testing.allocator, &dib, options));
    cancelled.store(false, .release);
    options.deadline_ns = clipboard_clock.nowNs() - 1;
    try std.testing.expectError(error.TimedOut, convertToPng(std.testing.allocator, &dib, options));
}

test "Windows DIB conversion deflate stream round trips literals and long runs" {
    var source: [1280]u8 = undefined;
    for (source[0..256], 0..) |*byte, value| byte.* = @intCast(value);
    @memset(source[256..], 0x80);

    var output = BoundedOutput{
        .allocator = std.testing.allocator,
        .max_bytes = 4096,
    };
    defer output.deinit();
    var deflate = try DeflateWriter.init(&output);
    try deflate.writeData(&source, testOptions());
    try deflate.finish();

    var input: std.Io.Reader = .fixed(output.bytes.items);
    var decompressed: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer decompressed.deinit();
    var inflater: std.compress.flate.Decompress = .init(&input, .zlib, &.{});
    _ = try inflater.reader.streamRemaining(&decompressed.writer);
    try std.testing.expectEqualSlices(u8, &source, decompressed.written());
}
