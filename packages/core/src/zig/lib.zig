const std = @import("std");
const build_options = @import("build_options");
const Allocator = std.mem.Allocator;

const ansi = @import("ansi.zig");
const buffer = @import("buffer.zig");
const renderer = @import("renderer.zig");
const gp = @import("grapheme.zig");
const link = @import("link.zig");
const text_buffer = @import("text-buffer.zig");
const text_buffer_view = @import("text-buffer-view.zig");
const text_buffer_iterators = @import("text-buffer-iterators.zig");
const edit_buffer_mod = @import("edit-buffer.zig");
const editor_view = @import("editor-view.zig");
const syntax_style = @import("syntax-style.zig");
const terminal = @import("terminal.zig");
const utf8 = @import("utf8.zig");
const logger = @import("logger.zig");
const event_bus = @import("event-bus.zig");
const native_span_feed = @import("native-span-feed.zig");
const buffer_effects = @import("buffer-methods.zig");

pub const OptimizedBuffer = buffer.OptimizedBuffer;
pub const CliRenderer = renderer.CliRenderer;
pub const Terminal = terminal.Terminal;
pub const RGBA = buffer.RGBA;

fn ptrToRGBA(color: [*]const u16) RGBA {
    return .{ color[0], color[1], color[2], color[3] };
}

fn optionalPtrToRGBA(color: ?[*]const u16) ?RGBA {
    if (color) |packed_color| {
        return ptrToRGBA(packed_color);
    }

    return null;
}

inline fn selectionStyle(bg: ?RGBA, fg: ?RGBA) text_buffer_view.SelectionStyle {
    return .{
        .bgColor = bg,
        .fgColor = fg,
    };
}

comptime {
    _ = native_span_feed;
}

export fn setLogCallback(callback: ?*const fn (level: u8, msgPtr: [*]const u8, msgLen: usize) callconv(.c) void) void {
    logger.setLogCallback(callback);
}

export fn setEventCallback(callback: ?*const fn (namePtr: [*]const u8, nameLen: usize, dataPtr: [*]const u8, dataLen: usize) callconv(.c) void) void {
    event_bus.setEventCallback(callback);
}

var gpa: std.heap.GeneralPurposeAllocator(.{
    .enable_memory_limit = build_options.gpa_safe_stats,
    .safety = build_options.gpa_safe_stats,
}) = .{};
const globalAllocator = gpa.allocator();
var arena = std.heap.ArenaAllocator.init(globalAllocator);
const globalArena = arena.allocator();

pub const ExternalBuildOptions = extern struct {
    gpa_safe_stats: bool,
    gpa_memory_limit_tracking: bool,
};

pub const ExternalAllocatorStats = extern struct {
    total_requested_bytes: u64,
    active_allocations: u64,
    small_allocations: u64,
    large_allocations: u64,
    requested_bytes_valid: bool,
};

fn toNonNegativeU64(value: anytype) u64 {
    const ValueType = @TypeOf(value);

    return switch (@typeInfo(ValueType)) {
        .int => |int_info| if (int_info.signedness == .signed) blk: {
            const signed_value: i64 = @intCast(value);
            if (signed_value <= 0) break :blk 0;
            break :blk @intCast(signed_value);
        } else @intCast(value),
        .comptime_int => blk: {
            if (value <= 0) break :blk 0;
            break :blk @intCast(value);
        },
        else => 0,
    };
}

const RequestedBytesInfo = struct {
    bytes: u64,
    valid: bool,
};

fn sanitizeRequestedBytes(value: u64) RequestedBytesInfo {
    const signed_value: i64 = @bitCast(value);
    if (signed_value < 0) {
        return .{ .bytes = 0, .valid = false };
    }

    return .{ .bytes = @intCast(signed_value), .valid = true };
}

fn queryStatsField(comptime field_names: []const []const u8) ?u64 {
    if (!@hasDecl(@TypeOf(gpa), "queryStats")) {
        return null;
    }

    const stats = gpa.queryStats();
    const StatsType = @TypeOf(stats);

    inline for (field_names) |field_name| {
        if (@hasField(StatsType, field_name)) {
            return toNonNegativeU64(@field(stats, field_name));
        }
    }

    return null;
}

fn getTotalRequestedBytesInfo() RequestedBytesInfo {
    if (!build_options.gpa_safe_stats) {
        return .{ .bytes = 0, .valid = false };
    }

    if (queryStatsField(&.{"total_requested_bytes"})) |value| {
        return sanitizeRequestedBytes(value);
    }

    if (@hasField(@TypeOf(gpa), "total_requested_bytes")) {
        if (@TypeOf(gpa.total_requested_bytes) == void) {
            return .{ .bytes = 0, .valid = false };
        }

        return sanitizeRequestedBytes(toNonNegativeU64(gpa.total_requested_bytes));
    }

    return .{ .bytes = 0, .valid = false };
}

fn getSmallAllocationCount() u64 {
    if (queryStatsField(&.{ "small_allocations", "small_allocation_count" })) |value| {
        return value;
    }

    var total: u64 = 0;
    for (gpa.buckets) |bucket_head| {
        var current = bucket_head;
        while (current) |bucket| {
            const allocated: u64 = @intCast(bucket.allocated_count);
            const freed: u64 = @intCast(bucket.freed_count);
            if (allocated >= freed) {
                total += allocated - freed;
            }
            current = bucket.next;
        }
    }

    return total;
}

fn getLargeAllocationCount() u64 {
    if (queryStatsField(&.{ "large_allocations", "large_allocation_count" })) |value| {
        return value;
    }

    return @intCast(gpa.large_allocations.count());
}

export fn createNativeSpanFeed(options_ptr: ?*const native_span_feed.Options) ?*native_span_feed.Stream {
    return native_span_feed.createNativeSpanFeedWithAllocator(globalAllocator, options_ptr);
}

export fn getArenaAllocatedBytes() usize {
    return arena.queryCapacity();
}

export fn getBuildOptions(out_ptr: *ExternalBuildOptions) void {
    out_ptr.* = .{
        .gpa_safe_stats = build_options.gpa_safe_stats,
        .gpa_memory_limit_tracking = build_options.gpa_safe_stats,
    };
}

export fn getAllocatorStats(out_ptr: *ExternalAllocatorStats) void {
    const small_allocations = getSmallAllocationCount();
    const large_allocations = getLargeAllocationCount();
    const active_allocations = small_allocations + large_allocations;
    const requested_bytes = getTotalRequestedBytesInfo();

    out_ptr.* = .{
        .total_requested_bytes = requested_bytes.bytes,
        .active_allocations = active_allocations,
        .small_allocations = small_allocations,
        .large_allocations = large_allocations,
        .requested_bytes_valid = requested_bytes.valid,
    };
}

export fn createRenderer(width: u32, height: u32, testing: bool, remote: bool) ?*renderer.CliRenderer {
    if (width == 0 or height == 0) {
        logger.warn("Invalid renderer dimensions: {}x{}", .{ width, height });
        return null;
    }

    const pool = gp.initGlobalPool(globalArena);
    _ = link.initGlobalLinkPool(globalArena);
    return renderer.CliRenderer.createWithOptions(globalAllocator, width, height, pool, testing, remote) catch |err| {
        logger.err("Failed to create renderer: {}", .{err});
        return null;
    };
}

export fn setTerminalEnvVar(rendererPtr: *renderer.CliRenderer, keyPtr: [*]const u8, keyLen: usize, valuePtr: [*]const u8, valueLen: usize) bool {
    const key = keyPtr[0..keyLen];
    const value = valuePtr[0..valueLen];
    return rendererPtr.setTerminalEnvVar(key, value);
}

export fn setUseThread(rendererPtr: *renderer.CliRenderer, useThread: bool) void {
    rendererPtr.setUseThread(useThread);
}

export fn setClearOnShutdown(rendererPtr: *renderer.CliRenderer, clear: bool) void {
    rendererPtr.setClearOnShutdown(clear);
}

export fn destroyRenderer(rendererPtr: *renderer.CliRenderer) void {
    rendererPtr.destroy();
}

export fn setBackgroundColor(rendererPtr: *renderer.CliRenderer, color: [*]const u16) void {
    rendererPtr.setBackgroundColor(ptrToRGBA(color));
}

export fn setRenderOffset(rendererPtr: *renderer.CliRenderer, offset: u32) void {
    rendererPtr.setRenderOffset(offset);
}

export fn resetSplitScrollback(rendererPtr: *renderer.CliRenderer, seedRows: u32, pinnedRenderOffset: u32) u32 {
    return rendererPtr.resetSplitScrollback(seedRows, pinnedRenderOffset);
}

export fn syncSplitScrollback(rendererPtr: *renderer.CliRenderer, pinnedRenderOffset: u32) u32 {
    return rendererPtr.syncSplitScrollback(pinnedRenderOffset);
}

export fn getSplitOutputOffset(rendererPtr: *renderer.CliRenderer, surfaceOffset: u32) u32 {
    return rendererPtr.getSplitOutputOffset(surfaceOffset);
}

export fn setPendingSplitFooterTransition(
    rendererPtr: *renderer.CliRenderer,
    mode: u8,
    sourceTopLine: u32,
    sourceHeight: u32,
    targetTopLine: u32,
    targetHeight: u32,
    scrollLines: u32,
) void {
    rendererPtr.setPendingSplitFooterTransition(
        @enumFromInt(mode),
        sourceTopLine,
        sourceHeight,
        targetTopLine,
        targetHeight,
        scrollLines,
    );
}

export fn clearPendingSplitFooterTransition(rendererPtr: *renderer.CliRenderer) void {
    rendererPtr.clearPendingSplitFooterTransition();
}

