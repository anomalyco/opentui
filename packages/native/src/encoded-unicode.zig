const std = @import("std");
const buffer = @import("buffer.zig");
const grapheme = @import("grapheme.zig");
const utf8 = @import("utf8.zig");

pub const EncodedChar = extern struct {
    width: u8,
    char: u32,
};

pub const EncodedUnicode = struct {
    chars: []const EncodedChar,

    pub fn init(allocator: std.mem.Allocator, pool: *grapheme.GraphemePool, text: []const u8, width_method: utf8.WidthMethod) !*EncodedUnicode {
        try buffer.validateTextInput(text);
        const self = try allocator.create(EncodedUnicode);
        errdefer allocator.destroy(self);
        // A native caller may borrow text from this pool; allocating new glyphs can move it.
        const input = try allocator.dupe(u8, text);
        defer allocator.free(input);
        var clusters: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
        defer clusters.deinit(allocator);
        const tab_width = 2;
        try utf8.findRenderClusterInfo(allocator, input, tab_width, utf8.isAsciiOnly(input), width_method, &clusters);
        var result: std.ArrayListUnmanaged(EncodedChar) = .empty;
        errdefer {
            release(pool, result.items);
            result.deinit(allocator);
        }
        try result.ensureTotalCapacity(allocator, input.len);
        var byte_offset: usize = 0;
        var cluster_index: usize = 0;
        while (byte_offset < input.len) {
            const start = byte_offset;
            if (cluster_index < clusters.items.len and clusters.items[cluster_index].byte_start == start) {
                byte_offset += clusters.items[cluster_index].byte_len;
                cluster_index += 1;
            } else {
                // Sparse metadata omits zero-width clusters, not their UTF-8 bytes.
                byte_offset += std.unicode.utf8ByteSequenceLength(input[start]) catch unreachable;
            }
            const bytes = input[start..byte_offset];
            const width = utf8.getWidthAt(bytes, 0, tab_width, width_method);
            if (width == 0) continue;
            const char: u32 = if (bytes.len == 1 and width == 1 and bytes[0] >= 32) bytes[0] else char: {
                const id = pool.alloc(bytes) catch |err| return switch (err) {
                    error.GraphemeTooLong => error.TextLimit,
                    else => err,
                };
                if ((pool.getRefcount(id) catch unreachable) == std.math.maxInt(u32)) return error.TrackerLimit;
                pool.incref(id) catch |err| {
                    pool.freeUnreferenced(id) catch unreachable;
                    return err;
                };
                break :char grapheme.packGraphemeStart(id, width);
            };
            result.appendAssumeCapacity(.{ .width = @intCast(width), .char = char });
        }
        self.* = .{ .chars = try result.toOwnedSlice(allocator) };
        return self;
    }

    pub fn deinit(self: *EncodedUnicode, allocator: std.mem.Allocator, pool: *grapheme.GraphemePool) void {
        release(pool, self.chars);
        allocator.free(self.chars);
        allocator.destroy(self);
    }

    fn release(pool: *grapheme.GraphemePool, chars: []const EncodedChar) void {
        for (chars) |cell| {
            if (grapheme.isGraphemeChar(cell.char)) pool.decref(grapheme.graphemeIdFromChar(cell.char)) catch unreachable;
        }
    }
};
