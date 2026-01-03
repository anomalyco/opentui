const std = @import("std");
const Allocator = std.mem.Allocator;
const ansi = @import("ansi.zig");
const tb = @import("text-buffer.zig");
const tbv = @import("text-buffer-view.zig");
const edv = @import("editor-view.zig");
const ss = @import("syntax-style.zig");
const math = std.math;

const gp = @import("grapheme.zig");
const link = @import("link.zig");

const logger = @import("logger.zig");
const utf8 = @import("utf8.zig");
const uucode = @import("uucode");

pub const RGBA = ansi.RGBA;
pub const Vec3f = @Vector(3, f32);
pub const Vec4f = @Vector(4, f32);

const TextBuffer = tb.TextBuffer;
const TextBufferView = tbv.TextBufferView;
const EditorView = edv.EditorView;

const INV_255: f32 = 1.0 / 255.0;
pub const DEFAULT_SPACE_CHAR: u32 = 32;
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
    attributes: u32,
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
        attributes: []u32,
    },
    width: u32,
    height: u32,
    respectAlpha: bool,
    allocator: Allocator,
    pool: *gp.GraphemePool,
    link_pool: *link.LinkPool,

    grapheme_tracker: gp.GraphemeTracker,
    link_tracker: link.LinkTracker,
    width_method: utf8.WidthMethod,
    id: []const u8,
    scissor_stack: std.ArrayListUnmanaged(ClipRect),
    opacity_stack: std.ArrayListUnmanaged(f32),

    const InitOptions = struct {
        respectAlpha: bool = false,
        pool: *gp.GraphemePool,
        width_method: utf8.WidthMethod = .unicode,
        id: []const u8 = "unnamed buffer",
        link_pool: ?*link.LinkPool = null,
    };

    pub fn init(allocator: Allocator, width: u32, height: u32, options: InitOptions) BufferError!*OptimizedBuffer {
        if (width == 0 or height == 0) {
            logger.warn("OptimizedBuffer.init: Invalid dimensions {}x{}", .{ width, height });
            return BufferError.InvalidDimensions;
        }

        const self = allocator.create(OptimizedBuffer) catch return BufferError.OutOfMemory;
        errdefer allocator.destroy(self);

        const size = width * height;

        const owned_id = allocator.dupe(u8, options.id) catch return BufferError.OutOfMemory;
        errdefer allocator.free(owned_id);

        var scissor_stack: std.ArrayListUnmanaged(ClipRect) = .{};
        errdefer scissor_stack.deinit(allocator);

        var opacity_stack: std.ArrayListUnmanaged(f32) = .{};
        errdefer opacity_stack.deinit(allocator);

        const lp = options.link_pool orelse link.initGlobalLinkPool(allocator);

        self.* = .{
            .buffer = .{
                .char = allocator.alloc(u32, size) catch return BufferError.OutOfMemory,
                .fg = allocator.alloc(RGBA, size) catch return BufferError.OutOfMemory,
                .bg = allocator.alloc(RGBA, size) catch return BufferError.OutOfMemory,
                .attributes = allocator.alloc(u32, size) catch return BufferError.OutOfMemory,
            },
            .width = width,
            .height = height,
            .respectAlpha = options.respectAlpha,
            .allocator = allocator,
            .pool = options.pool,
            .link_pool = lp,
            .grapheme_tracker = gp.GraphemeTracker.init(allocator, options.pool),
            .link_tracker = link.LinkTracker.init(allocator, lp),
            .width_method = options.width_method,
            .id = owned_id,
            .scissor_stack = scissor_stack,
            .opacity_stack = opacity_stack,
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

    pub fn getAttributesPtr(self: *OptimizedBuffer) [*]u32 {
        return self.buffer.attributes.ptr;
    }

    pub fn deinit(self: *OptimizedBuffer) void {
        self.opacity_stack.deinit(self.allocator);
        self.scissor_stack.deinit(self.allocator);
        self.link_tracker.deinit();
        self.grapheme_tracker.deinit();
        self.allocator.free(self.buffer.char);
        self.allocator.free(self.buffer.fg);
        self.allocator.free(self.buffer.bg);
        self.allocator.free(self.buffer.attributes);
        self.allocator.free(self.id);
        self.allocator.destroy(self);
    }

    pub fn getCurrentScissorRect(self: *const OptimizedBuffer) ?ClipRect {
        if (self.scissor_stack.items.len == 0) return null;
        return self.scissor_stack.items[self.scissor_stack.items.len - 1];
    }

    pub fn isPointInScissor(self: *const OptimizedBuffer, x: i32, y: i32) bool {
        const scissor = self.getCurrentScissorRect() orelse return true;
        return x >= scissor.x and x < scissor.x + @as(i32, @intCast(scissor.width)) and
            y >= scissor.y and y < scissor.y + @as(i32, @intCast(scissor.height));
    }

    pub fn isRectInScissor(self: *const OptimizedBuffer, x: i32, y: i32, width: u32, height: u32) bool {
        const scissor = self.getCurrentScissorRect() orelse return true;

        const rect_end_x = x + @as(i32, @intCast(width));
        const rect_end_y = y + @as(i32, @intCast(height));
        const scissor_end_x = scissor.x + @as(i32, @intCast(scissor.width));
        const scissor_end_y = scissor.y + @as(i32, @intCast(scissor.height));

        return !(x >= scissor_end_x or rect_end_x <= scissor.x or
            y >= scissor_end_y or rect_end_y <= scissor.y);
    }

    pub fn clipRectToScissor(self: *const OptimizedBuffer, x: i32, y: i32, width: u32, height: u32) ?ClipRect {
        const scissor = self.getCurrentScissorRect() orelse return ClipRect{
            .x = x,
            .y = y,
            .width = width,
            .height = height,
        };

        const rect_end_x = x + @as(i32, @intCast(width));
        const rect_end_y = y + @as(i32, @intCast(height));
        const scissor_end_x = scissor.x + @as(i32, @intCast(scissor.width));
        const scissor_end_y = scissor.y + @as(i32, @intCast(scissor.height));

        const intersect_x = @max(x, scissor.x);
        const intersect_y = @max(y, scissor.y);
        const intersect_end_x = @min(rect_end_x, scissor_end_x);
        const intersect_end_y = @min(rect_end_y, scissor_end_y);

        if (intersect_x >= intersect_end_x or intersect_y >= intersect_end_y) {
            return null; // No intersection
        }

        return ClipRect{
            .x = intersect_x,
            .y = intersect_y,
            .width = @intCast(intersect_end_x - intersect_x),
            .height = @intCast(intersect_end_y - intersect_y),
        };
    }

    pub fn pushScissorRect(self: *OptimizedBuffer, x: i32, y: i32, width: u32, height: u32) !void {
        var rect = ClipRect{
            .x = x,
            .y = y,
            .width = width,
            .height = height,
        };

        // Intersect with current scissor (if any) so nested scissor rects always clip to parents.
        if (self.getCurrentScissorRect() != null) {
            const intersect = self.clipRectToScissor(rect.x, rect.y, rect.width, rect.height);
            if (intersect) |clipped| {
                rect = clipped;
            } else {
                // Completely outside current scissor; push a degenerate rect so nothing renders.
                rect = ClipRect{ .x = 0, .y = 0, .width = 0, .height = 0 };
            }
        }

        try self.scissor_stack.append(self.allocator, rect);
    }

    pub fn popScissorRect(self: *OptimizedBuffer) void {
        if (self.scissor_stack.items.len > 0) {
            _ = self.scissor_stack.pop();
        }
    }

    pub fn clearScissorRects(self: *OptimizedBuffer) void {
        self.scissor_stack.clearRetainingCapacity();
    }

    /// Get the current effective opacity (product of all stacked opacities)
    pub fn getCurrentOpacity(self: *const OptimizedBuffer) f32 {
        if (self.opacity_stack.items.len == 0) return 1.0;
        return self.opacity_stack.items[self.opacity_stack.items.len - 1];
    }

    /// Push an opacity value onto the stack. The effective opacity is multiplied with the current.
    pub fn pushOpacity(self: *OptimizedBuffer, opacity: f32) !void {
        const current = self.getCurrentOpacity();
        const effective = current * std.math.clamp(opacity, 0.0, 1.0);
        try self.opacity_stack.append(self.allocator, effective);
    }

    /// Pop an opacity value from the stack
    pub fn popOpacity(self: *OptimizedBuffer) void {
        if (self.opacity_stack.items.len > 0) {
            _ = self.opacity_stack.pop();
        }
    }

    /// Clear all opacity values from the stack
    pub fn clearOpacity(self: *OptimizedBuffer) void {
        self.opacity_stack.clearRetainingCapacity();
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

        // Always clear after resize to initialize cells (realloc doesn't zero memory)
        // This handles both growing (new cells are garbage) and shrinking (grapheme cleanup)
        try self.clear(.{ 0.0, 0.0, 0.0, 1.0 }, null);
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
        self.link_tracker.clear();
        self.grapheme_tracker.clear();
        @memset(self.buffer.char, @intCast(cellChar));
        @memset(self.buffer.attributes, 0);
        @memset(self.buffer.fg, .{ 1.0, 1.0, 1.0, 1.0 });
        @memset(self.buffer.bg, bg);
    }

    pub fn setRaw(self: *OptimizedBuffer, x: u32, y: u32, cell: Cell) void {
        if (x >= self.width or y >= self.height) return;
        if (!self.isPointInScissor(@intCast(x), @intCast(y))) return;
        const index = self.coordsToIndex(x, y);

        const prev_attr = self.buffer.attributes[index];
        const prev_link_id = ansi.TextAttributes.getLinkId(prev_attr);
        const new_link_id = ansi.TextAttributes.getLinkId(cell.attributes);

        self.buffer.char[index] = cell.char;
        self.buffer.fg[index] = cell.fg;
        self.buffer.bg[index] = cell.bg;
        self.buffer.attributes[index] = cell.attributes;

        if (prev_link_id != 0 and prev_link_id != new_link_id) {
            self.link_tracker.removeCellRef(prev_link_id);
        }
        if (new_link_id != 0 and new_link_id != prev_link_id) {
            self.link_tracker.addCellRef(new_link_id);
        }
    }

    pub fn set(self: *OptimizedBuffer, x: u32, y: u32, cell: Cell) void {
        if (x >= self.width or y >= self.height) return;
        if (!self.isPointInScissor(@intCast(x), @intCast(y))) return;

        const index = self.coordsToIndex(x, y);
        const prev_char = self.buffer.char[index];
        const prev_attr = self.buffer.attributes[index];
        const prev_link_id = ansi.TextAttributes.getLinkId(prev_attr);

        // If overwriting a grapheme span (start or continuation) with a different char, clear that span first
        if ((gp.isGraphemeChar(prev_char) or gp.isContinuationChar(prev_char)) and prev_char != cell.char) {
            const row_start: u32 = y * self.width;
            const row_end: u32 = row_start + self.width - 1;
            const left = gp.charLeftExtent(prev_char);
            const right = gp.charRightExtent(prev_char);
            const id = gp.graphemeIdFromChar(prev_char);

            self.grapheme_tracker.remove(id);

            const span_start = index - @min(left, index - row_start);
            const span_end = index + @min(right, row_end - index);
            const span_len = span_end - span_start + 1;

            var span_i: u32 = span_start;
            while (span_i < span_start + span_len) : (span_i += 1) {
                const span_link_id = ansi.TextAttributes.getLinkId(self.buffer.attributes[span_i]);
                if (span_link_id != 0) {
                    self.link_tracker.removeCellRef(span_link_id);
                }
            }

            @memset(self.buffer.char[span_start .. span_start + span_len], @intCast(DEFAULT_SPACE_CHAR));
            @memset(self.buffer.attributes[span_start .. span_start + span_len], 0);
        }

        if (gp.isGraphemeChar(cell.char)) {
            const right = gp.charRightExtent(cell.char);
            const width: u32 = 1 + right;

            if (x + width > self.width) {
                const end_of_line = (y + 1) * self.width;
                var eol_i = index;
                while (eol_i < end_of_line) : (eol_i += 1) {
                    const eol_link_id = ansi.TextAttributes.getLinkId(self.buffer.attributes[eol_i]);
                    if (eol_link_id != 0) {
                        self.link_tracker.removeCellRef(eol_link_id);
                    }
                }
                @memset(self.buffer.char[index..end_of_line], @intCast(DEFAULT_SPACE_CHAR));
                @memset(self.buffer.attributes[index..end_of_line], cell.attributes);
                @memset(self.buffer.fg[index..end_of_line], cell.fg);
                @memset(self.buffer.bg[index..end_of_line], cell.bg);
                const new_link_id = ansi.TextAttributes.getLinkId(cell.attributes);
                if (new_link_id != 0) {
                    const cells_written = end_of_line - index;
                    var link_i: u32 = 0;
                    while (link_i < cells_written) : (link_i += 1) {
                        self.link_tracker.addCellRef(new_link_id);
                    }
                }
                return;
            }

            self.buffer.char[index] = cell.char;
            self.buffer.fg[index] = cell.fg;
            self.buffer.bg[index] = cell.bg;
            self.buffer.attributes[index] = cell.attributes;

            const id: u32 = gp.graphemeIdFromChar(cell.char);
            self.grapheme_tracker.add(id);

            const new_link_id = ansi.TextAttributes.getLinkId(cell.attributes);
            if (prev_link_id != 0 and prev_link_id != new_link_id) {
                self.link_tracker.removeCellRef(prev_link_id);
            }
            if (new_link_id != 0 and new_link_id != prev_link_id) {
                self.link_tracker.addCellRef(new_link_id);
            }
            if (prev_link_id != 0 and prev_link_id != new_link_id) {
                self.link_tracker.removeCellRef(prev_link_id);
            }
            if (new_link_id != 0 and new_link_id != prev_link_id) {
                self.link_tracker.addCellRef(new_link_id);
            }

            if (width > 1) {
                const row_end_index: u32 = (y * self.width) + self.width - 1;
                const max_right = @min(right, row_end_index - index);
                if (max_right > 0) {
                    var cont_i: u32 = 1;
                    while (cont_i <= max_right) : (cont_i += 1) {
                        const cont_link_id = ansi.TextAttributes.getLinkId(self.buffer.attributes[index + cont_i]);
                        if (cont_link_id != 0) {
                            self.link_tracker.removeCellRef(cont_link_id);
                        }
                    }

                    @memset(self.buffer.fg[index + 1 .. index + 1 + max_right], cell.fg);
                    @memset(self.buffer.bg[index + 1 .. index + 1 + max_right], cell.bg);
                    @memset(self.buffer.attributes[index + 1 .. index + 1 + max_right], cell.attributes);
                    var k: u32 = 1;
                    while (k <= max_right) : (k += 1) {
                        const cont = gp.packContinuation(k, max_right - k, id);
                        self.buffer.char[index + k] = cont;
                        if (new_link_id != 0) {
                            self.link_tracker.addCellRef(new_link_id);
                        }
                    }
                }
            }
        } else {
            self.buffer.char[index] = cell.char;
            self.buffer.fg[index] = cell.fg;
            self.buffer.bg[index] = cell.bg;
            self.buffer.attributes[index] = cell.attributes;

            const new_link_id = ansi.TextAttributes.getLinkId(cell.attributes);
            if (prev_link_id != 0 and prev_link_id != new_link_id) {
                self.link_tracker.removeCellRef(prev_link_id);
            }
            if (new_link_id != 0 and new_link_id != prev_link_id) {
                self.link_tracker.addCellRef(new_link_id);
            }
        }
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

    pub fn getId(self: *const OptimizedBuffer) []const u8 {
        return self.id;
    }

    /// Calculate the real byte size of the character buffer including grapheme pool data
    pub fn getRealCharSize(self: *const OptimizedBuffer) u32 {
        const total_chars = self.width * self.height;
        const grapheme_count = self.grapheme_tracker.getGraphemeCount();
        const total_grapheme_bytes = self.grapheme_tracker.getTotalGraphemeBytes();

        const regular_char_bytes = (total_chars - grapheme_count) * @sizeOf(u32);
        return regular_char_bytes + total_grapheme_bytes;
    }

    /// Write all resolved character bytes to the given output buffer
    /// Returns the number of bytes written, or 0 if the output buffer is too small
    pub fn writeResolvedChars(self: *const OptimizedBuffer, output_buffer: []u8, addLineBreaks: bool) BufferError!u32 {
        var bytes_written: u32 = 0;
        const total_cells = self.width * self.height;

        var i: u32 = 0;
        while (i < total_cells) : (i += 1) {
            const char_code = self.buffer.char[i];

            if (gp.isGraphemeChar(char_code)) {
                const gid = gp.graphemeIdFromChar(char_code);
                if (self.pool.get(gid)) |grapheme_bytes| {
                    if (bytes_written + grapheme_bytes.len > output_buffer.len) {
                        return BufferError.BufferTooSmall;
                    }
                    @memcpy(output_buffer[bytes_written .. bytes_written + grapheme_bytes.len], grapheme_bytes);
                    bytes_written += @intCast(grapheme_bytes.len);
                } else |_| {
                    if (bytes_written + 1 > output_buffer.len) {
                        return BufferError.BufferTooSmall;
                    }
                    output_buffer[bytes_written] = ' ';
                    bytes_written += 1;
                }
            } else if (gp.isContinuationChar(char_code)) {
                continue;
            } else {
                const codepoint = char_code;

                if (codepoint > 0x10FFFF) {
                    if (bytes_written + 1 > output_buffer.len) {
                        return BufferError.BufferTooSmall;
                    }
                    output_buffer[bytes_written] = ' ';
                    bytes_written += 1;
                    continue;
                }

                var utf8_bytes: [4]u8 = undefined;
                const utf8_len = std.unicode.utf8Encode(@intCast(codepoint), &utf8_bytes) catch {
                    if (bytes_written + 1 > output_buffer.len) {
                        return BufferError.BufferTooSmall;
                    }
                    output_buffer[bytes_written] = ' ';
                    bytes_written += 1;
                    continue;
                };

                if (bytes_written + utf8_len > output_buffer.len) {
                    return BufferError.BufferTooSmall;
                }
                @memcpy(output_buffer[bytes_written .. bytes_written + utf8_len], utf8_bytes[0..utf8_len]);
                bytes_written += @intCast(utf8_len);
            }

            if (addLineBreaks and (i + 1) % self.width == 0) {
                if (bytes_written + 1 > output_buffer.len) {
                    return BufferError.BufferTooSmall;
                }
                output_buffer[bytes_written] = '\n';
                bytes_written += 1;
            }
        }

        return bytes_written;
    }

    pub fn blendCells(overlayCell: Cell, destCell: Cell) Cell {
        const hasBgAlpha = isRGBAWithAlpha(overlayCell.bg);
        const hasFgAlpha = isRGBAWithAlpha(overlayCell.fg);

        if (hasBgAlpha or hasFgAlpha) {
            const blendedBgRgb = if (hasBgAlpha) blendColors(overlayCell.bg, destCell.bg) else overlayCell.bg;
            const charIsDefaultSpace = overlayCell.char == DEFAULT_SPACE_CHAR;
            const destNotZero = destCell.char != 0;
            const destNotDefaultSpace = destCell.char != DEFAULT_SPACE_CHAR;
            const destWidthIsOne = gp.encodedCharWidth(destCell.char) == 1;

            const preserveChar = (charIsDefaultSpace and
                destNotZero and
                destNotDefaultSpace and
                destWidthIsOne);
            const finalChar = if (preserveChar) destCell.char else overlayCell.char;

            var finalFg: RGBA = undefined;
            if (preserveChar) {
                finalFg = blendColors(overlayCell.bg, destCell.fg);
            } else {
                finalFg = if (hasFgAlpha) blendColors(overlayCell.fg, destCell.bg) else overlayCell.fg;
            }

            // When preserving char, preserve its base attributes but NOT its link
            // Links ALWAYS come from overlay, never from destination
            // Even if overlay has no link (link_id=0), it clears the destination's link
            const baseAttrs = if (preserveChar)
                ansi.TextAttributes.getBaseAttributes(destCell.attributes)
            else
                ansi.TextAttributes.getBaseAttributes(overlayCell.attributes);
            // Overlay link always wins - whether it's a real link or 0 (no link)
            const overlayLinkId = ansi.TextAttributes.getLinkId(overlayCell.attributes);
            const finalAttributes = ansi.TextAttributes.setLinkId(@as(u32, baseAttrs), overlayLinkId);

            // When overlay background is fully transparent, preserve destination background alpha
            const finalBgAlpha = if (overlayCell.bg[3] == 0.0) destCell.bg[3] else overlayCell.bg[3];

            return Cell{
                .char = finalChar,
                .fg = finalFg,
                .bg = .{ blendedBgRgb[0], blendedBgRgb[1], blendedBgRgb[2], finalBgAlpha },
                .attributes = finalAttributes,
            };
        }

        return overlayCell;
    }

    pub fn setCellWithAlphaBlending(
        self: *OptimizedBuffer,
        x: u32,
        y: u32,
        char: u32,
        fg: RGBA,
        bg: RGBA,
        attributes: u32,
    ) !void {
        if (!self.isPointInScissor(@intCast(x), @intCast(y))) return;

        // Apply current opacity from the stack
        const opacity = self.getCurrentOpacity();
        const effectiveFg = RGBA{ fg[0], fg[1], fg[2], fg[3] * opacity };
        const effectiveBg = RGBA{ bg[0], bg[1], bg[2], bg[3] * opacity };

        const overlayCell = Cell{ .char = char, .fg = effectiveFg, .bg = effectiveBg, .attributes = attributes };

        if (self.get(x, y)) |destCell| {
            const blendedCell = blendCells(overlayCell, destCell);
            self.set(x, y, blendedCell);
        } else {
            self.set(x, y, overlayCell);
        }
    }

    pub fn setCellWithAlphaBlendingRaw(
        self: *OptimizedBuffer,
        x: u32,
        y: u32,
        char: u32,
        fg: RGBA,
        bg: RGBA,
        attributes: u32,
    ) !void {
        if (!self.isPointInScissor(@intCast(x), @intCast(y))) return;

        // Apply current opacity from the stack
        const opacity = self.getCurrentOpacity();
        const effectiveFg = RGBA{ fg[0], fg[1], fg[2], fg[3] * opacity };
        const effectiveBg = RGBA{ bg[0], bg[1], bg[2], bg[3] * opacity };

        const overlayCell = Cell{ .char = char, .fg = effectiveFg, .bg = effectiveBg, .attributes = attributes };

        if (self.get(x, y)) |destCell| {
            const blendedCell = blendCells(overlayCell, destCell);
            // After blending, check if result contains a grapheme
            if (gp.isGraphemeChar(blendedCell.char)) {
                return self.set(x, y, blendedCell);
            }
            self.setRaw(x, y, blendedCell);
        } else {
            self.setRaw(x, y, overlayCell);
        }
    }

    pub fn drawChar(
        self: *OptimizedBuffer,
        char: u32,
        x: u32,
        y: u32,
        fg: RGBA,
        bg: RGBA,
        attributes: u32,
    ) !void {
        if (!self.isPointInScissor(@intCast(x), @intCast(y))) return;

        if (isRGBAWithAlpha(bg) or isRGBAWithAlpha(fg)) {
            try self.setCellWithAlphaBlending(x, y, char, fg, bg, attributes);
        } else {
            self.set(x, y, Cell{
                .char = char,
                .fg = fg,
                .bg = bg,
                .attributes = attributes,
            });
        }
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

        if (!self.isRectInScissor(@intCast(x), @intCast(y), width, height)) return;

        const startX = x;
        const startY = y;
        const maxEndX = if (x < self.width) self.width - 1 else 0;
        const maxEndY = if (y < self.height) self.height - 1 else 0;
        const requestedEndX = x + width - 1;
        const requestedEndY = y + height - 1;
        const endX = @min(maxEndX, requestedEndX);
        const endY = @min(maxEndY, requestedEndY);

        if (startX > endX or startY > endY) return;

        const clippedRect = self.clipRectToScissor(@intCast(startX), @intCast(startY), endX - startX + 1, endY - startY + 1) orelse return;
        const clippedStartX = @max(startX, @as(u32, @intCast(clippedRect.x)));
        const clippedStartY = @max(startY, @as(u32, @intCast(clippedRect.y)));
        const clippedEndX = @min(endX, @as(u32, @intCast(clippedRect.x + @as(i32, @intCast(clippedRect.width)) - 1)));
        const clippedEndY = @min(endY, @as(u32, @intCast(clippedRect.y + @as(i32, @intCast(clippedRect.height)) - 1)));

        const opacity = self.getCurrentOpacity();
        const hasAlpha = isRGBAWithAlpha(bg) or opacity < 1.0;
        const linkAware = self.link_tracker.hasAny();

        if (hasAlpha or self.grapheme_tracker.hasAny() or linkAware) {
            var fillY = clippedStartY;
            while (fillY <= clippedEndY) : (fillY += 1) {
                var fillX = clippedStartX;
                while (fillX <= clippedEndX) : (fillX += 1) {
                    try self.setCellWithAlphaBlending(fillX, fillY, DEFAULT_SPACE_CHAR, .{ 1.0, 1.0, 1.0, 1.0 }, bg, 0);
                }
            }
        } else {
            // For non-alpha (fully opaque) backgrounds with no graphemes or links, we can do direct filling
            var fillY = clippedStartY;
            while (fillY <= clippedEndY) : (fillY += 1) {
                const rowStartIndex = self.coordsToIndex(@intCast(clippedStartX), @intCast(fillY));
                const rowWidth = clippedEndX - clippedStartX + 1;

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
        attributes: u32,
    ) BufferError!void {
        if (x >= self.width or y >= self.height) return;
        if (text.len == 0) return;

        const is_ascii_only = utf8.isAsciiOnly(text);

        var grapheme_list: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
        defer grapheme_list.deinit(self.allocator);

        const tab_width: u8 = 2;
        try utf8.findGraphemeInfo(text, tab_width, is_ascii_only, self.width_method, self.allocator, &grapheme_list);
        const specials = grapheme_list.items;

        var advance_cells: u32 = 0;
        var byte_offset: u32 = 0;
        var col: u32 = 0;
        var special_idx: usize = 0;

        while (byte_offset < text.len) {
            const charX = x + advance_cells;
            if (charX >= self.width) break;

            const at_special = special_idx < specials.len and specials[special_idx].col_offset == col;

            var grapheme_bytes: []const u8 = undefined;
            var g_width: u8 = undefined;

            if (at_special) {
                const g = specials[special_idx];
                grapheme_bytes = text[g.byte_offset .. g.byte_offset + g.byte_len];
                g_width = g.width;
                byte_offset = g.byte_offset + g.byte_len;
                special_idx += 1;
            } else {
                if (byte_offset >= text.len) break;
                grapheme_bytes = text[byte_offset .. byte_offset + 1];
                g_width = 1;
                byte_offset += 1;
            }

            if (!self.isPointInScissor(@intCast(charX), @intCast(y))) {
                advance_cells += g_width;
                col += g_width;
                continue;
            }

            var bgColor: RGBA = undefined;
            if (bg) |b| {
                bgColor = b;
            } else if (self.get(charX, y)) |existingCell| {
                bgColor = existingCell.bg;
            } else {
                bgColor = .{ 0.0, 0.0, 0.0, 1.0 };
            }

            const cell_width = utf8.getWidthAt(text, if (at_special) specials[special_idx - 1].byte_offset else byte_offset - 1, tab_width, self.width_method);
            if (cell_width == 0) {
                col += g_width;
                continue;
            }

            if (grapheme_bytes.len == 1 and grapheme_bytes[0] == '\t') {
                var tab_col: u32 = 0;
                while (tab_col < g_width) : (tab_col += 1) {
                    const tab_x = charX + tab_col;
                    if (tab_x >= self.width) break;

                    if (isRGBAWithAlpha(bgColor)) {
                        try self.setCellWithAlphaBlending(
                            tab_x,
                            y,
                            DEFAULT_SPACE_CHAR,
                            fg,
                            bgColor,
                            attributes,
                        );
                    } else {
                        self.set(tab_x, y, Cell{
                            .char = DEFAULT_SPACE_CHAR,
                            .fg = fg,
                            .bg = bgColor,
                            .attributes = attributes,
                        });
                    }
                }
                advance_cells += g_width;
                col += g_width;
                continue;
            }

            var encoded_char: u32 = 0;
            if (grapheme_bytes.len == 1 and cell_width == 1 and grapheme_bytes[0] >= 32) {
                encoded_char = @as(u32, grapheme_bytes[0]);
            } else {
                const gid = self.pool.alloc(grapheme_bytes) catch return BufferError.OutOfMemory;
                encoded_char = gp.packGraphemeStart(gid & gp.GRAPHEME_ID_MASK, cell_width);
            }

            if (isRGBAWithAlpha(bgColor)) {
                try self.setCellWithAlphaBlending(charX, y, encoded_char, fg, bgColor, attributes);
            } else {
                self.set(charX, y, Cell{
                    .char = encoded_char,
                    .fg = fg,
                    .bg = bgColor,
                    .attributes = attributes,
                });
            }

            advance_cells += cell_width;
            col += g_width;
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

        // Check if the destination rectangle intersects with the scissor rect
        const destWidth = @as(u32, @intCast(endDestX - startDestX + 1));
        const destHeight = @as(u32, @intCast(endDestY - startDestY + 1));
        if (!self.isRectInScissor(startDestX, startDestY, destWidth, destHeight)) return;

        const graphemeAware = self.grapheme_tracker.hasAny() or frameBuffer.grapheme_tracker.hasAny();
        const linkAware = self.link_tracker.hasAny() or frameBuffer.link_tracker.hasAny();

        // Calculate clipping once for both paths
        const clippedRect = self.clipRectToScissor(startDestX, startDestY, destWidth, destHeight) orelse return;
        const clippedStartX = @max(startDestX, clippedRect.x);
        const clippedStartY = @max(startDestY, clippedRect.y);
        const clippedEndX = @min(endDestX, @as(i32, @intCast(clippedRect.x + @as(i32, @intCast(clippedRect.width)) - 1)));
        const clippedEndY = @min(endDestY, @as(i32, @intCast(clippedRect.y + @as(i32, @intCast(clippedRect.height)) - 1)));

        if (!graphemeAware and !frameBuffer.respectAlpha and !linkAware) {
            // Fast path: direct memory copy
            var dY = clippedStartY;

            while (dY <= clippedEndY) : (dY += 1) {
                const relativeDestY = dY - destY;
                const sY = srcY + @as(u32, @intCast(relativeDestY));

                if (sY >= frameBuffer.height) continue;

                const relativeDestX = clippedStartX - destX;
                const sX = srcX + @as(u32, @intCast(relativeDestX));

                if (sX >= frameBuffer.width) continue;

                const destRowStart = self.coordsToIndex(@intCast(clippedStartX), @intCast(dY));
                const srcRowStart = frameBuffer.coordsToIndex(sX, sY);
                const actualCopyWidth = @min(@as(u32, @intCast(clippedEndX - clippedStartX + 1)), frameBuffer.width - sX);

                @memcpy(self.buffer.char[destRowStart .. destRowStart + actualCopyWidth], frameBuffer.buffer.char[srcRowStart .. srcRowStart + actualCopyWidth]);
                @memcpy(self.buffer.fg[destRowStart .. destRowStart + actualCopyWidth], frameBuffer.buffer.fg[srcRowStart .. srcRowStart + actualCopyWidth]);
                @memcpy(self.buffer.bg[destRowStart .. destRowStart + actualCopyWidth], frameBuffer.buffer.bg[srcRowStart .. srcRowStart + actualCopyWidth]);
                @memcpy(self.buffer.attributes[destRowStart .. destRowStart + actualCopyWidth], frameBuffer.buffer.attributes[srcRowStart .. srcRowStart + actualCopyWidth]);
            }
            return;
        }

        var dY = clippedStartY;
        while (dY <= clippedEndY) : (dY += 1) {
            var lastDrawnGraphemeId: u32 = 0;

            var dX = clippedStartX;
            while (dX <= clippedEndX) : (dX += 1) {
                const relativeDestX = dX - destX;
                const relativeDestY = dY - destY;
                const sX = srcX + @as(u32, @intCast(relativeDestX));
                const sY = srcY + @as(u32, @intCast(relativeDestY));

                if (sX >= frameBuffer.width or sY >= frameBuffer.height) continue;

                const srcIndex = frameBuffer.coordsToIndex(sX, sY);
                if (srcIndex >= frameBuffer.buffer.char.len) continue;

                const srcChar = frameBuffer.buffer.char[srcIndex];
                const srcFg = frameBuffer.buffer.fg[srcIndex];
                const srcBg = frameBuffer.buffer.bg[srcIndex];
                const srcAttr = frameBuffer.buffer.attributes[srcIndex];

                if (srcBg[3] == 0.0 and srcFg[3] == 0.0) continue;

                if (graphemeAware) {
                    if (gp.isContinuationChar(srcChar)) {
                        const graphemeId = srcChar & gp.GRAPHEME_ID_MASK;
                        if (graphemeId != lastDrawnGraphemeId) {
                            // We haven't drawn the start character for this grapheme (likely out of bounds to the left)
                            // Draw a space with the same attributes to fill the cell
                            self.setCellWithAlphaBlending(@intCast(dX), @intCast(dY), DEFAULT_SPACE_CHAR, srcFg, srcBg, srcAttr) catch {};
                        }
                        continue;
                    }

                    if (gp.isGraphemeChar(srcChar)) {
                        lastDrawnGraphemeId = srcChar & gp.GRAPHEME_ID_MASK;
                    }

                    self.setCellWithAlphaBlending(@intCast(dX), @intCast(dY), srcChar, srcFg, srcBg, srcAttr) catch {};
                    continue;
                }

                self.setCellWithAlphaBlendingRaw(@intCast(dX), @intCast(dY), srcChar, srcFg, srcBg, srcAttr) catch {};
            }
        }
    }

    /// Draw a TextBufferView to this OptimizedBuffer with selection support and optional syntax highlighting
    pub fn drawTextBuffer(
        self: *OptimizedBuffer,
        text_buffer_view: *TextBufferView,
        x: i32,
        y: i32,
    ) !void {
        try self.drawTextBufferInternal(TextBufferView, text_buffer_view, x, y);
    }

    /// Internal implementation that accepts either TextBufferView or EditorView
    /// Both types must expose: getVirtualLines(), getViewport(), getCachedLineInfo(), getVirtualLineSpans(), getTextBuffer(), getSelection()
    fn drawTextBufferInternal(
        self: *OptimizedBuffer,
        comptime ViewType: type,
        view: *ViewType,
        x: i32,
        y: i32,
    ) !void {
        const virtual_lines = view.getVirtualLines();
        if (virtual_lines.len == 0) return;

        const firstVisibleLine: u32 = if (y < 0) @intCast(-y) else 0;
        const bufferBottomY = self.height;
        const lastPossibleLine = if (y >= @as(i32, @intCast(bufferBottomY)))
            0
        else if (y < 0)
            @min(virtual_lines.len, firstVisibleLine + bufferBottomY)
        else
            @min(virtual_lines.len, bufferBottomY - @as(u32, @intCast(y)));

        if (firstVisibleLine >= virtual_lines.len or lastPossibleLine == 0) return;
        if (firstVisibleLine >= lastPossibleLine) return;

        const viewport = view.getViewport();
        const horizontal_offset: u32 = if (viewport) |vp| vp.x else 0;
        const viewport_width: u32 = if (viewport) |vp| vp.width else std.math.maxInt(u32);

        var currentX = x;
        var currentY = y + @as(i32, @intCast(firstVisibleLine));
        const text_buffer = view.getTextBuffer();
        const total_line_count = text_buffer.getLineCount();

        const line_info = view.getCachedLineInfo();
        var globalCharPos: u32 = if (firstVisibleLine < line_info.starts.len)
            line_info.starts[firstVisibleLine]
        else
            0;

        for (virtual_lines[firstVisibleLine..lastPossibleLine], 0..) |vline, slice_idx| {
            if (currentY >= bufferBottomY) break;

            currentX = x;
            var column_in_line: u32 = 0;

            // When viewport is set, virtual_lines is a slice starting from viewport.y
            // But getVirtualLineSpans expects absolute indices, so we need to use the absolute index
            // slice_idx is relative to the slice (0, 1, 2...), we need to add viewport offset + firstVisibleLine
            const viewport_offset: u32 = if (viewport) |vp| vp.y else 0;
            const vline_idx = viewport_offset + firstVisibleLine + slice_idx;
            const vline_span_info = view.getVirtualLineSpans(vline_idx);
            const spans = vline_span_info.spans;
            const col_offset = vline_span_info.col_offset;
            var span_idx: usize = 0;
            var lineFg = text_buffer.default_fg orelse RGBA{ 1.0, 1.0, 1.0, 1.0 };
            var lineBg = text_buffer.default_bg orelse RGBA{ 0.0, 0.0, 0.0, 0.0 };
            var lineAttributes = text_buffer.default_attributes orelse 0;

            // Find the span that contains the starting render position (col_offset + horizontal_offset)
            const start_col = col_offset + horizontal_offset;
            while (span_idx < spans.len and spans[span_idx].next_col <= start_col) {
                span_idx += 1;
            }

            var next_change_col: u32 = if (span_idx < spans.len)
                spans[span_idx].next_col
            else
                std.math.maxInt(u32);

            // Apply the style at the starting position
            if (span_idx < spans.len and spans[span_idx].col <= start_col and spans[span_idx].style_id != 0) {
                if (text_buffer.getSyntaxStyle()) |style| {
                    if (style.resolveById(spans[span_idx].style_id)) |resolved_style| {
                        if (resolved_style.fg) |fg| lineFg = fg;
                        if (resolved_style.bg) |bg| lineBg = bg;
                        lineAttributes |= resolved_style.attributes;
                    }
                }
            }

            for (vline.chunks.items) |vchunk| {
                const chunk = vchunk.chunk;
                const chunk_bytes = chunk.getBytes(&text_buffer.mem_registry);
                const specials = chunk.getGraphemes(&text_buffer.mem_registry, text_buffer.allocator, text_buffer.tab_width, text_buffer.width_method) catch continue;

                if (currentX >= @as(i32, @intCast(self.width))) {
                    globalCharPos += vchunk.width;
                    currentX += @intCast(vchunk.width);
                    continue;
                }
                const col_end = vchunk.grapheme_start + vchunk.width;
                var col = vchunk.grapheme_start;
                var special_idx: usize = 0;
                var byte_offset: u32 = 0;

                if (vchunk.grapheme_start > 0) {
                    // Use UTF-8 aware position finding to skip to the grapheme_start
                    const is_ascii_only = (vchunk.chunk.flags & tb.TextChunk.Flags.ASCII_ONLY) != 0;
                    const pos_result = utf8.findPosByWidth(chunk_bytes, vchunk.grapheme_start, text_buffer.tab_width, is_ascii_only, false, text_buffer.width_method);
                    byte_offset = pos_result.byte_offset;

                    // Advance special_idx to match the skipped columns
                    var init_col: u32 = 0;
                    while (init_col < vchunk.grapheme_start and special_idx < specials.len) {
                        const g = specials[special_idx];
                        if (g.col_offset < vchunk.grapheme_start) {
                            special_idx += 1;
                            init_col = g.col_offset + g.width;
                        } else {
                            break;
                        }
                    }
                }

                while (col < col_end) {
                    const at_special = special_idx < specials.len and specials[special_idx].col_offset == col;

                    var grapheme_bytes: []const u8 = undefined;
                    var g_width: u8 = undefined;

                    if (at_special) {
                        const g = specials[special_idx];
                        grapheme_bytes = chunk_bytes[g.byte_offset .. g.byte_offset + g.byte_len];
                        g_width = g.width;
                        byte_offset = g.byte_offset + g.byte_len;
                        special_idx += 1;
                    } else {
                        if (byte_offset >= chunk_bytes.len) break;
                        // Read the next UTF-8 grapheme properly
                        const cp_len = std.unicode.utf8ByteSequenceLength(chunk_bytes[byte_offset]) catch 1;
                        const next_byte_offset = @min(byte_offset + cp_len, chunk_bytes.len);
                        grapheme_bytes = chunk_bytes[byte_offset..next_byte_offset];
                        g_width = 1; // Assuming width 1 for non-special characters (ASCII mostly)
                        byte_offset = next_byte_offset;
                    }

                    if (column_in_line < horizontal_offset) {
                        globalCharPos += g_width;
                        column_in_line += g_width;
                        col += g_width;
                        continue;
                    }

                    if (column_in_line >= horizontal_offset + viewport_width) {
                        globalCharPos += (col_end - col);
                        break;
                    }

                    if (currentX < -@as(i32, @intCast(g_width))) {
                        globalCharPos += g_width;
                        currentX += @as(i32, @intCast(g_width));
                        column_in_line += g_width;
                        col += g_width;
                        continue;
                    }

                    if (currentX >= @as(i32, @intCast(self.width))) {
                        globalCharPos += (col_end - col);
                        break;
                    }

                    if (!self.isPointInScissor(currentX, currentY)) {
                        globalCharPos += g_width;
                        currentX += @as(i32, @intCast(g_width));
                        column_in_line += g_width;
                        col += g_width;
                        continue;
                    }

                    // Track the actual column position in the source line (including horizontal offset)
                    const source_col_pos = col_offset + column_in_line;

                    if (source_col_pos >= next_change_col and span_idx + 1 < spans.len) {
                        span_idx += 1;
                        const new_span = spans[span_idx];

                        lineFg = text_buffer.default_fg orelse RGBA{ 1.0, 1.0, 1.0, 1.0 };
                        lineBg = text_buffer.default_bg orelse RGBA{ 0.0, 0.0, 0.0, 0.0 };
                        lineAttributes = text_buffer.default_attributes orelse 0;

                        if (text_buffer.getSyntaxStyle()) |style| {
                            if (new_span.style_id != 0) {
                                if (style.resolveById(new_span.style_id)) |resolved_style| {
                                    if (resolved_style.fg) |fg| lineFg = fg;
                                    if (resolved_style.bg) |bg| lineBg = bg;
                                    lineAttributes |= resolved_style.attributes;
                                }
                            }
                        }

                        next_change_col = new_span.next_col;
                    }

                    var finalFg = lineFg;
                    var finalBg = lineBg;
                    const finalAttributes = lineAttributes;

                    var cell_idx: u32 = 0;
                    while (cell_idx < g_width) : (cell_idx += 1) {
                        if (view.getSelection()) |sel| {
                            const isSelected = globalCharPos + cell_idx >= sel.start and globalCharPos + cell_idx < sel.end;
                            if (isSelected) {
                                if (sel.bgColor) |selBg| {
                                    finalBg = selBg;
                                    if (sel.fgColor) |selFg| {
                                        finalFg = selFg;
                                    }
                                } else {
                                    const temp = lineFg;
                                    finalFg = if (lineBg[3] > 0) lineBg else RGBA{ 0.0, 0.0, 0.0, 1.0 };
                                    finalBg = temp;
                                }
                                break;
                            }
                        }
                    }

                    // Skip zero-width characters (ZWJ, VS16, etc.) - don't render them
                    // Don't increment col since they take no space
                    if (g_width == 0) {
                        continue;
                    }

                    var drawFg = finalFg;
                    var drawBg = finalBg;
                    const drawAttributes = finalAttributes;

                    if (drawAttributes & (1 << 5) != 0) {
                        const temp = drawFg;
                        drawFg = drawBg;
                        drawBg = temp;
                    }

                    if (grapheme_bytes.len == 1 and grapheme_bytes[0] == '\t') {
                        const tab_indicator = view.getTabIndicator();
                        const tab_indicator_color = view.getTabIndicatorColor();

                        var tab_col: u32 = 0;
                        while (tab_col < g_width) : (tab_col += 1) {
                            if (currentX + @as(i32, @intCast(tab_col)) >= @as(i32, @intCast(self.width))) break;

                            const char = if (tab_col == 0 and tab_indicator != null) tab_indicator.? else DEFAULT_SPACE_CHAR;
                            const fg = if (tab_col == 0 and tab_indicator_color != null) tab_indicator_color.? else drawFg;

                            try self.setCellWithAlphaBlending(
                                @intCast(currentX + @as(i32, @intCast(tab_col))),
                                @intCast(currentY),
                                char,
                                fg,
                                drawBg,
                                drawAttributes,
                            );
                        }
                    } else {
                        var encoded_char: u32 = 0;
                        if (grapheme_bytes.len == 1 and g_width == 1 and grapheme_bytes[0] >= 32) {
                            encoded_char = @as(u32, grapheme_bytes[0]);
                        } else {
                            const gid = self.pool.alloc(grapheme_bytes) catch |err| {
                                logger.warn("GraphemePool.alloc FAILED for grapheme (len={d}, bytes={any}): {}", .{ grapheme_bytes.len, grapheme_bytes, err });
                                globalCharPos += g_width;
                                currentX += @as(i32, @intCast(g_width));
                                col += g_width;
                                continue;
                            };
                            encoded_char = gp.packGraphemeStart(gid & gp.GRAPHEME_ID_MASK, g_width);
                        }

                        try self.setCellWithAlphaBlending(
                            @intCast(currentX),
                            @intCast(currentY),
                            encoded_char,
                            drawFg,
                            drawBg,
                            drawAttributes,
                        );
                    }

                    globalCharPos += g_width;
                    currentX += @as(i32, @intCast(g_width));
                    column_in_line += g_width;
                    col += g_width;
                }
            }

            const is_last_vline_of_logical_line = (slice_idx + 1 >= virtual_lines[firstVisibleLine..lastPossibleLine].len) or
                (virtual_lines[firstVisibleLine..lastPossibleLine][slice_idx + 1].source_line != vline.source_line);

            if (is_last_vline_of_logical_line) {
                const is_last_logical_line = vline.source_line + 1 >= total_line_count;
                if (!is_last_logical_line) {
                    globalCharPos += 1;
                }
            }

            currentY += 1;
        }
    }

    /// Draw an EditorView to this OptimizedBuffer
    /// EditorView wraps TextBufferView, so we just delegate to drawTextBufferInternal
    /// EditorView handles viewport management and returns only the visible lines
    pub fn drawEditorView(
        self: *OptimizedBuffer,
        editor_view: *EditorView,
        x: i32,
        y: i32,
    ) !void {
        try self.drawTextBufferInternal(EditorView, editor_view, x, y);
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

        const boxWidth = @as(u32, @intCast(endX - startX + 1));
        const boxHeight = @as(u32, @intCast(endY - startY + 1));
        if (!self.isRectInScissor(startX, startY, boxWidth, boxHeight)) return;

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
                const is_ascii = utf8.isAsciiOnly(titleText);
                const titleLength = @as(i32, @intCast(utf8.calculateTextWidth(titleText, 2, is_ascii, self.width_method)));
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
                if (!self.isPointInScissor(@intCast(x_cell), @intCast(y_cell))) {
                    continue;
                }

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

            if (!self.isPointInScissor(@intCast(cellX), @intCast(cellY))) continue;

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