export fn updateStats(rendererPtr: *renderer.CliRenderer, time: f64, fps: u32, frameCallbackTime: f64) void {
    rendererPtr.updateStats(time, fps, frameCallbackTime);
}

export fn updateMemoryStats(rendererPtr: *renderer.CliRenderer, heapUsed: u32, heapTotal: u32, arrayBuffers: u32) void {
    rendererPtr.updateMemoryStats(heapUsed, heapTotal, arrayBuffers);
}

export fn getNextBuffer(rendererPtr: *renderer.CliRenderer) *buffer.OptimizedBuffer {
    return rendererPtr.getNextBuffer();
}

export fn getCurrentBuffer(rendererPtr: *renderer.CliRenderer) *buffer.OptimizedBuffer {
    return rendererPtr.getCurrentBuffer();
}

const OutputSlice = extern struct {
    ptr: [*]const u8,
    len: usize,
};

export fn getLastOutputForTest(rendererPtr: *renderer.CliRenderer, outSlice: *OutputSlice) void {
    const output = rendererPtr.getLastOutputForTest();
    outSlice.ptr = output.ptr;
    outSlice.len = output.len;
}

export fn setHyperlinksCapability(rendererPtr: *renderer.CliRenderer, enabled: bool) void {
    rendererPtr.terminal.caps.hyperlinks = enabled;
}

export fn clearGlobalLinkPool() void {
    link.deinitGlobalLinkPool();
}

export fn getBufferWidth(bufferPtr: *buffer.OptimizedBuffer) u32 {
    return bufferPtr.width;
}

export fn getBufferHeight(bufferPtr: *buffer.OptimizedBuffer) u32 {
    return bufferPtr.height;
}

export fn render(rendererPtr: *renderer.CliRenderer, force: bool) void {
    rendererPtr.render(force);
}

export fn repaintSplitFooter(
    rendererPtr: *renderer.CliRenderer,
    pinnedRenderOffset: u32,
    force: bool,
) u32 {
    return rendererPtr.repaintSplitFooter(pinnedRenderOffset, force);
}

export fn commitSplitFooterSnapshot(
    rendererPtr: *renderer.CliRenderer,
    snapshotBufferPtr: *buffer.OptimizedBuffer,
    rowColumns: u32,
    startOnNewLine: bool,
    trailingNewline: bool,
    pinnedRenderOffset: u32,
    force: bool,
    beginFrame: bool,
    finalizeFrame: bool,
) u32 {
    // JS passes rowColumns/startOnNewLine/trailingNewline per commit from
    // writeToScrollback or captured stdout chunking. This entrypoint is the ABI
    // boundary where that metadata enters the native split append algorithm.
    // Route all commits through the batched renderer path so sync/cursor framing
    // happens exactly once per JS flush cycle.
    if (beginFrame and finalizeFrame) {
        return rendererPtr.commitSplitFooterSnapshotBatched(
            snapshotBufferPtr,
            rowColumns,
            startOnNewLine,
            trailingNewline,
            pinnedRenderOffset,
            force,
            true,
            true,
        );
    }

    return rendererPtr.commitSplitFooterSnapshotBatched(
        snapshotBufferPtr,
        rowColumns,
        startOnNewLine,
        trailingNewline,
        pinnedRenderOffset,
        force,
        beginFrame,
        finalizeFrame,
    );
}

export fn createOptimizedBuffer(width: u32, height: u32, respectAlpha: bool, widthMethod: u8, idPtr: [*]const u8, idLen: usize) ?*buffer.OptimizedBuffer {
    if (width == 0 or height == 0) {
        logger.warn("Invalid buffer dimensions: {}x{}", .{ width, height });
        return null;
    }

    const pool = gp.initGlobalPool(globalArena);
    const link_pool = link.initGlobalLinkPool(globalArena);
    const wMethod: utf8.WidthMethod = if (widthMethod == 0) .wcwidth else .unicode;
    const id = idPtr[0..idLen];

    return buffer.OptimizedBuffer.init(globalAllocator, width, height, .{
        .respectAlpha = respectAlpha,
        .pool = pool,
        .width_method = wMethod,
        .id = id,
        .link_pool = link_pool,
    }) catch |err| {
        logger.err("Failed to create optimized buffer: {}", .{err});
        return null;
    };
}

export fn destroyOptimizedBuffer(bufferPtr: *buffer.OptimizedBuffer) void {
    bufferPtr.deinit();
}

export fn destroyFrameBuffer(frameBufferPtr: *buffer.OptimizedBuffer) void {
    destroyOptimizedBuffer(frameBufferPtr);
}

export fn drawFrameBuffer(targetPtr: *buffer.OptimizedBuffer, destX: i32, destY: i32, frameBuffer: *buffer.OptimizedBuffer, sourceX: u32, sourceY: u32, sourceWidth: u32, sourceHeight: u32) void {
    const srcX = if (sourceX == 0) null else sourceX;
    const srcY = if (sourceY == 0) null else sourceY;
    const srcWidth = if (sourceWidth == 0) null else sourceWidth;
    const srcHeight = if (sourceHeight == 0) null else sourceHeight;

    targetPtr.drawFrameBuffer(destX, destY, frameBuffer, srcX, srcY, srcWidth, srcHeight);
}

export fn setCursorPosition(rendererPtr: *renderer.CliRenderer, x: i32, y: i32, visible: bool) void {
    rendererPtr.terminal.setCursorPosition(@intCast(@max(1, x)), @intCast(@max(1, y)), visible);
}

pub const ExternalCapabilities = extern struct {
    kitty_keyboard: bool,
    kitty_graphics: bool,
    rgb: bool,
    ansi256: bool,
    unicode: u8, // 0 = wcwidth, 1 = unicode
    sgr_pixels: bool,
    color_scheme_updates: bool,
    explicit_width: bool,
    scaled_text: bool,
    sixel: bool,
    focus_tracking: bool,
    sync: bool,
    bracketed_paste: bool,
    hyperlinks: bool,
    osc52: bool,
    explicit_cursor_positioning: bool,
    in_tmux: bool,
    term_name_ptr: [*]const u8,
    term_name_len: usize,
    term_version_ptr: [*]const u8,
    term_version_len: usize,
    term_from_xtversion: bool,
};

export fn getTerminalCapabilities(rendererPtr: *renderer.CliRenderer, capsPtr: *ExternalCapabilities) void {
    const caps = rendererPtr.getTerminalCapabilities();
    const term = &rendererPtr.terminal;

    capsPtr.* = .{
        .kitty_keyboard = caps.kitty_keyboard,
        .kitty_graphics = caps.kitty_graphics,
        .rgb = caps.rgb,
        .ansi256 = caps.ansi256,
        .unicode = if (caps.unicode == .wcwidth) 0 else 1,
        .sgr_pixels = caps.sgr_pixels,
        .color_scheme_updates = caps.color_scheme_updates,
        .explicit_width = caps.explicit_width,
        .scaled_text = caps.scaled_text,
        .sixel = caps.sixel,
        .focus_tracking = caps.focus_tracking,
        .sync = caps.sync,
        .bracketed_paste = caps.bracketed_paste,
        .hyperlinks = caps.hyperlinks,
        .osc52 = caps.osc52,
        .explicit_cursor_positioning = caps.explicit_cursor_positioning,
        .in_tmux = term.in_tmux,
        .term_name_ptr = &term.term_info.name,
        .term_name_len = term.term_info.name_len,
        .term_version_ptr = &term.term_info.version,
        .term_version_len = term.term_info.version_len,
        .term_from_xtversion = term.term_info.from_xtversion,
    };
}

export fn processCapabilityResponse(rendererPtr: *renderer.CliRenderer, responsePtr: [*]const u8, responseLen: usize) void {
    const response = responsePtr[0..responseLen];
    rendererPtr.processCapabilityResponse(response);
}

export fn setCursorColor(rendererPtr: *renderer.CliRenderer, color: [*]const u16) void {
    rendererPtr.terminal.setCursorColor(ptrToRGBA(color));
}

export fn rendererSetPaletteState(
    rendererPtr: *renderer.CliRenderer,
    palettePtr: [*]const u16,
    paletteLen: usize,
    defaultFgPtr: [*]const u16,
    defaultBgPtr: [*]const u16,
    paletteEpoch: u32,
) void {
    if (paletteLen < 256) return;

    var palette: [256]renderer.RGBA = undefined;
    var index: usize = 0;
    while (index < palette.len) : (index += 1) {
        const base = index * 4;
        palette[index] = .{ palettePtr[base], palettePtr[base + 1], palettePtr[base + 2], palettePtr[base + 3] };
    }

    rendererPtr.setPaletteState(palette[0..], ptrToRGBA(defaultFgPtr), ptrToRGBA(defaultBgPtr), paletteEpoch);
}

pub const CursorStyleOptions = extern struct {
    style: u8,
    blinking: u8,
    color: ?[*]const u16,
    cursor: u8,
};

export fn setCursorStyleOptions(rendererPtr: *renderer.CliRenderer, options: *const CursorStyleOptions) void {
    const current = rendererPtr.terminal.getCursorStyle();

    const style = if (options.style <= 3) @as(terminal.CursorStyle, @enumFromInt(options.style)) else current.style;
    const blinking = if (options.blinking <= 1) options.blinking == 1 else current.blinking;

    if (options.style <= 3 or options.blinking <= 1) {
        rendererPtr.terminal.setCursorStyle(style, blinking);
    }
    if (options.color) |rgba| {
        rendererPtr.terminal.setCursorColor(ptrToRGBA(rgba));
    }
    if (options.cursor <= 35) {
        rendererPtr.terminal.setMousePointerStyle(@enumFromInt(options.cursor));
    }
}

