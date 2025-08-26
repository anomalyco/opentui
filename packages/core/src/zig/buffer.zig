const std = @import("std");
const Allocator = std.mem.Allocator;
const ansi = @import("ansi.zig");
const tb = @import("text-buffer.zig");
const math = std.math;

pub const RGBA = ansi.RGBA;
pub const Vec3f = @Vector(3, f32);
pub const Vec4f = @Vector(4, f32);

const TextBuffer = tb.TextBuffer;

const INV_255: f32 = 1.0 / 255.0;
const DEFAULT_SPACE_CHAR: u32 = 32;
const MAX_UNICODE_CODEPOINT: u32 = 0x10FFFF;
const BLOCK_CHAR: u32 = 0x2588; // Full block █
const QUADRANT_CHARS_COUNT = 16;

pub const BorderSides = packed struct {
    top: bool = false,
    right: bool = false,
    bottom: bool = false,
    left: bool = false,
};

pub const BorderCharIndex = enum(u8) {
    topLeft = 0,
    topRight = 1,
    bottomLeft = 2,
    bottomRight = 3,
    horizontal = 4,
    vertical = 5,
    topT = 6,
    bottomT = 7,
    leftT = 8,
    rightT = 9,
    cross = 10,
};

pub const TextSelection = struct {
    start: u32,
    end: u32,
    bgColor: ?RGBA,
    fgColor: ?RGBA,
};

pub const ClipRect = struct {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
};

pub const BufferError = error{
    OutOfMemory,
    InvalidDimensions,
    InvalidUnicode,
    BufferTooSmall,
};

pub fn rgbaToVec4f(color: RGBA) Vec4f {
    return Vec4f{ color[0], color[1], color[2], color[3] };
}

pub fn rgbaEqual(a: RGBA, b: RGBA, epsilon: f32) bool {
    const va = rgbaToVec4f(a);
    const vb = rgbaToVec4f(b);
    const diff = @abs(va - vb);
    const eps = @as(Vec4f, @splat(epsilon));
    return @reduce(.And, diff < eps);
}

pub const Cell = struct {
    char: u32,
    fg: RGBA,
    bg: RGBA,
    attributes: u8,
};

fn isRGBAWithAlpha(color: RGBA) bool {
    return color[3] < 1.0;
}

fn blendColors(overlay: RGBA, text: RGBA) RGBA {
    if (overlay[3] == 1.0) {
        return overlay;
    }

    const alpha = overlay[3];
    var perceptualAlpha: f32 = undefined;

    // For high alpha values (>0.8), use a more aggressive curve
    if (alpha > 0.8) {
        const normalizedHighAlpha = (alpha - 0.8) * 5.0;
        const curvedHighAlpha = std.math.pow(f32, normalizedHighAlpha, 0.2);
        perceptualAlpha = 0.8 + (curvedHighAlpha * 0.2);
    } else {
        perceptualAlpha = std.math.pow(f32, alpha, 0.9);
    }

    const overlayVec = Vec3f{ overlay[0], overlay[1], overlay[2] };
    const textVec = Vec3f{ text[0], text[1], text[2] };
    const alphaSplat = @as(Vec3f, @splat(perceptualAlpha));
    const oneMinusAlpha = @as(Vec3f, @splat(1.0 - perceptualAlpha));
    const blended = overlayVec * alphaSplat + textVec * oneMinusAlpha;

    return .{ blended[0], blended[1], blended[2], text[3] };
}

