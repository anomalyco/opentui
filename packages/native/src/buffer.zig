const std = @import("std");
const Allocator = std.mem.Allocator;
const ansi = @import("ansi.zig");
const tb = @import("text-buffer.zig");
const tbv = @import("text-buffer-view.zig");
const edv = @import("editor-view.zig");
const math = std.math;
const assert = std.debug.assert;
const fillU32 = @import("utils.zig").fillU32;

const gp = @import("grapheme.zig");
const link = @import("link.zig");
const native_image = @import("image.zig");

const logger = @import("logger.zig");
const utf8 = @import("utf8.zig");

pub const RGBA = ansi.RGBA;
pub const Vec3f = @Vector(3, f32);
pub const Vec4f = @Vector(4, f32);

const TextBuffer = tb.TextBuffer;
const TextBufferView = tbv.TextBufferView;
const EditorView = edv.EditorView;

pub const DEFAULT_SPACE_CHAR: u32 = 32;
/// Bounds segmentation and provisional storage for one checked text draw call.
pub const text_bytes_max: u32 = 64 * 1024;

pub fn validateColor(color: RGBA) error{InvalidOptions}!void {
    const intent = ansi.intent(color);
    if (ansi.getMeta(color) != ansi.packMeta(intent, if (intent == .indexed) ansi.slot(color) else 0)) return error.InvalidOptions;
}

pub fn validateTextInput(text: []const u8) error{ TextLimit, InvalidUnicode }!void {
    if (text.len > text_bytes_max) return error.TextLimit;
    const view = std.unicode.Utf8View.init(text) catch return error.InvalidUnicode;
    var codepoints = view.iterator();
    while (codepoints.nextCodepoint()) |codepoint| {
        if ((codepoint < 0x20 and codepoint != '\t') or (codepoint >= 0x7f and codepoint <= 0x9f)) {
            return error.InvalidUnicode;
        }
    }
}

const MAX_UNICODE_CODEPOINT: u32 = 0x10FFFF;
const BLOCK_CHAR: u32 = 0x2588; // Full block █
const QUADRANT_CHARS_COUNT = 16;

const GRAYSCALE_CHARS = " .'^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";

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
    GenerationExhausted,
};

pub const BufferArrays = struct {
    char: []u32,
    fg: []RGBA,
    bg: []RGBA,
    attributes: []u32,
};

pub const BufferSnapshot = struct {
    buffer: BufferArrays,
    width: u32,
    height: u32,
    generation: u64,
    pool: *gp.GraphemePool,

    pub fn getRealCharSize(self: *const BufferSnapshot, add_line_breaks: bool) BufferError!u32 {
        return self.resolveChars(null, add_line_breaks, null);
    }

    pub fn writeResolvedChars(
        self: *const BufferSnapshot,
        output: []u8,
        add_line_breaks: bool,
    ) BufferError!u32 {
        return self.resolveChars(output, add_line_breaks, null);
    }

    pub fn writeResolvedCells(
        self: *const BufferSnapshot,
        output: []u8,
        add_line_breaks: bool,
        cell_lengths: []u8,
    ) BufferError!u32 {
        return self.resolveChars(output, add_line_breaks, cell_lengths);
    }

    fn resolveChars(
        self: *const BufferSnapshot,
        output: ?[]u8,
        add_line_breaks: bool,
        cell_lengths: ?[]u8,
    ) BufferError!u32 {
        assert(self.width > 0 and self.height > 0);
        assert(@as(u64, self.width) * self.height == self.buffer.char.len);
        if (cell_lengths) |lengths| {
            if (lengths.len < self.buffer.char.len) return error.BufferTooSmall;
        }
        var written: u32 = 0;
        for (self.buffer.char, 0..) |char_code, index| {
            var encoded: [4]u8 = undefined;
            const bytes: []const u8 = resolved: {
                if (gp.isContinuationChar(char_code)) break :resolved "";
                if (gp.isGraphemeChar(char_code)) {
                    break :resolved self.pool.get(gp.graphemeIdFromChar(char_code)) catch " ";
                }
                const codepoint = if (gp.isImageChar(char_code))
                    quadrantChars[gp.imageFallbackFromChar(char_code)]
                else
                    char_code;
                if (codepoint == 0 or codepoint > MAX_UNICODE_CODEPOINT) break :resolved " ";
                const length = std.unicode.utf8Encode(@intCast(codepoint), &encoded) catch break :resolved " ";
                break :resolved encoded[0..length];
            };
            const length = math.cast(u32, bytes.len) orelse return error.InvalidDimensions;
            const end = math.add(u32, written, length) catch return error.InvalidDimensions;
            if (output) |destination| {
                if (end > destination.len) return error.BufferTooSmall;
                @memcpy(destination[written..end], bytes);
            }
            if (cell_lengths) |lengths| {
                // Pool entries are at most 128 bytes; continuations contribute no bytes.
                assert(length <= std.math.maxInt(u8));
                lengths[index] = @intCast(length);
            }
            written = end;
            if (add_line_breaks and (index + 1) % self.width == 0) {
                const row_end = math.add(u32, written, 1) catch return error.InvalidDimensions;
                if (output) |destination| {
                    if (row_end > destination.len) return error.BufferTooSmall;
                    destination[written] = '\n';
                }
                written = row_end;
            }
        }
        return written;
    }
};

/// One allocation generation. The buffer owns one reference until retirement;
/// each lease owns another. No owner keeps a list of retired storage.
pub const BufferStorage = struct {
    allocator: Allocator,
    buffer: BufferArrays,
    width: u32,
    height: u32,
    generation: u64,
    ref_count: u32 = 1,
    retired: bool = false,
    // Requested allocation bytes for this header, its four arrays, trackers, and placements.
    // Shared pool allocations belong to the context, not this storage.
    retained_bytes: u64,
    // One checked owner charges each distinct storage. Raw leases affect only
    // ref_count; tracker growth stays charged until the last checked release.
    lease_budget: ?struct {
        bytes: *u64,
        bytes_max: *const u64,
        checked_ref_count: u32,
    } = null,
    grapheme_tracker: gp.GraphemeTracker,
    link_tracker: link.LinkTracker,
    image_placements: std.ArrayListUnmanaged(OptimizedBuffer.ImagePlacement) = .empty,

    fn init(
        allocator: Allocator,
        width: u32,
        height: u32,
        generation: u64,
        pool: *gp.GraphemePool,
        link_pool: *link.LinkPool,
    ) BufferError!*BufferStorage {
        if (width == 0 or height == 0) return error.InvalidDimensions;
        const size = math.mul(u32, width, height) catch return error.InvalidDimensions;
        const cell_bytes = 2 * @sizeOf(u32) + 2 * @sizeOf(RGBA);
        const array_bytes = math.mul(usize, size, cell_bytes) catch return error.InvalidDimensions;
        const self = try allocator.create(BufferStorage);
        errdefer allocator.destroy(self);
        const chars = try allocator.alloc(u32, size);
        errdefer allocator.free(chars);
        const fg = try allocator.alloc(RGBA, size);
        errdefer allocator.free(fg);
        const bg = try allocator.alloc(RGBA, size);
        errdefer allocator.free(bg);
        const attributes = try allocator.alloc(u32, size);
        const tracker_allocator = self.resourceAllocator();
        self.* = .{
            .allocator = allocator,
            .buffer = .{ .char = chars, .fg = fg, .bg = bg, .attributes = attributes },
            .width = width,
            .height = height,
            .generation = generation,
            .retained_bytes = @as(u64, array_bytes) + @sizeOf(BufferStorage),
            .grapheme_tracker = gp.GraphemeTracker.init(tracker_allocator, pool),
            .link_tracker = link.LinkTracker.init(tracker_allocator, link_pool),
        };
        return self;
    }

    fn retire(self: *BufferStorage) void {
        assert(!self.retired);
        self.retired = true;
        self.release();
    }

    fn snapshot(self: *const BufferStorage) BufferSnapshot {
        return .{
            .buffer = self.buffer,
            .width = self.width,
            .height = self.height,
            .generation = self.generation,
            .pool = self.grapheme_tracker.pool,
        };
    }

    fn release(self: *BufferStorage) void {
        assert(self.ref_count > 0);
        self.ref_count -= 1;
        if (self.ref_count != 0) return;
        assert(self.retired);
        self.grapheme_tracker.deinit();
        self.link_tracker.deinit();
        for (self.image_placements.items) |placement| placement.image.deinit();
        self.image_placements.deinit(self.resourceAllocator());
        self.allocator.free(self.buffer.char);
        self.allocator.free(self.buffer.fg);
        self.allocator.free(self.buffer.bg);
        self.allocator.free(self.buffer.attributes);
        self.allocator.destroy(self);
    }

    pub fn ensureTrackerCapacity(self: *BufferStorage, graphemes: u64, links: u64) error{ OutOfMemory, TrackerLimit }!void {
        // Hash maps round to a u32 power-of-two capacity. Reject overflow before allocation.
        const entries_max = ((@as(u64, 1) << 31) - 1) * std.hash_map.default_max_load_percentage / 100;
        if (graphemes > entries_max or links > entries_max) return error.TrackerLimit;
        try self.grapheme_tracker.used_ids.ensureTotalCapacity(@intCast(graphemes));
        try self.link_tracker.used_ids.ensureTotalCapacity(@intCast(links));
    }

    fn resourceAllocator(self: *BufferStorage) Allocator {
        return .{ .ptr = self, .vtable = &.{
            .alloc = trackerAlloc,
            .resize = Allocator.noResize,
            .remap = Allocator.noRemap,
            .free = trackerFree,
        } };
    }

    fn trackerAlloc(ptr: *anyopaque, len: usize, alignment: std.mem.Alignment, ret_addr: usize) ?[*]u8 {
        const self: *BufferStorage = @ptrCast(@alignCast(ptr));
        if (self.lease_budget) |budget| {
            assert(budget.bytes.* <= budget.bytes_max.*);
            if (len > budget.bytes_max.* - budget.bytes.*) return null;
        }
        const result = self.allocator.rawAlloc(len, alignment, ret_addr) orelse return null;
        self.retained_bytes += len;
        if (self.lease_budget) |budget| budget.bytes.* += len;
        return result;
    }

    fn trackerFree(ptr: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ret_addr: usize) void {
        const self: *BufferStorage = @ptrCast(@alignCast(ptr));
        self.allocator.rawFree(memory, alignment, ret_addr);
        self.retained_bytes -= memory.len;
        if (self.lease_budget) |budget| {
            assert(budget.bytes.* >= memory.len);
            budget.bytes.* -= memory.len;
        }
    }
};

/// Move-only owner-thread lease; copying the value does not acquire a reference.
/// The allocator and both pools must outlive release, including after retirement.
/// A snapshot aliases live mutable cells, not a frozen frame. Resize/deinit make
/// it stale, but its arrays and tracked IDs remain allocated until release.
/// Release cannot revoke saved raw aliases. Do not use them after release or
/// change tagged IDs through the arrays without maintaining the trackers.
pub const BufferLease = struct {
    storage: ?*BufferStorage,

    pub const count_max_default: u32 = 4096;
    pub const bytes_max_default: u64 = 64 * 1024 * 1024;

    /// The owner serializes acquisition, publication, and release. Publication
    /// failure must releaseChecked; reserved tracker capacity may remain reusable.
    pub fn acquireChecked(
        target: *OptimizedBuffer,
        count: *u32,
        count_max: u32,
        bytes: *u64,
        bytes_max: *const u64,
    ) error{ LeaseLimit, LeaseBytesLimit, OutOfMemory, StaleLease }!BufferLease {
        if (count.* >= count_max) return error.LeaseLimit;
        const storage = target.storage;
        const already_leased = storage.lease_budget != null;
        assert(bytes.* <= bytes_max.*);
        if (!already_leased and storage.retained_bytes > bytes_max.* - bytes.*) {
            return error.LeaseBytesLimit;
        }
        var lease = target.acquireLease() catch return error.LeaseLimit;
        errdefer lease.release();
        if (!already_leased) {
            // Reserve every cell and one in-flight replacement.
            const entries = @as(u64, storage.buffer.char.len) + 1;
            storage.ensureTrackerCapacity(entries, entries) catch |err| return switch (err) {
                error.TrackerLimit => error.LeaseLimit,
                error.OutOfMemory => error.OutOfMemory,
            };
            if (storage.retained_bytes > bytes_max.* - bytes.*) return error.LeaseBytesLimit;
        }
        if (storage.retired) return error.StaleLease;
        if (storage.lease_budget) |*budget| {
            assert(budget.bytes == bytes);
            assert(budget.bytes_max == bytes_max);
            assert(budget.checked_ref_count > 0);
            assert(budget.checked_ref_count <= count.*);
            budget.checked_ref_count += 1;
        } else {
            storage.lease_budget = .{
                .bytes = bytes,
                .bytes_max = bytes_max,
                .checked_ref_count = 1,
            };
            bytes.* += storage.retained_bytes;
        }
        count.* += 1;
        return lease;
    }

    /// Consume the registry identity before calling this: reclaiming storage can
    /// reenter the owner through its allocator. Only the last release uncharges it.
    pub fn releaseChecked(self: *BufferLease, count: *u32, bytes: *u64, bytes_max: *const u64) void {
        const storage = self.storage orelse return;
        self.storage = null;
        const budget = &storage.lease_budget.?;
        assert(budget.bytes == bytes);
        assert(budget.bytes_max == bytes_max);
        assert(budget.checked_ref_count > 0);
        assert(budget.checked_ref_count <= count.*);
        budget.checked_ref_count -= 1;
        if (budget.checked_ref_count == 0) {
            assert(bytes.* >= storage.retained_bytes);
            bytes.* -= storage.retained_bytes;
            storage.lease_budget = null;
        }
        count.* -= 1;
        storage.release();
    }

    pub fn isCurrent(self: *const BufferLease) bool {
        const storage = self.storage orelse return false;
        return !storage.retired;
    }

    pub fn snapshot(self: *const BufferLease) error{ LeaseReleased, StaleLease }!BufferSnapshot {
        const storage = self.storage orelse return error.LeaseReleased;
        if (storage.retired) return error.StaleLease;
        return storage.snapshot();
    }

    pub fn release(self: *BufferLease) void {
        const storage = self.storage orelse return;
        self.storage = null;
        storage.release();
    }
};

pub inline fn rgbaEqual(a: RGBA, b: RGBA) bool {
    return a[0] == b[0] and a[1] == b[1] and a[2] == b[2] and a[3] == b[3];
}

pub const Cell = struct {
    char: u32,
    fg: RGBA,
    bg: RGBA,
    attributes: u32,
};

inline fn makeCell(char: u32, fg: RGBA, bg: RGBA, attributes: u32) Cell {
    return .{
        .char = char,
        .fg = fg,
        .bg = bg,
        .attributes = attributes,
    };
}

fn isRGBAWithAlpha(color: RGBA) bool {
    return ansi.alpha(color) < 255;
}

inline fn isFullyOpaque(opacity: f32, fg: RGBA, bg: RGBA) bool {
    return opacity == 1.0 and !isRGBAWithAlpha(fg) and !isRGBAWithAlpha(bg);
}

inline fn isFullyTransparent(opacity: f32, fg: RGBA, bg: RGBA) bool {
    return opacity == 0.0 or (ansi.alpha(fg) == 0 and ansi.alpha(bg) == 0);
}

inline fn mulDiv255(a: u32, b: u32) u32 {
    return (a * b + 127) / 255;
}

inline fn roundDiv(n: u32, d: u32) u8 {
    return @intCast((n + d / 2) / d);
}

fn blendColors(src: RGBA, dst0: RGBA, backdrop: ?RGBA) RGBA {
    const sa = @as(u32, ansi.alpha(src));

    if (sa == 0) return dst0;

    const dst = if (ansi.alpha(dst0) == 0) (backdrop orelse dst0) else dst0;
    if (sa == 255) return ansi.rgbColor(ansi.red(src), ansi.green(src), ansi.blue(src), 255);

    const da = @as(u32, ansi.alpha(dst));
    const inv = 255 - sa;
    const out_a = sa + mulDiv255(da, inv);

    if (out_a == 0) return ansi.rgbColor(0, 0, 0, 0);

    if (da == 255) {
        return ansi.rgbColor(
            @intCast((@as(u32, ansi.red(src)) * sa + @as(u32, ansi.red(dst)) * inv + 127) / 255),
            @intCast((@as(u32, ansi.green(src)) * sa + @as(u32, ansi.green(dst)) * inv + 127) / 255),
            @intCast((@as(u32, ansi.blue(src)) * sa + @as(u32, ansi.blue(dst)) * inv + 127) / 255),
            255,
        );
    }

    return ansi.rgbColor(
        roundDiv(@as(u32, ansi.red(src)) * sa + mulDiv255(@as(u32, ansi.red(dst)) * da, inv), out_a),
        roundDiv(@as(u32, ansi.green(src)) * sa + mulDiv255(@as(u32, ansi.green(dst)) * da, inv), out_a),
        roundDiv(@as(u32, ansi.blue(src)) * sa + mulDiv255(@as(u32, ansi.blue(dst)) * da, inv), out_a),
        @intCast(out_a),
    );
}

inline fn opacityToU8(opacity: f32) u8 {
    return ansi.rgbaComponentToU8(opacity);
}

fn applyOpacity(color: RGBA, opacity: u8) RGBA {
    return ansi.packRGBA8(
        ansi.red(color),
        ansi.green(color),
        ansi.blue(color),
        @intCast(mulDiv255(@as(u32, ansi.alpha(color)), opacity)),
        ansi.getMeta(color),
    );
}