pub const ExternalCursorState = extern struct {
    x: u32,
    y: u32,
    visible: bool,
    style: u8,
    blinking: bool,
    r: f32,
    g: f32,
    b: f32,
    a: f32,
};

export fn getCursorState(rendererPtr: *renderer.CliRenderer, outPtr: *ExternalCursorState) void {
    const pos = rendererPtr.terminal.getCursorPosition();
    const style = rendererPtr.terminal.getCursorStyle();
    const color = rendererPtr.terminal.getCursorColor();

    const styleTag: u8 = switch (style.style) {
        .block => 0,
        .line => 1,
        .underline => 2,
        .default => 3,
    };

    outPtr.* = .{
        .x = pos.x,
        .y = pos.y,
        .visible = pos.visible,
        .style = styleTag,
        .blinking = style.blinking,
        .r = ansi.redF(color),
        .g = ansi.greenF(color),
        .b = ansi.blueF(color),
        .a = ansi.alphaF(color),
    };
}

export fn setDebugOverlay(rendererPtr: *renderer.CliRenderer, enabled: bool, corner: u8) void {
    const cornerEnum: renderer.DebugOverlayCorner = switch (corner) {
        0 => .topLeft,
        1 => .topRight,
        2 => .bottomLeft,
        else => .bottomRight,
    };

    rendererPtr.setDebugOverlay(enabled, cornerEnum);
}

export fn clearTerminal(rendererPtr: *renderer.CliRenderer) void {
    rendererPtr.clearTerminal();
}

export fn setTerminalTitle(rendererPtr: *renderer.CliRenderer, titlePtr: [*]const u8, titleLen: usize) void {
    const title = titlePtr[0..titleLen];
    rendererPtr.setTerminalTitle(title);
}

export fn copyToClipboardOSC52(rendererPtr: *renderer.CliRenderer, target: u8, payloadPtr: [*]const u8, payloadLen: usize) bool {
    const targetEnum = std.meta.intToEnum(terminal.ClipboardTarget, target) catch .clipboard;
    const payload = payloadPtr[0..payloadLen];
    return rendererPtr.copyToClipboardOSC52(targetEnum, payload);
}

export fn clearClipboardOSC52(rendererPtr: *renderer.CliRenderer, target: u8) bool {
    const targetEnum = std.meta.intToEnum(terminal.ClipboardTarget, target) catch .clipboard;
    return rendererPtr.clearClipboardOSC52(targetEnum);
}

// Buffer functions
export fn bufferClear(bufferPtr: *buffer.OptimizedBuffer, bg: [*]const u16) void {
    bufferPtr.clear(ptrToRGBA(bg), null);
}

export fn bufferGetCharPtr(bufferPtr: *buffer.OptimizedBuffer) [*]u32 {
    return bufferPtr.getCharPtr();
}

export fn bufferGetFgPtr(bufferPtr: *buffer.OptimizedBuffer) [*]RGBA {
    return bufferPtr.getFgPtr();
}

export fn bufferGetBgPtr(bufferPtr: *buffer.OptimizedBuffer) [*]RGBA {
    return bufferPtr.getBgPtr();
}

export fn bufferGetAttributesPtr(bufferPtr: *buffer.OptimizedBuffer) [*]u32 {
    return bufferPtr.getAttributesPtr();
}

export fn bufferGetRespectAlpha(bufferPtr: *buffer.OptimizedBuffer) bool {
    return bufferPtr.getRespectAlpha();
}

export fn bufferSetRespectAlpha(bufferPtr: *buffer.OptimizedBuffer, respectAlpha: bool) void {
    bufferPtr.setRespectAlpha(respectAlpha);
}

export fn bufferGetId(bufferPtr: *buffer.OptimizedBuffer, outPtr: [*]u8, maxLen: usize) usize {
    const id = bufferPtr.getId();
    const copyLen = @min(id.len, maxLen);
    @memcpy(outPtr[0..copyLen], id[0..copyLen]);
    return copyLen;
}

export fn bufferGetRealCharSize(bufferPtr: *buffer.OptimizedBuffer) u32 {
    return bufferPtr.getRealCharSize();
}

export fn bufferWriteResolvedChars(bufferPtr: *buffer.OptimizedBuffer, outputPtr: [*]u8, outputLen: usize, addLineBreaks: bool) u32 {
    const output_slice = outputPtr[0..outputLen];
    return bufferPtr.writeResolvedChars(output_slice, addLineBreaks) catch 0;
}

export fn bufferDrawText(bufferPtr: *buffer.OptimizedBuffer, text: [*]const u8, textLen: usize, x: u32, y: u32, fg: [*]const u16, bg: ?[*]const u16, attributes: u32) void {
    bufferPtr.drawText(
        text[0..textLen],
        x,
        y,
        ptrToRGBA(fg),
        optionalPtrToRGBA(bg),
        attributes,
    ) catch {};
}

export fn bufferSetCellWithAlphaBlending(bufferPtr: *buffer.OptimizedBuffer, x: u32, y: u32, char: u32, fg: [*]const u16, bg: [*]const u16, attributes: u32) void {
    bufferPtr.setCellWithAlphaBlending(x, y, char, ptrToRGBA(fg), ptrToRGBA(bg), attributes);
}

export fn bufferSetCell(bufferPtr: *buffer.OptimizedBuffer, x: u32, y: u32, char: u32, fg: [*]const u16, bg: [*]const u16, attributes: u32) void {
    bufferPtr.set(x, y, .{
        .char = char,
        .fg = ptrToRGBA(fg),
        .bg = ptrToRGBA(bg),
        .attributes = attributes,
    });
}

export fn bufferFillRect(bufferPtr: *buffer.OptimizedBuffer, x: u32, y: u32, width: u32, height: u32, bg: [*]const u16) void {
    bufferPtr.fillRect(x, y, width, height, ptrToRGBA(bg));
}

export fn bufferColorMatrix(bufferPtr: *buffer.OptimizedBuffer, matrixPtr: [*]const f32, cellMaskPtr: [*]const f32, cellMaskCount: usize, strength: f32, target: u8) void {
    if (cellMaskCount == 0) return;
    const matrix = matrixPtr[0..16];
    const len = cellMaskCount * 3;
    const cellMask = cellMaskPtr[0..len];
    const targetEnum: buffer_effects.ColorTarget = @enumFromInt(target);
    buffer_effects.colorMatrix(bufferPtr, matrix, cellMask, strength, targetEnum);
}

export fn bufferColorMatrixUniform(bufferPtr: *buffer.OptimizedBuffer, matrixPtr: [*]const f32, strength: f32, target: u8) void {
    const matrix = matrixPtr[0..16];
    const targetEnum: buffer_effects.ColorTarget = @enumFromInt(target);
    buffer_effects.colorMatrixUniform(bufferPtr, matrix, strength, targetEnum);
}

export fn bufferDrawPackedBuffer(bufferPtr: *buffer.OptimizedBuffer, data: [*]const u8, dataLen: usize, posX: u32, posY: u32, terminalWidthCells: u32, terminalHeightCells: u32) void {
    bufferPtr.drawPackedBuffer(data, dataLen, posX, posY, terminalWidthCells, terminalHeightCells);
}

export fn bufferDrawGrayscaleBuffer(bufferPtr: *buffer.OptimizedBuffer, posX: i32, posY: i32, intensities: [*]const f32, srcWidth: u32, srcHeight: u32, fg: ?[*]const u16, bg: ?[*]const u16) void {
    bufferPtr.drawGrayscaleBuffer(
        posX,
        posY,
        intensities,
        srcWidth,
        srcHeight,
        optionalPtrToRGBA(fg),
        optionalPtrToRGBA(bg),
    );
}

export fn bufferDrawGrayscaleBufferSupersampled(bufferPtr: *buffer.OptimizedBuffer, posX: i32, posY: i32, intensities: [*]const f32, srcWidth: u32, srcHeight: u32, fg: ?[*]const u16, bg: ?[*]const u16) void {
    bufferPtr.drawGrayscaleBufferSupersampled(
        posX,
        posY,
        intensities,
        srcWidth,
        srcHeight,
        optionalPtrToRGBA(fg),
        optionalPtrToRGBA(bg),
    );
}

export fn bufferPushScissorRect(bufferPtr: *buffer.OptimizedBuffer, x: i32, y: i32, width: u32, height: u32) void {
    bufferPtr.pushScissorRect(x, y, width, height) catch {};
}

export fn bufferPopScissorRect(bufferPtr: *buffer.OptimizedBuffer) void {
    bufferPtr.popScissorRect();
}

export fn bufferClearScissorRects(bufferPtr: *buffer.OptimizedBuffer) void {
    bufferPtr.clearScissorRects();
}

// Opacity stack functions
export fn bufferPushOpacity(bufferPtr: *buffer.OptimizedBuffer, opacity: f32) void {
    bufferPtr.pushOpacity(opacity) catch {};
}

export fn bufferPopOpacity(bufferPtr: *buffer.OptimizedBuffer) void {
    bufferPtr.popOpacity();
}

export fn bufferGetCurrentOpacity(bufferPtr: *buffer.OptimizedBuffer) f32 {
    return bufferPtr.getCurrentOpacity();
}

export fn bufferClearOpacity(bufferPtr: *buffer.OptimizedBuffer) void {
    bufferPtr.clearOpacity();
}

export fn bufferDrawSuperSampleBuffer(bufferPtr: *buffer.OptimizedBuffer, x: u32, y: u32, pixelData: [*]const u8, len: usize, format: u8, alignedBytesPerRow: u32) void {
    bufferPtr.drawSuperSampleBuffer(x, y, pixelData, len, format, alignedBytesPerRow);
}

export fn linkAlloc(urlPtr: [*]const u8, urlLen: usize) u32 {
    const url = urlPtr[0..urlLen];
    const link_pool = link.initGlobalLinkPool(globalArena);
    return link_pool.alloc(url) catch 0;
}