/// Optimized buffer for terminal rendering
pub const OptimizedBuffer = struct {
    buffer: struct {
        char: []u32,
        fg: []RGBA,
        bg: []RGBA,
        attributes: []u8,
    },
    width: u32,
    height: u32,
    respectAlpha: bool,
    allocator: Allocator,

    const InitOptions = struct {
        respectAlpha: bool = false,
    };

    pub fn init(allocator: Allocator, width: u32, height: u32, options: InitOptions) BufferError!*OptimizedBuffer {
        if (width == 0 or height == 0) return BufferError.InvalidDimensions;

        const self = allocator.create(OptimizedBuffer) catch return BufferError.OutOfMemory;
        errdefer allocator.destroy(self);

        const size = width * height;

        self.* = .{
            .buffer = .{
                .char = allocator.alloc(u32, size) catch return BufferError.OutOfMemory,
                .fg = allocator.alloc(RGBA, size) catch return BufferError.OutOfMemory,
                .bg = allocator.alloc(RGBA, size) catch return BufferError.OutOfMemory,
                .attributes = allocator.alloc(u8, size) catch return BufferError.OutOfMemory,
            },
            .width = width,
            .height = height,
            .respectAlpha = options.respectAlpha,
            .allocator = allocator,
        };

        @memset(self.buffer.char, 0);
        @memset(self.buffer.fg, .{ 0.0, 0.0, 0.0, 0.0 });
        @memset(self.buffer.bg, .{ 0.0, 0.0, 0.0, 0.0 });
        @memset(self.buffer.attributes, 0);

        return self;
    }

    pub fn getCharPtr(self: *OptimizedBuffer) [*]u32 {
        return self.buffer.char.ptr;
    }

    pub fn getFgPtr(self: *OptimizedBuffer) [*]RGBA {
        return self.buffer.fg.ptr;
    }

    pub fn getBgPtr(self: *OptimizedBuffer) [*]RGBA {
        return self.buffer.bg.ptr;
    }

    pub fn getAttributesPtr(self: *OptimizedBuffer) [*]u8 {
        return self.buffer.attributes.ptr;
    }

    pub fn deinit(self: *OptimizedBuffer) void {
        self.allocator.destroy(self);
    }

    pub fn resize(self: *OptimizedBuffer, width: u32, height: u32) BufferError!void {
        if (self.width == width and self.height == height) return;
        if (width == 0 or height == 0) return BufferError.InvalidDimensions;

        const size = width * height;

        self.buffer.char = self.allocator.realloc(self.buffer.char, size) catch return BufferError.OutOfMemory;
        self.buffer.fg = self.allocator.realloc(self.buffer.fg, size) catch return BufferError.OutOfMemory;
        self.buffer.bg = self.allocator.realloc(self.buffer.bg, size) catch return BufferError.OutOfMemory;
        self.buffer.attributes = self.allocator.realloc(self.buffer.attributes, size) catch return BufferError.OutOfMemory;

        self.width = width;
        self.height = height;
    }

    fn coordsToIndex(self: *const OptimizedBuffer, x: u32, y: u32) u32 {
        return y * self.width + x;
    }

    fn indexToCoords(self: *const OptimizedBuffer, index: u32) struct { x: u32, y: u32 } {
        return .{
            .x = index % self.width,
            .y = index / self.width,
        };
    }

    pub fn clear(self: *OptimizedBuffer, bg: RGBA, char: ?u32) !void {
        const cellChar = char orelse DEFAULT_SPACE_CHAR;

        @memset(self.buffer.char, @intCast(cellChar));
        @memset(self.buffer.attributes, 0);
        @memset(self.buffer.fg, .{ 1.0, 1.0, 1.0, 1.0 });
        @memset(self.buffer.bg, bg);
    }

    pub fn set(self: *OptimizedBuffer, x: u32, y: u32, cell: Cell) void {
        if (x >= self.width or y >= self.height) return;

        const index = self.coordsToIndex(x, y);
        self.buffer.char[index] = cell.char;
        self.buffer.fg[index] = cell.fg;
        self.buffer.bg[index] = cell.bg;
        self.buffer.attributes[index] = cell.attributes;
    }

    pub fn get(self: *const OptimizedBuffer, x: u32, y: u32) ?Cell {
        if (x >= self.width or y >= self.height) return null;

        const index = self.coordsToIndex(x, y);
        return Cell{
            .char = self.buffer.char[index],
            .fg = self.buffer.fg[index],
            .bg = self.buffer.bg[index],
            .attributes = self.buffer.attributes[index],
        };
    }

    pub fn getWidth(self: *const OptimizedBuffer) u32 {
        return self.width;
    }

    pub fn getHeight(self: *const OptimizedBuffer) u32 {
        return self.height;
    }

    pub fn setRespectAlpha(self: *OptimizedBuffer, respectAlpha: bool) void {
        self.respectAlpha = respectAlpha;
    }

    pub fn getRespectAlpha(self: *const OptimizedBuffer) bool {
        return self.respectAlpha;
    }

    pub fn setCellWithAlphaBlending(
        self: *OptimizedBuffer,
        x: u32,
        y: u32,
        char: u32,
        fg: RGBA,
        bg: RGBA,
        attributes: u8,
    ) !void {
        const hasBgAlpha = isRGBAWithAlpha(bg);
        const hasFgAlpha = isRGBAWithAlpha(fg);

        if (hasBgAlpha or hasFgAlpha) {
            if (self.get(x, y)) |destCell| {
                const blendedBgRgb = if (hasBgAlpha) blendColors(bg, destCell.bg) else bg;

                // Preserve destination character if overlay is just a space with alpha
                const preserveChar = (char == DEFAULT_SPACE_CHAR and destCell.char != 0 and destCell.char != DEFAULT_SPACE_CHAR);
                const finalChar = if (preserveChar) destCell.char else char;

                var finalFg: RGBA = undefined;
                if (preserveChar) {
                    // Blend foregrounds as well if preserving character
                    finalFg = blendColors(bg, destCell.fg);
                } else {
                    finalFg = if (hasFgAlpha) blendColors(fg, destCell.bg) else fg;
                }

                const finalAttributes = if (preserveChar) destCell.attributes else attributes;

                // Create the final cell, preserving the overlay alpha (bg[3])
                const blendedCell = Cell{
                    .char = finalChar,
                    .fg = finalFg,
                    .bg = .{ blendedBgRgb[0], blendedBgRgb[1], blendedBgRgb[2], bg[3] },
                    .attributes = finalAttributes,
                };

                self.set(x, y, blendedCell);
                return;
            }
        }

        const cellValue = Cell{
            .char = char,
            .fg = fg,
            .bg = bg,
            .attributes = attributes,
        };
        self.set(x, y, cellValue);
    }

    pub fn fillRect(
        self: *OptimizedBuffer,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        bg: RGBA,
    ) !void {
        if (self.width == 0 or self.height == 0 or width == 0 or height == 0) return;
        if (x >= self.width or y >= self.height) return;

        const startX = x;
        const startY = y;
        const maxEndX = if (x < self.width) self.width - 1 else 0;
        const maxEndY = if (y < self.height) self.height - 1 else 0;
        const requestedEndX = x + width - 1;
        const requestedEndY = y + height - 1;
        const endX = @min(maxEndX, requestedEndX);
        const endY = @min(maxEndY, requestedEndY);

        if (startX > endX or startY > endY) return;

        const hasAlpha = isRGBAWithAlpha(bg);

        if (hasAlpha) {
            var fillY = startY;
            while (fillY <= endY) : (fillY += 1) {
                var fillX = startX;
                while (fillX <= endX) : (fillX += 1) {
                    try self.setCellWithAlphaBlending(fillX, fillY, DEFAULT_SPACE_CHAR, .{ 1.0, 1.0, 1.0, 1.0 }, bg, 0);
                }
            }
        } else {
            // For non-alpha (fully opaque) backgrounds, we can do direct filling
            var fillY = startY;
            while (fillY <= endY) : (fillY += 1) {
                const rowStartIndex = self.coordsToIndex(startX, fillY);
                const rowWidth = endX - startX + 1;

                const rowSliceChar = self.buffer.char[rowStartIndex .. rowStartIndex + rowWidth];
                const rowSliceFg = self.buffer.fg[rowStartIndex .. rowStartIndex + rowWidth];
                const rowSliceBg = self.buffer.bg[rowStartIndex .. rowStartIndex + rowWidth];
                const rowSliceAttrs = self.buffer.attributes[rowStartIndex .. rowStartIndex + rowWidth];

                @memset(rowSliceChar, @intCast(DEFAULT_SPACE_CHAR));
                @memset(rowSliceFg, .{ 1.0, 1.0, 1.0, 1.0 });
                @memset(rowSliceBg, bg);
                @memset(rowSliceAttrs, 0);
            }
        }
    }

    pub fn drawText(
        self: *OptimizedBuffer,
        text: []const u8,
        x: u32,
        y: u32,
        fg: RGBA,
        bg: ?RGBA,
        attributes: u8,
    ) BufferError!void {
        if (x >= self.width or y >= self.height) return;
        if (text.len == 0) return;

        var i: u32 = 0;
        var utf8_it = std.unicode.Utf8Iterator{ .bytes = text, .i = 0 };
        while (utf8_it.nextCodepoint()) |codepoint| : (i += 1) {
            const charX = x + i;
            if (charX >= self.width) break;

            // Use provided background or get existing background
            var bgColor: RGBA = undefined;
            if (bg) |b| {
                bgColor = b;
            } else if (self.get(charX, y)) |existingCell| {
                bgColor = existingCell.bg;
            } else {
                bgColor = .{ 0.0, 0.0, 0.0, 1.0 };
            }

            if (isRGBAWithAlpha(bgColor)) {
                try self.setCellWithAlphaBlending(charX, y, codepoint, fg, bgColor, attributes);
            } else {
                self.set(charX, y, Cell{
                    .char = codepoint,
                    .fg = fg,
                    .bg = bgColor,
                    .attributes = attributes,
                });
            }
        }
    }

    pub fn drawFrameBuffer(self: *OptimizedBuffer, destX: i32, destY: i32, frameBuffer: *OptimizedBuffer, sourceX: ?u32, sourceY: ?u32, sourceWidth: ?u32, sourceHeight: ?u32) void {
        if (self.width == 0 or self.height == 0 or frameBuffer.width == 0 or frameBuffer.height == 0) return;

        const srcX = sourceX orelse 0;
        const srcY = sourceY orelse 0;
        const srcWidth = sourceWidth orelse frameBuffer.width;
        const srcHeight = sourceHeight orelse frameBuffer.height;

        if (srcX >= frameBuffer.width or srcY >= frameBuffer.height) return;
        if (srcWidth == 0 or srcHeight == 0) return;

        const clampedSrcWidth = @min(srcWidth, frameBuffer.width - srcX);
        const clampedSrcHeight = @min(srcHeight, frameBuffer.height - srcY);

        const startDestX = @max(0, destX);
        const startDestY = @max(0, destY);
        const endDestX = @min(@as(i32, @intCast(self.width)) - 1, destX + @as(i32, @intCast(clampedSrcWidth)) - 1);
        const endDestY = @min(@as(i32, @intCast(self.height)) - 1, destY + @as(i32, @intCast(clampedSrcHeight)) - 1);

        if (startDestX > endDestX or startDestY > endDestY) return;

        const copyWidth = @as(u32, @intCast(endDestX - startDestX + 1));

        if (!frameBuffer.respectAlpha) {
            // Fast path: direct memory copy
            var dY = startDestY;
            while (dY <= endDestY) : (dY += 1) {
                const relativeDestY = dY - destY;
                const sY = srcY + @as(u32, @intCast(relativeDestY));

                if (sY >= frameBuffer.height) continue;

                const relativeDestX = startDestX - destX;
                const sX = srcX + @as(u32, @intCast(relativeDestX));

                if (sX >= frameBuffer.width) continue;

                const destRowStart = self.coordsToIndex(@intCast(startDestX), @intCast(dY));
                const srcRowStart = frameBuffer.coordsToIndex(sX, sY);
                const actualCopyWidth = @min(copyWidth, frameBuffer.width - sX);

                @memcpy(self.buffer.char[destRowStart .. destRowStart + actualCopyWidth], frameBuffer.buffer.char[srcRowStart .. srcRowStart + actualCopyWidth]);
                @memcpy(self.buffer.fg[destRowStart .. destRowStart + actualCopyWidth], frameBuffer.buffer.fg[srcRowStart .. srcRowStart + actualCopyWidth]);
                @memcpy(self.buffer.bg[destRowStart .. destRowStart + actualCopyWidth], frameBuffer.buffer.bg[srcRowStart .. srcRowStart + actualCopyWidth]);
                @memcpy(self.buffer.attributes[destRowStart .. destRowStart + actualCopyWidth], frameBuffer.buffer.attributes[srcRowStart .. srcRowStart + actualCopyWidth]);
            }
            return;
        }

        // Slow path: process cells individually with alpha blending
        var dY = startDestY;
        while (dY <= endDestY) : (dY += 1) {
            var dX = startDestX;
            while (dX <= endDestX) : (dX += 1) {
                const relativeDestX = dX - destX;
                const relativeDestY = dY - destY;
                const sX = srcX + @as(u32, @intCast(relativeDestX));
                const sY = srcY + @as(u32, @intCast(relativeDestY));

                if (sX >= frameBuffer.width or sY >= frameBuffer.height) continue;

                const srcIndex = frameBuffer.coordsToIndex(sX, sY);
                if (srcIndex >= frameBuffer.buffer.char.len) continue;
                if (frameBuffer.buffer.bg[srcIndex][3] == 0.0 and frameBuffer.buffer.fg[srcIndex][3] == 0.0) continue;

                self.setCellWithAlphaBlending(@intCast(dX), @intCast(dY), frameBuffer.buffer.char[srcIndex], frameBuffer.buffer.fg[srcIndex], frameBuffer.buffer.bg[srcIndex], frameBuffer.buffer.attributes[srcIndex]) catch {};
            }
        }
    }

    /// Draw a TextBuffer to this OptimizedBuffer with selection support
    pub fn drawTextBuffer(
        self: *OptimizedBuffer,
        text_buffer: *const TextBuffer,
        x: i32,
        y: i32,
        clip_rect: ?ClipRect,
    ) !void {
        var currentX = x;
        var currentY = y;

        var i: u32 = 0;
        while (i < text_buffer.cursor) : (i += 1) {
            const charCode = text_buffer.char[i];

            // TODO: This implementation is very naive and inefficient but works for now.

            if (charCode == '\n') {
                currentY += 1;
                currentX = x;
                continue;
            }

            if (currentX < 0 or currentY < 0) {
                currentX += 1;
                continue;
            }
            if (currentX >= @as(i32, @intCast(self.width)) or currentY >= @as(i32, @intCast(self.height))) {
                currentX += 1;
                continue;
            }

            if (clip_rect) |clip| {
                if (currentX < clip.x or currentY < clip.y or
                    currentX >= clip.x + @as(i32, @intCast(clip.width)) or
                    currentY >= clip.y + @as(i32, @intCast(clip.height)))
                {
                    currentX += 1;
                    continue;
                }
            }

            var fg = text_buffer.fg[i];
            var bg = text_buffer.bg[i];
            const attributesRaw = text_buffer.attributes[i];

            if (attributesRaw & tb.USE_DEFAULT_FG != 0) {
                if (text_buffer.default_fg) |defFg| {
                    fg = defFg;
                }
            }

            if (attributesRaw & tb.USE_DEFAULT_BG != 0) {
                if (text_buffer.default_bg) |defBg| {
                    bg = defBg;
                }
            }

            var attributes: u8 = @intCast(attributesRaw & tb.ATTR_MASK);
            if (attributesRaw & tb.USE_DEFAULT_ATTR != 0) {
                if (text_buffer.default_attributes) |defAttr| {
                    attributes = defAttr;
                }
            }

            if (text_buffer.selection) |sel| {
                const isSelected = i >= sel.start and i < sel.end;
                if (isSelected) {
                    if (sel.bgColor) |selBg| {
                        bg = selBg;
                        if (sel.fgColor) |selFg| {
                            fg = selFg;
                        }
                    } else {
                        // Swap fg and bg for default selection style
                        const temp = fg;
                        fg = if (bg[3] > 0) bg else RGBA{ 0.0, 0.0, 0.0, 1.0 };
                        bg = temp;
                    }
                }
            }

            // Wait, isn't that handled by the ansi itself?
            if (attributes & (1 << 5) != 0) { // reverse bit
                const temp = fg;
                fg = bg;
                bg = temp;
            }

            try self.setCellWithAlphaBlending(
                @intCast(currentX),
                @intCast(currentY),
                charCode,
                fg,
                bg,
                attributes,
            );

            currentX += 1;
        }
    }

    /// Draw a box with borders and optional fill
    pub fn drawBox(
        self: *OptimizedBuffer,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        borderChars: [*]const u32, // Array of 11 border characters
        borderSides: BorderSides,
        borderColor: RGBA,
        backgroundColor: RGBA,
        shouldFill: bool,
        title: ?[]const u8,
        titleAlignment: u8, // 0=left, 1=center, 2=right
    ) !void {
        const startX = @max(0, x);
        const startY = @max(0, y);
        const endX = @min(@as(i32, @intCast(self.width)) - 1, x + @as(i32, @intCast(width)) - 1);
        const endY = @min(@as(i32, @intCast(self.height)) - 1, y + @as(i32, @intCast(height)) - 1);

        if (startX > endX or startY > endY) return;

        const isAtActualLeft = startX == x;
        const isAtActualRight = endX == x + @as(i32, @intCast(width)) - 1;
        const isAtActualTop = startY == y;
        const isAtActualBottom = endY == y + @as(i32, @intCast(height)) - 1;

        var shouldDrawTitle = false;
        var titleX: i32 = startX;
        var titleStartX: i32 = 0;
        var titleEndX: i32 = 0;

        if (title) |titleText| {
            if (titleText.len > 0 and borderSides.top and isAtActualTop) {
                const titleLength = @as(i32, @intCast(titleText.len));
                const minTitleSpace = 4;

                shouldDrawTitle = @as(i32, @intCast(width)) >= titleLength + minTitleSpace;

                if (shouldDrawTitle) {
                    const padding = 2;

                    if (titleAlignment == 1) { // center
                        titleX = startX + @max(padding, @divFloor(@as(i32, @intCast(width)) - titleLength, 2));
                    } else if (titleAlignment == 2) { // right
                        titleX = startX + @as(i32, @intCast(width)) - padding - titleLength;
                    } else { // left
                        titleX = startX + padding;
                    }

                    titleX = @max(startX + padding, @min(titleX, endX - titleLength));
                    titleStartX = titleX;
                    titleEndX = titleX + titleLength - 1;
                }
            }
        }

        if (shouldFill) {
            if (!borderSides.top and !borderSides.right and !borderSides.bottom and !borderSides.left) {
                const fillWidth = @as(u32, @intCast(endX - startX + 1));
                const fillHeight = @as(u32, @intCast(endY - startY + 1));
                try self.fillRect(@intCast(startX), @intCast(startY), fillWidth, fillHeight, backgroundColor);
            } else {
                const innerStartX = startX + if (borderSides.left and isAtActualLeft) @as(i32, 1) else @as(i32, 0);
                const innerStartY = startY + if (borderSides.top and isAtActualTop) @as(i32, 1) else @as(i32, 0);
                const innerEndX = endX - if (borderSides.right and isAtActualRight) @as(i32, 1) else @as(i32, 0);
                const innerEndY = endY - if (borderSides.bottom and isAtActualBottom) @as(i32, 1) else @as(i32, 0);

                if (innerEndX >= innerStartX and innerEndY >= innerStartY) {
                    const fillWidth = @as(u32, @intCast(innerEndX - innerStartX + 1));
                    const fillHeight = @as(u32, @intCast(innerEndY - innerStartY + 1));
                    try self.fillRect(@intCast(innerStartX), @intCast(innerStartY), fillWidth, fillHeight, backgroundColor);
                }
            }
        }

        // Special cases for extending vertical borders
        const leftBorderOnly = borderSides.left and isAtActualLeft and !borderSides.top and !borderSides.bottom;
        const rightBorderOnly = borderSides.right and isAtActualRight and !borderSides.top and !borderSides.bottom;
        const bottomOnlyWithVerticals = borderSides.bottom and isAtActualBottom and !borderSides.top and (borderSides.left or borderSides.right);
        const topOnlyWithVerticals = borderSides.top and isAtActualTop and !borderSides.bottom and (borderSides.left or borderSides.right);

        const extendVerticalsToTop = leftBorderOnly or rightBorderOnly or bottomOnlyWithVerticals;
        const extendVerticalsToBottom = leftBorderOnly or rightBorderOnly or topOnlyWithVerticals;

        // Draw horizontal borders
        if (borderSides.top or borderSides.bottom) {
            // Draw top border
            if (borderSides.top and isAtActualTop) {
                var drawX = startX;
                while (drawX <= endX) : (drawX += 1) {
                    if (startY >= 0 and startY < @as(i32, @intCast(self.height))) {
                        if (shouldDrawTitle and drawX >= titleStartX and drawX <= titleEndX) {
                            continue;
                        }

                        var char = borderChars[@intFromEnum(BorderCharIndex.horizontal)];

                        // Handle corners
                        if (drawX == startX and isAtActualLeft) {
                            char = if (borderSides.left) borderChars[@intFromEnum(BorderCharIndex.topLeft)] else borderChars[@intFromEnum(BorderCharIndex.horizontal)];
                        } else if (drawX == endX and isAtActualRight) {
                            char = if (borderSides.right) borderChars[@intFromEnum(BorderCharIndex.topRight)] else borderChars[@intFromEnum(BorderCharIndex.horizontal)];
                        }

                        try self.setCellWithAlphaBlending(@intCast(drawX), @intCast(startY), char, borderColor, backgroundColor, 0);
                    }
                }
            }

            // Draw bottom border
            if (borderSides.bottom and isAtActualBottom) {
                var drawX = startX;
                while (drawX <= endX) : (drawX += 1) {
                    if (endY >= 0 and endY < @as(i32, @intCast(self.height))) {
                        var char = borderChars[@intFromEnum(BorderCharIndex.horizontal)];

                        // Handle corners
                        if (drawX == startX and isAtActualLeft) {
                            char = if (borderSides.left) borderChars[@intFromEnum(BorderCharIndex.bottomLeft)] else borderChars[@intFromEnum(BorderCharIndex.horizontal)];
                        } else if (drawX == endX and isAtActualRight) {
                            char = if (borderSides.right) borderChars[@intFromEnum(BorderCharIndex.bottomRight)] else borderChars[@intFromEnum(BorderCharIndex.horizontal)];
                        }

                        try self.setCellWithAlphaBlending(@intCast(drawX), @intCast(endY), char, borderColor, backgroundColor, 0);
                    }
                }
            }
        }

        // Draw vertical borders
        const verticalStartY = if (extendVerticalsToTop) startY else startY + if (borderSides.top and isAtActualTop) @as(i32, 1) else @as(i32, 0);
        const verticalEndY = if (extendVerticalsToBottom) endY else endY - if (borderSides.bottom and isAtActualBottom) @as(i32, 1) else @as(i32, 0);

        if (borderSides.left or borderSides.right) {
            var drawY = verticalStartY;
            while (drawY <= verticalEndY) : (drawY += 1) {
                // Left border
                if (borderSides.left and isAtActualLeft and startX >= 0 and startX < @as(i32, @intCast(self.width))) {
                    try self.setCellWithAlphaBlending(@intCast(startX), @intCast(drawY), borderChars[@intFromEnum(BorderCharIndex.vertical)], borderColor, backgroundColor, 0);
                }

                // Right border
                if (borderSides.right and isAtActualRight and endX >= 0 and endX < @as(i32, @intCast(self.width))) {
                    try self.setCellWithAlphaBlending(@intCast(endX), @intCast(drawY), borderChars[@intFromEnum(BorderCharIndex.vertical)], borderColor, backgroundColor, 0);
                }
            }
        }

        if (shouldDrawTitle) {
            if (title) |titleText| {
                try self.drawText(titleText, @intCast(titleX), @intCast(startY), borderColor, backgroundColor, 0);
            }
        }
    }

    /// Draw a buffer of pixel data using super sampling (2x2 pixels per character cell)
    /// alignedBytesPerRow: The number of bytes per row in the pixelData buffer, considering alignment/padding.
    pub fn drawSuperSampleBuffer(
        self: *OptimizedBuffer,
        posX: u32,
        posY: u32,
        pixelData: [*]const u8,
        len: usize,
        format: u8, // 0: bgra8unorm, 1: rgba8unorm
        alignedBytesPerRow: u32,
    ) !void {
        const bytesPerPixel = 4;
        const isBGRA = (format == 0);

        // TODO: A more robust implementation might take source width/height explicitly.

        var y_cell = posY;
        while (y_cell < self.height) : (y_cell += 1) {
            var x_cell = posX;
            while (x_cell < self.width) : (x_cell += 1) {
                const renderX: u32 = (x_cell - posX) * 2;
                const renderY: u32 = (y_cell - posY) * 2;

                const tlIndex: usize = @intCast(renderY * alignedBytesPerRow + renderX * bytesPerPixel);
                const trIndex: usize = tlIndex + bytesPerPixel;
                const blIndex: usize = @intCast((renderY + 1) * alignedBytesPerRow + renderX * bytesPerPixel);
                const brIndex: usize = blIndex + bytesPerPixel;

                const indices = [_]usize{ tlIndex, trIndex, blIndex, brIndex };

                // Get RGBA colors for TL, TR, BL, BR
                var pixelsRgba: [4]RGBA = undefined;
                pixelsRgba[0] = getPixelColor(indices[0], pixelData, len, isBGRA); // TL
                pixelsRgba[1] = getPixelColor(indices[1], pixelData, len, isBGRA); // TR
                pixelsRgba[2] = getPixelColor(indices[2], pixelData, len, isBGRA); // BL
                pixelsRgba[3] = getPixelColor(indices[3], pixelData, len, isBGRA); // BR

                const cellResult = renderQuadrantBlock(pixelsRgba);

                try self.setCellWithAlphaBlending(x_cell, y_cell, cellResult.char, cellResult.fg, cellResult.bg, 0);
            }
        }
    }

    /// Draw a buffer of pixel data using pre-computed super sample results from compute shader
    /// data contains an array of CellResult structs (48 bytes each)
    /// Each CellResult: bg(16) + fg(16) + char(4) + padding1(4) + padding2(4) + padding3(4) = 48 bytes
    pub fn drawPackedBuffer(
        self: *OptimizedBuffer,
        data: [*]const u8,
        dataLen: usize,
        posX: u32,
        posY: u32,
        terminalWidthCells: u32,
        terminalHeightCells: u32,
    ) void {
        const cellResultSize = 48;
        const numCells = dataLen / cellResultSize;
        const bufferWidthCells = terminalWidthCells;

        var i: usize = 0;
        while (i < numCells) : (i += 1) {
            const cellDataOffset = i * cellResultSize;

            const cellX = posX + @as(u32, @intCast(i % bufferWidthCells));
            const cellY = posY + @as(u32, @intCast(i / bufferWidthCells));

            if (cellX >= terminalWidthCells or cellY >= terminalHeightCells) continue;
            if (cellX >= self.width or cellY >= self.height) continue;

            const bgPtr = @as([*]const f32, @ptrCast(@alignCast(data + cellDataOffset)));
            const bg: RGBA = .{ bgPtr[0], bgPtr[1], bgPtr[2], bgPtr[3] };

            const fgPtr = @as([*]const f32, @ptrCast(@alignCast(data + cellDataOffset + 16)));
            const fg: RGBA = .{ fgPtr[0], fgPtr[1], fgPtr[2], fgPtr[3] };

            const charPtr = @as([*]const u32, @ptrCast(@alignCast(data + cellDataOffset + 32)));
            var char = charPtr[0];

            if (char == 0 or char > MAX_UNICODE_CODEPOINT) {
                char = DEFAULT_SPACE_CHAR;
            }

            if (char < 32 or (char > 126 and char < 0x2580)) {
                char = BLOCK_CHAR;
            }

            self.setCellWithAlphaBlending(cellX, cellY, char, fg, bg, 0) catch {};
        }
    }
};