/// Optimized buffer for terminal rendering
pub const OptimizedBuffer = struct {
    pub const ImagePlacement = struct {
        placement_id: u32,
        image_handle: u32,
        image: *native_image.Image,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        pixel_width: u32,
        pixel_height: u32,
        source_x: u32,
        source_y: u32,
        source_width: u32,
        source_height: u32,
        opacity: u8,
        protocol: native_image.RenderProtocol,
    };

    buffer: BufferArrays,
    storage: *BufferStorage,
    owner_context_id: u64 = 0,
    cells_max: u32 = math.maxInt(u32),
    ref_count: u32 = 1,
    width: u32,
    height: u32,
    respectAlpha: bool,
    blendBackdropColor: ?RGBA,
    allocator: Allocator,
    pool: *gp.GraphemePool,
    link_pool: *link.LinkPool,
    logger: *const logger.Logger,

    grapheme_tracker: *gp.GraphemeTracker,
    link_tracker: *link.LinkTracker,
    width_method: utf8.WidthMethod,
    id: []const u8,
    scissor_stack: std.ArrayListUnmanaged(ClipRect),
    opacity_stack: std.ArrayListUnmanaged(f32),
    image_placements: *std.ArrayListUnmanaged(ImagePlacement),

    const InitOptions = struct {
        respectAlpha: bool = false,
        blendBackdropColor: ?RGBA = null,
        pool: *gp.GraphemePool,
        width_method: utf8.WidthMethod = .unicode,
        id: []const u8 = "unnamed buffer",
        link_pool: ?*link.LinkPool = null,
        logger: *const logger.Logger = logger.compatibilityLogger(),
    };

    const BoxTitleLayout = struct {
        shouldDraw: bool = false,
        x: i32 = 0,
        startX: i32 = 0,
        endX: i32 = 0,
    };

    pub fn init(allocator: Allocator, width: u32, height: u32, options: InitOptions) BufferError!*OptimizedBuffer {
        if (width == 0 or height == 0) {
            options.logger.warn("OptimizedBuffer.init: Invalid dimensions {}x{}", .{ width, height });
            return BufferError.InvalidDimensions;
        }

        const lp = options.link_pool orelse link.initGlobalLinkPool(allocator);
        const storage = try BufferStorage.init(allocator, width, height, 1, options.pool, lp);
        errdefer storage.retire();

        const self = allocator.create(OptimizedBuffer) catch return BufferError.OutOfMemory;
        errdefer allocator.destroy(self);

        const owned_id = allocator.dupe(u8, options.id) catch return BufferError.OutOfMemory;

        self.* = .{
            .buffer = storage.buffer,
            .storage = storage,
            .width = width,
            .height = height,
            .respectAlpha = options.respectAlpha,
            .blendBackdropColor = options.blendBackdropColor,
            .allocator = allocator,
            .pool = options.pool,
            .link_pool = lp,
            .logger = options.logger,
            .grapheme_tracker = &storage.grapheme_tracker,
            .link_tracker = &storage.link_tracker,
            .width_method = options.width_method,
            .id = owned_id,
            .scissor_stack = .empty,
            .opacity_stack = .empty,
            .image_placements = &storage.image_placements,
        };

        @memset(self.buffer.char, 0);
        @memset(self.buffer.fg, ansi.rgbColor(0, 0, 0, 0));
        @memset(self.buffer.bg, ansi.rgbColor(0, 0, 0, 0));
        @memset(self.buffer.attributes, 0);

        return self;
    }

    /// Acquisition cannot allocate. The owning context must also bound its total
    /// leases and distinct pinned storage bytes, including retired generations.
    pub fn acquireLease(self: *OptimizedBuffer) error{LeaseLimitExceeded}!BufferLease {
        assert(!self.storage.retired);
        if (self.storage.ref_count == math.maxInt(u32)) return error.LeaseLimitExceeded;
        self.storage.ref_count += 1;
        return .{ .storage = self.storage };
    }

    // Raw getters do not pin storage. Use acquireLease across resize/deinit.
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
        assert(self.ref_count > 0);
        self.ref_count -= 1;
        if (self.ref_count != 0) return;
        const allocator = self.allocator;
        defer allocator.destroy(self);

        self.opacity_stack.deinit(self.allocator);
        self.scissor_stack.deinit(self.allocator);
        self.storage.retire();
        self.allocator.free(self.id);
        self.* = undefined;
    }

    pub fn retain(self: *OptimizedBuffer) error{ObjectLimit}!void {
        if (self.ref_count == math.maxInt(u32)) return error.ObjectLimit;
        self.ref_count += 1;
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

        return .{
            .x = intersect_x,
            .y = intersect_y,
            .width = @intCast(intersect_end_x - intersect_x),
            .height = @intCast(intersect_end_y - intersect_y),
        };
    }

    pub fn pushScissorRect(self: *OptimizedBuffer, x: i32, y: i32, width: u32, height: u32) !void {
        var rect: ClipRect = .{
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

    /// Owns an unpublished replacement. Commit or deinit before resizing or
    /// destroying the target buffer. Preparing leaves existing leases current.
    pub const PreparedResize = struct {
        target: *OptimizedBuffer,
        storage: ?*BufferStorage = null,

        pub fn deinit(self: *PreparedResize) void {
            const storage = self.storage orelse return;
            self.storage = null;
            storage.retire();
        }

        pub fn commit(self: *PreparedResize) void {
            const storage = self.storage orelse return;
            const target = self.target;
            const previous = target.storage;
            assert(storage.generation - 1 == previous.generation);
            self.storage = null;
            target.storage = storage;
            target.buffer = storage.buffer;
            target.grapheme_tracker = &storage.grapheme_tracker;
            target.link_tracker = &storage.link_tracker;
            target.image_placements = &storage.image_placements;
            target.width = storage.width;
            target.height = storage.height;
            target.clear(ansi.rgbColor(0, 0, 0, 255), null);
            previous.retire();
        }
    };

    pub fn prepareResize(self: *OptimizedBuffer, width: u32, height: u32) BufferError!PreparedResize {
        if (self.width == width and self.height == height) return .{ .target = self };
        if (width == 0 or height == 0) return BufferError.InvalidDimensions;
        const cells = math.mul(u32, width, height) catch return error.InvalidDimensions;
        if (cells > self.cells_max) return error.InvalidDimensions;
        const generation = math.add(u64, self.storage.generation, 1) catch return error.GenerationExhausted;
        return .{
            .target = self,
            .storage = try BufferStorage.init(self.allocator, width, height, generation, self.pool, self.link_pool),
        };
    }

    pub fn resize(self: *OptimizedBuffer, width: u32, height: u32) BufferError!void {
        var prepared = try self.prepareResize(width, height);
        prepared.commit();
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

    pub fn clear(self: *OptimizedBuffer, bg: RGBA, char: ?u32) void {
        const cellChar = char orelse DEFAULT_SPACE_CHAR;
        self.link_tracker.clear();
        self.grapheme_tracker.clear();
        self.clearImagePlacements();
        fillU32(self.buffer.char, cellChar);
        fillU32(self.buffer.attributes, 0);
        @memset(self.buffer.fg, ansi.rgbColor(255, 255, 255, 255));
        @memset(self.buffer.bg, bg);
    }

    fn clearImagePlacements(self: *OptimizedBuffer) void {
        for (self.image_placements.items) |placement| placement.image.deinit();
        self.image_placements.clearRetainingCapacity();
    }

    pub fn syncImagePlacements(self: *OptimizedBuffer, source: *const OptimizedBuffer) error{ OutOfMemory, TrackerLimit }!void {
        assert(self != source);
        for (source.image_placements.items) |placement| {
            if (placement.image.ref_count > math.maxInt(u32) - source.image_placements.items.len) return error.TrackerLimit;
        }
        try self.image_placements.ensureTotalCapacity(self.storage.resourceAllocator(), source.image_placements.items.len);
        self.clearImagePlacements();
        for (source.image_placements.items) |placement| {
            placement.image.retain();
            self.image_placements.appendAssumeCapacity(placement);
        }
    }

    /// Replace all cells and references, without compositing or applying draw state.
    /// Rejection preserves both buffers; reserved tracking capacity may remain.
    pub fn copyFrom(self: *OptimizedBuffer, source: *const OptimizedBuffer) !void {
        assert(self.pool == source.pool and self.link_pool == source.link_pool);
        if (self.storage == source.storage or self.width != source.width or self.height != source.height) {
            return error.InvalidOptions;
        }
        try source.checkImageResources();
        try self.checkImageResources();
        inline for (.{ source.grapheme_tracker, source.link_tracker }) |tracker| {
            var ids = tracker.used_ids.keyIterator();
            while (ids.next()) |id| {
                const refs = try tracker.pool.getRefcount(id.*);
                assert(refs > 0);
                if (refs == math.maxInt(u32)) return error.TrackerLimit;
            }
        }
        try self.storage.ensureTrackerCapacity(
            source.grapheme_tracker.used_ids.count(),
            source.link_tracker.used_ids.count(),
        );
        try self.syncImagePlacements(source);

        // Source membership pins each ID, so rebuilding the preallocated trackers
        // cannot free a shared ID or allocate in the pools' first-use interners.
        self.grapheme_tracker.clear();
        var graphemes = source.grapheme_tracker.used_ids.iterator();
        while (graphemes.next()) |entry| {
            const id = entry.key_ptr.*;
            self.grapheme_tracker.add(id);
            self.grapheme_tracker.used_ids.getPtr(id).?.* = entry.value_ptr.*;
        }
        self.link_tracker.clear();
        var links = source.link_tracker.used_ids.iterator();
        while (links.next()) |entry| {
            const id = entry.key_ptr.*;
            self.link_tracker.addCellRef(id);
            self.link_tracker.used_ids.getPtr(id).?.* = entry.value_ptr.*;
        }
        @memcpy(self.buffer.char, source.buffer.char);
        @memcpy(self.buffer.fg, source.buffer.fg);
        @memcpy(self.buffer.bg, source.buffer.bg);
        @memcpy(self.buffer.attributes, source.buffer.attributes);
    }

    /// Write a single cell and update link tracker. No grapheme tracking,
    /// span cleanup, or continuation propagation.
    pub fn setRaw(self: *OptimizedBuffer, x: u32, y: u32, cell: Cell) void {
        const index = self.validateAndIndex(x, y) orelse return;
        self.writeCellAndLinks(index, cell);
    }

    /// Like set(), but without span cleanup. Writes the cell, its continuation
    /// cells (for width-2+ graphemes), and updates grapheme/link trackers.
    ///
    /// Intended for the renderer's diff loop where cells are synced from an
    /// authoritative source buffer. Span cleanup is skipped because it can
    /// destroy continuation cells that were correctly written by an earlier
    /// iteration of the same left-to-right pass (issue #723).
    pub fn syncCell(self: *OptimizedBuffer, x: u32, y: u32, cell: Cell) void {
        self.setInternal(false, x, y, cell);
    }

    pub fn set(self: *OptimizedBuffer, x: u32, y: u32, cell: Cell) void {
        self.setInternal(true, x, y, cell);
    }

    fn setInternal(self: *OptimizedBuffer, comptime span_cleanup: bool, x: u32, y: u32, cell: Cell) void {
        const index = self.validateAndIndex(x, y) orelse return;
        const prev_char = self.buffer.char[index];
        const new_link_id = ansi.TextAttributes.getLinkId(cell.attributes);
        // Cleanup can remove the last old cell using the replacement's link.
        if (new_link_id != 0) self.link_tracker.addCellRef(new_link_id);
        defer if (new_link_id != 0) self.link_tracker.removeCellRef(new_link_id);
        var tracker_replaced = false;

        if (!span_cleanup) {
            const old_start_id: ?u32 = if (gp.isGraphemeChar(prev_char)) gp.graphemeIdFromChar(prev_char) else null;
            const new_start_id: ?u32 = blk: {
                if (!gp.isGraphemeChar(cell.char)) break :blk null;
                const new_width = gp.charRightExtent(cell.char) + 1;
                if (x + new_width > self.width) break :blk null;
                break :blk gp.graphemeIdFromChar(cell.char);
            };

            if (old_start_id != null or new_start_id != null) {
                self.grapheme_tracker.replace(old_start_id, new_start_id);
                tracker_replaced = true;
            }
        }

        // If overwriting a grapheme span (start or continuation) with a different char, clear that span first
        if (span_cleanup) {
            if ((gp.isGraphemeChar(prev_char) or gp.isContinuationChar(prev_char)) and prev_char != cell.char) {
                const row_start: u32 = y * self.width;
                const row_end: u32 = row_start + self.width - 1;
                const left = gp.charLeftExtent(prev_char);
                const right = gp.charRightExtent(prev_char);
                const id = gp.graphemeIdFromChar(prev_char);

                const new_grapheme_id: ?u32 = blk: {
                    if (!gp.isGraphemeChar(cell.char)) break :blk null;
                    const new_width = gp.charRightExtent(cell.char) + 1;
                    if (x + new_width > self.width) break :blk null;
                    break :blk gp.graphemeIdFromChar(cell.char);
                };
                if (new_grapheme_id) |new_id| self.grapheme_tracker.add(new_id);
                tracker_replaced = true;

                const span_start = index - @min(left, index - row_start);
                const span_end = index + @min(right, row_end - index);

                var span_i: u32 = span_start;
                while (span_i <= span_end) : (span_i += 1) {
                    const span_char = self.buffer.char[span_i];
                    if (!(gp.isGraphemeChar(span_char) or gp.isContinuationChar(span_char))) continue;
                    if (gp.graphemeIdFromChar(span_char) != id) continue;

                    // Overlaps can leave continuations after their start was replaced.
                    if (gp.isGraphemeChar(span_char)) {
                        self.grapheme_tracker.remove(id);
                    }

                    const span_link_id = ansi.TextAttributes.getLinkId(self.buffer.attributes[span_i]);
                    if (span_link_id != 0) {
                        self.link_tracker.removeCellRef(span_link_id);
                    }

                    self.buffer.char[span_i] = @intCast(DEFAULT_SPACE_CHAR);
                    self.buffer.attributes[span_i] = 0;
                }
            }
        }

        if (gp.isGraphemeChar(cell.char)) {
            const right = gp.charRightExtent(cell.char);
            const width: u32 = 1 + right;

            if (x + width > self.width) {
                const end_of_line = (y + 1) * self.width;
                var eol_i = index;
                while (eol_i < end_of_line) : (eol_i += 1) {
                    const eol_char = self.buffer.char[eol_i];
                    // The start at index was already accounted for above.
                    if (eol_i != index and gp.isGraphemeChar(eol_char)) {
                        self.grapheme_tracker.remove(gp.graphemeIdFromChar(eol_char));
                    }
                    const eol_link_id = ansi.TextAttributes.getLinkId(self.buffer.attributes[eol_i]);
                    if (eol_link_id != 0) {
                        self.link_tracker.removeCellRef(eol_link_id);
                    }
                }
                @memset(self.buffer.char[index..end_of_line], @intCast(DEFAULT_SPACE_CHAR));
                @memset(self.buffer.attributes[index..end_of_line], cell.attributes);
                @memset(self.buffer.fg[index..end_of_line], cell.fg);
                @memset(self.buffer.bg[index..end_of_line], cell.bg);
                if (new_link_id != 0) {
                    const cells_written = end_of_line - index;
                    var link_i: u32 = 0;
                    while (link_i < cells_written) : (link_i += 1) {
                        self.link_tracker.addCellRef(new_link_id);
                    }
                }
                return;
            }

            self.writeCellAndLinks(index, cell);

            const id: u32 = gp.graphemeIdFromChar(cell.char);
            const is_same_grapheme_start = gp.isGraphemeChar(prev_char) and prev_char == cell.char;
            if (!tracker_replaced and !is_same_grapheme_start) {
                self.grapheme_tracker.add(id);
            }

            if (width > 1) {
                const row_end_index: u32 = (y * self.width) + self.width - 1;
                const max_right = @min(right, row_end_index - index);
                if (max_right > 0) {
                    var cont_i: u32 = 1;
                    while (cont_i <= max_right) : (cont_i += 1) {
                        const cont_index = index + cont_i;
                        const cont_char = self.buffer.char[cont_index];
                        if (gp.isGraphemeChar(cont_char)) {
                            const old_id = gp.graphemeIdFromChar(cont_char);
                            self.grapheme_tracker.remove(old_id);
                            if (span_cleanup) {
                                // Ordinary writes must not leave a tail outside the new span.
                                const tail_end = cont_index + @min(
                                    gp.charRightExtent(cont_char),
                                    row_end_index - cont_index,
                                );
                                var tail_i = index + width;
                                while (tail_i <= tail_end) : (tail_i += 1) {
                                    const tail_char = self.buffer.char[tail_i];
                                    if (!gp.isContinuationChar(tail_char)) continue;
                                    if (gp.graphemeIdFromChar(tail_char) != old_id) continue;
                                    const tail_link_id = ansi.TextAttributes.getLinkId(self.buffer.attributes[tail_i]);
                                    if (tail_link_id != 0) self.link_tracker.removeCellRef(tail_link_id);
                                    self.buffer.char[tail_i] = DEFAULT_SPACE_CHAR;
                                    self.buffer.attributes[tail_i] = 0;
                                }
                            }
                        }
                        const cont_link_id = ansi.TextAttributes.getLinkId(self.buffer.attributes[cont_index]);
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
            self.writeCellAndLinks(index, cell);
        }
    }

    /// Validate coordinates and return buffer index, or null if out of bounds / scissor.
    fn validateAndIndex(self: *OptimizedBuffer, x: u32, y: u32) ?u32 {
        if (x >= self.width or y >= self.height) return null;
        if (!self.isPointInScissor(@intCast(x), @intCast(y))) return null;
        return self.coordsToIndex(x, y);
    }

    /// Write cell data at index and update link tracker.
    fn writeCellAndLinks(self: *OptimizedBuffer, index: u32, cell: Cell) void {
        const prev_link_id = ansi.TextAttributes.getLinkId(self.buffer.attributes[index]);
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

    pub fn get(self: *const OptimizedBuffer, x: u32, y: u32) ?Cell {
        if (x >= self.width or y >= self.height) return null;

        const index = self.coordsToIndex(x, y);
        return .{
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

    pub fn setBlendBackdropColor(self: *OptimizedBuffer, color: ?RGBA) void {
        self.blendBackdropColor = color;
    }

    pub fn getBlendBackdropColor(self: *const OptimizedBuffer) ?RGBA {
        return self.blendBackdropColor;
    }

    pub fn getId(self: *const OptimizedBuffer) []const u8 {
        return self.id;
    }

    /// Calculate the real byte size of the character buffer including grapheme pool data
    pub fn getRealCharSize(self: *const OptimizedBuffer) u32 {
        const total_chars = self.width * self.height;
        const grapheme_count = self.grapheme_tracker.getGraphemeCellCount();
        const total_grapheme_bytes = self.grapheme_tracker.getTotalGraphemeBytes();

        const regular_char_bytes = (total_chars - grapheme_count) * @sizeOf(u32);
        return regular_char_bytes + total_grapheme_bytes;
    }

    pub fn writeResolvedChars(self: *const OptimizedBuffer, output_buffer: []u8, addLineBreaks: bool) BufferError!u32 {
        return self.storage.snapshot().writeResolvedChars(output_buffer, addLineBreaks);
    }

    pub fn blendCells(self: *const OptimizedBuffer, overlayCell: Cell, destCell: Cell) Cell {
        const hasBgAlpha = isRGBAWithAlpha(overlayCell.bg);
        const hasFgAlpha = isRGBAWithAlpha(overlayCell.fg);

        if (hasBgAlpha or hasFgAlpha) {
            const blendedBg = if (hasBgAlpha)
                blendColors(overlayCell.bg, destCell.bg, self.blendBackdropColor)
            else
                overlayCell.bg;
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
                finalFg = blendColors(overlayCell.bg, destCell.fg, self.blendBackdropColor);
            } else {
                finalFg = if (hasFgAlpha)
                    blendColors(overlayCell.fg, blendedBg, self.blendBackdropColor)
                else
                    overlayCell.fg;
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

            return .{
                .char = finalChar,
                .fg = finalFg,
                .bg = blendedBg,
                .attributes = finalAttributes,
            };
        }

        return overlayCell;
    }

    inline fn opaqueCell(cell: Cell) Cell {
        return makeCell(
            cell.char,
            ansi.packRGBA8(ansi.red(cell.fg), ansi.green(cell.fg), ansi.blue(cell.fg), 255, ansi.getMeta(cell.fg)),
            ansi.packRGBA8(ansi.red(cell.bg), ansi.green(cell.bg), ansi.blue(cell.bg), 255, ansi.getMeta(cell.bg)),
            cell.attributes,
        );
    }

    inline fn cellSpanOverlapsImage(self: *const OptimizedBuffer, x: u32, y: u32, char: u32) bool {
        if (self.image_placements.items.len == 0 or y >= self.height) return false;

        const width = if (gp.isGraphemeChar(char)) gp.charRightExtent(char) + 1 else 1;
        var offset: u32 = 0;
        while (offset < width and x + offset < self.width) : (offset += 1) {
            if (gp.isImageChar(self.buffer.char[self.coordsToIndex(x + offset, y)])) return true;
        }
        return false;
    }

    inline fn cellSpanTailOverlapsImage(self: *const OptimizedBuffer, x: u32, y: u32, char: u32) bool {
        if (!gp.isGraphemeChar(char) or y >= self.height) return false;
        const width = gp.charRightExtent(char) + 1;
        var offset: u32 = 1;
        while (offset < width and x + offset < self.width) : (offset += 1) {
            if (gp.isImageChar(self.buffer.char[self.coordsToIndex(x + offset, y)])) return true;
        }
        return false;
    }

    inline fn rectOverlapsImagePlacement(self: *const OptimizedBuffer, x: i32, y: i32, width: u32, height: u32) bool {
        for (self.image_placements.items) |placement| {
            if (@as(i64, x) < @as(i64, placement.x) + placement.width and @as(i64, placement.x) < @as(i64, x) + width and
                @as(i64, y) < @as(i64, placement.y) + placement.height and @as(i64, placement.y) < @as(i64, y) + height)
            {
                return true;
            }
        }
        return false;
    }

    pub fn setCellWithAlphaBlending(
        self: *OptimizedBuffer,
        x: u32,
        y: u32,
        char: u32,
        fg: RGBA,
        bg: RGBA,
        attributes: u32,
    ) void {
        self.setCellWithAlphaBlendingCell(x, y, makeCell(char, fg, bg, attributes));
    }

    inline fn blendCellWithOpacity(self: *OptimizedBuffer, x: u32, y: u32, cell: Cell, opacity: f32, dest_cell: ?Cell) void {
        const opacity_u8 = opacityToU8(opacity);
        const effective_cell = makeCell(
            cell.char,
            applyOpacity(cell.fg, opacity_u8),
            applyOpacity(cell.bg, opacity_u8),
            cell.attributes,
        );

        if (dest_cell) |dest| {
            const blended_cell = self.blendCells(effective_cell, dest);
            if (!self.grapheme_tracker.hasAny() and !self.link_tracker.hasAny() and !gp.isClusterChar(blended_cell.char)) {
                self.setRaw(x, y, blended_cell);
            } else {
                self.set(x, y, blended_cell);
            }
        } else {
            self.set(x, y, effective_cell);
        }
    }

    inline fn setCellWithAlphaBlendingCellWithoutImages(self: *OptimizedBuffer, x: u32, y: u32, cell: Cell) void {
        if (!self.isPointInScissor(@intCast(x), @intCast(y))) return;
        const opacity = self.getCurrentOpacity();
        if (isFullyTransparent(opacity, cell.fg, cell.bg)) return;
        if (isFullyOpaque(opacity, cell.fg, cell.bg)) {
            self.set(x, y, cell);
            return;
        }
        self.blendCellWithOpacity(x, y, cell, opacity, self.get(x, y));
    }

    inline fn skipTransparentCellDraw(self: *const OptimizedBuffer, opacity: f32, fully_transparent: bool) bool {
        if (fully_transparent) {
            if (self.image_placements.items.len == 0) return true;
            if (opacity == 0.0) return true;
        }
        return false;
    }

    inline fn setVisibleCellWithAlphaBlending(self: *OptimizedBuffer, x: u32, y: u32, cell: Cell, opacity: f32, fully_transparent: bool) void {
        if (!self.isPointInScissor(@intCast(x), @intCast(y))) return;
        if (isFullyOpaque(opacity, cell.fg, cell.bg)) {
            self.set(x, y, cell);
            return;
        }

        const destCell = self.get(x, y);
        const first_cell_overlaps_image = if (destCell) |dest| gp.isImageChar(dest.char) else false;
        if (first_cell_overlaps_image or self.cellSpanTailOverlapsImage(x, y, cell.char)) {
            self.set(x, y, opaqueCell(cell));
            return;
        }
        if (fully_transparent) return;
        self.blendCellWithOpacity(x, y, cell, opacity, destCell);
    }

    fn setCellWithAlphaBlendingCell(self: *OptimizedBuffer, x: u32, y: u32, cell: Cell) void {
        const opacity = self.getCurrentOpacity();
        const fully_transparent = isFullyTransparent(opacity, cell.fg, cell.bg);
        if (self.skipTransparentCellDraw(opacity, fully_transparent)) return;
        self.setVisibleCellWithAlphaBlending(x, y, cell, opacity, fully_transparent);
    }

    pub fn setCellWithAlphaBlendingRaw(
        self: *OptimizedBuffer,
        x: u32,
        y: u32,
        char: u32,
        fg: RGBA,
        bg: RGBA,
        attributes: u32,
    ) void {
        self.setCellWithAlphaBlendingRawCell(x, y, makeCell(char, fg, bg, attributes));
    }

    fn setCellWithAlphaBlendingRawCell(self: *OptimizedBuffer, x: u32, y: u32, cell: Cell) void {
        if (!self.isPointInScissor(@intCast(x), @intCast(y))) return;

        const opacity = self.getCurrentOpacity();
        if (opacity == 0.0) return;
        if (isFullyOpaque(opacity, cell.fg, cell.bg)) {
            assert(!gp.isGraphemeChar(cell.char));
            assert(!gp.isContinuationChar(cell.char));
            self.setRaw(x, y, cell);
            return;
        }

        if (isFullyTransparent(opacity, cell.fg, cell.bg)) return;

        const opacity_u8 = opacityToU8(opacity);
        const effectiveCell = makeCell(
            cell.char,
            applyOpacity(cell.fg, opacity_u8),
            applyOpacity(cell.bg, opacity_u8),
            cell.attributes,
        );

        if (self.get(x, y)) |dest| {
            const blendedCell = self.blendCells(effectiveCell, dest);
            assert(!gp.isGraphemeChar(blendedCell.char));
            assert(!gp.isContinuationChar(blendedCell.char));
            self.setRaw(x, y, blendedCell);
        } else {
            assert(!gp.isGraphemeChar(effectiveCell.char));
            assert(!gp.isContinuationChar(effectiveCell.char));
            self.setRaw(x, y, effectiveCell);
        }
    }

    inline fn setCellWithAlphaBlendingRawImageAware(self: *OptimizedBuffer, x: u32, y: u32, cell: Cell) void {
        if (self.get(x, y)) |dest| {
            if (gp.isImageChar(dest.char) and self.getCurrentOpacity() > 0.0) {
                self.setRaw(x, y, opaqueCell(cell));
                return;
            }
        }
        self.setCellWithAlphaBlendingRawCell(x, y, cell);
    }

    inline fn trySetTransparentTextCellFast(
        self: *OptimizedBuffer,
        index: u32,
        char: u32,
        fg: RGBA,
        attributes: u32,
    ) bool {
        // drawTextBuffer spends a lot of time in generic alpha blending when the
        // common case is really "opaque glyph over transparent bg". In that case
        // the result is just: keep the destination background, write fg/attrs,
        // and preserve an underlying visible glyph when the overlay char is a
        // transparent space. Links and graphemes stay on the slow path because
        // they need tracker maintenance that direct writes would skip.
        if (ansi.alpha(fg) != 255) return false;
        if (ansi.TextAttributes.getLinkId(attributes) != 0) return false;
        if (gp.isGraphemeChar(char) or gp.isContinuationChar(char)) return false;

        // The caller must clip the glyph before it calculates the index.
        assert(index < self.buffer.char.len);

        const dest_char = self.buffer.char[index];
        const dest_attributes = self.buffer.attributes[index];
        if (ansi.TextAttributes.getLinkId(dest_attributes) != 0) return false;
        if (gp.isGraphemeChar(dest_char) or gp.isContinuationChar(dest_char)) return false;
        if (self.image_placements.items.len != 0 and gp.isImageChar(dest_char)) return false;

        if (char == DEFAULT_SPACE_CHAR and dest_char != 0 and dest_char != DEFAULT_SPACE_CHAR and gp.encodedCharWidth(dest_char) == 1) {
            return true;
        }

        self.buffer.char[index] = char;
        self.buffer.fg[index] = fg;
        self.buffer.attributes[index] = attributes;
        return true;
    }

    pub inline fn drawChar(
        self: *OptimizedBuffer,
        char: u32,
        x: u32,
        y: u32,
        fg: RGBA,
        bg: RGBA,
        attributes: u32,
    ) void {
        const cell = makeCell(char, fg, bg, attributes);
        const opacity = self.getCurrentOpacity();
        const fully_transparent = isFullyTransparent(opacity, fg, bg);
        if (self.skipTransparentCellDraw(opacity, fully_transparent)) return;
        self.setVisibleCellWithAlphaBlending(x, y, cell, opacity, fully_transparent);
    }

    pub fn fillRect(
        self: *OptimizedBuffer,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        bg: RGBA,
    ) void {
        if (self.width == 0 or self.height == 0 or width == 0 or height == 0) return;
        if (x >= self.width or y >= self.height) return;

        if (!self.isRectInScissor(@intCast(x), @intCast(y), width, height)) return;

        const opacity = self.getCurrentOpacity();
        const fully_transparent = isFullyTransparent(opacity, ansi.rgbColor(0, 0, 0, 0), bg);
        if (fully_transparent and (opacity == 0.0 or self.image_placements.items.len == 0)) return;

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

        if (fully_transparent) {
            const cell = makeCell(DEFAULT_SPACE_CHAR, ansi.rgbColor(255, 255, 255, 255), bg, 0);
            const clipped_area = @as(u64, clippedEndX - clippedStartX + 1) * (clippedEndY - clippedStartY + 1);
            var intersection_area: u64 = 0;
            for (self.image_placements.items) |placement| {
                const intersection_start_x = @max(@as(i64, clippedStartX), placement.x);
                const intersection_start_y = @max(@as(i64, clippedStartY), placement.y);
                const intersection_end_x = @min(@as(i64, clippedEndX) + 1, @as(i64, placement.x) + placement.width);
                const intersection_end_y = @min(@as(i64, clippedEndY) + 1, @as(i64, placement.y) + placement.height);
                if (intersection_start_x >= intersection_end_x or intersection_start_y >= intersection_end_y) continue;

                const width_u64: u64 = @intCast(intersection_end_x - intersection_start_x);
                const height_u64: u64 = @intCast(intersection_end_y - intersection_start_y);
                intersection_area = @min(clipped_area, intersection_area +| width_u64 *| height_u64);
            }
            if (intersection_area == 0) return;

            if (intersection_area >= clipped_area / 2 + clipped_area % 2) {
                var fill_y = clippedStartY;
                while (fill_y <= clippedEndY) : (fill_y += 1) {
                    var fill_x = clippedStartX;
                    while (fill_x <= clippedEndX) : (fill_x += 1) {
                        if (gp.isImageChar(self.buffer.char[self.coordsToIndex(fill_x, fill_y)])) self.setRaw(fill_x, fill_y, opaqueCell(cell));
                    }
                }
                return;
            }

            for (self.image_placements.items) |placement| {
                const intersection_start_x = @max(@as(i64, clippedStartX), placement.x);
                const intersection_start_y = @max(@as(i64, clippedStartY), placement.y);
                const intersection_end_x = @min(@as(i64, clippedEndX) + 1, @as(i64, placement.x) + placement.width);
                const intersection_end_y = @min(@as(i64, clippedEndY) + 1, @as(i64, placement.y) + placement.height);
                if (intersection_start_x >= intersection_end_x or intersection_start_y >= intersection_end_y) continue;

                var fill_y: u32 = @intCast(intersection_start_y);
                while (fill_y < intersection_end_y) : (fill_y += 1) {
                    var fill_x: u32 = @intCast(intersection_start_x);
                    while (fill_x < intersection_end_x) : (fill_x += 1) {
                        if (gp.isImageChar(self.buffer.char[self.coordsToIndex(fill_x, fill_y)])) self.setRaw(fill_x, fill_y, opaqueCell(cell));
                    }
                }
            }
            return;
        }

        const hasAlpha = isRGBAWithAlpha(bg) or opacity < 1.0;
        const graphemeAware = self.grapheme_tracker.hasAny();
        const linkAware = self.link_tracker.hasAny();

        if (graphemeAware or linkAware) {
            var fillY = clippedStartY;
            while (fillY <= clippedEndY) : (fillY += 1) {
                var fillX = clippedStartX;
                while (fillX <= clippedEndX) : (fillX += 1) {
                    self.setCellWithAlphaBlendingCell(
                        fillX,
                        fillY,
                        makeCell(DEFAULT_SPACE_CHAR, ansi.rgbColor(255, 255, 255, 255), bg, 0),
                    );
                }
            }
        } else if (hasAlpha) {
            // No grapheme/link bookkeeping is needed here, so the raw blend
            // path avoids the extra tracker work done by the generic setter.
            const image_aware = self.image_placements.items.len != 0;
            var fillY = clippedStartY;
            while (fillY <= clippedEndY) : (fillY += 1) {
                var fillX = clippedStartX;
                while (fillX <= clippedEndX) : (fillX += 1) {
                    const cell = makeCell(DEFAULT_SPACE_CHAR, ansi.rgbColor(255, 255, 255, 255), bg, 0);
                    if (image_aware) self.setCellWithAlphaBlendingRawImageAware(fillX, fillY, cell) else self.setCellWithAlphaBlendingRawCell(fillX, fillY, cell);
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

                fillU32(rowSliceChar, DEFAULT_SPACE_CHAR);
                @memset(rowSliceFg, ansi.rgbColor(255, 255, 255, 255));
                @memset(rowSliceBg, bg);
                fillU32(rowSliceAttrs, 0);
            }
        }
    }

    fn fillRectClipped(
        self: *OptimizedBuffer,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        bg: RGBA,
    ) void {
        if (width == 0 or height == 0) return;

        const startX = @max(0, x);
        const startY = @max(0, y);
        const endX = @min(@as(i64, self.width), @as(i64, x) + width);
        const endY = @min(@as(i64, self.height), @as(i64, y) + height);

        if (startX >= endX or startY >= endY) return;

        self.fillRect(
            @intCast(startX),
            @intCast(startY),
            @intCast(endX - startX),
            @intCast(endY - startY),
            bg,
        );
    }

    inline fn setTextCell(self: *OptimizedBuffer, x: u32, y: u32, cell: Cell) void {
        if (self.image_placements.items.len != 0 and self.cellSpanOverlapsImage(x, y, cell.char)) {
            self.set(x, y, opaqueCell(cell));
            return;
        }
        if (isRGBAWithAlpha(cell.bg)) {
            self.setCellWithAlphaBlendingCellWithoutImages(x, y, cell);
            return;
        }
        self.set(x, y, cell);
    }

    pub inline fn drawText(
        self: *OptimizedBuffer,
        text: []const u8,
        x: u32,
        y: u32,
        fg: RGBA,
        bg: ?RGBA,
        attributes: u32,
    ) BufferError!void {
        const opacity = self.getCurrentOpacity();
        if (isFullyTransparent(opacity, fg, bg orelse ansi.rgbColor(0, 0, 0, 0)) and (opacity == 0.0 or self.image_placements.items.len == 0)) return;
        return self.drawVisibleText(text, x, y, fg, bg, attributes);
    }

    /// Draw one row of UTF-8 with base style bits and packed color intent.
    /// Tabs retain drawText's two-cell expansion.
    /// Reject controls, oversized input/visible graphemes, and unqualified image resources.
    /// Rejection preserves cells and live references; prepared capacity may remain.
    pub fn drawTextChecked(
        self: *OptimizedBuffer,
        text: []const u8,
        x: u32,
        y: u32,
        fg: RGBA,
        bg: ?RGBA,
        attributes: u32,
    ) error{ InvalidUnicode, InvalidOptions, TextLimit, UnsupportedResource, OutOfMemory, TrackerLimit }!void {
        if (text.len > text_bytes_max) return error.TextLimit;
        try self.checkImageResources();
        if (attributes & ~ansi.TextAttributes.ATTRIBUTE_BASE_MASK != 0) return error.InvalidOptions;
        try validateColor(fg);
        if (bg) |background| try validateColor(background);
        try validateTextInput(text);
        if (x >= self.width or y >= self.height or text.len == 0) return;
        if (self.width > math.maxInt(i32) or self.height > math.maxInt(i32)) return error.InvalidOptions;
        if (self.getCurrentScissorRect()) |clip| {
            if (clip.width > math.maxInt(i32) or clip.height > math.maxInt(i32) or
                @as(i64, clip.x) + clip.width > math.maxInt(i32) or
                @as(i64, clip.y) + clip.height > math.maxInt(i32)) return error.InvalidOptions;
        }
        const opacity = self.getCurrentOpacity();
        if (!math.isFinite(opacity) or opacity < 0 or opacity > 1) return error.InvalidOptions;
        if (self.skipTransparentCellDraw(opacity, isFullyTransparent(opacity, fg, bg orelse ansi.rgbColor(0, 0, 0, 0)))) return;

        var scratch = std.heap.stackFallback(4096, self.allocator);
        const scratch_allocator = scratch.get();
        // Pool growth can move input borrowed from this same pool.
        const input = try scratch_allocator.dupe(u8, text);
        defer scratch_allocator.free(input);
        var clusters: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
        defer clusters.deinit(scratch_allocator);
        const tab_width: u8 = 2;
        try utf8.findRenderClusterInfo(scratch_allocator, input, tab_width, utf8.isAsciiOnly(input), self.width_method, &clusters);

        const PreparedRun = struct { x: u32, char: u32, count: u32 };
        var runs: std.ArrayListUnmanaged(PreparedRun) = .empty;
        defer {
            for (runs.items) |run| {
                if (gp.isGraphemeChar(run.char)) self.pool.decref(gp.graphemeIdFromChar(run.char)) catch unreachable;
            }
            runs.deinit(scratch_allocator);
        }
        var byte_offset: usize = 0;
        var cluster_index: usize = 0;
        var advance_cells: u32 = 0;
        var grapheme_count: u32 = 0;
        while (byte_offset < input.len and advance_cells < self.width - x) {
            const start = byte_offset;
            const cluster: ?utf8.RenderClusterInfo = if (cluster_index < clusters.items.len and
                clusters.items[cluster_index].byte_start == start) clusters.items[cluster_index] else null;
            if (cluster) |entry| {
                byte_offset += entry.byte_len;
                cluster_index += 1;
            } else {
                // Sparse metadata omits zero-width clusters, not their UTF-8 bytes.
                byte_offset += std.unicode.utf8ByteSequenceLength(input[start]) catch unreachable;
            }
            const bytes = input[start..byte_offset];
            const cell_width = if (cluster != null and self.width_method != .wcwidth)
                cluster.?.width_cols
            else
                utf8.getWidthAt(bytes, 0, tab_width, self.width_method);
            if (cell_width == 0) continue;
            const cluster_width = if (cluster) |entry| entry.width_cols else cell_width;
            const char_x = x + advance_cells;
            const is_tab = bytes.len == 1 and bytes[0] == '\t';
            const count = if (is_tab) @min(cluster_width, self.width - char_x) else 1;
            var visible = false;
            if (is_tab) {
                for (0..count) |offset| {
                    visible = visible or self.isPointInScissor(@intCast(char_x + offset), @intCast(y));
                }
            } else if (cell_width <= self.width - char_x) {
                visible = true;
                for (0..cell_width) |offset| {
                    if (!self.isPointInScissor(@intCast(char_x + offset), @intCast(y))) {
                        visible = false;
                        break;
                    }
                }
            }
            if (!visible) {
                advance_cells += cluster_width;
                continue;
            }

            try runs.ensureUnusedCapacity(scratch_allocator, 1);
            const encoded: u32 = if (is_tab) DEFAULT_SPACE_CHAR else if (bytes.len == 1) bytes[0] else encoded: {
                const id = self.pool.alloc(bytes) catch |err| return switch (err) {
                    error.OutOfMemory => error.OutOfMemory,
                    error.GraphemeTooLong => error.TextLimit,
                    else => unreachable,
                };
                // Leave one reference for the destination tracker's first use.
                if ((self.pool.getRefcount(id) catch unreachable) >= math.maxInt(u32) - 1) return error.TrackerLimit;
                self.pool.incref(id) catch |err| {
                    self.pool.freeUnreferenced(id) catch unreachable;
                    return switch (err) {
                        error.OutOfMemory => error.OutOfMemory,
                        else => unreachable,
                    };
                };
                grapheme_count += 1;
                break :encoded gp.packGraphemeStart(id, cell_width);
            };
            runs.appendAssumeCapacity(.{ .x = char_x, .char = encoded, .count = count });
            advance_cells += if (is_tab) cluster_width else cell_width;
        }
        if (runs.items.len == 0) return;
        try self.storage.ensureTrackerCapacity(
            @min(@as(u64, self.grapheme_tracker.getGraphemeCount()) + grapheme_count, @as(u64, self.buffer.char.len) + 1),
            self.link_tracker.getLinkCount(),
        );

        for (runs.items) |run| {
            const background = bg orelse self.get(run.x, y).?.bg;
            const cell = makeCell(run.char, fg, background, attributes);
            for (0..run.count) |offset| {
                const column = run.x + @as(u32, @intCast(offset));
                self.setTextCell(column, y, cell);
            }
        }
    }

    /// Draw one already-segmented grapheme with an authoritative terminal-cell width.
    pub fn drawGrapheme(
        self: *OptimizedBuffer,
        grapheme_bytes: []const u8,
        cell_width: u8,
        x: u32,
        y: u32,
        fg: RGBA,
        bg: RGBA,
        attributes: u32,
    ) BufferError!void {
        if (grapheme_bytes.len == 0 or cell_width == 0 or x >= self.width or y >= self.height) return;
        if (x + cell_width > self.width) return;
        for (0..cell_width) |offset| {
            if (!self.isPointInScissor(@intCast(x + offset), @intCast(y))) return;
        }

        const encoded_char: u32 = if (grapheme_bytes.len == 1 and cell_width == 1 and grapheme_bytes[0] >= 32)
            grapheme_bytes[0]
        else blk: {
            const gid = self.pool.alloc(grapheme_bytes) catch return BufferError.OutOfMemory;
            break :blk gp.packGraphemeStart(gid & gp.GRAPHEME_ID_MASK, cell_width);
        };
        self.set(x, y, makeCell(encoded_char, fg, bg, attributes));
    }

    /// Preserve the supplied cell width and raw-cell semantics after preparing pool ownership.
    /// The caller validates retained image resources once before drawing its cells.
    pub fn drawGraphemeChecked(
        self: *OptimizedBuffer,
        grapheme_bytes: []const u8,
        cell_width: u8,
        x: u32,
        y: u32,
        fg: RGBA,
        bg: RGBA,
        attributes: u32,
    ) error{ InvalidUnicode, InvalidOptions, TextLimit, UnsupportedResource, OutOfMemory, TrackerLimit }!void {
        if (attributes & ~ansi.TextAttributes.ATTRIBUTE_BASE_MASK != 0) return error.InvalidOptions;
        try validateColor(fg);
        try validateColor(bg);
        if (grapheme_bytes.len == 0 or cell_width == 0 or x >= self.width or y >= self.height) return;
        if (cell_width > self.width - x) return;
        if (self.width > math.maxInt(i32) or self.height > math.maxInt(i32)) return error.InvalidOptions;
        if (self.getCurrentScissorRect()) |clip| {
            if (clip.width > math.maxInt(i32) or clip.height > math.maxInt(i32) or
                @as(i64, clip.x) + clip.width > math.maxInt(i32) or
                @as(i64, clip.y) + clip.height > math.maxInt(i32)) return error.InvalidOptions;
        }
        for (0..cell_width) |offset| {
            if (!self.isPointInScissor(@intCast(x + offset), @intCast(y))) return;
        }
        var input: [128]u8 = undefined;
        if (grapheme_bytes.len > input.len) return error.TextLimit;
        if (!std.unicode.utf8ValidateSlice(grapheme_bytes)) return error.InvalidUnicode;
        if (grapheme_bytes.len == 1 and cell_width == 1 and grapheme_bytes[0] >= 32) {
            self.set(x, y, makeCell(grapheme_bytes[0], fg, bg, attributes));
            return;
        }

        // Pool growth can relocate bytes borrowed from another glyph in this pool.
        @memcpy(input[0..grapheme_bytes.len], grapheme_bytes);
        const id = self.pool.alloc(input[0..grapheme_bytes.len]) catch |err| return switch (err) {
            error.OutOfMemory => error.OutOfMemory,
            error.GraphemeTooLong => error.TextLimit,
            else => unreachable,
        };
        if ((self.pool.getRefcount(id) catch unreachable) >= math.maxInt(u32) - 1) return error.TrackerLimit;
        self.pool.incref(id) catch |err| {
            self.pool.freeUnreferenced(id) catch unreachable;
            return switch (err) {
                error.OutOfMemory => error.OutOfMemory,
                else => unreachable,
            };
        };
        defer self.pool.decref(id) catch unreachable;
        try self.storage.ensureTrackerCapacity(
            @as(u64, self.grapheme_tracker.getGraphemeCount()) + 1,
            self.link_tracker.getLinkCount(),
        );
        self.set(x, y, makeCell(gp.packGraphemeStart(id, cell_width), fg, bg, attributes));
    }

    fn drawVisibleText(
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
        const explicit_colors_opaque = if (bg) |background|
            !isRGBAWithAlpha(fg) and !isRGBAWithAlpha(background)
        else
            false;

        const is_ascii_only = utf8.isAsciiOnly(text);
        if (explicit_colors_opaque and is_ascii_only) {
            var printable = true;
            for (text) |byte| {
                if (byte < 32 or byte > 126) {
                    printable = false;
                    break;
                }
            }
            if (printable) {
                const background = bg.?;
                for (text, 0..) |byte, offset| {
                    const char_x = x + @as(u32, @intCast(offset));
                    if (char_x >= self.width) break;
                    self.set(char_x, y, makeCell(byte, fg, background, attributes));
                }
                return;
            }
        }

        var render_cluster_list: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
        defer render_cluster_list.deinit(self.allocator);

        const tab_width: u8 = 2;
        try utf8.findRenderClusterInfo(self.allocator, text, tab_width, is_ascii_only, self.width_method, &render_cluster_list);
        const render_clusters = render_cluster_list.items;

        var advance_cells: u32 = 0;
        var byte_offset: u32 = 0;
        var col: u32 = 0;
        var special_idx: usize = 0;

        text_loop: while (byte_offset < text.len) {
            const charX = x + advance_cells;
            if (charX >= self.width) break;

            const at_special = special_idx < render_clusters.len and render_clusters[special_idx].col_start == col;

            var grapheme_bytes: []const u8 = undefined;
            var cluster_width_cols: u32 = undefined;

            if (at_special) {
                const g = render_clusters[special_idx];
                grapheme_bytes = text[g.byte_start .. g.byte_start + g.byte_len];
                cluster_width_cols = g.width_cols;
                byte_offset = g.byte_start + g.byte_len;
                special_idx += 1;
            } else {
                if (byte_offset >= text.len) break;
                grapheme_bytes = text[byte_offset .. byte_offset + 1];
                cluster_width_cols = 1;
                byte_offset += 1;
            }

            const is_tab = grapheme_bytes.len == 1 and grapheme_bytes[0] == '\t';
            if (!is_tab and !self.isPointInScissor(@intCast(charX), @intCast(y))) {
                advance_cells += cluster_width_cols;
                col += cluster_width_cols;
                continue;
            }

            var bgColor: RGBA = undefined;
            if (bg) |b| {
                bgColor = b;
            } else if (self.get(charX, y)) |existingCell| {
                bgColor = existingCell.bg;
            } else {
                bgColor = ansi.rgbColor(0, 0, 0, 255);
            }

            const cell_width = utf8.getWidthAt(text, if (at_special) render_clusters[special_idx - 1].byte_start else byte_offset - 1, tab_width, self.width_method);
            if (cell_width == 0) {
                col += cluster_width_cols;
                continue;
            }
            if (cell_width > 1 and !is_tab) {
                if (charX + cell_width > self.width) {
                    advance_cells += cluster_width_cols;
                    col += cluster_width_cols;
                    continue;
                }
                for (1..cell_width) |span_offset| {
                    if (!self.isPointInScissor(@intCast(charX + @as(u32, @intCast(span_offset))), @intCast(y))) {
                        advance_cells += cluster_width_cols;
                        col += cluster_width_cols;
                        continue :text_loop;
                    }
                }
            }

            if (is_tab) {
                var tab_col: u32 = 0;
                while (tab_col < cluster_width_cols) : (tab_col += 1) {
                    const tab_x = charX + tab_col;
                    if (tab_x >= self.width) break;
                    if (!self.isPointInScissor(@intCast(tab_x), @intCast(y))) continue;

                    const cell = makeCell(DEFAULT_SPACE_CHAR, fg, bgColor, attributes);
                    if (explicit_colors_opaque) self.set(tab_x, y, cell) else self.setTextCell(tab_x, y, cell);
                }
                advance_cells += cluster_width_cols;
                col += cluster_width_cols;
                continue;
            }

            var encoded_char: u32 = 0;
            if (grapheme_bytes.len == 1 and cell_width == 1 and grapheme_bytes[0] >= 32) {
                encoded_char = @as(u32, grapheme_bytes[0]);
            } else {
                const gid = self.pool.alloc(grapheme_bytes) catch return BufferError.OutOfMemory;
                encoded_char = gp.packGraphemeStart(gid & gp.GRAPHEME_ID_MASK, cell_width);
            }

            const cell = makeCell(encoded_char, fg, bgColor, attributes);
            if (explicit_colors_opaque) self.set(charX, y, cell) else self.setTextCell(charX, y, cell);

            advance_cells += cell_width;
            col += cluster_width_cols;
        }
    }

    pub fn drawFrameBuffer(self: *OptimizedBuffer, destX: i32, destY: i32, frameBuffer: *OptimizedBuffer, sourceX: ?u32, sourceY: ?u32, sourceWidth: ?u32, sourceHeight: ?u32) void {
        self.drawFrameBufferInternal(destX, destY, frameBuffer, sourceX, sourceY, sourceWidth, sourceHeight, false) catch unreachable;
    }

    pub fn drawFrameBufferChecked(self: *OptimizedBuffer, destX: i32, destY: i32, frameBuffer: *OptimizedBuffer, sourceX: ?u32, sourceY: ?u32, sourceWidth: ?u32, sourceHeight: ?u32) !void {
        try self.drawFrameBufferInternal(destX, destY, frameBuffer, sourceX, sourceY, sourceWidth, sourceHeight, true);
    }

    fn drawFrameBufferInternal(self: *OptimizedBuffer, destX: i32, destY: i32, frameBuffer: *OptimizedBuffer, sourceX: ?u32, sourceY: ?u32, sourceWidth: ?u32, sourceHeight: ?u32, checked: bool) !void {
        if (self.width == 0 or self.height == 0 or frameBuffer.width == 0 or frameBuffer.height == 0) return;

        const opacity = self.getCurrentOpacity();
        if (opacity == 0.0) return;

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
        const imageAware = self.image_placements.items.len != 0 or frameBuffer.image_placements.items.len != 0;

        // Calculate clipping once for both paths
        const clippedRect = self.clipRectToScissor(startDestX, startDestY, destWidth, destHeight) orelse return;
        const clippedStartX = @max(startDestX, clippedRect.x);
        const clippedStartY = @max(startDestY, clippedRect.y);
        const clippedEndX = @min(endDestX, @as(i32, @intCast(clippedRect.x + @as(i32, @intCast(clippedRect.width)) - 1)));
        const clippedEndY = @min(endDestY, @as(i32, @intCast(clippedRect.y + @as(i32, @intCast(clippedRect.height)) - 1)));

        if (opacity == 1.0 and !graphemeAware and !frameBuffer.respectAlpha and !linkAware and !imageAware) {
            // Fast path: direct memory copy
            const first_source_y = srcY + @as(u32, @intCast(clippedStartY - destY));
            const first_source_x = srcX + @as(u32, @intCast(clippedStartX - destX));
            const copy_width = @min(@as(u32, @intCast(clippedEndX - clippedStartX + 1)), frameBuffer.width - first_source_x);
            if (clippedStartX == 0 and first_source_x == 0 and copy_width == self.width and copy_width == frameBuffer.width) {
                const row_count: u32 = @intCast(clippedEndY - clippedStartY + 1);
                const cell_count = copy_width * row_count;
                const dest_start = self.coordsToIndex(0, @intCast(clippedStartY));
                const source_start = frameBuffer.coordsToIndex(0, first_source_y);
                @memcpy(self.buffer.char[dest_start .. dest_start + cell_count], frameBuffer.buffer.char[source_start .. source_start + cell_count]);
                @memcpy(self.buffer.fg[dest_start .. dest_start + cell_count], frameBuffer.buffer.fg[source_start .. source_start + cell_count]);
                @memcpy(self.buffer.bg[dest_start .. dest_start + cell_count], frameBuffer.buffer.bg[source_start .. source_start + cell_count]);
                @memcpy(self.buffer.attributes[dest_start .. dest_start + cell_count], frameBuffer.buffer.attributes[source_start .. source_start + cell_count]);
                return;
            }

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

        const has_source_images = frameBuffer.image_placements.items.len != 0;
        if (checked and frameBuffer.image_placements.items.len > gp.IMAGE_ID_MASK - self.image_placements.items.len) return error.ObjectLimit;
        if (checked) {
            for (frameBuffer.image_placements.items) |placement| {
                if (placement.image.ref_count > math.maxInt(u32) - frameBuffer.image_placements.items.len) return error.ObjectLimit;
            }
        }
        var empty_image_id_map = [_]u32{0};
        const allocated_image_id_map = if (has_source_images)
            self.allocator.alloc(u32, frameBuffer.image_placements.items.len + 1) catch |err| if (checked) return err else null
        else
            null;
        const image_id_map = allocated_image_id_map orelse empty_image_id_map[0..];
        defer if (allocated_image_id_map) |allocated| self.allocator.free(allocated);
        @memset(image_id_map, 0);
        var can_copy_images = allocated_image_id_map != null;
        if (can_copy_images) {
            self.image_placements.ensureTotalCapacity(
                self.storage.resourceAllocator(),
                self.image_placements.items.len + frameBuffer.image_placements.items.len,
            ) catch |err| {
                if (checked) return err;
                can_copy_images = false;
            };
        }
        for (frameBuffer.image_placements.items, 1..) |placement, source_id| {
            if (!can_copy_images or self.image_placements.items.len >= gp.IMAGE_ID_MASK) break;
            const full_x = @as(i64, destX) + placement.x - srcX;
            const full_y = @as(i64, destY) + placement.y - srcY;
            const x0 = @max(full_x, clippedStartX);
            const y0 = @max(full_y, clippedStartY);
            const x1 = @min(full_x + @as(i32, @intCast(placement.width)), clippedEndX + 1);
            const y1 = @min(full_y + @as(i32, @intCast(placement.height)), clippedEndY + 1);
            if (x0 >= x1 or y0 >= y1) continue;
            const left: u32 = @intCast(x0 - full_x);
            const top: u32 = @intCast(y0 - full_y);
            const right: u32 = @intCast(x1 - full_x);
            const bottom: u32 = @intCast(y1 - full_y);
            const source_start_x = placement.source_x + @as(u32, @intCast((@as(u64, left) * placement.source_width) / placement.width));
            const source_start_y = placement.source_y + @as(u32, @intCast((@as(u64, top) * placement.source_height) / placement.height));
            const source_end_x = placement.source_x + @as(u32, @intCast((@as(u64, right) * placement.source_width + placement.width - 1) / placement.width));
            const source_end_y = placement.source_y + @as(u32, @intCast((@as(u64, bottom) * placement.source_height + placement.height - 1) / placement.height));
            const visible_width: u32 = @intCast(x1 - x0);
            const visible_height: u32 = @intCast(y1 - y0);
            self.image_placements.appendAssumeCapacity(.{
                .placement_id = @intCast(self.image_placements.items.len + 1),
                .image_handle = placement.image_handle,
                .image = placement.image,
                .x = @intCast(x0),
                .y = @intCast(y0),
                .width = visible_width,
                .height = visible_height,
                .pixel_width = if (placement.pixel_width == 0) 0 else @intCast((@as(u64, visible_width) * placement.pixel_width + placement.width - 1) / placement.width),
                .pixel_height = if (placement.pixel_height == 0) 0 else @intCast((@as(u64, visible_height) * placement.pixel_height + placement.height - 1) / placement.height),
                .source_x = source_start_x,
                .source_y = source_start_y,
                .source_width = source_end_x - source_start_x,
                .source_height = source_end_y - source_start_y,
                .opacity = @intCast(mulDiv255(placement.opacity, opacityToU8(self.getCurrentOpacity()))),
                .protocol = placement.protocol,
            });
            placement.image.retain();
            image_id_map[source_id] = @intCast(self.image_placements.items.len);
        }

        var dY = clippedStartY;
        while (dY <= clippedEndY) : (dY += 1) {
            var lastDrawnGraphemeId: ?u32 = null;

            var dX = clippedStartX;
            while (dX <= clippedEndX) : (dX += 1) {
                const relativeDestX = dX - destX;
                const relativeDestY = dY - destY;
                const sX = srcX + @as(u32, @intCast(relativeDestX));
                const sY = srcY + @as(u32, @intCast(relativeDestY));

                if (sX >= frameBuffer.width or sY >= frameBuffer.height) continue;

                const srcIndex = frameBuffer.coordsToIndex(sX, sY);
                if (srcIndex >= frameBuffer.buffer.char.len) continue;

                var srcChar = frameBuffer.buffer.char[srcIndex];
                if (gp.isImageChar(srcChar)) {
                    const source_id = gp.imageIdFromChar(srcChar);
                    if (source_id < image_id_map.len) {
                        const mapped_id = image_id_map[source_id];
                        srcChar = if (mapped_id != 0)
                            gp.packImageCell(mapped_id, gp.imageFallbackFromChar(srcChar))
                        else
                            quadrantChars[gp.imageFallbackFromChar(srcChar)];
                    } else {
                        srcChar = quadrantChars[gp.imageFallbackFromChar(srcChar)];
                    }
                }
                const srcFg = frameBuffer.buffer.fg[srcIndex];
                const srcBg = frameBuffer.buffer.bg[srcIndex];
                const srcAttr = frameBuffer.buffer.attributes[srcIndex];

                if (ansi.alpha(srcBg) == 0 and ansi.alpha(srcFg) == 0) {
                    if (gp.isImageChar(srcChar)) {
                        const current = self.get(@intCast(dX), @intCast(dY)) orelse continue;
                        self.set(@intCast(dX), @intCast(dY), makeCell(srcChar, current.fg, current.bg, current.attributes));
                    }
                    continue;
                }

                if (graphemeAware) {
                    if (gp.isContinuationChar(srcChar)) {
                        const graphemeId = srcChar & gp.GRAPHEME_ID_MASK;
                        if (graphemeId != lastDrawnGraphemeId) {
                            // We haven't drawn the start character for this grapheme (likely out of bounds to the left)
                            // Draw a space with the same attributes to fill the cell
                            self.setCellWithAlphaBlendingCell(
                                @intCast(dX),
                                @intCast(dY),
                                makeCell(DEFAULT_SPACE_CHAR, srcFg, srcBg, srcAttr),
                            );
                        }
                        continue;
                    }

                    if (gp.isGraphemeChar(srcChar)) {
                        if (gp.charRightExtent(srcChar) > @as(u32, @intCast(clippedEndX - dX))) {
                            // Partial spans become styled spaces, as at the left edge.
                            srcChar = DEFAULT_SPACE_CHAR;
                            lastDrawnGraphemeId = null;
                        } else {
                            lastDrawnGraphemeId = srcChar & gp.GRAPHEME_ID_MASK;
                        }
                    }

                    self.setCellWithAlphaBlendingCell(
                        @intCast(dX),
                        @intCast(dY),
                        makeCell(srcChar, srcFg, srcBg, srcAttr),
                    );
                    continue;
                }

                const cell = makeCell(srcChar, srcFg, srcBg, srcAttr);
                if (imageAware) {
                    self.setCellWithAlphaBlendingRawImageAware(@intCast(dX), @intCast(dY), cell);
                } else self.setCellWithAlphaBlendingRawCell(@intCast(dX), @intCast(dY), cell);
            }
        }
    }

    /// Draw a TextBufferView to this OptimizedBuffer with selection support and optional syntax highlighting
    pub fn drawTextBuffer(
        self: *OptimizedBuffer,
        text_buffer_view: *TextBufferView,
        x: i32,
        y: i32,
    ) void {
        self.drawTextBufferInternal(TextBufferView, false, text_buffer_view, x, y) catch |err| {
            self.logger.warn("drawTextBuffer failed: {}", .{err});
        };
    }

    /// Errors can leave partial cells. The frame owner must clear or discard them.
    /// Every cell write has tracker capacity and a live glyph reference prepared.
    pub fn drawTextBufferChecked(
        self: *OptimizedBuffer,
        text_buffer_view: *TextBufferView,
        x: i32,
        y: i32,
    ) !void {
        self.drawTextBufferInternal(TextBufferView, true, text_buffer_view, x, y) catch |err| return switch (err) {
            error.GraphemeTooLong => error.TextLimit,
            else => err,
        };
    }

    /// Internal implementation that accepts either TextBufferView or EditorView
    /// Both types must expose: getVirtualLines(), getViewport(), getCachedLineInfo(), getVirtualLineSpans(), getTextBuffer(), getSelection()
    fn drawTextBufferInternal(
        self: *OptimizedBuffer,
        comptime ViewType: type,
        comptime checked: bool,
        view: *ViewType,
        x: i32,
        y: i32,
    ) !void {
        const opacity = self.getCurrentOpacity();
        if (opacity == 0.0) return;

        const virtual_lines = view.getVirtualLines();
        const layout_view = if (ViewType == TextBufferView) view else view.getTextBufferView();
        if (checked and (layout_view.virtual_lines_dirty or
            (layout_view.truncate and layout_view.viewport != null and !layout_view.truncation_applied)))
        {
            return error.OutOfMemory;
        }
        const viewport = view.getViewport();
        const text_buffer = view.getTextBuffer();
        const tab_indicator = view.getTabIndicator();
        const tab_indicator_color = view.getTabIndicatorColor();
        var indicator_bytes: [4]u8 = undefined;
        const indicator_length = if (tab_indicator) |scalar|
            std.unicode.utf8Encode(std.math.cast(u21, scalar) orelse return error.InvalidUnicode, &indicator_bytes) catch return error.InvalidUnicode
        else
            0;
        const indicator_width = if (indicator_length != 0)
            utf8.getGraphemeWidthAt(indicator_bytes[0..indicator_length], 0, text_buffer.tabWidth(), text_buffer.widthMethod())
        else
            0;
        const text_defaults = text_buffer.defaults();
        const PrefilledViewportBg = struct {
            bg: RGBA,
        };

        const prefilledViewportBg: ?PrefilledViewportBg = blk: {
            if (comptime ViewType != EditorView) break :blk null;
            const vp = viewport orelse break :blk null;
            const base_defaults = view.edit_buffer.getTextBuffer().defaults();
            const default_bg = base_defaults.bg orelse break :blk null;
            if (ansi.alpha(default_bg) == 0) break :blk null;
            self.fillRectClipped(x, y, vp.width, vp.height, default_bg);
            break :blk .{ .bg = default_bg };
        };

        if (virtual_lines.len == 0) return;

        const firstVisibleLine: u32 = if (y < 0) @intCast(-@as(i64, y)) else 0;
        const bufferBottomY = self.height;
        const lastPossibleLine = if (y >= @as(i32, @intCast(bufferBottomY)))
            0
        else if (y < 0)
            @min(virtual_lines.len, firstVisibleLine + bufferBottomY)
        else
            @min(virtual_lines.len, bufferBottomY - @as(u32, @intCast(y)));

        if (firstVisibleLine >= virtual_lines.len or lastPossibleLine == 0) return;
        if (firstVisibleLine >= lastPossibleLine) return;

        const horizontal_offset: u32 = if (viewport) |vp| vp.x else 0;
        const viewport_width: u32 = if (viewport) |vp| vp.width else std.math.maxInt(u32);

        var currentX = x;
        var currentY = y + @as(i32, @intCast(firstVisibleLine));
        const total_line_count = text_buffer.lineCount();

        const line_info = view.getCachedLineInfo();
        var document_cell_offset: u32 = if (firstVisibleLine < line_info.line_start_cols.len)
            line_info.line_start_cols[firstVisibleLine]
        else
            0;

        for (virtual_lines[firstVisibleLine..lastPossibleLine], 0..) |vline, slice_idx| {
            if (currentY >= bufferBottomY) break;

            currentX = x;
            var rendered_col_in_vline: u32 = 0;
            document_cell_offset = vline.document_cell_offset;

            // When viewport is set, virtual_lines is a slice starting from viewport.y
            // But getVirtualLineSpans expects absolute indices, so we need to use the absolute index
            // slice_idx is relative to the slice (0, 1, 2...), we need to add viewport offset + firstVisibleLine
            const viewport_offset: u32 = if (viewport) |vp| vp.y else 0;
            const vline_idx = viewport_offset + firstVisibleLine + slice_idx;
            const vline_span_info = view.getVirtualLineSpans(vline_idx);
            const spans = vline_span_info.spans;
            const col_offset = vline_span_info.source_col_start;
            var span_idx: usize = 0;
            var lineFg = text_defaults.fg orelse ansi.rgbColor(255, 255, 255, 255);
            var lineBg = text_defaults.bg orelse ansi.rgbColor(0, 0, 0, 0);
            var lineAttributes = text_defaults.attributes orelse 0;
            const defaultFg = lineFg;
            const defaultBg = lineBg;
            const defaultAttributes = lineAttributes;

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
                        if (resolved_style.fg) |fg| {
                            lineFg = fg;
                        }
                        if (resolved_style.bg) |bg| {
                            lineBg = bg;
                        }
                        lineAttributes |= resolved_style.attributes;
                    }
                }
            }

            for (vline.chunks.items) |vchunk| {
                const chunk = vchunk.chunk;
                const chunk_bytes = chunk.getBytes(text_buffer.memRegistry());
                const render_clusters = chunk.getRenderClusters(text_buffer.getAllocator(), text_buffer.memRegistry(), text_buffer.tabWidth(), text_buffer.widthMethod()) catch |err| {
                    if (checked) return err;
                    continue;
                };
                const line_col_offset = vline.document_cell_offset;

                if (currentX >= @as(i32, @intCast(self.width))) {
                    document_cell_offset += vchunk.width_cols;
                    currentX += @intCast(vchunk.width_cols);
                    continue;
                }
                const col_end = vchunk.col_start_in_chunk + vchunk.width_cols;
                var col = vchunk.col_start_in_chunk;
                var special_idx: usize = 0;
                var byte_offset = vchunk.byte_start_in_chunk;
                const byte_end = vchunk.byte_start_in_chunk + vchunk.byte_len;

                while (special_idx < render_clusters.len and render_clusters[special_idx].byte_start + render_clusters[special_idx].byte_len <= byte_offset) {
                    special_idx += 1;
                }

                text_buffer_loop: while (byte_offset < byte_end and col < col_end) {
                    const at_special = special_idx < render_clusters.len and render_clusters[special_idx].byte_start == byte_offset;

                    var grapheme_bytes: []const u8 = undefined;
                    var cluster_width_cols: u32 = undefined;

                    if (at_special) {
                        const g = render_clusters[special_idx];
                        if (g.byte_start + g.byte_len > byte_end) break;
                        grapheme_bytes = chunk_bytes[g.byte_start .. g.byte_start + g.byte_len];
                        cluster_width_cols = g.width_cols;
                        byte_offset = g.byte_start + g.byte_len;
                        special_idx += 1;
                    } else {
                        if (byte_offset >= byte_end or byte_offset >= chunk_bytes.len) break;
                        const cp_len = std.unicode.utf8ByteSequenceLength(chunk_bytes[byte_offset]) catch 1;
                        const next_byte_offset = @min(byte_offset + cp_len, byte_end);
                        grapheme_bytes = chunk_bytes[byte_offset..next_byte_offset];
                        // Sparse metadata also omits zero-width control characters.
                        cluster_width_cols = utf8.getWidthAt(grapheme_bytes, 0, text_buffer.tabWidth(), text_buffer.widthMethod());
                        byte_offset = next_byte_offset;
                    }

                    if (rendered_col_in_vline < horizontal_offset) {
                        document_cell_offset += cluster_width_cols;
                        rendered_col_in_vline += cluster_width_cols;
                        col += cluster_width_cols;
                        continue;
                    }

                    if (rendered_col_in_vline >= horizontal_offset + viewport_width) {
                        document_cell_offset += (col_end - col);
                        break;
                    }

                    // A glyph occupies columns [currentX, currentX + cluster_width_cols).
                    // If this range ends at or before column 0, the glyph is left of the screen.
                    // Skip the glyph, but advance the counters to put the next glyph in the correct columns.
                    // This check permits wide glyphs that cross column 0.
                    // The cluster_width_cols > 1 check below discards these glyphs before they reach the unchecked fast-path index.
                    if (currentX + @as(i32, @intCast(cluster_width_cols)) <= 0) {
                        document_cell_offset += cluster_width_cols;
                        currentX += @as(i32, @intCast(cluster_width_cols));
                        rendered_col_in_vline += cluster_width_cols;
                        col += cluster_width_cols;
                        continue;
                    }

                    if (currentX >= @as(i32, @intCast(self.width))) {
                        document_cell_offset += (col_end - col);
                        break;
                    }

                    const is_tab = grapheme_bytes.len == 1 and grapheme_bytes[0] == '\t';
                    if (!is_tab and !self.isPointInScissor(currentX, currentY)) {
                        document_cell_offset += cluster_width_cols;
                        currentX += @as(i32, @intCast(cluster_width_cols));
                        rendered_col_in_vline += cluster_width_cols;
                        col += cluster_width_cols;
                        continue;
                    }

                    if (cluster_width_cols > 1 and !is_tab) {
                        if (rendered_col_in_vline + cluster_width_cols > horizontal_offset + viewport_width or
                            currentX < 0 or currentX + @as(i32, @intCast(cluster_width_cols)) > @as(i32, @intCast(self.width)))
                        {
                            document_cell_offset += cluster_width_cols;
                            currentX += @as(i32, @intCast(cluster_width_cols));
                            rendered_col_in_vline += cluster_width_cols;
                            col += cluster_width_cols;
                            continue;
                        }
                        for (1..cluster_width_cols) |span_offset| {
                            if (!self.isPointInScissor(currentX + @as(i32, @intCast(span_offset)), currentY)) {
                                document_cell_offset += cluster_width_cols;
                                currentX += @as(i32, @intCast(cluster_width_cols));
                                rendered_col_in_vline += cluster_width_cols;
                                col += cluster_width_cols;
                                continue :text_buffer_loop;
                            }
                        }
                    }

                    var selection_offset = document_cell_offset;
                    if (vline.is_truncated and document_cell_offset >= line_col_offset) {
                        const ellipsis_width: u32 = 3;
                        const column_offset_in_line = document_cell_offset - line_col_offset;
                        if (column_offset_in_line >= vline.ellipsis_col and column_offset_in_line < vline.ellipsis_col + ellipsis_width) {
                            selection_offset = line_col_offset + vline.ellipsis_col;
                        } else if (column_offset_in_line >= vline.ellipsis_col + ellipsis_width) {
                            selection_offset = line_col_offset + vline.truncation_suffix_col_start +
                                (column_offset_in_line - vline.ellipsis_col - ellipsis_width);
                        } else {
                            selection_offset = line_col_offset + column_offset_in_line;
                        }
                    }

                    // Track the actual column position in the source line (including horizontal offset)
                    var source_col_pos = col_offset + rendered_col_in_vline;
                    if (vline.is_truncated) {
                        const ellipsis_width: u32 = 3;
                        const column_offset_in_line = document_cell_offset - line_col_offset;
                        if (column_offset_in_line >= vline.ellipsis_col and column_offset_in_line < vline.ellipsis_col + ellipsis_width) {
                            source_col_pos = std.math.maxInt(u32);
                        } else if (column_offset_in_line >= vline.ellipsis_col + ellipsis_width) {
                            source_col_pos = vline.truncation_suffix_col_start + (column_offset_in_line - vline.ellipsis_col - ellipsis_width);
                        }
                    }

                    while (source_col_pos >= next_change_col and span_idx + 1 < spans.len) {
                        span_idx += 1;
                        const new_span = spans[span_idx];

                        lineFg = defaultFg;
                        lineBg = defaultBg;
                        lineAttributes = defaultAttributes;

                        if (text_buffer.getSyntaxStyle()) |style| {
                            if (new_span.style_id != 0) {
                                if (style.resolveById(new_span.style_id)) |resolved_style| {
                                    if (resolved_style.fg) |fg| {
                                        lineFg = fg;
                                    }
                                    if (resolved_style.bg) |bg| {
                                        lineBg = bg;
                                    }
                                    lineAttributes |= resolved_style.attributes;
                                }
                            }
                        }

                        next_change_col = new_span.next_col;
                    }

                    if (vline.is_truncated) {
                        const column_offset_in_line = document_cell_offset - line_col_offset;
                        const ellipsis_width: u32 = 3;
                        if (column_offset_in_line >= vline.ellipsis_col and column_offset_in_line < vline.ellipsis_col + ellipsis_width) {
                            lineFg = defaultFg;
                            lineBg = defaultBg;
                            lineAttributes = defaultAttributes;
                        } else if (column_offset_in_line >= vline.ellipsis_col + ellipsis_width) {
                            const suffix_col_pos = vline.truncation_suffix_col_start + (column_offset_in_line - vline.ellipsis_col - ellipsis_width);
                            if (spans.len == 0) {
                                lineFg = defaultFg;
                                lineBg = defaultBg;
                                lineAttributes = defaultAttributes;
                                next_change_col = std.math.maxInt(u32);
                            } else {
                                var suffix_span_idx: usize = 0;
                                while (suffix_span_idx < spans.len and spans[suffix_span_idx].next_col <= suffix_col_pos) {
                                    suffix_span_idx += 1;
                                }
                                if (suffix_span_idx < spans.len) {
                                    span_idx = suffix_span_idx;
                                }
                                const active_span = spans[span_idx];
                                lineFg = defaultFg;
                                lineBg = defaultBg;
                                lineAttributes = defaultAttributes;
                                if (text_buffer.getSyntaxStyle()) |style| {
                                    if (active_span.style_id != 0) {
                                        if (style.resolveById(active_span.style_id)) |resolved_style| {
                                            if (resolved_style.fg) |fg| {
                                                lineFg = fg;
                                            }
                                            if (resolved_style.bg) |bg| {
                                                lineBg = bg;
                                            }
                                            lineAttributes |= resolved_style.attributes;
                                        }
                                    }
                                }
                                next_change_col = active_span.next_col;
                            }
                        }
                    }

                    var finalFg = lineFg;
                    var finalBg = lineBg;
                    const finalAttributes = lineAttributes;

                    var cell_idx: u32 = 0;
                    while (cell_idx < cluster_width_cols) : (cell_idx += 1) {
                        if (view.getSelection()) |sel| {
                            const isSelected = selection_offset + cell_idx >= sel.start and selection_offset + cell_idx < sel.end;
                            if (isSelected) {
                                if (sel.bgColor) |selBg| {
                                    finalBg = selBg;
                                    if (sel.fgColor) |selFg| {
                                        finalFg = selFg;
                                    }
                                } else {
                                    const temp = lineFg;
                                    finalFg = if (ansi.alpha(lineBg) > 0) lineBg else ansi.rgbColor(0, 0, 0, 255);
                                    finalBg = temp;
                                }
                                break;
                            }
                        }
                    }

                    if (cluster_width_cols == 0) {
                        if (utf8.isCombiningMark(grapheme_bytes)) {
                            try self.attachCombiningMark(checked, grapheme_bytes, currentX, currentY);
                        }
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

                    if (prefilledViewportBg) |prefilledBg| {
                        if (rgbaEqual(drawBg, prefilledBg.bg)) {
                            drawBg[3] = drawBg[3] & 0xff00;
                        }
                    }

                    const link_id = ansi.TextAttributes.getLinkId(drawAttributes);
                    if (link_id != 0) {
                        // set() pins the link and then writes its cells, so leave a spare
                        // map entry even after the first insertion by its void tracker.
                        try self.storage.ensureTrackerCapacity(
                            self.grapheme_tracker.getGraphemeCount(),
                            @as(u64, self.link_tracker.getLinkCount()) + 2,
                        );
                        const refs = try self.link_pool.getRefcount(link_id);
                        if (refs >= math.maxInt(u32) - 1) return error.TrackerLimit;
                        self.link_pool.incref(link_id) catch |err| {
                            // LinkPool publishes its reference before first-use interning.
                            if (err == error.OutOfMemory) self.link_pool.decref(link_id) catch unreachable;
                            return err;
                        };
                    }
                    defer if (link_id != 0) self.link_pool.decref(link_id) catch unreachable;

                    if (is_tab) {
                        const useTransparentTextFastPath = opacity == 1.0 and ansi.alpha(drawBg) == 0;
                        var tab_col: u32 = 0;
                        while (tab_col < cluster_width_cols) : (tab_col += 1) {
                            if (rendered_col_in_vline + tab_col >= horizontal_offset + viewport_width) break;
                            const tab_x = currentX + @as(i32, @intCast(tab_col));
                            if (tab_x < 0) continue;
                            if (tab_x >= @as(i32, @intCast(self.width))) break;
                            if (!self.isPointInScissor(tab_x, currentY)) continue;

                            var char = DEFAULT_SPACE_CHAR;
                            var fg = drawFg;
                            if (tab_col == 0 and indicator_width > 0 and indicator_width <= cluster_width_cols and
                                @as(u64, rendered_col_in_vline) + indicator_width <= @as(u64, horizontal_offset) + viewport_width)
                            {
                                if (indicator_width == 1) {
                                    char = tab_indicator.?;
                                    fg = tab_indicator_color orelse drawFg;
                                } else if (indicator_width <= self.width - @as(u32, @intCast(tab_x))) {
                                    var visible = true;
                                    for (1..indicator_width) |offset| {
                                        if (!self.isPointInScissor(tab_x + @as(i32, @intCast(offset)), currentY)) visible = false;
                                    }
                                    if (visible) {
                                        try self.drawTextBufferGrapheme(checked, indicator_bytes[0..indicator_length], indicator_width, @intCast(tab_x), @intCast(currentY), tab_indicator_color orelse drawFg, drawBg, drawAttributes);
                                        tab_col += indicator_width - 1;
                                        continue;
                                    }
                                }
                            }

                            if (useTransparentTextFastPath) {
                                const index = self.coordsToIndex(@intCast(tab_x), @intCast(currentY));
                                if (self.trySetTransparentTextCellFast(index, char, fg, drawAttributes)) {
                                    continue;
                                }
                            }

                            self.setCellWithAlphaBlendingCell(
                                @intCast(tab_x),
                                @intCast(currentY),
                                makeCell(char, fg, drawBg, drawAttributes),
                            );
                        }
                    } else {
                        try self.drawTextBufferGrapheme(checked, grapheme_bytes, cluster_width_cols, @intCast(currentX), @intCast(currentY), drawFg, drawBg, drawAttributes);
                    }

                    document_cell_offset += cluster_width_cols;
                    currentX += @as(i32, @intCast(cluster_width_cols));
                    rendered_col_in_vline += cluster_width_cols;
                    col += cluster_width_cols;
                }
            }

            const is_last_vline_of_logical_line = (slice_idx + 1 >= virtual_lines[firstVisibleLine..lastPossibleLine].len) or
                (virtual_lines[firstVisibleLine..lastPossibleLine][slice_idx + 1].source_line != vline.source_line);

            if (is_last_vline_of_logical_line) {
                const is_last_logical_line = vline.source_line + 1 >= total_line_count;
                if (!is_last_logical_line) {
                    document_cell_offset += 1;
                }
            }

            currentY += 1;
        }
    }

    fn attachCombiningMark(self: *OptimizedBuffer, comptime checked: bool, mark: []const u8, current_x: i32, current_y: i32) !void {
        if (current_x <= 0 or current_y < 0) return;
        const prev_x: u32 = @intCast(current_x - 1);
        const y: u32 = @intCast(current_y);
        if (prev_x >= self.width or y >= self.height) return;
        const prev = self.buffer.char[self.coordsToIndex(prev_x, y)];
        const start_x: u32 = if (gp.isContinuationChar(prev)) blk: {
            const left = gp.charLeftExtent(prev);
            if (left > prev_x) return;
            break :blk prev_x - left;
        } else prev_x;
        const start = self.coordsToIndex(start_x, y);
        const char_code = self.buffer.char[start];
        if (char_code == 0 or gp.isContinuationChar(char_code) or gp.isImageChar(char_code)) return;
        var encoded: [4]u8 = undefined;
        const base: []const u8 = if (gp.isGraphemeChar(char_code))
            self.pool.get(gp.graphemeIdFromChar(char_code)) catch return
        else blk: {
            const codepoint = math.cast(u21, char_code) orelse return;
            const length = std.unicode.utf8Encode(codepoint, &encoded) catch return;
            break :blk encoded[0..length];
        };
        var combined: [128]u8 = undefined;
        if (base.len + mark.len > combined.len) return;
        @memcpy(combined[0..base.len], base);
        @memcpy(combined[base.len..][0..mark.len], mark);
        try self.drawTextBufferGrapheme(
            checked,
            combined[0 .. base.len + mark.len],
            gp.encodedCharWidth(char_code),
            start_x,
            y,
            self.buffer.fg[start],
            self.buffer.bg[start],
            self.buffer.attributes[start],
        );
    }

    fn drawTextBufferGrapheme(self: *OptimizedBuffer, comptime checked: bool, bytes: []const u8, width: u32, x: u32, y: u32, fg: RGBA, bg: RGBA, attributes: u32) !void {
        const opacity = self.getCurrentOpacity();
        if (self.skipTransparentCellDraw(opacity, isFullyTransparent(opacity, fg, bg))) return;
        var encoded_char: u32 = 0;
        var retained_gid: ?u32 = null;
        defer if (retained_gid) |gid| self.pool.decref(gid) catch unreachable;
        if (bytes.len == 1 and width == 1 and bytes[0] >= 32) {
            encoded_char = @as(u32, bytes[0]);
        } else {
            const gid = self.pool.alloc(bytes) catch |err| {
                if (checked) return err;
                self.logger.warn("Failed to allocate grapheme: {}", .{err});
                return;
            };
            if ((try self.pool.getRefcount(gid)) >= math.maxInt(u32) - 1) return error.TrackerLimit;
            // Intern before the void cell writer can take its first reference.
            // This temporary reference also reclaims glyphs discarded by blending.
            self.pool.incref(gid) catch |err| {
                self.pool.freeUnreferenced(gid) catch unreachable;
                return err;
            };
            retained_gid = gid;
            try self.storage.ensureTrackerCapacity(
                @as(u64, self.grapheme_tracker.getGraphemeCount()) + 1,
                self.link_tracker.getLinkCount(),
            );
            encoded_char = gp.packGraphemeStart(gid & gp.GRAPHEME_ID_MASK, width);
        }
        // Opaque text on transparent backgrounds avoids generic per-cell blending.
        if (opacity == 1.0 and ansi.alpha(bg) == 0) {
            const index = self.coordsToIndex(x, y);
            if (self.trySetTransparentTextCellFast(index, encoded_char, fg, attributes)) return;
        }
        self.setCellWithAlphaBlendingCell(x, y, makeCell(encoded_char, fg, bg, attributes));
    }

    /// Draw an EditorView to this OptimizedBuffer
    /// EditorView wraps TextBufferView, so we just delegate to drawTextBufferInternal
    /// EditorView handles viewport management and returns only the visible lines
    pub fn drawEditorView(
        self: *OptimizedBuffer,
        editor_view: *EditorView,
        x: i32,
        y: i32,
    ) void {
        self.drawTextBufferInternal(EditorView, false, editor_view, x, y) catch |err| {
            self.logger.warn("drawEditorView failed: {}", .{err});
        };
    }

    pub fn drawEditorViewChecked(
        self: *OptimizedBuffer,
        editor_view: *EditorView,
        x: i32,
        y: i32,
    ) !void {
        self.drawTextBufferInternal(EditorView, true, editor_view, x, y) catch |err| return switch (err) {
            error.GraphemeTooLong => error.TextLimit,
            else => err,
        };
    }

    /// Draw a complete border grid in a single call.
    /// columnOffsets and rowOffsets include an extra trailing entry so that
    /// the range for column `i` is `[columnOffsets[i]+1 .. columnOffsets[i+1]-1]`.
    pub fn drawGrid(
        self: *OptimizedBuffer,
        borderChars: [*]const u32,
        borderFg: RGBA,
        borderBg: RGBA,
        columnOffsets: [*]const i32,
        columnCount: u32,
        rowOffsets: [*]const i32,
        rowCount: u32,
        drawInner: bool,
        drawOuter: bool,
    ) void {
        if (rowCount == 0 or columnCount == 0) return;
        if (!drawInner and !drawOuter) return;

        const opacity = self.getCurrentOpacity();
        if (self.skipTransparentCellDraw(opacity, isFullyTransparent(opacity, borderFg, borderBg))) return;

        const hChar = borderChars[@intFromEnum(BorderCharIndex.horizontal)];
        const vChar = borderChars[@intFromEnum(BorderCharIndex.vertical)];
        const bufWidth = self.width;
        const bufHeight = self.height;
        const bufWidthI32 = @as(i32, @intCast(bufWidth));
        const bufHeightI32 = @as(i32, @intCast(bufHeight));
        var first_visible_column: u32 = 0;
        while (first_visible_column <= columnCount and columnOffsets[first_visible_column] < 0) : (first_visible_column += 1) {}

        // Draw row-by-row: horizontal border line, then vertical borders for the row's content area
        var rowIdx: u32 = 0;
        while (rowIdx <= rowCount) : (rowIdx += 1) {
            const is_outer_row = rowIdx == 0 or rowIdx == rowCount;
            const should_draw_horizontal = if (is_outer_row) drawOuter else drawInner;
            const borderY = rowOffsets[rowIdx];
            if (borderY >= bufHeightI32) break;

            // --- horizontal border line: intersections + fills ---
            if (should_draw_horizontal and borderY >= 0) {
                var colBorderIdx: u32 = first_visible_column;
                while (colBorderIdx <= columnCount) : (colBorderIdx += 1) {
                    const is_outer_col = colBorderIdx == 0 or colBorderIdx == columnCount;
                    const should_draw_vertical = if (is_outer_col) drawOuter else drawInner;
                    if (!should_draw_vertical) continue;

                    const bx = columnOffsets[colBorderIdx];
                    if (bx >= bufWidthI32) break;
                    if (bx < 0) continue;

                    const has_up = rowIdx > 0 and should_draw_vertical;
                    const has_down = rowIdx < rowCount and should_draw_vertical;
                    const has_left = colBorderIdx > 0;
                    const has_right = colBorderIdx < columnCount;
                    const intersection = tableBorderIntersectionByConnections(borderChars, has_up, has_down, has_left, has_right);

                    self.setCellWithAlphaBlending(@intCast(bx), @intCast(borderY), intersection, borderFg, borderBg, 0);
                }

                var colIdx: u32 = first_visible_column -| 1;
                while (colIdx < columnCount) : (colIdx += 1) {
                    const has_boundary_after = if (colIdx < columnCount - 1) drawInner else drawOuter;
                    const boundary_padding: i32 = if (has_boundary_after) 0 else 1;
                    const startX = @as(i64, columnOffsets[colIdx]) + 1;
                    const endX = @as(i64, columnOffsets[colIdx + 1]) + boundary_padding;

                    if (startX >= bufWidthI32) break;
                    if (endX <= 0) continue;

                    const clampedStart = @as(u32, @intCast(@max(@as(i32, 0), startX)));
                    const clampedEnd = @as(u32, @intCast(@min(bufWidthI32, endX)));

                    if (clampedStart < clampedEnd) {
                        const borderYU32 = @as(u32, @intCast(borderY));
                        for (clampedStart..clampedEnd) |x| {
                            self.setCellWithAlphaBlending(@intCast(x), borderYU32, hChar, borderFg, borderBg, 0);
                        }
                    }
                }
            }

            if (rowIdx >= rowCount) break;

            // --- vertical borders for each content line in this row ---
            const has_row_boundary_after = if (rowIdx < rowCount - 1) drawInner else drawOuter;
            const row_boundary_padding: i32 = if (has_row_boundary_after) 0 else 1;
            const contentStartY = @max(0, @as(i64, borderY) + 1);
            const contentEndY = @as(i64, rowOffsets[rowIdx + 1]) + row_boundary_padding;
            var cy = contentStartY;
            while (cy < contentEndY and cy < bufHeightI32) : (cy += 1) {
                var colBorderIdx: u32 = first_visible_column;
                while (colBorderIdx <= columnCount) : (colBorderIdx += 1) {
                    const is_outer_col = colBorderIdx == 0 or colBorderIdx == columnCount;
                    const should_draw_vertical = if (is_outer_col) drawOuter else drawInner;
                    if (!should_draw_vertical) continue;

                    const bx = columnOffsets[colBorderIdx];
                    if (bx >= bufWidthI32) break;
                    if (bx < 0) continue;

                    self.setCellWithAlphaBlending(@intCast(bx), @intCast(cy), vChar, borderFg, borderBg, 0);
                }
            }
        }
    }

    fn tableBorderIntersectionByConnections(borderChars: [*]const u32, hasUp: bool, hasDown: bool, hasLeft: bool, hasRight: bool) u32 {
        if (hasUp and hasDown and hasLeft and hasRight) return borderChars[@intFromEnum(BorderCharIndex.cross)];

        if (!hasUp and hasDown and !hasLeft and hasRight) return borderChars[@intFromEnum(BorderCharIndex.topLeft)];
        if (!hasUp and hasDown and hasLeft and !hasRight) return borderChars[@intFromEnum(BorderCharIndex.topRight)];
        if (hasUp and !hasDown and !hasLeft and hasRight) return borderChars[@intFromEnum(BorderCharIndex.bottomLeft)];
        if (hasUp and !hasDown and hasLeft and !hasRight) return borderChars[@intFromEnum(BorderCharIndex.bottomRight)];

        if (hasUp and hasDown and !hasLeft and hasRight) return borderChars[@intFromEnum(BorderCharIndex.leftT)];
        if (hasUp and hasDown and hasLeft and !hasRight) return borderChars[@intFromEnum(BorderCharIndex.rightT)];
        if (!hasUp and hasDown and hasLeft and hasRight) return borderChars[@intFromEnum(BorderCharIndex.topT)];
        if (hasUp and !hasDown and hasLeft and hasRight) return borderChars[@intFromEnum(BorderCharIndex.bottomT)];

        if ((hasLeft or hasRight) and !hasUp and !hasDown) return borderChars[@intFromEnum(BorderCharIndex.horizontal)];
        if ((hasUp or hasDown) and !hasLeft and !hasRight) return borderChars[@intFromEnum(BorderCharIndex.vertical)];

        return borderChars[@intFromEnum(BorderCharIndex.cross)];
    }

    inline fn isSingleWidthBorderChar(char: u32) bool {
        if (char == 0) return true;
        if ((char >= 32 and char <= 126) or (char >= 0x2500 and char <= 0x257F)) return true;
        if (char > MAX_UNICODE_CODEPOINT) return false;
        return utf8.eastAsianWidth(@intCast(char)) == 1;
    }

    inline fn canUseTransparentBorderFastPath(
        self: *const OptimizedBuffer,
        borderChars: [*]const u32,
        borderColor: RGBA,
        backgroundColor: RGBA,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    ) bool {
        // When border glyphs are width-1, opaque, and tracker-free, drawing them
        // over a transparent background is just a direct char/fg/attrs write
        // while keeping the destination background unchanged.
        return self.getCurrentOpacity() == 1.0 and
            ansi.alpha(borderColor) == 255 and
            ansi.alpha(backgroundColor) == 0 and
            self.isPointInScissor(x, y) and
            self.isPointInScissor(x + @as(i32, @intCast(width)) - 1, y + @as(i32, @intCast(height)) - 1) and
            !self.grapheme_tracker.hasAny() and
            !self.link_tracker.hasAny() and
            isSingleWidthBorderChar(borderChars[@intFromEnum(BorderCharIndex.topLeft)]) and
            isSingleWidthBorderChar(borderChars[@intFromEnum(BorderCharIndex.topRight)]) and
            isSingleWidthBorderChar(borderChars[@intFromEnum(BorderCharIndex.bottomLeft)]) and
            isSingleWidthBorderChar(borderChars[@intFromEnum(BorderCharIndex.bottomRight)]) and
            isSingleWidthBorderChar(borderChars[@intFromEnum(BorderCharIndex.horizontal)]) and
            isSingleWidthBorderChar(borderChars[@intFromEnum(BorderCharIndex.vertical)]) and
            (self.image_placements.items.len == 0 or !self.rectOverlapsImagePlacement(x, y, width, height));
    }

    /// Draw a box with borders and optional fill
    pub inline fn drawBox(
        self: *OptimizedBuffer,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        borderChars: [*]const u32,
        borderSides: BorderSides,
        borderColor: RGBA,
        backgroundColor: RGBA,
        titleColor: RGBA,
        shouldFill: bool,
        title: ?[]const u8,
        titleAlignment: u8, // 0=left, 1=center, 2=right
        bottomTitle: ?[]const u8,
        bottomTitleAlignment: u8, // 0=left, 1=center, 2=right
    ) !void {
        return self.drawBoxInternal(false, x, y, width, height, borderChars, borderSides, borderColor, backgroundColor, titleColor, shouldFill, title, titleAlignment, bottomTitle, bottomTitleAlignment);
    }

    /// Scene titles use the checked text path; any failure invalidates the frame.
    pub fn drawBoxChecked(
        self: *OptimizedBuffer,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        borderChars: [*]const u32,
        borderSides: BorderSides,
        borderColor: RGBA,
        backgroundColor: RGBA,
        titleColor: RGBA,
        shouldFill: bool,
        title: ?[]const u8,
        titleAlignment: u8,
        bottomTitle: ?[]const u8,
        bottomTitleAlignment: u8,
    ) !void {
        return self.drawBoxInternal(true, x, y, width, height, borderChars, borderSides, borderColor, backgroundColor, titleColor, shouldFill, title, titleAlignment, bottomTitle, bottomTitleAlignment);
    }

    inline fn drawBoxInternal(
        self: *OptimizedBuffer,
        comptime checked_titles: bool,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        borderChars: [*]const u32,
        borderSides: BorderSides,
        borderColor: RGBA,
        backgroundColor: RGBA,
        titleColor: RGBA,
        shouldFill: bool,
        title: ?[]const u8,
        titleAlignment: u8,
        bottomTitle: ?[]const u8,
        bottomTitleAlignment: u8,
    ) !void {
        const opacity = self.getCurrentOpacity();

        const border_bg_transparent = isFullyTransparent(opacity, borderColor, backgroundColor);
        const has_title = title != null or bottomTitle != null;
        const title_visible = has_title and !isFullyTransparent(opacity, titleColor, backgroundColor);
        if (border_bg_transparent and !title_visible) {
            if (self.image_placements.items.len == 0) return;
            if (opacity == 0.0) return;
        }
        return self.drawVisibleBox(
            checked_titles,
            x,
            y,
            width,
            height,
            borderChars,
            borderSides,
            borderColor,
            backgroundColor,
            titleColor,
            shouldFill,
            title,
            titleAlignment,
            bottomTitle,
            bottomTitleAlignment,
            border_bg_transparent,
            title_visible,
            opacity,
        );
    }

    fn drawVisibleBox(
        self: *OptimizedBuffer,
        comptime checked_titles: bool,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        borderChars: [*]const u32,
        borderSides: BorderSides,
        borderColor: RGBA,
        backgroundColor: RGBA,
        titleColor: RGBA,
        shouldFill: bool,
        title: ?[]const u8,
        titleAlignment: u8,
        bottomTitle: ?[]const u8,
        bottomTitleAlignment: u8,
        border_bg_transparent: bool,
        title_visible: bool,
        opacity: f32,
    ) !void {
        const startX = @max(0, x);
        const startY = @max(0, y);
        const endX = @min(@as(i32, @intCast(self.width)) - 1, x + @as(i32, @intCast(width)) - 1);
        const endY = @min(@as(i32, @intCast(self.height)) - 1, y + @as(i32, @intCast(height)) - 1);

        if (startX > endX or startY > endY) return;

        const boxWidth = @as(u32, @intCast(endX - startX + 1));
        const boxHeight = @as(u32, @intCast(endY - startY + 1));
        if (!self.isRectInScissor(startX, startY, boxWidth, boxHeight)) return;
        if (border_bg_transparent and !title_visible and !self.rectOverlapsImagePlacement(startX, startY, boxWidth, boxHeight)) return;

        const isAtActualLeft = startX == x;
        const isAtActualRight = endX == x + @as(i32, @intCast(width)) - 1;
        const isAtActualTop = startY == y;
        const isAtActualBottom = endY == y + @as(i32, @intCast(height)) - 1;

        const titleLayout = self.computeBoxTitleLayout(title, borderSides.top, isAtActualTop, startX, endX, width, titleAlignment);
        const bottomTitleLayout = self.computeBoxTitleLayout(bottomTitle, borderSides.bottom, isAtActualBottom, startX, endX, width, bottomTitleAlignment);

        if (shouldFill) {
            if (!borderSides.top and !borderSides.right and !borderSides.bottom and !borderSides.left) {
                const fillWidth = @as(u32, @intCast(endX - startX + 1));
                const fillHeight = @as(u32, @intCast(endY - startY + 1));
                self.fillRect(@intCast(startX), @intCast(startY), fillWidth, fillHeight, backgroundColor);
            } else {
                const innerStartX = startX + if (borderSides.left and isAtActualLeft) @as(i32, 1) else @as(i32, 0);
                const innerStartY = startY + if (borderSides.top and isAtActualTop) @as(i32, 1) else @as(i32, 0);
                const innerEndX = endX - if (borderSides.right and isAtActualRight) @as(i32, 1) else @as(i32, 0);
                const innerEndY = endY - if (borderSides.bottom and isAtActualBottom) @as(i32, 1) else @as(i32, 0);

                if (innerEndX >= innerStartX and innerEndY >= innerStartY) {
                    const fillWidth = @as(u32, @intCast(innerEndX - innerStartX + 1));
                    const fillHeight = @as(u32, @intCast(innerEndY - innerStartY + 1));
                    self.fillRect(@intCast(innerStartX), @intCast(innerStartY), fillWidth, fillHeight, backgroundColor);
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
        const useTransparentBorderFastPath = canUseTransparentBorderFastPath(self, borderChars, borderColor, backgroundColor, startX, startY, boxWidth, boxHeight);
        const useOpaqueBorderFastPath = isFullyOpaque(opacity, borderColor, backgroundColor);
        const image_aware = self.image_placements.items.len != 0;

        // Draw horizontal borders
        if (borderSides.top or borderSides.bottom) {
            // Draw top border
            if (borderSides.top and isAtActualTop) {
                var drawX = startX;
                while (drawX <= endX) : (drawX += 1) {
                    if (startY >= 0 and startY < @as(i32, @intCast(self.height))) {
                        if (titleLayout.shouldDraw and drawX >= titleLayout.startX and drawX <= titleLayout.endX) {
                            continue;
                        }

                        var char = borderChars[@intFromEnum(BorderCharIndex.horizontal)];

                        // Handle corners
                        if (drawX == startX and isAtActualLeft) {
                            char = if (borderSides.left) borderChars[@intFromEnum(BorderCharIndex.topLeft)] else borderChars[@intFromEnum(BorderCharIndex.horizontal)];
                        } else if (drawX == endX and isAtActualRight) {
                            char = if (borderSides.right) borderChars[@intFromEnum(BorderCharIndex.topRight)] else borderChars[@intFromEnum(BorderCharIndex.horizontal)];
                        }

                        if (useTransparentBorderFastPath) {
                            const index = self.coordsToIndex(@intCast(drawX), @intCast(startY));
                            self.buffer.char[index] = char;
                            self.buffer.fg[index] = borderColor;
                            self.buffer.attributes[index] = 0;
                        } else if (useOpaqueBorderFastPath) {
                            self.set(@intCast(drawX), @intCast(startY), makeCell(char, borderColor, backgroundColor, 0));
                        } else {
                            const cell = makeCell(char, borderColor, backgroundColor, 0);
                            if (image_aware)
                                self.setCellWithAlphaBlendingCell(@intCast(drawX), @intCast(startY), cell)
                            else
                                self.setCellWithAlphaBlendingCellWithoutImages(@intCast(drawX), @intCast(startY), cell);
                        }
                    }
                }
            }

            // Draw bottom border
            if (borderSides.bottom and isAtActualBottom) {
                var drawX = startX;
                while (drawX <= endX) : (drawX += 1) {
                    if (endY >= 0 and endY < @as(i32, @intCast(self.height))) {
                        if (bottomTitleLayout.shouldDraw and drawX >= bottomTitleLayout.startX and drawX <= bottomTitleLayout.endX) {
                            continue;
                        }

                        var char = borderChars[@intFromEnum(BorderCharIndex.horizontal)];

                        // Handle corners
                        if (drawX == startX and isAtActualLeft) {
                            char = if (borderSides.left) borderChars[@intFromEnum(BorderCharIndex.bottomLeft)] else borderChars[@intFromEnum(BorderCharIndex.horizontal)];
                        } else if (drawX == endX and isAtActualRight) {
                            char = if (borderSides.right) borderChars[@intFromEnum(BorderCharIndex.bottomRight)] else borderChars[@intFromEnum(BorderCharIndex.horizontal)];
                        }

                        if (useTransparentBorderFastPath) {
                            const index = self.coordsToIndex(@intCast(drawX), @intCast(endY));
                            self.buffer.char[index] = char;
                            self.buffer.fg[index] = borderColor;
                            self.buffer.attributes[index] = 0;
                        } else if (useOpaqueBorderFastPath) {
                            self.set(@intCast(drawX), @intCast(endY), makeCell(char, borderColor, backgroundColor, 0));
                        } else {
                            const cell = makeCell(char, borderColor, backgroundColor, 0);
                            if (image_aware)
                                self.setCellWithAlphaBlendingCell(@intCast(drawX), @intCast(endY), cell)
                            else
                                self.setCellWithAlphaBlendingCellWithoutImages(@intCast(drawX), @intCast(endY), cell);
                        }
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
                    if (useTransparentBorderFastPath) {
                        const index = self.coordsToIndex(@intCast(startX), @intCast(drawY));
                        self.buffer.char[index] = borderChars[@intFromEnum(BorderCharIndex.vertical)];
                        self.buffer.fg[index] = borderColor;
                        self.buffer.attributes[index] = 0;
                    } else if (useOpaqueBorderFastPath) {
                        self.set(
                            @intCast(startX),
                            @intCast(drawY),
                            makeCell(borderChars[@intFromEnum(BorderCharIndex.vertical)], borderColor, backgroundColor, 0),
                        );
                    } else {
                        const cell = makeCell(borderChars[@intFromEnum(BorderCharIndex.vertical)], borderColor, backgroundColor, 0);
                        if (image_aware)
                            self.setCellWithAlphaBlendingCell(@intCast(startX), @intCast(drawY), cell)
                        else
                            self.setCellWithAlphaBlendingCellWithoutImages(@intCast(startX), @intCast(drawY), cell);
                    }
                }

                // Right border
                if (borderSides.right and isAtActualRight and endX >= 0 and endX < @as(i32, @intCast(self.width))) {
                    if (useTransparentBorderFastPath) {
                        const index = self.coordsToIndex(@intCast(endX), @intCast(drawY));
                        self.buffer.char[index] = borderChars[@intFromEnum(BorderCharIndex.vertical)];
                        self.buffer.fg[index] = borderColor;
                        self.buffer.attributes[index] = 0;
                    } else if (useOpaqueBorderFastPath) {
                        self.set(
                            @intCast(endX),
                            @intCast(drawY),
                            makeCell(borderChars[@intFromEnum(BorderCharIndex.vertical)], borderColor, backgroundColor, 0),
                        );
                    } else {
                        const cell = makeCell(borderChars[@intFromEnum(BorderCharIndex.vertical)], borderColor, backgroundColor, 0);
                        if (image_aware)
                            self.setCellWithAlphaBlendingCell(@intCast(endX), @intCast(drawY), cell)
                        else
                            self.setCellWithAlphaBlendingCellWithoutImages(@intCast(endX), @intCast(drawY), cell);
                    }
                }
            }
        }

        if (titleLayout.shouldDraw) {
            if (title) |titleText| {
                if (checked_titles) {
                    try self.drawTextChecked(titleText, @intCast(titleLayout.x), @intCast(startY), titleColor, backgroundColor, 0);
                } else {
                    try self.drawText(titleText, @intCast(titleLayout.x), @intCast(startY), titleColor, backgroundColor, 0);
                }
            }
        }

        if (bottomTitleLayout.shouldDraw) {
            if (bottomTitle) |titleText| {
                if (checked_titles) {
                    try self.drawTextChecked(titleText, @intCast(bottomTitleLayout.x), @intCast(endY), titleColor, backgroundColor, 0);
                } else {
                    try self.drawText(titleText, @intCast(bottomTitleLayout.x), @intCast(endY), titleColor, backgroundColor, 0);
                }
            }
        }
    }

    fn computeBoxTitleLayout(
        self: *OptimizedBuffer,
        titleText: ?[]const u8,
        borderSide: bool,
        isAtActualSide: bool,
        startX: i32,
        endX: i32,
        width: u32,
        alignment: u8,
    ) BoxTitleLayout {
        const text = titleText orelse return .{ .x = startX };

        if (text.len == 0 or !borderSide or !isAtActualSide) {
            return .{ .x = startX };
        }

        const is_ascii = utf8.isAsciiOnly(text);
        const titleLength = @as(i32, @intCast(utf8.calculateTextWidth(text, 2, is_ascii, self.width_method)));
        const minTitleSpace = 4;

        if (@as(i32, @intCast(width)) < titleLength + minTitleSpace) {
            return .{ .x = startX };
        }

        const padding = 2;
        var titleX = startX + padding;

        if (alignment == 1) {
            titleX = startX + @max(padding, @divFloor(@as(i32, @intCast(width)) - titleLength, 2));
        } else if (alignment == 2) {
            titleX = startX + @as(i32, @intCast(width)) - padding - titleLength;
        }

        titleX = @max(startX + padding, @min(titleX, endX - titleLength));

        return .{
            .shouldDraw = true,
            .x = titleX,
            .startX = titleX,
            .endX = titleX + titleLength - 1,
        };
    }

    pub fn drawImage(
        self: *OptimizedBuffer,
        image: *const native_image.Image,
        image_handle: u32,
        pos_x: i32,
        pos_y: i32,
        width: u32,
        height: u32,
        pixel_width: u32,
        pixel_height: u32,
        source_x: u32,
        source_y: u32,
        source_width: u32,
        source_height: u32,
        protocol: native_image.RenderProtocol,
    ) !bool {
        const opacity = opacityToU8(self.getCurrentOpacity());
        if (opacity == 0) return false;
        if (image.ref_count == math.maxInt(u32) or self.image_placements.items.len >= gp.IMAGE_ID_MASK) return error.ObjectLimit;
        if (width == 0 or height == 0 or source_width == 0 or source_height == 0 or
            source_x >= image.width() or source_y >= image.height() or source_width > image.width() - source_x or
            source_height > image.height() - source_y or
            self.width > std.math.maxInt(i32) or self.height > std.math.maxInt(i32)) return false;
        var clip_x0 = @max(@as(i64, pos_x), 0);
        var clip_y0 = @max(@as(i64, pos_y), 0);
        var clip_x1 = @min(@as(i64, pos_x) + width, self.width);
        var clip_y1 = @min(@as(i64, pos_y) + height, self.height);
        if (self.getCurrentScissorRect()) |scissor| {
            clip_x0 = @max(clip_x0, scissor.x);
            clip_y0 = @max(clip_y0, scissor.y);
            clip_x1 = @min(clip_x1, @as(i64, scissor.x) + scissor.width);
            clip_y1 = @min(clip_y1, @as(i64, scissor.y) + scissor.height);
        }
        if (clip_x0 >= clip_x1 or clip_y0 >= clip_y1) return false;

        const left: u32 = @intCast(clip_x0 - @as(i64, pos_x));
        const top: u32 = @intCast(clip_y0 - @as(i64, pos_y));
        const right: u32 = @intCast(clip_x1 - @as(i64, pos_x));
        const bottom: u32 = @intCast(clip_y1 - @as(i64, pos_y));
        const clipped_source_x = source_x + @as(u32, @intCast((@as(u64, left) * source_width) / width));
        const clipped_source_y = source_y + @as(u32, @intCast((@as(u64, top) * source_height) / height));
        const source_end_x = source_x + @as(u32, @intCast((@as(u64, right) * source_width + width - 1) / width));
        const source_end_y = source_y + @as(u32, @intCast((@as(u64, bottom) * source_height + height - 1) / height));
        const clipped_width: u32 = @intCast(clip_x1 - clip_x0);
        const clipped_height: u32 = @intCast(clip_y1 - clip_y0);
        const clipped_pixel_width = if (pixel_width == 0) 0 else @as(u32, @intCast((@as(u64, clipped_width) * pixel_width + width - 1) / width));
        const clipped_pixel_height = if (pixel_height == 0) 0 else @as(u32, @intCast((@as(u64, clipped_height) * pixel_height + height - 1) / height));
        const placement_id: u32 = @intCast(self.image_placements.items.len + 1);
        try self.image_placements.append(self.storage.resourceAllocator(), .{
            .placement_id = placement_id,
            .image_handle = image_handle,
            .image = @constCast(image),
            .x = @intCast(clip_x0),
            .y = @intCast(clip_y0),
            .width = clipped_width,
            .height = clipped_height,
            .pixel_width = clipped_pixel_width,
            .pixel_height = clipped_pixel_height,
            .source_x = clipped_source_x,
            .source_y = clipped_source_y,
            .source_width = source_end_x - clipped_source_x,
            .source_height = source_end_y - clipped_source_y,
            .opacity = opacity,
            .protocol = protocol,
        });
        @constCast(image).retain();

        var cell_y: u32 = 0;
        while (cell_y < clipped_height) : (cell_y += 1) {
            const dest_y: u32 = @intCast(clip_y0 + cell_y);
            var cell_x: u32 = 0;
            while (cell_x < clipped_width) : (cell_x += 1) {
                const dest_x: u32 = @intCast(clip_x0 + cell_x);
                const current = self.get(dest_x, dest_y) orelse continue;
                self.set(dest_x, dest_y, makeCell(gp.packImageCell(placement_id, 0), current.fg, current.bg, current.attributes));
            }
        }
        return true;
    }

    pub fn materializeImageFallback(self: *OptimizedBuffer, placement_id: u32) !void {
        if (placement_id == 0 or placement_id > self.image_placements.items.len) return;
        const placement = self.image_placements.items[placement_id - 1];
        const image_pixels = try placement.image.ensurePixels();
        var cell_y: u32 = 0;
        while (cell_y < placement.height) : (cell_y += 1) {
            const dest_y: u32 = @intCast(placement.y + @as(i32, @intCast(cell_y)));
            var cell_x: u32 = 0;
            while (cell_x < placement.width) : (cell_x += 1) {
                const dest_x: u32 = @intCast(placement.x + @as(i32, @intCast(cell_x)));
                const current = self.get(dest_x, dest_y) orelse continue;
                if (!gp.isImageChar(current.char)) continue;
                const current_placement_id = gp.imageIdFromChar(current.char);
                if (current_placement_id < placement_id) continue;

                var pixels: [4]RGBA = undefined;
                inline for (0..4) |quadrant| {
                    const sample_x = cell_x * 2 + @as(u32, @intCast(quadrant & 1));
                    const sample_y = cell_y * 2 + @as(u32, @intCast(quadrant >> 1));
                    const sx = placement.source_x + @min(placement.source_width - 1, @as(u32, @intCast((@as(u64, sample_x) * placement.source_width) / (@as(u64, placement.width) * 2))));
                    const sy = placement.source_y + @min(placement.source_height - 1, @as(u32, @intCast((@as(u64, sample_y) * placement.source_height) / (@as(u64, placement.height) * 2))));
                    const offset = (@as(usize, sy) * placement.image.width() + sx) * 4;
                    pixels[quadrant] = ansi.rgbColor(
                        image_pixels[offset],
                        image_pixels[offset + 1],
                        image_pixels[offset + 2],
                        image_pixels[offset + 3],
                    );
                }
                const rendered = renderQuadrantBlock(pixels);
                const fallback = makeCell(
                    if (current_placement_id == placement_id)
                        gp.packImageCell(placement_id, quadrantIndex(rendered.char))
                    else
                        current.char,
                    rendered.fg,
                    rendered.bg,
                    if (current_placement_id == placement_id) 0 else current.attributes,
                );
                if (placement.opacity == 255 and !isRGBAWithAlpha(fallback.fg) and !isRGBAWithAlpha(fallback.bg)) {
                    self.setRaw(dest_x, dest_y, fallback);
                } else {
                    const effective = makeCell(
                        fallback.char,
                        applyOpacity(fallback.fg, placement.opacity),
                        applyOpacity(fallback.bg, placement.opacity),
                        fallback.attributes,
                    );
                    self.setRaw(dest_x, dest_y, self.blendCells(effective, current));
                }
            }
        }
    }

    pub fn materializeImageFallbacks(self: *OptimizedBuffer) !void {
        if (self.image_placements.items.len == 0) return;
        for (1..self.image_placements.items.len + 1) |placement_id| {
            try self.materializeImageFallback(@intCast(placement_id));
        }
        for (self.buffer.char) |*char| {
            if (gp.isImageChar(char.*)) char.* = quadrantChars[gp.imageFallbackFromChar(char.*)];
        }
        self.clearImagePlacements();
    }

    pub fn checkImageResources(self: *const OptimizedBuffer) error{UnsupportedResource}!void {
        for (self.image_placements.items) |placement| {
            if (self.owner_context_id == 0 or placement.image.owner_context_id != self.owner_context_id) return error.UnsupportedResource;
        }
    }

    fn checkPixelDraw(self: *const OptimizedBuffer) !void {
        try self.checkImageResources();
        if (self.width > math.maxInt(i32) or self.height > math.maxInt(i32)) return error.InvalidDimensions;
        if (self.getCurrentScissorRect()) |clip| {
            if (clip.width > math.maxInt(i32) or clip.height > math.maxInt(i32) or
                @as(i64, clip.x) + clip.width > math.maxInt(i32) or
                @as(i64, clip.y) + clip.height > math.maxInt(i32)) return error.InvalidOptions;
        }
        const opacity = self.getCurrentOpacity();
        if (!math.isFinite(opacity) or opacity < 0 or opacity > 1) return error.InvalidOptions;
    }

    pub fn drawSuperSampleBufferChecked(self: *OptimizedBuffer, x: u32, y: u32, pixels: []const u8, format: u8, stride: u32) !void {
        try self.checkPixelDraw();
        try self.drawSuperSampleBufferInternal(x, y, pixels, format, stride);
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
    ) void {
        self.drawSuperSampleBufferInternal(posX, posY, pixelData[0..len], format, alignedBytesPerRow) catch {};
    }

    fn drawSuperSampleBufferInternal(self: *OptimizedBuffer, posX: u32, posY: u32, pixels: []const u8, format: u8, alignedBytesPerRow: u32) !void {
        if (format > 1 or alignedBytesPerRow == 0 or alignedBytesPerRow % 4 != 0) return error.InvalidOptions;
        if (pixels.len % alignedBytesPerRow != 0) return error.InvalidOptions;
        if (posX >= self.width or posY >= self.height) return;
        const bytesPerPixel = 4;
        const isBGRA = (format == 0);
        const sourceWidth = alignedBytesPerRow / bytesPerPixel;
        const width: u32 = @intCast(@min(self.width - posX, (sourceWidth + 1) / 2));
        const height: u32 = @intCast(@min(self.height - posY, (pixels.len / alignedBytesPerRow + 1) / 2));

        var y_cell = posY;
        while (y_cell < posY + height) : (y_cell += 1) {
            var x_cell = posX;
            while (x_cell < posX + width) : (x_cell += 1) {
                if (!self.isPointInScissor(@intCast(x_cell), @intCast(y_cell))) {
                    continue;
                }

                const renderX: usize = @as(usize, x_cell - posX) * 2;
                const renderY: usize = @as(usize, y_cell - posY) * 2;

                const tlIndex: usize = @intCast(renderY * alignedBytesPerRow + renderX * bytesPerPixel);
                const trIndex: usize = tlIndex + bytesPerPixel;
                const blIndex: usize = @intCast((renderY + 1) * alignedBytesPerRow + renderX * bytesPerPixel);
                const brIndex: usize = blIndex + bytesPerPixel;

                const missing = ansi.rgbColor(255, 0, 255, 0);
                const pixelsRgba = [4]RGBA{
                    getPixelColor(tlIndex, pixels.ptr, pixels.len, isBGRA),
                    if (renderX + 1 < sourceWidth) getPixelColor(trIndex, pixels.ptr, pixels.len, isBGRA) else missing,
                    getPixelColor(blIndex, pixels.ptr, pixels.len, isBGRA),
                    if (renderX + 1 < sourceWidth) getPixelColor(brIndex, pixels.ptr, pixels.len, isBGRA) else missing,
                };

                const cellResult = renderQuadrantBlock(pixelsRgba);

                self.setCellWithAlphaBlending(
                    x_cell,
                    y_cell,
                    cellResult.char,
                    cellResult.fg,
                    cellResult.bg,
                    0,
                );
            }
        }
    }

    /// Validates visible cells before writing. The borrowed input may be unaligned.
    pub fn drawPackedBufferChecked(self: *OptimizedBuffer, data: []const u8, x: u32, y: u32, width: u32, height: u32) !void {
        try self.checkPixelDraw();
        try self.drawPackedBufferInternal(true, data, x, y, width, height);
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
        self.drawPackedBufferInternal(false, data[0..dataLen], posX, posY, terminalWidthCells, terminalHeightCells) catch {};
    }

    fn drawPackedBufferInternal(self: *OptimizedBuffer, comptime checked: bool, data: []const u8, posX: u32, posY: u32, terminalWidthCells: u32, terminalHeightCells: u32) !void {
        const cellResultSize = 48;
        const required = math.mul(u64, @as(u64, terminalWidthCells) * terminalHeightCells, cellResultSize) catch return error.InvalidDimensions;
        if (data.len < required or data.len % cellResultSize != 0) return error.InvalidOptions;
        if (posX >= self.width or posY >= self.height) return;
        const width = @min(terminalWidthCells, self.width - posX);
        const height = @min(terminalHeightCells, self.height - posY);
        inline for (0..(if (checked) 2 else 1)) |pass| {
            for (0..height) |y| {
                for (0..width) |x| {
                    const cellX = posX + @as(u32, @intCast(x));
                    const cellY = posY + @as(u32, @intCast(y));
                    if (!self.isPointInScissor(@intCast(cellX), @intCast(cellY))) continue;
                    const offset = (y * terminalWidthCells + x) * cellResultSize;
                    const colors = @as(*align(1) const [8]f32, @ptrCast(data.ptr + offset));
                    if (checked and pass == 0) {
                        for (colors) |channel| if (!math.isFinite(channel)) return error.InvalidOptions;
                        continue;
                    }
                    const bg = ansi.rgbaFromFloats(colors[0], colors[1], colors[2], colors[3]);
                    const fg = ansi.rgbaFromFloats(colors[4], colors[5], colors[6], colors[7]);
                    var char = @as(*align(1) const u32, @ptrCast(data.ptr + offset + 32)).*;
                    if (char == 0 or char > MAX_UNICODE_CODEPOINT or (char >= 0xd800 and char <= 0xdfff)) {
                        char = DEFAULT_SPACE_CHAR;
                    } else if (char < 32 or (char > 126 and char < 0x2580) or !isSingleWidthBorderChar(char)) {
                        char = BLOCK_CHAR;
                    }
                    self.setCellWithAlphaBlending(cellX, cellY, char, fg, bg, 0);
                }
            }
        }
    }

    fn getGrayscaleChar(intensity: f32) u32 {
        if (intensity < 0.01) return ' ';
        const clamped = @min(@max(intensity, 0.0), 1.0);
        const index: usize = @intFromFloat(clamped * @as(f32, @floatFromInt(GRAYSCALE_CHARS.len - 1)));
        return GRAYSCALE_CHARS[index];
    }

    pub fn drawGrayscaleBuffer(
        self: *OptimizedBuffer,
        posX: i32,
        posY: i32,
        intensities: [*]const f32,
        srcWidth: u32,
        srcHeight: u32,
        fgColor: ?RGBA,
        bgColor: ?RGBA,
    ) void {
        self.drawGrayscaleBufferInternal(false, false, posX, posY, intensities, srcWidth, srcHeight, fgColor, bgColor) catch {};
    }

    pub fn drawGrayscaleBufferSupersampled(
        self: *OptimizedBuffer,
        posX: i32,
        posY: i32,
        intensities: [*]const f32,
        srcWidth: u32,
        srcHeight: u32,
        fgColor: ?RGBA,
        bgColor: ?RGBA,
    ) void {
        self.drawGrayscaleBufferInternal(false, true, posX, posY, intensities, srcWidth, srcHeight, fgColor, bgColor) catch {};
    }

    /// Only visible samples are inspected; invalid input rejects before any writes.
    pub fn drawGrayscaleBufferChecked(self: *OptimizedBuffer, posX: i32, posY: i32, intensities: []align(1) const f32, srcWidth: u32, srcHeight: u32, fgColor: ?RGBA, bgColor: ?RGBA, supersampled: bool) !void {
        try self.checkPixelDraw();
        const count = math.mul(u32, srcWidth, srcHeight) catch return error.InvalidDimensions;
        if (intensities.len < count) return error.InvalidOptions;
        if (fgColor) |fg| try validateColor(fg);
        if (bgColor) |bg| try validateColor(bg);
        try self.drawGrayscaleBufferInternal(true, supersampled, posX, posY, intensities.ptr, srcWidth, srcHeight, fgColor, bgColor);
    }

    fn drawGrayscaleBufferInternal(self: *OptimizedBuffer, comptime checked: bool, supersampled: bool, posX: i32, posY: i32, intensities: [*]align(1) const f32, srcWidth: u32, srcHeight: u32, fgColor: ?RGBA, bgColor: ?RGBA) !void {
        _ = math.mul(u32, srcWidth, srcHeight) catch return error.InvalidDimensions;
        const bg = bgColor orelse ansi.rgbColor(0, 0, 0, 0);
        const scale: u32 = if (supersampled) 2 else 1;
        const termWidth = srcWidth / scale;
        const termHeight = srcHeight / scale;

        if (termWidth == 0 or termHeight == 0) return;
        if (posX >= @as(i32, @intCast(self.width)) or posY >= @as(i32, @intCast(self.height))) return;

        const startX: u32 = if (posX < 0) @intCast(-@as(i64, posX)) else 0;
        const startY: u32 = if (posY < 0) @intCast(-@as(i64, posY)) else 0;

        const destStartX: u32 = if (posX < 0) 0 else @intCast(posX);
        const destStartY: u32 = if (posY < 0) 0 else @intCast(posY);

        if (startX >= termWidth or startY >= termHeight) return;

        const visibleWidth = @min(termWidth - startX, self.width - destStartX);
        const visibleHeight = @min(termHeight - startY, self.height - destStartY);

        if (visibleWidth == 0 or visibleHeight == 0) return;

        const baseFg = fgColor orelse ansi.rgbColor(255, 255, 255, 255);

        const graphemeAware = self.grapheme_tracker.hasAny();
        const linkAware = self.link_tracker.hasAny();
        const imageAware = self.image_placements.items.len != 0;
        inline for (0..(if (checked) 2 else 1)) |pass| {
            for (0..visibleHeight) |y| {
                for (0..visibleWidth) |x| {
                    const destX = destStartX + @as(u32, @intCast(x));
                    const destY = destStartY + @as(u32, @intCast(y));
                    if (!self.isPointInScissor(@intCast(destX), @intCast(destY))) continue;
                    const index = ((startY + y) * srcWidth + startX + x) * scale;
                    const samples = if (supersampled)
                        [4]f32{ intensities[index], intensities[index + 1], intensities[index + srcWidth], intensities[index + srcWidth + 1] }
                    else
                        @as([4]f32, @splat(intensities[index]));
                    var finite = true;
                    for (samples) |value| finite = finite and math.isFinite(value);
                    if (!finite) {
                        if (checked) return error.InvalidOptions;
                        continue;
                    }
                    if (checked and pass == 0) continue;
                    var intensity = samples[0];
                    if (supersampled) {
                        intensity = (samples[0] + samples[1] + samples[2] + samples[3]) / 4;
                        if (!math.isFinite(intensity)) intensity = samples[0] / 4 + samples[1] / 4 + samples[2] / 4 + samples[3] / 4;
                    }
                    if (intensity < 0.01) continue;
                    const char = getGrayscaleChar(intensity);
                    const gray = math.clamp(intensity, 0.0, 1.0);
                    const fg = applyOpacity(baseFg, opacityToU8(gray));
                    if (graphemeAware or linkAware) {
                        self.setCellWithAlphaBlendingCell(destX, destY, makeCell(char, fg, bg, 0));
                    } else if (imageAware) {
                        self.setCellWithAlphaBlendingRawImageAware(destX, destY, makeCell(char, fg, bg, 0));
                    } else {
                        self.setCellWithAlphaBlendingRawCell(destX, destY, makeCell(char, fg, bg, 0));
                    }
                }
            }
        }
    }
};

fn getPixelColor(idx: usize, data: [*]const u8, dataLen: usize, bgra: bool) RGBA {
    if (idx + 3 >= dataLen) {
        return ansi.rgbColor(255, 0, 255, 0); // Return Transparent Magenta for out-of-bounds
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

    return ansi.rgbColor(rByte, gByte, bByte, aByte);
}

pub const quadrantChars = [_]u32{
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

fn quadrantIndex(char: u32) u4 {
    for (quadrantChars, 0..) |candidate, index| {
        if (candidate == char) return @intCast(index);
    }
    return 15;
}

fn colorDistance(a: RGBA, b: RGBA) f32 {
    const dr = @as(f32, @floatFromInt(ansi.red(a))) - @as(f32, @floatFromInt(ansi.red(b)));
    const dg = @as(f32, @floatFromInt(ansi.green(a))) - @as(f32, @floatFromInt(ansi.green(b)));
    const db = @as(f32, @floatFromInt(ansi.blue(a))) - @as(f32, @floatFromInt(ansi.blue(b)));
    return dr * dr + dg * dg + db * db;
}

fn closestColorIndex(pixel: RGBA, candidates: [2]RGBA) u1 {
    return if (colorDistance(pixel, candidates[0]) <= colorDistance(pixel, candidates[1])) 0 else 1;
}

fn averageColorRgba(pixels: []const RGBA) RGBA {
    if (pixels.len == 0) return ansi.rgbColor(0, 0, 0, 0);

    var sumR: u32 = 0;
    var sumG: u32 = 0;
    var sumB: u32 = 0;
    var sumA: u32 = 0;

    for (pixels) |p| {
        sumR += ansi.red(p);
        sumG += ansi.green(p);
        sumB += ansi.blue(p);
        sumA += ansi.alpha(p);
    }

    const len: u32 = @intCast(pixels.len);
    return ansi.rgbColor(
        @intCast((sumR + len / 2) / len),
        @intCast((sumG + len / 2) / len),
        @intCast((sumB + len / 2) / len),
        @intCast((sumA + len / 2) / len),
    );
}

fn luminance(color: RGBA) f32 {
    return 0.2126 * ansi.redF(color) + 0.7152 * ansi.greenF(color) + 0.0722 * ansi.blueF(color);
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
        return .{
            .char = 32,
            .fg = chosen_dark_color,
            .bg = averageColorRgba(pixels[0..4]),
        };
    } else if (quadrantBits == 15) { // All dark
        return .{
            .char = quadrantChars[15],
            .fg = averageColorRgba(pixels[0..4]),
            .bg = chosen_light_color,
        };
    } else { // Mixed pattern
        return .{
            .char = quadrantChars[quadrantBits],
            .fg = chosen_dark_color,
            .bg = chosen_light_color,
        };
    }
}