export fn linkGetUrl(id: u32, outPtr: [*]u8, maxLen: usize) usize {
    const link_pool = link.initGlobalLinkPool(globalArena);
    const url_bytes = link_pool.get(id) catch return 0;
    const copyLen = @min(url_bytes.len, maxLen);
    @memcpy(outPtr[0..copyLen], url_bytes[0..copyLen]);
    return copyLen;
}

export fn attributesWithLink(baseAttributes: u32, linkId: u32) u32 {
    return ansi.TextAttributes.setLinkId(baseAttributes, linkId);
}

export fn attributesGetLinkId(attributes: u32) u32 {
    return ansi.TextAttributes.getLinkId(attributes);
}

pub const ExternalGridDrawOptions = extern struct {
    draw_inner: bool,
    draw_outer: bool,
};

export fn bufferDrawGrid(
    bufferPtr: *buffer.OptimizedBuffer,
    borderChars: [*]const u32,
    borderFg: [*]const u16,
    borderBg: [*]const u16,
    columnOffsets: [*]const i32,
    columnCount: u32,
    rowOffsets: [*]const i32,
    rowCount: u32,
    options: *const ExternalGridDrawOptions,
) void {
    bufferPtr.drawGrid(
        borderChars,
        ptrToRGBA(borderFg),
        ptrToRGBA(borderBg),
        columnOffsets,
        columnCount,
        rowOffsets,
        rowCount,
        options.draw_inner,
        options.draw_outer,
    );
}

export fn bufferDrawBox(
    bufferPtr: *buffer.OptimizedBuffer,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    borderChars: [*]const u32,
    packedOptions: u32,
    borderColor: [*]const u16,
    backgroundColor: [*]const u16,
    title: ?[*]const u8,
    titleLen: u32,
    bottomTitle: ?[*]const u8,
    bottomTitleLen: u32,
) void {
    const borderSides: buffer.BorderSides = .{
        .top = (packedOptions & 0b1000) != 0,
        .right = (packedOptions & 0b0100) != 0,
        .bottom = (packedOptions & 0b0010) != 0,
        .left = (packedOptions & 0b0001) != 0,
    };

    const shouldFill = ((packedOptions >> 4) & 1) != 0;
    const titleAlignment = @as(u8, @intCast((packedOptions >> 5) & 0b11));
    const bottomTitleAlignment = @as(u8, @intCast((packedOptions >> 7) & 0b11));
    const titleSlice = if (title) |t| t[0..titleLen] else null;

    const bottomTitleSlice = if (bottomTitle) |bt| bt[0..bottomTitleLen] else null;

    bufferPtr.drawBox(
        x,
        y,
        width,
        height,
        borderChars,
        borderSides,
        ptrToRGBA(borderColor),
        ptrToRGBA(backgroundColor),
        shouldFill,
        titleSlice,
        titleAlignment,
        bottomTitleSlice,
        bottomTitleAlignment,
    ) catch {};
}

export fn bufferResize(bufferPtr: *buffer.OptimizedBuffer, width: u32, height: u32) void {
    bufferPtr.resize(width, height) catch {};
}

export fn resizeRenderer(rendererPtr: *renderer.CliRenderer, width: u32, height: u32) void {
    rendererPtr.resize(width, height) catch {};
}

export fn addToHitGrid(rendererPtr: *renderer.CliRenderer, x: i32, y: i32, width: u32, height: u32, id: u32) void {
    rendererPtr.addToHitGrid(x, y, width, height, id);
}

export fn clearCurrentHitGrid(rendererPtr: *renderer.CliRenderer) void {
    rendererPtr.clearCurrentHitGrid();
}

export fn hitGridPushScissorRect(rendererPtr: *renderer.CliRenderer, x: i32, y: i32, width: u32, height: u32) void {
    rendererPtr.hitGridPushScissorRect(x, y, width, height);
}

export fn hitGridPopScissorRect(rendererPtr: *renderer.CliRenderer) void {
    rendererPtr.hitGridPopScissorRect();
}

export fn hitGridClearScissorRects(rendererPtr: *renderer.CliRenderer) void {
    rendererPtr.hitGridClearScissorRects();
}

export fn addToCurrentHitGridClipped(rendererPtr: *renderer.CliRenderer, x: i32, y: i32, width: u32, height: u32, id: u32) void {
    rendererPtr.addToCurrentHitGridClipped(x, y, width, height, id);
}

export fn checkHit(rendererPtr: *renderer.CliRenderer, x: u32, y: u32) u32 {
    return rendererPtr.checkHit(x, y);
}

export fn getHitGridDirty(rendererPtr: *renderer.CliRenderer) bool {
    return rendererPtr.getHitGridDirty();
}

export fn dumpHitGrid(rendererPtr: *renderer.CliRenderer) void {
    rendererPtr.dumpHitGrid();
}

export fn dumpBuffers(rendererPtr: *renderer.CliRenderer, timestamp: i64) void {
    rendererPtr.dumpBuffers(timestamp);
}

export fn dumpStdoutBuffer(rendererPtr: *renderer.CliRenderer, timestamp: i64) void {
    rendererPtr.dumpStdoutBuffer(timestamp);
}

export fn restoreTerminalModes(rendererPtr: *renderer.CliRenderer) void {
    rendererPtr.restoreTerminalModes();
}

export fn enableMouse(rendererPtr: *renderer.CliRenderer, enableMovement: bool) void {
    rendererPtr.enableMouse(enableMovement);
}

export fn disableMouse(rendererPtr: *renderer.CliRenderer) void {
    rendererPtr.disableMouse();
}

export fn queryPixelResolution(rendererPtr: *renderer.CliRenderer) void {
    rendererPtr.queryPixelResolution();
}

export fn queryThemeColors(rendererPtr: *renderer.CliRenderer) void {
    rendererPtr.queryThemeColors();
}

export fn enableKittyKeyboard(rendererPtr: *renderer.CliRenderer, flags: u8) void {
    rendererPtr.enableKittyKeyboard(flags);
}

export fn disableKittyKeyboard(rendererPtr: *renderer.CliRenderer) void {
    rendererPtr.disableKittyKeyboard();
}

export fn setKittyKeyboardFlags(rendererPtr: *renderer.CliRenderer, flags: u8) void {
    rendererPtr.setKittyKeyboardFlags(flags);
}

export fn getKittyKeyboardFlags(rendererPtr: *renderer.CliRenderer) u8 {
    return rendererPtr.getKittyKeyboardFlags();
}

export fn setupTerminal(rendererPtr: *renderer.CliRenderer, useAlternateScreen: bool) void {
    rendererPtr.setupTerminal(useAlternateScreen);
}

export fn suspendRenderer(rendererPtr: *renderer.CliRenderer) void {
    rendererPtr.suspendRenderer();
}

export fn resumeRenderer(rendererPtr: *renderer.CliRenderer) void {
    rendererPtr.resumeRenderer();
}

export fn writeOut(rendererPtr: *renderer.CliRenderer, dataPtr: [*]const u8, dataLen: usize) void {
    if (dataLen == 0) return;
    const data = dataPtr[0..dataLen];
    rendererPtr.writeOut(data);
}

export fn createTextBuffer(widthMethod: u8) ?*text_buffer.UnifiedTextBuffer {
    const pool = gp.initGlobalPool(globalArena);
    const link_pool = link.initGlobalLinkPool(globalArena);
    const wMethod: utf8.WidthMethod = if (widthMethod == 0) .wcwidth else .unicode;

    return text_buffer.UnifiedTextBuffer.init(globalAllocator, pool, link_pool, wMethod) catch {
        return null;
    };
}

export fn destroyTextBuffer(tb: *text_buffer.UnifiedTextBuffer) void {
    tb.deinit();
}

export fn textBufferGetLength(tb: *text_buffer.UnifiedTextBuffer) u32 {
    return tb.getLength();
}

export fn textBufferGetByteSize(tb: *text_buffer.UnifiedTextBuffer) u32 {
    return tb.getByteSize();
}

export fn textBufferReset(tb: *text_buffer.UnifiedTextBuffer) void {
    tb.reset();
}

export fn textBufferClear(tb: *text_buffer.UnifiedTextBuffer) void {
    tb.clear();
}

export fn textBufferSetDefaultFg(tb: *text_buffer.UnifiedTextBuffer, fg: ?[*]const u16) void {
    tb.setDefaultFg(optionalPtrToRGBA(fg));
}

export fn textBufferSetDefaultBg(tb: *text_buffer.UnifiedTextBuffer, bg: ?[*]const u16) void {
    tb.setDefaultBg(optionalPtrToRGBA(bg));
}

export fn textBufferSetDefaultAttributes(tb: *text_buffer.UnifiedTextBuffer, attr: ?[*]const u32) void {
    const attributes = if (attr) |a| a[0] else null;
    tb.setDefaultAttributes(attributes);
}

export fn textBufferResetDefaults(tb: *text_buffer.UnifiedTextBuffer) void {
    tb.resetDefaults();
}

export fn textBufferGetTabWidth(tb: *text_buffer.UnifiedTextBuffer) u8 {
    return tb.tabWidth();
}

export fn textBufferSetTabWidth(tb: *text_buffer.UnifiedTextBuffer, width: u8) void {
    tb.setTabWidth(width);
}

export fn textBufferRegisterMemBuffer(tb: *text_buffer.UnifiedTextBuffer, dataPtr: [*]const u8, dataLen: usize, owned: bool) u16 {
    const data = dataPtr[0..dataLen];
    const mem_id = tb.registerMemBuffer(data, owned) catch return 0xFFFF;
    return @intCast(mem_id);
}