fn getPixelColor(idx: usize, data: [*]const u8, dataLen: usize, bgra: bool) RGBA {
    if (idx + 3 >= dataLen) {
        return .{ 1.0, 0.0, 1.0, 0.0 }; // Return Transparent Magenta for out-of-bounds
    }
    var rByte: u8 = undefined;
    var gByte: u8 = undefined;
    var bByte: u8 = undefined;
    var aByte: u8 = undefined;

    if (bgra) {
        bByte = data[idx];
        gByte = data[idx + 1];
        rByte = data[idx + 2];
        aByte = data[idx + 3];
    } else { // Assume RGBA
        rByte = data[idx];
        gByte = data[idx + 1];
        bByte = data[idx + 2];
        aByte = data[idx + 3];
    }

    return .{
        @as(f32, @floatFromInt(rByte)) * INV_255,
        @as(f32, @floatFromInt(gByte)) * INV_255,
        @as(f32, @floatFromInt(bByte)) * INV_255,
        @as(f32, @floatFromInt(aByte)) * INV_255,
    };
}

const quadrantChars = [_]u32{
    32, // 0000
    0x2597, // 0001 BR ░
    0x2596, // 0010 BL ░
    0x2584, // 0011 Lower Half Block ▄
    0x259D, // 0100 TR ░
    0x2590, // 0101 Right Half Block ▐
    0x259E, // 0110 TR+BL ░
    0x259F, // 0111 TR+BL+BR ░
    0x2598, // 1000 TL ░
    0x259A, // 1001 TL+BR ░
    0x258C, // 1010 Left Half Block ▌
    0x2599, // 1011 TL+BL+BR ░
    0x2580, // 1100 Upper Half Block ▀
    0x259C, // 1101 TL+TR+BR ░
    0x259B, // 1110 TL+TR+BL ░
    0x2588, // 1111 Full Block █
};

