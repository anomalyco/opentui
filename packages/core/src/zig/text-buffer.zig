const std = @import("std");
const Allocator = std.mem.Allocator;
const buffer = @import("buffer.zig");

pub const RGBA = buffer.RGBA;
pub const TextSelection = buffer.TextSelection;

pub const USE_DEFAULT_FG: u16 = 0x8000;
pub const USE_DEFAULT_BG: u16 = 0x4000;
pub const USE_DEFAULT_ATTR: u16 = 0x2000;
pub const ATTR_MASK: u16 = 0x00FF;

pub const TextBufferError = error{
    OutOfMemory,
    InvalidDimensions,
    InvalidIndex,
};

/// TextBuffer holds packed arrays for styled text fragments
/// Similar to OptimizedBuffer but specifically for text fragments
pub const TextBuffer = struct {
    char: []u32,
    fg: []RGBA,
    bg: []RGBA,
    attributes: []u16,
    length: u32,
    cursor: u32,
    selection: ?TextSelection,
    default_fg: ?RGBA,
    default_bg: ?RGBA,
    default_attributes: ?u8,
    allocator: Allocator,

    line_starts: std.ArrayListUnmanaged(u32),
    line_widths: std.ArrayListUnmanaged(u32),
    current_line_width: u32,

    pub fn init(allocator: Allocator, length: u32) TextBufferError!*TextBuffer {
        if (length == 0) return TextBufferError.InvalidDimensions;

        const self = allocator.create(TextBuffer) catch return TextBufferError.OutOfMemory;
        errdefer allocator.destroy(self);

        self.* = .{
            .char = allocator.alloc(u32, length) catch return TextBufferError.OutOfMemory,
            .fg = allocator.alloc(RGBA, length) catch return TextBufferError.OutOfMemory,
            .bg = allocator.alloc(RGBA, length) catch return TextBufferError.OutOfMemory,
            .attributes = allocator.alloc(u16, length) catch return TextBufferError.OutOfMemory,
            .length = length,
            .cursor = 0,
            .selection = null,
            .default_fg = null,
            .default_bg = null,
            .default_attributes = null,
            .allocator = allocator,
            .line_starts = std.ArrayListUnmanaged(u32){},
            .line_widths = std.ArrayListUnmanaged(u32){},
            .current_line_width = 0,
        };

        @memset(self.char, ' ');
        @memset(self.fg, .{ 1.0, 1.0, 1.0, 1.0 });
        @memset(self.bg, .{ 0.0, 0.0, 0.0, 0.0 });
        @memset(self.attributes, 0);

        self.line_starts.append(allocator, 0) catch return TextBufferError.OutOfMemory;

        return self;
    }

    pub fn deinit(self: *TextBuffer) void {
        self.allocator.free(self.char);
        self.allocator.free(self.fg);
        self.allocator.free(self.bg);
        self.allocator.free(self.attributes);
        self.line_starts.deinit(self.allocator);
        self.line_widths.deinit(self.allocator);
        self.allocator.destroy(self);
    }

    pub fn getCharPtr(self: *TextBuffer) [*]u32 {
        return self.char.ptr;
    }

    pub fn getFgPtr(self: *TextBuffer) [*]RGBA {
        return self.fg.ptr;
    }

    pub fn getBgPtr(self: *TextBuffer) [*]RGBA {
        return self.bg.ptr;
    }

    pub fn getAttributesPtr(self: *TextBuffer) [*]u16 {
        return self.attributes.ptr;
    }

    pub fn getLength(self: *const TextBuffer) u32 {
        return self.cursor;
    }

    pub fn getCapacity(self: *const TextBuffer) u32 {
        return self.length;
    }

    pub fn setCell(self: *TextBuffer, index: u32, char: u32, fg: RGBA, bg: RGBA, attr: u16) TextBufferError!void {
        if (index >= self.length) return TextBufferError.InvalidIndex;

        self.char[index] = char;
        self.fg[index] = fg;
        self.bg[index] = bg;
        self.attributes[index] = attr;
    }

    /// Concatenate another TextBuffer to create a new combined buffer
    pub fn concat(self: *const TextBuffer, other: *const TextBuffer) TextBufferError!*TextBuffer {
        const newLength = self.cursor + other.cursor;
        const result = try init(self.allocator, newLength);

        @memcpy(result.char[0..self.cursor], self.char[0..self.cursor]);
        @memcpy(result.fg[0..self.cursor], self.fg[0..self.cursor]);
        @memcpy(result.bg[0..self.cursor], self.bg[0..self.cursor]);
        @memcpy(result.attributes[0..self.cursor], self.attributes[0..self.cursor]);

        @memcpy(result.char[self.cursor .. self.cursor + other.cursor], other.char[0..other.cursor]);
        @memcpy(result.fg[self.cursor .. self.cursor + other.cursor], other.fg[0..other.cursor]);
        @memcpy(result.bg[self.cursor .. self.cursor + other.cursor], other.bg[0..other.cursor]);
        @memcpy(result.attributes[self.cursor .. self.cursor + other.cursor], other.attributes[0..other.cursor]);

        result.cursor = newLength;

        result.line_starts.clearRetainingCapacity();
        result.line_widths.clearRetainingCapacity();
        for (self.line_starts.items) |start| {
            result.line_starts.append(result.allocator, start) catch {};
        }
        for (self.line_widths.items) |width| {
            result.line_widths.append(result.allocator, width) catch {};
        }

        for (other.line_starts.items[1..]) |start| {
            result.line_starts.append(result.allocator, start + self.cursor) catch {};
        }
        for (other.line_widths.items) |width| {
            result.line_widths.append(result.allocator, width) catch {};
        }

        result.current_line_width = other.current_line_width;

        return result;
    }

    pub fn reset(self: *TextBuffer) void {
        self.cursor = 0;
        self.line_starts.clearRetainingCapacity();
        self.line_widths.clearRetainingCapacity();
        self.current_line_width = 0;
        self.line_starts.append(self.allocator, 0) catch {};
    }

    pub fn setSelection(self: *TextBuffer, start: u32, end: u32, bgColor: ?RGBA, fgColor: ?RGBA) void {
        self.selection = TextSelection{
            .start = start,
            .end = end,
            .bgColor = bgColor,
            .fgColor = fgColor,
        };
    }

    pub fn resetSelection(self: *TextBuffer) void {
        self.selection = null;
    }

    pub fn setDefaultFg(self: *TextBuffer, fg: ?RGBA) void {
        self.default_fg = fg;
    }

    pub fn setDefaultBg(self: *TextBuffer, bg: ?RGBA) void {
        self.default_bg = bg;
    }

    pub fn setDefaultAttributes(self: *TextBuffer, attributes: ?u8) void {
        self.default_attributes = attributes;
    }

    pub fn resetDefaults(self: *TextBuffer) void {
        self.default_fg = null;
        self.default_bg = null;
        self.default_attributes = null;
    }

    pub fn resize(self: *TextBuffer, newLength: u32) TextBufferError!void {
        if (newLength == self.length) return;
        if (newLength == 0) return TextBufferError.InvalidDimensions;

        self.char = self.allocator.realloc(self.char, newLength) catch return TextBufferError.OutOfMemory;
        self.fg = self.allocator.realloc(self.fg, newLength) catch return TextBufferError.OutOfMemory;
        self.bg = self.allocator.realloc(self.bg, newLength) catch return TextBufferError.OutOfMemory;
        self.attributes = self.allocator.realloc(self.attributes, newLength) catch return TextBufferError.OutOfMemory;

        if (newLength > self.length) {
            @memset(self.char[self.length..newLength], ' ');
            @memset(self.fg[self.length..newLength], .{ 1.0, 1.0, 1.0, 1.0 });
            @memset(self.bg[self.length..newLength], .{ 0.0, 0.0, 0.0, 0.0 });
            @memset(self.attributes[self.length..newLength], 0);
        }

        self.length = newLength;
    }

    /// Write a UTF-8 encoded text chunk with styling to the buffer at the current cursor position
    /// This advances the cursor by the number of codepoints written and auto-resizes if needed
    /// Returns flags: bit 0 = resized during write, bits 1-31 = number of codepoints written
    pub fn writeChunk(self: *TextBuffer, textBytes: []const u8, fg: ?RGBA, bg: ?RGBA, attr: ?u8) TextBufferError!u32 {
        var attrValue: u16 = 0;

        const useFg = fg orelse blk: {
            attrValue |= USE_DEFAULT_FG;
            break :blk self.default_fg orelse .{ 1.0, 1.0, 1.0, 1.0 };
        };

        const useBg = bg orelse blk: {
            attrValue |= USE_DEFAULT_BG;
            break :blk self.default_bg orelse .{ 0.0, 0.0, 0.0, 0.0 };
        };

        if (attr) |a| {
            attrValue |= @as(u16, a);
        } else {
            attrValue |= USE_DEFAULT_ATTR;
            attrValue |= @as(u16, self.default_attributes orelse 0);
        }

        var utf8_it = std.unicode.Utf8Iterator{ .bytes = textBytes, .i = 0 };
        var codepointCount: u32 = 0;
        var wasResized: bool = false;

        while (utf8_it.nextCodepoint()) |codepoint| {
            if (self.cursor >= self.length) {
                const newCapacity = self.length + 256;
                try self.resize(newCapacity);
                wasResized = true;
            }

            try self.setCell(self.cursor, codepoint, useFg, useBg, attrValue);

            if (codepoint == '\n') {
                self.line_widths.append(self.allocator, self.current_line_width) catch {};
                self.line_starts.append(self.allocator, self.cursor + 1) catch {};
                self.current_line_width = 0;
            } else {
                self.current_line_width += 1;
            }

            self.cursor += 1;
            codepointCount += 1;
        }

        const resizeFlag: u32 = if (wasResized) 1 else 0;
        return (codepointCount << 1) | resizeFlag;
    }

    pub fn finalizeLineInfo(self: *TextBuffer) void {
        if (self.current_line_width > 0 or self.cursor == 0) {
            self.line_widths.append(self.allocator, self.current_line_width) catch {};
        }
    }

    pub fn getLineStarts(self: *const TextBuffer) []const u32 {
        return self.line_starts.items;
    }

    pub fn getLineWidths(self: *const TextBuffer) []const u32 {
        return self.line_widths.items;
    }

    pub fn getLineCount(self: *const TextBuffer) u32 {
        return @intCast(self.line_starts.items.len);
    }
};