export fn textBufferReplaceMemBuffer(tb: *text_buffer.UnifiedTextBuffer, id: u8, dataPtr: [*]const u8, dataLen: usize, owned: bool) bool {
    const data = dataPtr[0..dataLen];
    tb.replaceMemBuffer(id, data, owned) catch return false;
    return true;
}

export fn textBufferClearMemRegistry(tb: *text_buffer.UnifiedTextBuffer) void {
    tb.clearMemRegistry();
}

export fn textBufferSetTextFromMem(tb: *text_buffer.UnifiedTextBuffer, id: u8) void {
    tb.setTextFromMemId(id) catch {};
}

export fn textBufferAppend(tb: *text_buffer.UnifiedTextBuffer, dataPtr: [*]const u8, dataLen: usize) void {
    const data = dataPtr[0..dataLen];
    tb.append(data) catch {};
}

export fn textBufferAppendFromMemId(tb: *text_buffer.UnifiedTextBuffer, id: u8) void {
    tb.appendFromMemId(id) catch {};
}

export fn textBufferLoadFile(tb: *text_buffer.UnifiedTextBuffer, pathPtr: [*]const u8, pathLen: usize) bool {
    const path = pathPtr[0..pathLen];
    tb.loadFile(path) catch return false;
    return true;
}

export fn textBufferSetStyledText(
    tb: *text_buffer.UnifiedTextBuffer,
    chunksPtr: [*]const text_buffer.StyledChunk,
    chunkCount: usize,
) void {
    if (chunkCount == 0) return;
    const chunks = chunksPtr[0..chunkCount];
    tb.setStyledText(chunks) catch {};
}

export fn textBufferGetLineCount(tb: *text_buffer.UnifiedTextBuffer) u32 {
    return tb.getLineCount();
}

export fn textBufferGetPlainText(tb: *text_buffer.UnifiedTextBuffer, outPtr: [*]u8, maxLen: usize) usize {
    const outBuffer = outPtr[0..maxLen];
    return tb.getPlainTextIntoBuffer(outBuffer);
}

// TextBufferView functions (Array-based for backward compatibility)
export fn createTextBufferView(tb: *text_buffer.UnifiedTextBuffer) ?*text_buffer_view.UnifiedTextBufferView {
    return text_buffer_view.UnifiedTextBufferView.init(globalAllocator, tb) catch {
        return null;
    };
}

export fn destroyTextBufferView(view: *text_buffer_view.UnifiedTextBufferView) void {
    view.deinit();
}