fn colorDistance(a: RGBA, b: RGBA) f32 {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
}

fn closestColorIndex(pixel: RGBA, candidates: [2]RGBA) u1 {
    return if (colorDistance(pixel, candidates[0]) <= colorDistance(pixel, candidates[1])) 0 else 1;
}

fn averageColorRgba(pixels: []const RGBA) RGBA {
    if (pixels.len == 0) return .{ 0.0, 0.0, 0.0, 0.0 };

    var sumR: f32 = 0.0;
    var sumG: f32 = 0.0;
    var sumB: f32 = 0.0;
    var sumA: f32 = 0.0;

    for (pixels) |p| {
        sumR += p[0];
        sumG += p[1];
        sumB += p[2];
        sumA += p[3];
    }

    const len = @as(f32, @floatFromInt(pixels.len));
    return .{ sumR / len, sumG / len, sumB / len, sumA / len };
}

fn luminance(color: RGBA) f32 {
    return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

pub const QuadrantResult = struct {
    char: u32,
    fg: RGBA,
    bg: RGBA,
};

// Calculate the quadrant block character and colors from RGBA pixels
fn renderQuadrantBlock(pixels: [4]RGBA) QuadrantResult {
    // 1. Find the most different pair of pixels
    var p_idxA: u3 = 0;
    var p_idxB: u3 = 1;
    var maxDist = colorDistance(pixels[0], pixels[1]);

    inline for (0..4) |i| {
        inline for ((i + 1)..4) |j| {
            const dist = colorDistance(pixels[i], pixels[j]);
            if (dist > maxDist) {
                p_idxA = @intCast(i);
                p_idxB = @intCast(j);
                maxDist = dist;
            }
        }
    }
    const p_candA = pixels[p_idxA];
    const p_candB = pixels[p_idxB];

    // 2. Determine chosen_dark_color and chosen_light_color based on luminance
    var chosen_dark_color: RGBA = undefined;
    var chosen_light_color: RGBA = undefined;

    if (luminance(p_candA) <= luminance(p_candB)) {
        chosen_dark_color = p_candA;
        chosen_light_color = p_candB;
    } else {
        chosen_dark_color = p_candB;
        chosen_light_color = p_candA;
    }

    // 3. Classify quadrants and build quadrantBits
    var quadrantBits: u4 = 0;
    const bitValues = [_]u4{ 8, 4, 2, 1 };

    inline for (0..4) |i| {
        const pixelRgba = pixels[i];
        if (closestColorIndex(pixelRgba, .{ chosen_dark_color, chosen_light_color }) == 0) {
            quadrantBits |= bitValues[i];
        }
    }

    // 4. Construct Result
    if (quadrantBits == 0) { // All light
        return QuadrantResult{
            .char = 32,
            .fg = chosen_dark_color,
            .bg = averageColorRgba(pixels[0..4]),
        };
    } else if (quadrantBits == 15) { // All dark
        return QuadrantResult{
            .char = quadrantChars[15],
            .fg = averageColorRgba(pixels[0..4]),
            .bg = chosen_light_color,
        };
    } else { // Mixed pattern
        return QuadrantResult{
            .char = quadrantChars[quadrantBits],
            .fg = chosen_dark_color,
            .bg = chosen_light_color,
        };
    }
}