export fn textBufferViewSetSelection(view: *text_buffer_view.UnifiedTextBufferView, start: u32, end: u32, bgColor: ?[*]const u16, fgColor: ?[*]const u16) void {
    view.setSelectionStyle(start, end, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
}

export fn textBufferViewResetSelection(view: *text_buffer_view.UnifiedTextBufferView) void {
    view.resetSelection();
}

export fn textBufferViewGetSelectionInfo(view: *text_buffer_view.UnifiedTextBufferView) u64 {
    return view.packSelectionInfo();
}

export fn textBufferViewSetLocalSelection(view: *text_buffer_view.UnifiedTextBufferView, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?[*]const u16, fgColor: ?[*]const u16) bool {
    return view.setLocalSelectionStyle(anchorX, anchorY, focusX, focusY, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
}

export fn textBufferViewUpdateSelection(view: *text_buffer_view.UnifiedTextBufferView, end: u32, bgColor: ?[*]const u16, fgColor: ?[*]const u16) void {
    view.updateSelectionStyle(end, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
}

export fn textBufferViewUpdateLocalSelection(view: *text_buffer_view.UnifiedTextBufferView, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?[*]const u16, fgColor: ?[*]const u16) bool {
    return view.updateLocalSelectionStyle(anchorX, anchorY, focusX, focusY, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
}

export fn textBufferViewResetLocalSelection(view: *text_buffer_view.UnifiedTextBufferView) void {
    view.resetLocalSelection();
}

export fn textBufferViewSetWrapWidth(view: *text_buffer_view.UnifiedTextBufferView, width: u32) void {
    view.setWrapWidth(if (width == 0) null else width);
}

export fn textBufferViewSetWrapMode(view: *text_buffer_view.UnifiedTextBufferView, mode: u8) void {
    const wrapMode: text_buffer.WrapMode = switch (mode) {
        0 => .none,
        1 => .char,
        2 => .word,
        else => .none,
    };
    view.setWrapMode(wrapMode);
}

export fn textBufferViewSetFirstLineOffset(view: *text_buffer_view.UnifiedTextBufferView, offset: u32) void {
    view.setFirstLineOffset(offset);
}

export fn textBufferViewSetViewportSize(view: *text_buffer_view.UnifiedTextBufferView, width: u32, height: u32) void {
    view.setViewportSize(width, height);
}

export fn textBufferViewSetViewport(view: *text_buffer_view.UnifiedTextBufferView, x: u32, y: u32, width: u32, height: u32) void {
    view.setViewport(.{
        .x = x,
        .y = y,
        .width = width,
        .height = height,
    });
}

export fn textBufferViewGetVirtualLineCount(view: *text_buffer_view.UnifiedTextBufferView) u32 {
    return view.getVirtualLineCount();
}

export fn textBufferViewGetLineInfoDirect(view: *text_buffer_view.UnifiedTextBufferView, outPtr: *ExternalLineInfo) void {
    const line_info = view.getCachedLineInfo();

    outPtr.* = .{
        .start_cols_ptr = line_info.line_start_cols.ptr,
        .start_cols_len = @intCast(line_info.line_start_cols.len),
        .width_cols_ptr = line_info.line_width_cols.ptr,
        .width_cols_len = @intCast(line_info.line_width_cols.len),
        .sources_ptr = line_info.line_sources.ptr,
        .sources_len = @intCast(line_info.line_sources.len),
        .wraps_ptr = line_info.line_wraps.ptr,
        .wraps_len = @intCast(line_info.line_wraps.len),
        .width_cols_max = line_info.line_width_cols_max,
    };
}

export fn textBufferViewGetLogicalLineInfoDirect(view: *text_buffer_view.UnifiedTextBufferView, outPtr: *ExternalLineInfo) void {
    const line_info = view.getLogicalLineInfo();

    outPtr.* = .{
        .start_cols_ptr = line_info.line_start_cols.ptr,
        .start_cols_len = @intCast(line_info.line_start_cols.len),
        .width_cols_ptr = line_info.line_width_cols.ptr,
        .width_cols_len = @intCast(line_info.line_width_cols.len),
        .sources_ptr = line_info.line_sources.ptr,
        .sources_len = @intCast(line_info.line_sources.len),
        .wraps_ptr = line_info.line_wraps.ptr,
        .wraps_len = @intCast(line_info.line_wraps.len),
        .width_cols_max = line_info.line_width_cols_max,
    };
}

export fn textBufferViewGetSelectedText(view: *text_buffer_view.UnifiedTextBufferView, outPtr: [*]u8, maxLen: usize) usize {
    const outBuffer = outPtr[0..maxLen];
    return view.getSelectedTextIntoBuffer(outBuffer);
}

export fn textBufferViewGetPlainText(view: *text_buffer_view.UnifiedTextBufferView, outPtr: [*]u8, maxLen: usize) usize {
    const outBuffer = outPtr[0..maxLen];
    return view.getPlainTextIntoBuffer(outBuffer);
}

export fn textBufferViewSetTabIndicator(view: *text_buffer_view.UnifiedTextBufferView, indicator: u32) void {
    view.setTabIndicator(indicator);
}

export fn textBufferViewSetTabIndicatorColor(view: *text_buffer_view.UnifiedTextBufferView, color: [*]const u16) void {
    view.setTabIndicatorColor(ptrToRGBA(color));
}

export fn textBufferViewSetTruncate(view: *text_buffer_view.UnifiedTextBufferView, truncate: bool) void {
    view.setTruncate(truncate);
}

pub const ExternalMeasureResult = extern struct {
    line_count: u32,
    width_cols_max: u32,
};

export fn textBufferViewMeasureForDimensions(view: *text_buffer_view.UnifiedTextBufferView, width: u32, height: u32, outPtr: *ExternalMeasureResult) bool {
    const result = view.measureForDimensions(width, height) catch return false;
    outPtr.* = .{
        .line_count = result.line_count,
        .width_cols_max = result.width_cols_max,
    };
    return true;
}

// ===== EditBuffer Exports =====

export fn createEditBuffer(widthMethod: u8) ?*edit_buffer_mod.EditBuffer {
    const pool = gp.initGlobalPool(globalArena);
    const link_pool = link.initGlobalLinkPool(globalArena);
    const wMethod: utf8.WidthMethod = if (widthMethod == 0) .wcwidth else .unicode;

    return edit_buffer_mod.EditBuffer.init(
        globalAllocator,
        pool,
        link_pool,
        wMethod,
    ) catch null;
}

export fn destroyEditBuffer(edit_buffer: *edit_buffer_mod.EditBuffer) void {
    edit_buffer.deinit();
}

export fn editBufferGetTextBuffer(edit_buffer: *edit_buffer_mod.EditBuffer) *text_buffer.UnifiedTextBuffer {
    return edit_buffer.getTextBuffer();
}

export fn editBufferInsertText(edit_buffer: *edit_buffer_mod.EditBuffer, textPtr: [*]const u8, textLen: usize) void {
    const text = textPtr[0..textLen];
    edit_buffer.insertText(text) catch {};
}

export fn editBufferDeleteRange(edit_buffer: *edit_buffer_mod.EditBuffer, start_row: u32, start_col: u32, end_row: u32, end_col: u32) void {
    const start: edit_buffer_mod.Cursor = .{ .row = start_row, .col = start_col };
    const end: edit_buffer_mod.Cursor = .{ .row = end_row, .col = end_col };
    edit_buffer.deleteRange(start, end) catch {};
}

export fn editBufferDeleteCharBackward(edit_buffer: *edit_buffer_mod.EditBuffer) void {
    edit_buffer.backspace() catch {};
}

export fn editBufferDeleteChar(edit_buffer: *edit_buffer_mod.EditBuffer) void {
    edit_buffer.deleteForward() catch {};
}

export fn editBufferMoveCursorLeft(edit_buffer: *edit_buffer_mod.EditBuffer) void {
    edit_buffer.moveLeft();
}

export fn editBufferMoveCursorRight(edit_buffer: *edit_buffer_mod.EditBuffer) void {
    edit_buffer.moveRight();
}

export fn editBufferMoveCursorUp(edit_buffer: *edit_buffer_mod.EditBuffer) void {
    edit_buffer.moveUp();
}

export fn editBufferMoveCursorDown(edit_buffer: *edit_buffer_mod.EditBuffer) void {
    edit_buffer.moveDown();
}

export fn editBufferGetCursor(edit_buffer: *edit_buffer_mod.EditBuffer, outRow: *u32, outCol: *u32) void {
    const cursor = edit_buffer.getPrimaryCursor();
    outRow.* = cursor.row;
    outCol.* = cursor.col;
}

export fn editBufferSetCursor(edit_buffer: *edit_buffer_mod.EditBuffer, row: u32, col: u32) void {
    edit_buffer.setCursor(row, col) catch {};
}

export fn editBufferSetCursorToLineCol(edit_buffer: *edit_buffer_mod.EditBuffer, row: u32, col: u32) void {
    edit_buffer.setCursor(row, col) catch {};
}

export fn editBufferSetCursorByOffset(edit_buffer: *edit_buffer_mod.EditBuffer, offset: u32) void {
    edit_buffer.setCursorByOffset(offset) catch {};
}

export fn editBufferGetNextWordBoundary(edit_buffer: *edit_buffer_mod.EditBuffer, outPtr: *ExternalLogicalCursor) void {
    const cursor = edit_buffer.getNextWordBoundary();
    outPtr.* = .{
        .row = cursor.row,
        .col = cursor.col,
        .offset = cursor.offset,
    };
}

export fn editBufferGetPrevWordBoundary(edit_buffer: *edit_buffer_mod.EditBuffer, outPtr: *ExternalLogicalCursor) void {
    const cursor = edit_buffer.getPrevWordBoundary();
    outPtr.* = .{
        .row = cursor.row,
        .col = cursor.col,
        .offset = cursor.offset,
    };
}

export fn editBufferGetEOL(edit_buffer: *edit_buffer_mod.EditBuffer, outPtr: *ExternalLogicalCursor) void {
    const cursor = edit_buffer.getEOL();
    outPtr.* = .{
        .row = cursor.row,
        .col = cursor.col,
        .offset = cursor.offset,
    };
}

export fn editBufferOffsetToPosition(edit_buffer: *edit_buffer_mod.EditBuffer, offset: u32, outPtr: *ExternalLogicalCursor) bool {
    const coords = text_buffer_iterators.offsetToCoords(edit_buffer.tb.rope(), offset) orelse return false;
    outPtr.* = .{
        .row = coords.row,
        .col = coords.col,
        .offset = offset,
    };
    return true;
}

export fn editBufferPositionToOffset(edit_buffer: *edit_buffer_mod.EditBuffer, row: u32, col: u32) u32 {
    return text_buffer_iterators.coordsToOffset(edit_buffer.tb.rope(), row, col) orelse 0;
}

export fn editBufferGetLineStartOffset(edit_buffer: *edit_buffer_mod.EditBuffer, row: u32) u32 {
    return text_buffer_iterators.coordsToOffset(edit_buffer.tb.rope(), row, 0) orelse 0;
}

export fn editBufferGetTextRange(edit_buffer: *edit_buffer_mod.EditBuffer, start_offset: u32, end_offset: u32, outPtr: [*]u8, maxLen: usize) usize {
    const outBuffer = outPtr[0..maxLen];
    return edit_buffer.getTextRange(start_offset, end_offset, outBuffer) catch 0;
}

export fn editBufferGetTextRangeByCoords(edit_buffer: *edit_buffer_mod.EditBuffer, start_row: u32, start_col: u32, end_row: u32, end_col: u32, outPtr: [*]u8, maxLen: usize) usize {
    const outBuffer = outPtr[0..maxLen];
    return edit_buffer.getTextRangeByCoords(start_row, start_col, end_row, end_col, outBuffer);
}

export fn editBufferSetText(edit_buffer: *edit_buffer_mod.EditBuffer, textPtr: [*]const u8, textLen: usize) void {
    const text = textPtr[0..textLen];
    edit_buffer.setText(text) catch {};
}

export fn editBufferSetTextFromMem(edit_buffer: *edit_buffer_mod.EditBuffer, mem_id: u8) void {
    edit_buffer.setTextFromMemId(mem_id) catch {};
}

export fn editBufferReplaceText(edit_buffer: *edit_buffer_mod.EditBuffer, textPtr: [*]const u8, textLen: usize) void {
    const text = textPtr[0..textLen];
    edit_buffer.replaceText(text) catch {};
}

export fn editBufferReplaceTextFromMem(edit_buffer: *edit_buffer_mod.EditBuffer, mem_id: u8) void {
    edit_buffer.replaceTextFromMemId(mem_id) catch {};
}

export fn editBufferGetText(edit_buffer: *edit_buffer_mod.EditBuffer, outPtr: [*]u8, maxLen: usize) usize {
    const outBuffer = outPtr[0..maxLen];
    return edit_buffer.getText(outBuffer);
}

export fn editBufferInsertChar(edit_buffer: *edit_buffer_mod.EditBuffer, charPtr: [*]const u8, charLen: usize) void {
    const text = charPtr[0..charLen];
    edit_buffer.insertText(text) catch {};
}

export fn editBufferNewLine(edit_buffer: *edit_buffer_mod.EditBuffer) void {
    edit_buffer.insertText("\n") catch {};
}

export fn editBufferDeleteLine(edit_buffer: *edit_buffer_mod.EditBuffer) void {
    edit_buffer.deleteLine() catch {};
}

export fn editBufferGotoLine(edit_buffer: *edit_buffer_mod.EditBuffer, line: u32) void {
    edit_buffer.gotoLine(line) catch {};
}

export fn editBufferGetCursorPosition(edit_buffer: *edit_buffer_mod.EditBuffer, outPtr: *ExternalLogicalCursor) void {
    const pos = edit_buffer.getCursorPosition();
    outPtr.* = .{
        .row = pos.line,
        .col = pos.visual_col,
        .offset = pos.offset,
    };
}

export fn editBufferGetId(edit_buffer: *edit_buffer_mod.EditBuffer) u16 {
    return edit_buffer.getId();
}

export fn editBufferDebugLogRope(edit_buffer: *edit_buffer_mod.EditBuffer) void {
    edit_buffer.debugLogRope();
}

export fn editBufferUndo(edit_buffer: *edit_buffer_mod.EditBuffer, outPtr: [*]u8, maxLen: usize) usize {
    const prev_meta = edit_buffer.undo() catch return 0;
    const copyLen = @min(prev_meta.len, maxLen);
    @memcpy(outPtr[0..copyLen], prev_meta[0..copyLen]);
    return copyLen;
}

export fn editBufferRedo(edit_buffer: *edit_buffer_mod.EditBuffer, outPtr: [*]u8, maxLen: usize) usize {
    const next_meta = edit_buffer.redo() catch return 0;
    const copyLen = @min(next_meta.len, maxLen);
    @memcpy(outPtr[0..copyLen], next_meta[0..copyLen]);
    return copyLen;
}

export fn editBufferCanUndo(edit_buffer: *edit_buffer_mod.EditBuffer) bool {
    return edit_buffer.canUndo();
}

export fn editBufferCanRedo(edit_buffer: *edit_buffer_mod.EditBuffer) bool {
    return edit_buffer.canRedo();
}

export fn editBufferClearHistory(edit_buffer: *edit_buffer_mod.EditBuffer) void {
    edit_buffer.clearHistory();
}

export fn editBufferClear(edit_buffer: *edit_buffer_mod.EditBuffer) void {
    edit_buffer.clear() catch {};
}

// ===== EditorView Exports =====

export fn createEditorView(edit_buffer: *edit_buffer_mod.EditBuffer, viewport_width: u32, viewport_height: u32) ?*editor_view.EditorView {
    return editor_view.EditorView.init(globalArena, edit_buffer, viewport_width, viewport_height) catch null;
}

export fn destroyEditorView(view: *editor_view.EditorView) void {
    view.deinit();
}

export fn editorViewSetViewport(view: *editor_view.EditorView, x: u32, y: u32, width: u32, height: u32, moveCursor: bool) void {
    view.setViewport(.{ .x = x, .y = y, .width = width, .height = height }, moveCursor);
}

export fn editorViewClearViewport(view: *editor_view.EditorView) void {
    view.setViewport(null, false);
}

export fn editorViewGetViewport(view: *editor_view.EditorView, outX: *u32, outY: *u32, outWidth: *u32, outHeight: *u32) bool {
    if (view.getViewport()) |vp| {
        outX.* = vp.x;
        outY.* = vp.y;
        outWidth.* = vp.width;
        outHeight.* = vp.height;
        return true;
    }
    return false;
}

export fn editorViewSetScrollMargin(view: *editor_view.EditorView, margin: f32) void {
    view.setScrollMargin(margin);
}

export fn editorViewGetVirtualLineCount(view: *editor_view.EditorView) u32 {
    // TODO: There is a getter for that directly, no?
    return @intCast(view.getVirtualLines().len);
}

export fn editorViewGetTotalVirtualLineCount(view: *editor_view.EditorView) u32 {
    return view.getTotalVirtualLineCount();
}

export fn editorViewGetLineInfoDirect(view: *editor_view.EditorView, outPtr: *ExternalLineInfo) void {
    const line_info = view.getCachedLineInfo();
    outPtr.* = .{
        .start_cols_ptr = line_info.line_start_cols.ptr,
        .start_cols_len = @intCast(line_info.line_start_cols.len),
        .width_cols_ptr = line_info.line_width_cols.ptr,
        .width_cols_len = @intCast(line_info.line_width_cols.len),
        .sources_ptr = line_info.line_sources.ptr,
        .sources_len = @intCast(line_info.line_sources.len),
        .wraps_ptr = line_info.line_wraps.ptr,
        .wraps_len = @intCast(line_info.line_wraps.len),
        .width_cols_max = line_info.line_width_cols_max,
    };
}

export fn editorViewGetTextBufferView(view: *editor_view.EditorView) *text_buffer_view.UnifiedTextBufferView {
    return view.getTextBufferView();
}

export fn editorViewGetLogicalLineInfoDirect(view: *editor_view.EditorView, outPtr: *ExternalLineInfo) void {
    const line_info = view.getLogicalLineInfo();
    outPtr.* = .{
        .start_cols_ptr = line_info.line_start_cols.ptr,
        .start_cols_len = @intCast(line_info.line_start_cols.len),
        .width_cols_ptr = line_info.line_width_cols.ptr,
        .width_cols_len = @intCast(line_info.line_width_cols.len),
        .sources_ptr = line_info.line_sources.ptr,
        .sources_len = @intCast(line_info.line_sources.len),
        .wraps_ptr = line_info.line_wraps.ptr,
        .wraps_len = @intCast(line_info.line_wraps.len),
        .width_cols_max = line_info.line_width_cols_max,
    };
}

export fn editorViewSetViewportSize(view: *editor_view.EditorView, width: u32, height: u32) void {
    view.setViewportSize(width, height);
}

export fn editorViewSetWrapMode(view: *editor_view.EditorView, mode: u8) void {
    const wrapMode: text_buffer.WrapMode = switch (mode) {
        0 => .none,
        1 => .char,
        2 => .word,
        else => .none,
    };
    view.setWrapMode(wrapMode);
}

// EditorView selection methods - delegate to TextBufferView
export fn editorViewSetSelection(view: *editor_view.EditorView, start: u32, end: u32, bgColor: ?[*]const u16, fgColor: ?[*]const u16) void {
    view.text_buffer_view.setSelectionStyle(start, end, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
}

export fn editorViewResetSelection(view: *editor_view.EditorView) void {
    view.text_buffer_view.resetSelection();
}

export fn editorViewGetSelection(view: *editor_view.EditorView) u64 {
    return view.text_buffer_view.packSelectionInfo();
}

export fn editorViewSetLocalSelection(view: *editor_view.EditorView, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?[*]const u16, fgColor: ?[*]const u16, updateCursor: bool, followCursor: bool) bool {
    view.setSelectionFollowCursor(followCursor);
    const changed = view.text_buffer_view.setLocalSelectionStyle(anchorX, anchorY, focusX, focusY, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
    if (changed and updateCursor) {
        view.syncCursorToSelectionFocus();
    }
    return changed;
}

export fn editorViewUpdateSelection(view: *editor_view.EditorView, end: u32, bgColor: ?[*]const u16, fgColor: ?[*]const u16) void {
    view.text_buffer_view.updateSelectionStyle(end, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
}

export fn editorViewUpdateLocalSelection(view: *editor_view.EditorView, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?[*]const u16, fgColor: ?[*]const u16, updateCursor: bool, followCursor: bool) bool {
    view.setSelectionFollowCursor(followCursor);
    const changed = view.text_buffer_view.updateLocalSelectionStyle(anchorX, anchorY, focusX, focusY, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
    if (changed and updateCursor) {
        view.syncCursorToSelectionFocus();
    }
    return changed;
}

export fn editorViewResetLocalSelection(view: *editor_view.EditorView) void {
    view.setSelectionFollowCursor(false);
    view.text_buffer_view.resetLocalSelection();
}

export fn editorViewGetSelectedTextBytes(view: *editor_view.EditorView, outPtr: [*]u8, maxLen: usize) usize {
    const outBuffer = outPtr[0..maxLen];
    return view.text_buffer_view.getSelectedTextIntoBuffer(outBuffer);
}

// EditorView cursor and text methods
export fn editorViewGetCursor(view: *editor_view.EditorView, outRow: *u32, outCol: *u32) void {
    const cursor = view.getPrimaryCursor();
    outRow.* = cursor.row;
    outCol.* = cursor.col;
}

export fn editorViewGetText(view: *editor_view.EditorView, outPtr: [*]u8, maxLen: usize) usize {
    const outBuffer = outPtr[0..maxLen];
    return view.getText(outBuffer);
}

// ===== EditorView VisualCursor Exports =====

export fn editorViewGetVisualCursor(view: *editor_view.EditorView, outPtr: *ExternalVisualCursor) void {
    const vcursor = view.getVisualCursor();
    outPtr.* = .{
        .visual_row = vcursor.visual_row,
        .visual_col = vcursor.visual_col,
        .logical_row = vcursor.logical_row,
        .logical_col = vcursor.logical_col,
        .offset = vcursor.offset,
    };
}

export fn editorViewMoveUpVisual(view: *editor_view.EditorView) void {
    view.moveUpVisual();
}

export fn editorViewMoveDownVisual(view: *editor_view.EditorView) void {
    view.moveDownVisual();
}

export fn editorViewDeleteSelectedText(view: *editor_view.EditorView) void {
    view.deleteSelectedText() catch {};
}

export fn editorViewSetCursorByOffset(view: *editor_view.EditorView, offset: u32) void {
    view.setCursorByOffset(offset) catch {};
}

export fn editorViewGetNextWordBoundary(view: *editor_view.EditorView, outPtr: *ExternalVisualCursor) void {
    const vcursor = view.getNextWordBoundary();
    outPtr.* = .{
        .visual_row = vcursor.visual_row,
        .visual_col = vcursor.visual_col,
        .logical_row = vcursor.logical_row,
        .logical_col = vcursor.logical_col,
        .offset = vcursor.offset,
    };
}

export fn editorViewGetPrevWordBoundary(view: *editor_view.EditorView, outPtr: *ExternalVisualCursor) void {
    const vcursor = view.getPrevWordBoundary();
    outPtr.* = .{
        .visual_row = vcursor.visual_row,
        .visual_col = vcursor.visual_col,
        .logical_row = vcursor.logical_row,
        .logical_col = vcursor.logical_col,
        .offset = vcursor.offset,
    };
}

export fn editorViewGetEOL(view: *editor_view.EditorView, outPtr: *ExternalVisualCursor) void {
    const vcursor = view.getEOL();
    outPtr.* = .{
        .visual_row = vcursor.visual_row,
        .visual_col = vcursor.visual_col,
        .logical_row = vcursor.logical_row,
        .logical_col = vcursor.logical_col,
        .offset = vcursor.offset,
    };
}

export fn editorViewGetVisualSOL(view: *editor_view.EditorView, outPtr: *ExternalVisualCursor) void {
    const vcursor = view.getVisualSOL();
    outPtr.* = .{
        .visual_row = vcursor.visual_row,
        .visual_col = vcursor.visual_col,
        .logical_row = vcursor.logical_row,
        .logical_col = vcursor.logical_col,
        .offset = vcursor.offset,
    };
}

export fn editorViewGetVisualEOL(view: *editor_view.EditorView, outPtr: *ExternalVisualCursor) void {
    const vcursor = view.getVisualEOL();
    outPtr.* = .{
        .visual_row = vcursor.visual_row,
        .visual_col = vcursor.visual_col,
        .logical_row = vcursor.logical_row,
        .logical_col = vcursor.logical_col,
        .offset = vcursor.offset,
    };
}

export fn editorViewSetPlaceholderStyledText(
    view: *editor_view.EditorView,
    chunksPtr: [*]const text_buffer.StyledChunk,
    chunkCount: usize,
) void {
    if (chunkCount == 0) {
        view.setPlaceholderStyledText(&[_]text_buffer.StyledChunk{}) catch {};
        return;
    }
    const chunks = chunksPtr[0..chunkCount];
    view.setPlaceholderStyledText(chunks) catch {};
}

export fn editorViewSetTabIndicator(view: *editor_view.EditorView, indicator: u32) void {
    view.setTabIndicator(indicator);
}

export fn editorViewSetTabIndicatorColor(view: *editor_view.EditorView, color: [*]const u16) void {
    view.setTabIndicatorColor(ptrToRGBA(color));
}

export fn bufferDrawEditorView(
    bufferPtr: *buffer.OptimizedBuffer,
    viewPtr: *editor_view.EditorView,
    x: i32,
    y: i32,
) void {
    bufferPtr.drawEditorView(viewPtr, x, y);
}

export fn bufferDrawTextBufferView(
    bufferPtr: *buffer.OptimizedBuffer,
    viewPtr: *text_buffer_view.UnifiedTextBufferView,
    x: i32,
    y: i32,
) void {
    bufferPtr.drawTextBuffer(viewPtr, x, y);
}

pub const ExternalHighlight = extern struct {
    start: u32,
    end: u32,
    style_id: u32,
    priority: u8,
    hl_ref: u16,
};

pub const ExternalLogicalCursor = extern struct {
    row: u32,
    col: u32,
    offset: u32,
};

pub const ExternalVisualCursor = extern struct {
    visual_row: u32,
    visual_col: u32,
    logical_row: u32,
    logical_col: u32,
    offset: u32,
};

pub const ExternalLineInfo = extern struct {
    start_cols_ptr: [*]const u32,
    start_cols_len: u32,
    width_cols_ptr: [*]const u32,
    width_cols_len: u32,
    sources_ptr: [*]const u32,
    sources_len: u32,
    wraps_ptr: [*]const u32,
    wraps_len: u32,
    width_cols_max: u32,
};

export fn textBufferAddHighlightByCharRange(
    tb: *text_buffer.UnifiedTextBuffer,
    hl_ptr: [*]const ExternalHighlight,
) void {
    const hl = hl_ptr[0];
    // For char-range highlights, start/end in the struct are unused (passed as char_start/char_end)
    tb.addHighlightByCharRange(hl.start, hl.end, hl.style_id, hl.priority, hl.hl_ref) catch {};
}

export fn textBufferAddHighlight(
    tb: *text_buffer.UnifiedTextBuffer,
    line_idx: u32,
    hl_ptr: [*]const ExternalHighlight,
) void {
    const hl = hl_ptr[0];
    // For line-based highlights, start/end are column offsets
    tb.addHighlight(line_idx, hl.start, hl.end, hl.style_id, hl.priority, hl.hl_ref) catch {};
}

export fn textBufferRemoveHighlightsByRef(tb: *text_buffer.UnifiedTextBuffer, hl_ref: u16) void {
    tb.removeHighlightsByRef(hl_ref);
}

export fn textBufferClearLineHighlights(tb: *text_buffer.UnifiedTextBuffer, line_idx: u32) void {
    tb.clearLineHighlights(line_idx);
}

export fn textBufferClearAllHighlights(tb: *text_buffer.UnifiedTextBuffer) void {
    tb.clearAllHighlights();
}

export fn textBufferSetSyntaxStyle(tb: *text_buffer.UnifiedTextBuffer, style: ?*syntax_style.SyntaxStyle) void {
    tb.setSyntaxStyle(style);
}

export fn textBufferGetLineHighlightsPtr(
    tb: *text_buffer.UnifiedTextBuffer,
    line_idx: u32,
    out_count: *usize,
) ?[*]const ExternalHighlight {
    const highs = tb.getLineHighlightsSlice(@intCast(line_idx));

    if (highs.len == 0) {
        out_count.* = 0;
        return null;
    }

    var slice = globalAllocator.alloc(ExternalHighlight, highs.len) catch return null;

    for (highs, 0..) |hl, i| {
        slice[i] = .{
            .start = hl.col_start,
            .end = hl.col_end,
            .style_id = hl.style_id,
            .priority = hl.priority,
            .hl_ref = hl.hl_ref,
        };
    }

    out_count.* = highs.len;
    return slice.ptr;
}

export fn textBufferFreeLineHighlights(ptr: [*]const ExternalHighlight, count: usize) void {
    globalAllocator.free(@constCast(ptr)[0..count]);
}

export fn textBufferGetHighlightCount(tb: *text_buffer.UnifiedTextBuffer) u32 {
    return tb.getHighlightCount();
}

export fn textBufferGetTextRange(tb: *text_buffer.UnifiedTextBuffer, start_offset: u32, end_offset: u32, outPtr: [*]u8, maxLen: usize) usize {
    const outBuffer = outPtr[0..maxLen];
    return tb.getTextRange(start_offset, end_offset, outBuffer);
}

export fn textBufferGetTextRangeByCoords(tb: *text_buffer.UnifiedTextBuffer, start_row: u32, start_col: u32, end_row: u32, end_col: u32, outPtr: [*]u8, maxLen: usize) usize {
    const outBuffer = outPtr[0..maxLen];
    return tb.getTextRangeByCoords(start_row, start_col, end_row, end_col, outBuffer);
}

// SyntaxStyle functions
export fn createSyntaxStyle() ?*syntax_style.SyntaxStyle {
    return syntax_style.SyntaxStyle.init(globalAllocator) catch |err| {
        logger.err("Failed to create SyntaxStyle: {}", .{err});
        return null;
    };
}

export fn destroySyntaxStyle(style: *syntax_style.SyntaxStyle) void {
    style.deinit();
}

export fn syntaxStyleRegister(style: *syntax_style.SyntaxStyle, namePtr: [*]const u8, nameLen: usize, fg: ?[*]const u16, bg: ?[*]const u16, attributes: u32) u32 {
    const name = namePtr[0..nameLen];
    return style.registerStyleDefinition(name, .{
        .fg = optionalPtrToRGBA(fg),
        .bg = optionalPtrToRGBA(bg),
        .attributes = attributes,
    }) catch 0;
}

export fn syntaxStyleResolveByName(style: *syntax_style.SyntaxStyle, namePtr: [*]const u8, nameLen: usize) u32 {
    const name = namePtr[0..nameLen];
    return style.resolveByName(name) orelse 0;
}

export fn syntaxStyleGetStyleCount(style: *syntax_style.SyntaxStyle) usize {
    return style.getStyleCount();
}

// Unicode encoding API

pub const EncodedChar = extern struct {
    width: u8,
    char: u32,
};

export fn encodeUnicode(
    textPtr: [*]const u8,
    textLen: usize,
    outPtr: *[*]EncodedChar,
    outLenPtr: *usize,
    widthMethod: u8,
) bool {
    const text = textPtr[0..textLen];
    const pool = gp.initGlobalPool(globalArena);
    const wMethod: utf8.WidthMethod = if (widthMethod == 0) .wcwidth else .unicode;

    // Check if ASCII only for optimization
    const is_ascii_only = utf8.isAsciiOnly(text);

    // Find grapheme info
    var grapheme_list: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer grapheme_list.deinit(globalAllocator);

    const tab_width: u8 = 2;
    utf8.findGraphemeInfo(globalAllocator, text, tab_width, is_ascii_only, wMethod, &grapheme_list) catch return false;
    const specials = grapheme_list.items;

    // Allocate output array
    const estimated_count = if (is_ascii_only) text.len else text.len * 2;
    var result = globalAllocator.alloc(EncodedChar, estimated_count) catch return false;
    var result_idx: usize = 0;
    var success = false;
    var pending_gid: ?u32 = null; // Track grapheme allocated but not yet stored in result

    // Clean up result array and any allocated grapheme IDs on failure
    defer {
        if (!success) {
            // Clean up pending grapheme that wasn't stored yet
            if (pending_gid) |gid| {
                // Try decref first (works if incref was called, refcount >= 1)
                // If that fails (refcount was 0), use freeUnreferenced
                pool.decref(gid) catch {
                    pool.freeUnreferenced(gid) catch {};
                };
            }
            // Decref any grapheme IDs we allocated before the failure
            for (result[0..result_idx]) |encoded_char| {
                if (gp.isGraphemeChar(encoded_char.char)) {
                    const gid = gp.graphemeIdFromChar(encoded_char.char);
                    pool.decref(gid) catch {};
                }
            }
            globalAllocator.free(result);
        }
    }

    var byte_offset: u32 = 0;
    var col: u32 = 0;
    var special_idx: usize = 0;

    while (byte_offset < text.len) {
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

        const cell_width = utf8.getWidthAt(text, if (at_special) specials[special_idx - 1].byte_offset else byte_offset - 1, tab_width, wMethod);
        if (cell_width == 0) {
            col += g_width;
            continue;
        }

        // Encode the character
        var encoded_char: u32 = 0;
        if (grapheme_bytes.len == 1 and cell_width == 1 and grapheme_bytes[0] >= 32) {
            // Simple ASCII character
            encoded_char = @as(u32, grapheme_bytes[0]);
        } else {
            // Multi-byte or special character - allocate in pool
            const gid = pool.alloc(grapheme_bytes) catch return false;
            pending_gid = gid; // Track until stored in result
            encoded_char = gp.packGraphemeStart(gid & gp.GRAPHEME_ID_MASK, cell_width);

            // Incref since we're handing this off to the caller
            // Note: incref can only fail if gid is invalid, which shouldn't happen
            // for a freshly allocated gid. If it does fail, the slot leaks but
            // this is an edge case that indicates a bug elsewhere.
            pool.incref(gid) catch return false;
        }

        // Ensure we have space
        if (result_idx >= result.len) {
            const new_len = result.len * 2;
            result = globalAllocator.realloc(result, new_len) catch return false;
        }

        result[result_idx] = EncodedChar{
            .width = @intCast(cell_width),
            .char = encoded_char,
        };
        pending_gid = null; // Successfully stored, no longer pending
        result_idx += 1;
        col += g_width;
    }

    // Trim to actual size
    result = globalAllocator.realloc(result, result_idx) catch result;

    outPtr.* = result.ptr;
    outLenPtr.* = result_idx;
    success = true;
    return true;
}

export fn freeUnicode(charsPtr: [*]const EncodedChar, charsLen: usize) void {
    const chars = charsPtr[0..charsLen];
    const pool = gp.initGlobalPool(globalArena);

    for (chars) |encoded_char| {
        const char = encoded_char.char;

        // Check if this is a packed grapheme
        if (gp.isGraphemeChar(char)) {
            const gid = gp.graphemeIdFromChar(char);
            pool.decref(gid) catch {};
        }
    }

    // Free the array itself
    globalAllocator.free(chars);
}

export fn bufferDrawChar(
    bufferPtr: *buffer.OptimizedBuffer,
    char: u32,
    x: u32,
    y: u32,
    fg: [*]const u16,
    bg: [*]const u16,
    attributes: u32,
) void {
    bufferPtr.drawChar(char, x, y, ptrToRGBA(fg), ptrToRGBA(bg), attributes);
}
