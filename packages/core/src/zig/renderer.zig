const std = @import("std");
const Allocator = std.mem.Allocator;
const ansi = @import("ansi.zig");
const buf = @import("buffer.zig");
const gp = @import("grapheme.zig");
const link = @import("link.zig");
const split_scrollback = @import("split-scrollback.zig");
const Terminal = @import("terminal.zig");
const logger = @import("logger.zig");
const NativeSpanFeed = @import("native-span-feed.zig");
const output = @import("renderer-output.zig");

pub const RGBA = ansi.RGBA;
pub const OptimizedBuffer = buf.OptimizedBuffer;
pub const TextAttributes = ansi.TextAttributes;
pub const CursorStyle = Terminal.CursorStyle;
pub const OutputBackend = output.OutputBackend;
pub const BufferedBackend = output.BufferedBackend;
pub const BufferedOutput = output.BufferedOutput;
pub const StdoutOutput = output.StdoutOutput;
pub const FeedBackend = output.FeedBackend;
pub const OUTPUT_BUFFER_SIZE = output.OUTPUT_BUFFER_SIZE;

pub const RenderStatus = enum(u8) {
    rendered = 0,
    skipped = 1,
    failed = 2,
};

pub const RenderResult = struct {
    renderOffset: u32,
    status: RenderStatus,
};

const CLEAR_CHAR = '\u{0a00}';
const MAX_STAT_SAMPLES = 30;
const STAT_SAMPLE_CAPACITY = 30;

pub const RendererError = error{
    OutOfMemory,
    InvalidDimensions,
    ThreadingFailed,
    WriteFailed,
};

pub const DebugOverlayCorner = enum {
    topLeft,
    topRight,
    bottomLeft,
    bottomRight,
};

fn moveToSplitOutputCursor(writer: anytype, render_offset: u32, output_column: u32, width: u32) void {
    const safe_width = @max(width, @as(u32, 1));
    const row: u32 = if (render_offset > 0) render_offset else 1;
    const column: u32 = if (render_offset == 0 or output_column == 0)
        1
    else
        @min(output_column + 1, safe_width);

    ansi.ANSI.moveToOutput(writer, column, row) catch {};
}

fn snapshotRowEnd(snapshot: *const OptimizedBuffer, row: u32, limit: u32) u32 {
    var x = limit;
    while (x > 0) {
        const cell = snapshot.get(x - 1, row) orelse {
            x -= 1;
            continue;
        };

        if (cell.char == 0 or gp.isContinuationChar(cell.char)) {
            x -= 1;
            continue;
        }

        return x;
    }

    return 0;
}

pub const SplitFooterTransitionMode = enum(u8) {
    none = 0,
    viewport_scroll = 1,
    clear_stale_rows = 2,
};

pub const RenderStatsSnapshot = struct {
    lastFrameTime: f64,
    averageFrameTime: f64,
    frameCount: u64,
    cellsUpdated: u32,
    averageCellsUpdated: u32,
    renderTime: ?f64,
    outputWriteTime: ?f64,
};

const SplitFooterTransition = struct {
    mode: SplitFooterTransitionMode = .none,
    source_top_line: u32 = 0,
    source_height: u32 = 0,
    target_top_line: u32 = 0,
    target_height: u32 = 0,
    scroll_lines: u32 = 0,

    fn clear(self: *SplitFooterTransition) void {
        self.* = .{};
    }
};

pub const CliRenderer = struct {
    width: u32,
    height: u32,
    currentRenderBuffer: *OptimizedBuffer,
    nextRenderBuffer: *OptimizedBuffer,
    pool: *gp.GraphemePool,
    backgroundColor: RGBA,
    renderOffset: u32,
    terminal: Terminal,
    useAlternateScreen: bool = true,
    terminalSetup: bool = false,
    clearOnShutdown: bool = true,

    splitScrollback: split_scrollback.SplitScrollback = .{},
    // Batch state for split-footer commit flushing. A single JS render tick can
    // enqueue multiple stdout snapshots; batching keeps all of them inside one
    // sync frame so terminals do not repeatedly enter/exit synchronized update.
    splitBatchActive: bool = false,
    splitBatchRedrawFooter: bool = false,
    splitBatchDeltaTime: f64 = 0,
    pendingSplitFooterTransition: SplitFooterTransition = .{},

    /// Output transport. Owned by the renderer; destroyed in `destroy()`.
    backend: OutputBackend,

    renderStats: struct {
        lastFrameTime: f64,
        averageFrameTime: f64,
        frameCount: u64,
        fps: u32,
        cellsUpdated: u32,
        renderTime: ?f64,
        overallFrameTime: ?f64,
        bufferResetTime: ?f64,
        outputWriteTime: ?f64,
        heapUsed: u32,
        heapTotal: u32,
        arrayBuffers: u32,
        frameCallbackTime: ?f64,
    },
    statSamples: struct {
        lastFrameTime: std.ArrayListUnmanaged(f64),
        renderTime: std.ArrayListUnmanaged(f64),
        overallFrameTime: std.ArrayListUnmanaged(f64),
        bufferResetTime: std.ArrayListUnmanaged(f64),
        outputWriteTime: std.ArrayListUnmanaged(f64),
        cellsUpdated: std.ArrayListUnmanaged(u32),
        frameCallbackTime: std.ArrayListUnmanaged(f64),
    },
    lastRenderTime: i64,
    allocator: Allocator,
    writeOutBuf: [1024]u8 = undefined,
    debugOverlay: struct {
        enabled: bool,
        corner: DebugOverlayCorner,
    } = .{
        .enabled = false,
        .corner = .bottomRight,
    },

    // Hit grid for mouse event dispatch.
    //
    // The hit grid is a screen-sized array where each cell stores the renderable ID
    // at that position. Mouse events query checkHit(x, y) to find which element to
    // dispatch to.
    //
    // Double buffering: During render, addToHitGrid writes to nextHitGrid. After
    // render completes, the buffers swap. This keeps hit testing consistent during
    // a frame. Queries see the previous frame's state, not a half-built grid.
    //
    // On-demand sync: When scroll/translate changes between renders, the TypeScript
    // layer can rebuild currentHitGrid directly via addToCurrentHitGridClipped. This
    // updates hover states immediately rather than waiting for the next render.
    //
    // Scissor clipping: The hitScissorStack mirrors overflow:hidden regions. Elements
    // outside their parent's visible area are excluded from hit testing. The stack
    // uses screen coordinates. Buffered renderables need getHitGridScissorRect() to
    // convert from buffer-local (0,0) to their actual screen position.
    currentHitGrid: []u32,
    nextHitGrid: []u32,
    hitGridWidth: u32,
    hitGridHeight: u32,
    hitScissorStack: std.ArrayListUnmanaged(buf.ClipRect),
    hitGridDirty: bool = false,
    hitGridResizeInvalidated: bool = false,

    lastCursorStyleTag: ?u8 = null,
    lastCursorBlinking: ?bool = null,
    lastCursorColorRGB: ?[3]u8 = null,
    // Cursor diff cache. If nothing changed we avoid emitting cursor restore/show
    // sequences for no-op frames, which removes a major source of visible flicker.
    lastCursorX: ?u32 = null,
    lastCursorY: ?u32 = null,
    lastCursorVisible: ?bool = null,
    lastMousePointerStyle: Terminal.MousePointerStyle = .default,
    palette_rgba: [256]RGBA,
    default_fg_rgba: RGBA,
    default_bg_rgba: RGBA,
    palette_epoch: u32,
    last_rendered_palette_epoch: ?u32 = null,
    force_full_repaint: bool = false,
    palette_index_cache: std.AutoHashMapUnmanaged(u64, u8) = .{},

    pub const OutputTarget = union(enum) {
        stdout,
        memory,
        buffered: BufferedOutput,
        feed: *NativeSpanFeed.Stream,
    };

    /// Full set of options for `createWithOptions`. `output` determines the
    /// backend variant: buffered stdout, injected buffered output, or feed.
    pub const CreateOptions = struct {
        remote_mode: Terminal.RemoteMode = .local,
        output: OutputTarget = .stdout,
        clearOnShutdown: bool = true,
    };

    pub fn create(allocator: Allocator, width: u32, height: u32, pool: *gp.GraphemePool) !*CliRenderer {
        return createWithOptions(allocator, width, height, pool, .{});
    }

    pub fn createWithOptions(
        allocator: Allocator,
        width: u32,
        height: u32,
        pool: *gp.GraphemePool,
        opts: CreateOptions,
    ) !*CliRenderer {
        const self = try allocator.create(CliRenderer);
        errdefer allocator.destroy(self);

        const currentBuffer = try OptimizedBuffer.init(allocator, width, height, .{ .pool = pool, .width_method = .unicode, .id = "current buffer" });
        errdefer currentBuffer.deinit();
        const nextBuffer = try OptimizedBuffer.init(allocator, width, height, .{ .pool = pool, .width_method = .unicode, .id = "next buffer" });
        errdefer nextBuffer.deinit();

        // stat sample arrays
        var lastFrameTime: std.ArrayListUnmanaged(f64) = .{};
        errdefer lastFrameTime.deinit(allocator);
        var renderTime: std.ArrayListUnmanaged(f64) = .{};
        errdefer renderTime.deinit(allocator);
        var overallFrameTime: std.ArrayListUnmanaged(f64) = .{};
        errdefer overallFrameTime.deinit(allocator);
        var bufferResetTime: std.ArrayListUnmanaged(f64) = .{};
        errdefer bufferResetTime.deinit(allocator);
        var outputWriteTime: std.ArrayListUnmanaged(f64) = .{};
        errdefer outputWriteTime.deinit(allocator);
        var cellsUpdated: std.ArrayListUnmanaged(u32) = .{};
        errdefer cellsUpdated.deinit(allocator);
        var frameCallbackTimes: std.ArrayListUnmanaged(f64) = .{};
        errdefer frameCallbackTimes.deinit(allocator);

        try lastFrameTime.ensureTotalCapacity(allocator, STAT_SAMPLE_CAPACITY);
        try renderTime.ensureTotalCapacity(allocator, STAT_SAMPLE_CAPACITY);
        try overallFrameTime.ensureTotalCapacity(allocator, STAT_SAMPLE_CAPACITY);
        try bufferResetTime.ensureTotalCapacity(allocator, STAT_SAMPLE_CAPACITY);
        try outputWriteTime.ensureTotalCapacity(allocator, STAT_SAMPLE_CAPACITY);
        try cellsUpdated.ensureTotalCapacity(allocator, STAT_SAMPLE_CAPACITY);
        try frameCallbackTimes.ensureTotalCapacity(allocator, STAT_SAMPLE_CAPACITY);

        const hitGridSize = width * height;
        const currentHitGrid = try allocator.alloc(u32, hitGridSize);
        errdefer allocator.free(currentHitGrid);
        const nextHitGrid = try allocator.alloc(u32, hitGridSize);
        errdefer allocator.free(nextHitGrid);
        @memset(currentHitGrid, 0); // Initialize with 0 (no renderable)
        @memset(nextHitGrid, 0);
        const hitScissorStack: std.ArrayListUnmanaged(buf.ClipRect) = .{};

        // Backend variant selected once by opts.output.
        var backend: OutputBackend = switch (opts.output) {
            .stdout => .{ .buffered = try BufferedBackend.createStdout(allocator) },
            .memory => .{ .buffered = try BufferedBackend.createMemory(allocator) },
            .buffered => |buffered_output| .{ .buffered = try BufferedBackend.create(allocator, buffered_output) },
            .feed => |feed_ptr| .{ .feed = FeedBackend.create(feed_ptr) },
        };
        errdefer backend.deinit(allocator);

        self.* = .{
            .width = width,
            .height = height,
            .currentRenderBuffer = currentBuffer,
            .nextRenderBuffer = nextBuffer,
            .pool = pool,
            .backgroundColor = ansi.rgbColor(0, 0, 0, 0),
            .renderOffset = 0,
            .terminal = Terminal.init(.{ .remote_mode = opts.remote_mode }),
            .clearOnShutdown = opts.clearOnShutdown,
            .backend = backend,
            .lastCursorStyleTag = null,
            .lastCursorBlinking = null,
            .lastCursorColorRGB = null,

            .renderStats = .{
                .lastFrameTime = 0,
                .averageFrameTime = 0,
                .frameCount = 0,
                .fps = 0,
                .cellsUpdated = 0,
                .renderTime = null,
                .overallFrameTime = null,
                .bufferResetTime = null,
                .outputWriteTime = null,
                .heapUsed = 0,
                .heapTotal = 0,
                .arrayBuffers = 0,
                .frameCallbackTime = null,
            },
            .statSamples = .{
                .lastFrameTime = lastFrameTime,
                .renderTime = renderTime,
                .overallFrameTime = overallFrameTime,
                .bufferResetTime = bufferResetTime,
                .outputWriteTime = outputWriteTime,
                .cellsUpdated = cellsUpdated,
                .frameCallbackTime = frameCallbackTimes,
            },
            .lastRenderTime = std.time.microTimestamp(),
            .allocator = allocator,
            .currentHitGrid = currentHitGrid,
            .nextHitGrid = nextHitGrid,
            .hitGridWidth = width,
            .hitGridHeight = height,
            .hitScissorStack = hitScissorStack,
            .palette_rgba = undefined,
            .default_fg_rgba = ansi.defaultColor(255, 255, 255, 255),
            .default_bg_rgba = ansi.defaultColor(0, 0, 0, 255),
            .palette_epoch = 0,
        };

        self.resetFallbackPaletteState();
        nextBuffer.setBlendBackdropColor(ansi.rgbColor(ansi.red(self.backgroundColor), ansi.green(self.backgroundColor), ansi.blue(self.backgroundColor), 255));

        currentBuffer.clear(self.backgroundColor, CLEAR_CHAR);
        nextBuffer.clear(self.backgroundColor, null);

        return self;
    }

    pub fn destroy(self: *CliRenderer) void {
        // Order matters: performShutdownSequence writes cleanup ANSI through
        // the backend. backend.deinit then joins the render thread using a
        // terminate-only signal (no renderRequested) so the thread exits
        // without replaying the stale last-frame buffer on top of the
        // freshly-restored terminal.
        self.performShutdownSequence();
        self.backend.deinit(self.allocator);
        self.terminal.deinit();

        self.currentRenderBuffer.deinit();
        self.nextRenderBuffer.deinit();

        // Free stat sample arrays
        self.statSamples.lastFrameTime.deinit(self.allocator);
        self.statSamples.renderTime.deinit(self.allocator);
        self.statSamples.overallFrameTime.deinit(self.allocator);
        self.statSamples.bufferResetTime.deinit(self.allocator);
        self.statSamples.outputWriteTime.deinit(self.allocator);
        self.statSamples.cellsUpdated.deinit(self.allocator);
        self.statSamples.frameCallbackTime.deinit(self.allocator);
        self.palette_index_cache.deinit(self.allocator);

        self.allocator.free(self.currentHitGrid);
        self.allocator.free(self.nextHitGrid);
        self.hitScissorStack.deinit(self.allocator);

        self.allocator.destroy(self);
    }

    pub fn setupTerminal(self: *CliRenderer, useAlternateScreen: bool) void {
        self.useAlternateScreen = useAlternateScreen;
        self.terminalSetup = true;

        // Build capability query into a stack buffer, then emit via backend.
        // Buffer sized to accommodate all capability-query sequences with margin.
        var queryBuf: [4096]u8 = undefined;
        var stream = std.io.fixedBufferStream(&queryBuf);
        self.terminal.queryTerminalSend(stream.writer()) catch {
            logger.warn("Failed to query terminal capabilities", .{});
        };
        self.backend.writeOut(stream.getWritten());

        self.setupTerminalWithoutDetection(useAlternateScreen, true);
    }

    fn setupTerminalWithoutDetection(self: *CliRenderer, useAlternateScreen: bool, reserve_non_alt_surface: bool) void {
        var setupBuf: [4096]u8 = undefined;
        var stream = std.io.fixedBufferStream(&setupBuf);
        const writer = stream.writer();

        writer.writeAll(ansi.ANSI.saveCursorState) catch {};

        if (useAlternateScreen) {
            self.terminal.enterAltScreen(writer) catch {};
        } else if (reserve_non_alt_surface) {
            ansi.ANSI.makeRoomForRendererOutput(writer, @max(self.height, 1)) catch {};
        }

        self.terminal.setCursorPosition(1, 1, false);
        const useKitty = self.terminal.opts.kitty_keyboard_flags > 0;
        self.terminal.enableDetectedFeatures(writer, useKitty) catch {};

        self.backend.writeOut(stream.getWritten());
    }

    pub fn suspendRenderer(self: *CliRenderer) void {
        if (!self.terminalSetup) return;
        self.performShutdownSequence();
    }

    pub fn resumeRenderer(self: *CliRenderer) void {
        if (!self.terminalSetup) return;
        self.setupTerminalWithoutDetection(self.useAlternateScreen, self.renderOffset == 0);
    }

    fn clearSplitFooterSurface(self: *CliRenderer, writer: anytype) void {
        if (self.renderOffset == 0) return;

        const footer_top_line = @max(self.renderOffset + 1, @as(u32, 1));
        writer.writeAll("\x1b[r") catch {};
        ansi.ANSI.moveToOutput(writer, 1, footer_top_line) catch {};
        writer.writeAll(ansi.ANSI.eraseBelowCursor) catch {};
        ansi.ANSI.moveToOutput(writer, 1, footer_top_line) catch {};
    }

    pub fn performShutdownSequence(self: *CliRenderer) void {
        if (!self.terminalSetup) return;

        // Build the shutdown ANSI sequence into a stack buffer, then emit.
        var shutdownBuf: [4096]u8 = undefined;
        var stream = std.io.fixedBufferStream(&shutdownBuf);
        const writer = stream.writer();

        self.terminal.resetState(writer) catch {
            logger.warn("Failed to reset terminal state", .{});
        };

        if (self.useAlternateScreen) {
            // Alt screen: resetState already exited alt screen; just flush.
        } else if (self.clearOnShutdown and self.renderOffset == 0) {
            writer.writeAll("\x1b[H\x1b[J") catch {};
        } else if (self.clearOnShutdown and self.renderOffset > 0) {
            self.clearSplitFooterSurface(writer);
        }

        // NOTE: This messes up state after shutdown, but might be necessary for windows?
        // writer.writeAll(ansi.ANSI.restoreCursorState) catch {};

        writer.writeAll(ansi.ANSI.resetCursorColorFallback) catch {};
        writer.writeAll(ansi.ANSI.resetCursorColor) catch {};
        writer.writeAll(ansi.ANSI.defaultCursorStyle) catch {};
        writer.writeAll(ansi.ANSI.showCursor) catch {};

        self.backend.writeOut(stream.getWritten());

        // Workaround for Ghostty not showing the cursor after shutdown for some reason.
        // Keep this backend-agnostic: the active output transport owns delivery.
        std.Thread.sleep(10 * std.time.ns_per_ms);
        self.backend.writeOut(ansi.ANSI.showCursor);
        std.Thread.sleep(10 * std.time.ns_per_ms);
    }

    pub fn setClearOnShutdown(self: *CliRenderer, clear: bool) void {
        self.clearOnShutdown = clear;
    }

    fn addStatSample(self: *CliRenderer, comptime T: type, samples: *std.ArrayListUnmanaged(T), value: T) void {
        samples.append(self.allocator, value) catch return;

        if (samples.items.len > MAX_STAT_SAMPLES) {
            _ = samples.orderedRemove(0);
        }
    }

    fn getStatAverage(comptime T: type, samples: *const std.ArrayListUnmanaged(T)) T {
        if (samples.items.len == 0) {
            return 0;
        }

        var sum: T = 0;
        for (samples.items) |value| {
            sum += value;
        }

        if (@typeInfo(T) == .float) {
            return sum / @as(T, @floatFromInt(samples.items.len));
        } else {
            return sum / @as(T, @intCast(samples.items.len));
        }
    }

    fn collectFrameStats(self: *CliRenderer, deltaTime: f64) void {
        if (self.backend.getLastWriteTimeUs()) |wt| {
            self.renderStats.outputWriteTime = wt;
        }

        self.renderStats.lastFrameTime = deltaTime * 1000.0;
        self.renderStats.frameCount += 1;

        self.addStatSample(f64, &self.statSamples.lastFrameTime, deltaTime * 1000.0);
        if (self.renderStats.renderTime) |rt| {
            self.addStatSample(f64, &self.statSamples.renderTime, rt);
        }
        if (self.renderStats.bufferResetTime) |brt| {
            self.addStatSample(f64, &self.statSamples.bufferResetTime, brt);
        }
        if (self.renderStats.outputWriteTime) |swt| {
            self.addStatSample(f64, &self.statSamples.outputWriteTime, swt);
        }
        self.addStatSample(u32, &self.statSamples.cellsUpdated, self.renderStats.cellsUpdated);
    }

    pub fn setUseThread(self: *CliRenderer, useThread: bool) void {
        if (!self.backend.supportsThreading() and useThread) return;
        self.backend.setUseThread(useThread);
    }

    /// Whether the backend is currently running a write thread (for debug overlay).
    pub fn isUseThread(self: *CliRenderer) bool {
        return self.backend.isUseThread();
    }

    pub fn updateStats(self: *CliRenderer, time: f64, fps: u32, frameCallbackTime: f64) void {
        self.renderStats.overallFrameTime = time;
        self.renderStats.fps = fps;
        self.renderStats.frameCallbackTime = frameCallbackTime;

        self.addStatSample(f64, &self.statSamples.overallFrameTime, time);
        self.addStatSample(f64, &self.statSamples.frameCallbackTime, frameCallbackTime);
    }

    pub fn updateMemoryStats(self: *CliRenderer, heapUsed: u32, heapTotal: u32, arrayBuffers: u32) void {
        self.renderStats.heapUsed = heapUsed;
        self.renderStats.heapTotal = heapTotal;
        self.renderStats.arrayBuffers = arrayBuffers;
    }

    pub fn getRenderStats(self: *const CliRenderer) RenderStatsSnapshot {
        return .{
            .lastFrameTime = self.renderStats.lastFrameTime,
            .averageFrameTime = getStatAverage(f64, &self.statSamples.lastFrameTime),
            .frameCount = self.renderStats.frameCount,
            .cellsUpdated = self.renderStats.cellsUpdated,
            .averageCellsUpdated = getStatAverage(u32, &self.statSamples.cellsUpdated),
            .renderTime = self.renderStats.renderTime,
            .outputWriteTime = self.renderStats.outputWriteTime,
        };
    }

    pub fn resize(self: *CliRenderer, width: u32, height: u32) !void {
        if (self.width == width and self.height == height) return;

        self.width = width;
        self.height = height;

        try self.currentRenderBuffer.resize(width, height);
        try self.nextRenderBuffer.resize(width, height);
        self.nextRenderBuffer.setBlendBackdropColor(ansi.rgbColor(ansi.red(self.backgroundColor), ansi.green(self.backgroundColor), ansi.blue(self.backgroundColor), 255));

        self.currentRenderBuffer.clear(ansi.rgbColor(0, 0, 0, 255), CLEAR_CHAR);
        self.nextRenderBuffer.clear(self.backgroundColor, null);

        const newHitGridSize = width * height;
        const currentHitGridSize = self.hitGridWidth * self.hitGridHeight;
        if (newHitGridSize > currentHitGridSize) {
            const newCurrentHitGrid = try self.allocator.alloc(u32, newHitGridSize);
            errdefer self.allocator.free(newCurrentHitGrid);
            const newNextHitGrid = try self.allocator.alloc(u32, newHitGridSize);

            self.allocator.free(self.currentHitGrid);
            self.allocator.free(self.nextHitGrid);
            self.currentHitGrid = newCurrentHitGrid;
            self.nextHitGrid = newNextHitGrid;
        }

        @memset(self.currentHitGrid, 0);
        @memset(self.nextHitGrid, 0);
        self.hitGridResizeInvalidated = true;

        // Always update dimensions. The backing buffer is at least as large as
        // width*height, so this is safe even when the terminal shrinks. Without
        // this, checkHit keeps using stale dimensions after a shrink and returns
        // 0 for any coordinate beyond the old bounds.
        self.hitGridWidth = width;
        self.hitGridHeight = height;

        const cursor = self.terminal.getCursorPosition();
        self.terminal.setCursorPosition(@min(cursor.x, width), @min(cursor.y, height), cursor.visible);
    }

    pub fn setBackgroundColor(self: *CliRenderer, rgba: RGBA) void {
        self.backgroundColor = rgba;
        self.nextRenderBuffer.setBlendBackdropColor(ansi.rgbColor(ansi.red(rgba), ansi.green(rgba), ansi.blue(rgba), 255));

        // Do not mirror renderer background to terminal default background via
        // OSC 11 for now. In Ghostty, once OSC 11 has been used, later system
        // light/dark theme changes can leave OSC 11 queries stuck on stale bg
        // values even after OSC 111 resets. Theme detection relies on fresh
        // OSC 10/11 replies, so mutating terminal default bg here breaks that.
    }

    fn resetFallbackPaletteState(self: *CliRenderer) void {
        for (0..self.palette_rgba.len) |index| {
            self.palette_rgba[index] = ansi.fallbackAnsi256Color(index);
        }
        self.default_fg_rgba = ansi.defaultColor(255, 255, 255, 255);
        self.default_bg_rgba = ansi.defaultColor(0, 0, 0, 255);
    }

    pub fn setPaletteState(self: *CliRenderer, palette: []const RGBA, default_fg: RGBA, default_bg: RGBA, palette_epoch: u32) void {
        self.resetFallbackPaletteState();

        const copy_len = @min(palette.len, self.palette_rgba.len);
        for (palette[0..copy_len], 0..) |color, index| {
            self.palette_rgba[index] = color;
        }

        self.default_fg_rgba = default_fg;
        self.default_bg_rgba = default_bg;

        if (self.palette_epoch != palette_epoch) {
            self.palette_epoch = palette_epoch;
            self.force_full_repaint = true;
            self.palette_index_cache.clearRetainingCapacity();
        }
    }

    fn cachedNearestPaletteIndex(self: *CliRenderer, rgba: RGBA) u8 {
        const rgb24 = ansi.rgbaToRgb24(rgba);
        const key = (@as(u64, self.palette_epoch) << 24) | @as(u64, rgb24);

        if (self.palette_index_cache.get(key)) |cached| {
            return cached;
        }

        var best_index: u8 = 0;
        var best_distance = std.math.inf(f32);

        for (self.palette_rgba, 0..) |candidate, index| {
            const distance = ansi.colorDistanceSquared(rgba, candidate);
            if (distance < best_distance) {
                best_distance = distance;
                best_index = @intCast(index);
            }
        }

        self.palette_index_cache.put(self.allocator, key, best_index) catch {};
        return best_index;
    }

    fn emitColor(self: *CliRenderer, writer: anytype, rgba: RGBA, is_background: bool) void {
        const caps = self.terminal.getCapabilities();

        if (ansi.intent(rgba) == .default) {
            if (is_background) {
                ansi.ANSI.bgDefaultOutput(writer) catch {};
            } else {
                ansi.ANSI.fgDefaultOutput(writer) catch {};
            }
            return;
        }

        if (is_background and ansi.alpha(rgba) == 0) {
            ansi.ANSI.bgDefaultOutput(writer) catch {};
            return;
        }

        if (ansi.intent(rgba) == .indexed and caps.ansi256) {
            const index = ansi.slot(rgba);
            if (is_background) {
                ansi.ANSI.bgIndexedColorOutput(writer, index) catch {};
            } else {
                ansi.ANSI.fgIndexedColorOutput(writer, index) catch {};
            }
            return;
        }

        if (!caps.rgb and caps.ansi256) {
            const index: u8 = self.cachedNearestPaletteIndex(rgba);

            if (is_background) {
                ansi.ANSI.bgIndexedColorOutput(writer, index) catch {};
            } else {
                ansi.ANSI.fgIndexedColorOutput(writer, index) catch {};
            }
            return;
        }

        if (is_background) {
            ansi.ANSI.bgColorOutput(writer, ansi.red(rgba), ansi.green(rgba), ansi.blue(rgba)) catch {};
        } else {
            ansi.ANSI.fgColorOutput(writer, ansi.red(rgba), ansi.green(rgba), ansi.blue(rgba)) catch {};
        }
    }

    pub fn setRenderOffset(self: *CliRenderer, offset: u32) void {
        if (self.terminalSetup and !self.useAlternateScreen and self.renderOffset > 0 and offset == 0) {
            var clearBuf: [256]u8 = undefined;
            var stream = std.io.fixedBufferStream(&clearBuf);
            const writer = stream.writer();
            self.clearSplitFooterSurface(writer);
            self.backend.writeOut(stream.getWritten());
        }

        self.renderOffset = offset;
    }

    fn renderStatusFromWrite(status: output.WriteStatus) RenderStatus {
        return switch (status) {
            .ok => .rendered,
            .skipped => .skipped,
            .failed => .failed,
        };
    }

    fn clearSkippedFrameState(self: *CliRenderer) void {
        self.nextRenderBuffer.clear(self.backgroundColor, null);
        @memset(self.nextHitGrid, 0);
    }

    fn finishSkippedFrame(self: *CliRenderer) RenderStatus {
        self.clearSkippedFrameState();
        return .skipped;
    }

    fn finishFailedFrame(self: *CliRenderer) RenderStatus {
        self.force_full_repaint = true;
        return .failed;
    }

    fn renderResult(self: *CliRenderer, status: RenderStatus) RenderResult {
        return .{ .renderOffset = self.renderOffset, .status = status };
    }

    // One code path; backend selects writer type at compile time.
    pub fn render(self: *CliRenderer, force: bool) RenderStatus {
        // Backpressure: skipping must NOT update lastRenderTime so the next
        // successful render sees the full accumulated delta (catch-up).
        if (self.backend.prepareFrame() != .ok) {
            return self.finishSkippedFrame();
        }

        const now = std.time.microTimestamp();
        const deltaTimeMs = @as(f64, @floatFromInt(now - self.lastRenderTime));
        const deltaTime = deltaTimeMs / 1000.0;

        self.lastRenderTime = now;
        self.renderDebugOverlay();

        // `inline else` monomorphizes the writer type per variant — one
        // dispatch site, zero vtable cost.
        var write_status: output.WriteStatus = .ok;
        switch (self.backend) {
            inline else => |*b| {
                b.beginFrame();
                var w = b.writer();
                self.prepareRenderFrameWithWriter(&w, force, false);
                write_status = b.endFrame();
            },
        }

        const status = renderStatusFromWrite(write_status);
        if (status == .failed) {
            return self.finishFailedFrame();
        }

        self.collectFrameStats(deltaTime);
        return status;
    }

    fn splitOutputOffset(self: *const CliRenderer, surface_offset: u32) u32 {
        return self.splitScrollback.renderOffset(surface_offset);
    }

    fn clampSplitSurfaceOffset(self: *const CliRenderer, surface_offset: u32, pinned_render_offset: u32) u32 {
        const output_offset = self.splitOutputOffset(pinned_render_offset);
        return std.math.clamp(surface_offset, output_offset, pinned_render_offset);
    }

    pub fn resetSplitScrollback(self: *CliRenderer, seed_rows: u32, pinned_render_offset: u32) u32 {
        self.splitScrollback.reset(seed_rows);
        self.renderOffset = self.splitScrollback.renderOffset(pinned_render_offset);
        return self.renderOffset;
    }

    pub fn syncSplitScrollback(self: *CliRenderer, pinned_render_offset: u32) u32 {
        self.renderOffset = self.clampSplitSurfaceOffset(self.renderOffset, pinned_render_offset);
        return self.renderOffset;
    }

    pub fn getSplitOutputOffset(self: *CliRenderer, surface_offset: u32) u32 {
        return self.splitOutputOffset(surface_offset);
    }

    pub fn setPendingSplitFooterTransition(
        self: *CliRenderer,
        mode: SplitFooterTransitionMode,
        source_top_line: u32,
        source_height: u32,
        target_top_line: u32,
        target_height: u32,
        scroll_lines: u32,
    ) void {
        self.pendingSplitFooterTransition = .{
            .mode = mode,
            .source_top_line = source_top_line,
            .source_height = source_height,
            .target_top_line = target_top_line,
            .target_height = target_height,
            .scroll_lines = scroll_lines,
        };
    }

    pub fn clearPendingSplitFooterTransition(self: *CliRenderer) void {
        self.pendingSplitFooterTransition.clear();
    }

    fn applyPendingSplitFooterTransition(self: *CliRenderer, writer: anytype, frame_started: *bool) void {
        const transition = self.pendingSplitFooterTransition;
        defer self.pendingSplitFooterTransition.clear();

        if (transition.mode == .none or transition.source_height == 0 or transition.target_height == 0) {
            return;
        }

        if (!frame_started.*) {
            beginRenderFrame(writer);
            frame_started.* = true;
        }

        switch (transition.mode) {
            .viewport_scroll => {
                if (transition.scroll_lines == 0) {
                    return;
                }

                self.splitScrollback.noteViewportScroll(transition.scroll_lines);

                if (transition.source_top_line < transition.target_top_line) {
                    writer.print("\x1b[{d}T", .{transition.scroll_lines}) catch {};
                } else if (transition.source_top_line > transition.target_top_line) {
                    writer.print("\x1b[{d}S", .{transition.scroll_lines}) catch {};
                }
            },
            .clear_stale_rows => {
                const source_end = transition.source_top_line + transition.source_height - 1;
                const target_end = transition.target_top_line + transition.target_height - 1;
                var line = transition.source_top_line;
                while (line <= source_end) : (line += 1) {
                    if (line >= transition.target_top_line and line <= target_end) {
                        continue;
                    }

                    ansi.ANSI.moveToOutput(writer, 1, line) catch {};
                    writer.writeAll("\x1b[2K") catch {};
                }
            },
            .none => {},
        }
    }

    pub fn repaintSplitFooter(
        self: *CliRenderer,
        pinned_render_offset: u32,
        force: bool,
    ) RenderResult {
        if (self.backend.prepareFrame() != .ok) {
            const status = self.finishSkippedFrame();
            return self.renderResult(status);
        }

        const now = std.time.microTimestamp();
        const deltaTimeMs = @as(f64, @floatFromInt(now - self.lastRenderTime));
        const deltaTime = deltaTimeMs / 1000.0;

        self.lastRenderTime = now;
        self.renderDebugOverlay();

        const status = self.prepareSplitFooterRepaintFrame(pinned_render_offset, force);
        var result_status = status;
        if (status == .failed) {
            result_status = self.finishFailedFrame();
        } else {
            self.collectFrameStats(deltaTime);
        }

        return self.renderResult(result_status);
    }

    pub fn commitSplitFooterSnapshotBatched(
        self: *CliRenderer,
        snapshot: *const OptimizedBuffer,
        row_columns: u32,
        start_on_new_line: bool,
        trailing_newline: bool,
        pinned_render_offset: u32,
        force: bool,
        begin_frame: bool,
        finalize_frame: bool,
    ) RenderResult {
        // Batched commit protocol:
        // - first call starts frame and appends payload
        // - middle calls append payload only
        // - final call renders footer diff/cursor and closes frame
        // This avoids repeated syncSet/syncReset and cursor toggles per chunk.
        if (begin_frame) {
            if (self.backend.prepareFrame() != .ok) {
                const status = self.finishSkippedFrame();
                return self.renderResult(status);
            }

            const now = std.time.microTimestamp();
            const deltaTimeMs = @as(f64, @floatFromInt(now - self.lastRenderTime));
            const deltaTime = deltaTimeMs / 1000.0;

            self.lastRenderTime = now;
            self.renderDebugOverlay();

            var write_status: output.WriteStatus = .ok;
            var result_status: RenderStatus = .rendered;
            switch (self.backend) {
                inline else => |*b| {
                    b.beginFrame();
                    var w = b.writer();
                    beginRenderFrame(&w);
                    var frame_started = true;
                    self.applyPendingSplitFooterTransition(&w, &frame_started);

                    // Track batch lifetime so subsequent calls can append into the same
                    // output buffer without restarting frame state.
                    self.splitBatchActive = !finalize_frame;
                    self.splitBatchRedrawFooter = false;
                    self.splitBatchDeltaTime = deltaTime;

                    const redraw_footer = self.appendSplitFooterSnapshotCommit(
                        &w,
                        snapshot,
                        row_columns,
                        start_on_new_line,
                        trailing_newline,
                        pinned_render_offset,
                        force,
                    );

                    if (finalize_frame) {
                        self.prepareRenderFrameWithWriter(&w, redraw_footer, true);
                        write_status = b.endFrame();
                        const status = renderStatusFromWrite(write_status);
                        if (status == .failed) {
                            result_status = self.finishFailedFrame();
                        } else {
                            result_status = status;
                            self.collectFrameStats(deltaTime);
                        }

                        self.splitBatchActive = false;
                        self.splitBatchRedrawFooter = false;
                        self.splitBatchDeltaTime = 0;
                    } else {
                        result_status = .rendered;
                        self.splitBatchRedrawFooter = redraw_footer;
                    }
                },
            }

            return self.renderResult(result_status);
        }

        // Defensive fallback: if caller forgot begin_frame, execute through a
        // single-call frame instead of appending into undefined batch state.
        if (!self.splitBatchActive) {
            return self.commitSplitFooterSnapshotBatched(
                snapshot,
                row_columns,
                start_on_new_line,
                trailing_newline,
                pinned_render_offset,
                force,
                true,
                true,
            );
        }

        var write_status: output.WriteStatus = .ok;
        var result_status: RenderStatus = .rendered;
        switch (self.backend) {
            inline else => |*b| {
                var w = b.writer();
                const redraw_footer = self.appendSplitFooterSnapshotCommit(
                    &w,
                    snapshot,
                    row_columns,
                    start_on_new_line,
                    trailing_newline,
                    pinned_render_offset,
                    force,
                );
                self.splitBatchRedrawFooter = self.splitBatchRedrawFooter or redraw_footer;

                if (finalize_frame) {
                    self.prepareRenderFrameWithWriter(&w, self.splitBatchRedrawFooter, true);
                    write_status = b.endFrame();

                    const status = renderStatusFromWrite(write_status);
                    if (status == .failed) {
                        result_status = self.finishFailedFrame();
                    } else {
                        result_status = status;
                        self.collectFrameStats(self.splitBatchDeltaTime);
                    }

                    self.splitBatchActive = false;
                    self.splitBatchRedrawFooter = false;
                    self.splitBatchDeltaTime = 0;
                } else {
                    result_status = .rendered;
                }
            },
        }

        return self.renderResult(result_status);
    }

    /// Serialization for one split append payload.
    ///
    /// This function intentionally does not emit syncSet/syncReset or footer
    /// repaint sequences. It only writes snapshot text rows at the current output
    /// cursor. Frame boundaries are controlled by commitSplitFooterSnapshot*
    /// callers so multiple payloads can share one frame.
    ///
    /// row_columns limits the per-row emitted width. Caller may provide a
    /// wider buffer but a smaller logical row width for wrapped stdout chunks.
    ///
    /// trailing_newline mirrors stdout semantics: only payloads that logically
    /// ended with '\n' advance and clear the next row after the final row.
    fn writeSnapshotCommit(
        self: *CliRenderer,
        writer: anytype,
        snapshot: *const OptimizedBuffer,
        row_columns: u32,
        trailing_newline: bool,
    ) void {
        var currentFg: ?RGBA = null;
        var currentBg: ?RGBA = null;
        var currentAttributes: ?u32 = null;
        var currentLinkId: u32 = 0;
        var utf8Buf: [4]u8 = undefined;

        const hyperlinksEnabled = self.terminal.getCapabilities().hyperlinks;
        const render_columns = @min(row_columns, snapshot.width);

        for (0..snapshot.height) |uy| {
            const y = @as(u32, @intCast(uy));
            const row_end = snapshotRowEnd(snapshot, y, render_columns);

            for (0..row_end) |ux| {
                const x = @as(u32, @intCast(ux));
                const cell = snapshot.get(x, y) orelse continue;

                const fgMatch = currentFg != null and buf.rgbaEqual(currentFg.?, cell.fg);
                const bgMatch = currentBg != null and buf.rgbaEqual(currentBg.?, cell.bg);
                const sameAttributes = fgMatch and bgMatch and currentAttributes != null and cell.attributes == currentAttributes.?;

                const linkId = if (hyperlinksEnabled) ansi.TextAttributes.getLinkId(cell.attributes) else 0;
                if (hyperlinksEnabled and linkId != currentLinkId) {
                    if (currentLinkId != 0) {
                        writer.writeAll("\x1b]8;;\x1b\\") catch {};
                    }
                    currentLinkId = linkId;
                    if (currentLinkId != 0) {
                        const lp = link.initGlobalLinkPool(self.allocator);
                        if (lp.get(currentLinkId)) |url_bytes| {
                            writer.print("\x1b]8;id={d};{s}\x1b\\", .{ currentLinkId, url_bytes }) catch {};
                        } else |_| {
                            currentLinkId = 0;
                        }
                    }
                }

                if (!sameAttributes) {
                    writer.writeAll(ansi.ANSI.reset) catch {};

                    currentFg = cell.fg;
                    currentBg = cell.bg;
                    currentAttributes = cell.attributes;

                    self.emitColor(writer, cell.fg, false);
                    self.emitColor(writer, cell.bg, true);

                    ansi.TextAttributes.applyAttributesOutputWriter(writer, cell.attributes) catch {};
                }

                if (cell.char == 0) {
                    writer.writeByte(' ') catch {};
                } else if (gp.isGraphemeChar(cell.char)) {
                    const gid: u32 = gp.graphemeIdFromChar(cell.char);
                    const bytes = self.pool.get(gid) catch {
                        writer.writeByte(' ') catch {};
                        continue;
                    };

                    if (bytes.len > 0) {
                        const capabilities = self.terminal.getCapabilities();
                        const graphemeWidth = gp.charRightExtent(cell.char) + 1;
                        if (capabilities.explicit_width) {
                            ansi.ANSI.explicitWidthOutput(writer, graphemeWidth, bytes) catch {};
                        } else {
                            writer.writeAll(bytes) catch {};
                        }
                    }
                } else if (gp.isContinuationChar(cell.char)) {
                    // Keep split scrollback payload behavior aligned with the live
                    // frame renderer: continuation cells must not serialize as
                    // spaces, or wide graphemes become one extra column wider in
                    // terminal output and table rows can autowrap unexpectedly.
                } else {
                    const len = std.unicode.utf8Encode(@intCast(cell.char), &utf8Buf) catch 1;
                    writer.writeAll(utf8Buf[0..len]) catch {};
                }
            }

            if (hyperlinksEnabled and currentLinkId != 0) {
                writer.writeAll("\x1b]8;;\x1b\\") catch {};
                currentLinkId = 0;
            }

            writer.writeAll(ansi.ANSI.reset) catch {};
            // Guarantee short rows do not leave stale content from prior frame data.
            writer.writeAll(ansi.ANSI.eraseToEndOfLine) catch {};
            currentFg = null;
            currentBg = null;
            currentAttributes = null;

            const is_last_row = @as(u32, @intCast(uy + 1)) >= snapshot.height;
            if (!is_last_row or trailing_newline) {
                writer.writeAll("\r\n") catch {};
            }

            if (is_last_row and trailing_newline) {
                // After a trailing newline, clear the destination row that becomes
                // current so old footer text cannot flash through.
                writer.writeAll(ansi.ANSI.reset) catch {};
                writer.writeAll(ansi.ANSI.eraseToEndOfLine) catch {};
            }
        }
    }

    /// Shared append path for all split payload sources.
    ///
    /// Contract: append payload first, then position for footer repaint in the
    /// same frame. Returning redraw_footer lets caller skip full diff work when
    /// footer position did not actually change.
    fn appendSplitFooterSnapshotCommit(
        self: *CliRenderer,
        writer: anytype,
        snapshot: *const OptimizedBuffer,
        row_columns: u32,
        start_on_new_line: bool,
        trailing_newline: bool,
        pinned_render_offset: u32,
        force: bool,
    ) bool {
        const previousSurfaceOffset = self.renderOffset;
        const previousOutputOffset = self.splitOutputOffset(previousSurfaceOffset);
        const previousOutputColumn = self.splitScrollback.tail_column;
        const snapshot_has_content = snapshot.width > 0 and snapshot.height > 0;
        const normalized_row_columns = @min(row_columns, snapshot.width);
        const starts_mid_line = previousOutputColumn > 0 and start_on_new_line;
        const starts_wrapped_line = previousOutputColumn >= self.width;
        const previousFooterTopLine: u32 = @max(previousSurfaceOffset + 1, @as(u32, 1));

        if (snapshot_has_content) {
            // First update logical split scrollback state, then emit terminal I/O.
            // Keeping model state authoritative makes repaint decisions deterministic.
            if (starts_mid_line) {
                self.splitScrollback.noteNewline();
            }

            var row: u32 = 0;
            while (row < snapshot.height) : (row += 1) {
                self.splitScrollback.publishRow(
                    snapshotRowEnd(snapshot, row, normalized_row_columns),
                    self.width,
                    row + 1 < snapshot.height or trailing_newline,
                );
            }

            self.splitScrollback.published_rows = @min(self.splitScrollback.published_rows, pinned_render_offset);
        }

        const next_output_offset = self.splitScrollback.renderOffset(pinned_render_offset);
        const next_render_offset = self.clampSplitSurfaceOffset(previousSurfaceOffset, pinned_render_offset);
        const targetFooterTopLine: u32 = @max(next_render_offset + 1, @as(u32, 1));
        // Footer redraw is only needed when offset changes (settling/pinning) or
        // when an explicit force was requested by the caller.
        const redraw_footer = force or previousSurfaceOffset != next_render_offset;
        // When split scrollback is settled at the pinned boundary, newlines/wraps from
        // appended output must scroll only the upper pane. Without a temporary DECSTBM
        // region, terminals advance into the footer rows and overwrite them in place.
        const use_bounded_scroll_region = snapshot_has_content and
            pinned_render_offset > 0 and
            next_render_offset == pinned_render_offset and
            next_output_offset == next_render_offset;

        if (snapshot_has_content or force) {
            if (snapshot_has_content) {
                // Clear rows that are transitioning from "footer surface" to scrollback before
                // writing appended rows. If this happens after append, the clear itself is what
                // gets scrolled and manifests as extra blank lines in history.
                if (targetFooterTopLine > previousFooterTopLine) {
                    var clear_line = previousFooterTopLine;
                    while (clear_line < targetFooterTopLine) : (clear_line += 1) {
                        ansi.ANSI.moveToOutput(writer, 1, clear_line) catch {};
                        writer.writeAll("\x1b[2K") catch {};
                    }
                }

                if (use_bounded_scroll_region) {
                    // Temporarily bound scrolling to the upper pane so newline/wrap
                    // from appended payload pushes history upward instead of stepping
                    // through footer rows.
                    writer.print("\x1b[1;{d}r", .{pinned_render_offset}) catch {};
                }

                moveToSplitOutputCursor(writer, previousOutputOffset, previousOutputColumn, self.width);
                if (starts_mid_line or starts_wrapped_line) {
                    // The prior commit left output cursor mid-row and caller asked
                    // for newline anchoring. When the prior commit exactly filled the
                    // row, we also need a CRLF here because moving the cursor back to
                    // the last column loses the terminal's pending autowrap state.
                    // Emit CRLF before payload to preserve logical row boundaries
                    // across commit chunks.
                    writer.writeAll("\r\n") catch {};
                }

                // Serialize payload rows at current output cursor.
                self.writeSnapshotCommit(writer, snapshot, normalized_row_columns, trailing_newline);

                if (use_bounded_scroll_region) {
                    // Restore default full-height scroll region for regular repaint
                    // and cursor operations after append is complete.
                    writer.writeAll("\x1b[r") catch {};
                }
            }

            self.renderOffset = next_render_offset;
            if (redraw_footer) {
                ansi.ANSI.moveToOutput(writer, 1, targetFooterTopLine) catch {};
            }
        } else {
            self.renderOffset = next_render_offset;
        }

        return redraw_footer;
    }

    fn beginRenderFrame(writer: anytype) void {
        writer.writeAll(ansi.ANSI.syncSet) catch {};
        writer.writeAll(ansi.ANSI.hideCursor) catch {};
    }

    fn prepareSplitFooterRepaintFrame(
        self: *CliRenderer,
        pinned_render_offset: u32,
        force: bool,
    ) RenderStatus {
        const transition = self.pendingSplitFooterTransition;
        const hasPendingViewportTarget = transition.mode == .viewport_scroll and
            transition.target_top_line > 0 and
            transition.scroll_lines > 0;
        const previousRenderOffset = self.renderOffset;
        const next_render_offset = if (hasPendingViewportTarget)
            transition.target_top_line - 1
        else
            self.clampSplitSurfaceOffset(previousRenderOffset, pinned_render_offset);
        const redraw_footer = force or previousRenderOffset != next_render_offset;

        self.renderOffset = next_render_offset;
        // Do not pre-start sync frame here. prepareRenderFrameWithWriter now lazily starts
        // frame output only when something actually changes; this prevents no-op
        // repaint ticks from emitting hide/show cursor and sync envelopes.
        var write_status: output.WriteStatus = .ok;
        switch (self.backend) {
            inline else => |*b| {
                b.beginFrame();
                var w = b.writer();
                self.prepareRenderFrameWithWriter(&w, redraw_footer, false);
                write_status = b.endFrame();
            },
        }
        return renderStatusFromWrite(write_status);
    }

    pub fn getNextBuffer(self: *CliRenderer) *OptimizedBuffer {
        return self.nextRenderBuffer;
    }

    pub fn getCurrentBuffer(self: *CliRenderer) *OptimizedBuffer {
        return self.currentRenderBuffer;
    }

    /// Generic over the writer type so each backend can provide its own writer
    /// (buffered frame append or feed streaming) without dispatch in the render path.
    /// `sync_started` is true only when the caller already opened the
    /// synchronized-update envelope for a batched split-footer commit.
    pub fn prepareRenderFrameWithWriter(self: *CliRenderer, writer: anytype, force: bool, sync_started: bool) void {
        const renderStartTime = std.time.microTimestamp();
        var cellsUpdated: u32 = 0;
        const palette_force = self.last_rendered_palette_epoch == null or self.last_rendered_palette_epoch.? != self.palette_epoch;
        const should_force = force or self.force_full_repaint or palette_force;

        // Lazy frame start is the core no-op suppression mechanism. If diffing,
        // cursor state, and pointer state are unchanged, frame_started stays false
        // and we emit nothing at all for this tick.
        var frame_started = sync_started;
        self.applyPendingSplitFooterTransition(writer, &frame_started);

        var currentFg: ?RGBA = null;
        var currentBg: ?RGBA = null;
        var currentAttributes: ?u32 = null;
        var currentLinkId: u32 = 0;
        var utf8Buf: [4]u8 = undefined;

        const hyperlinksEnabled = self.terminal.getCapabilities().hyperlinks;

        for (0..self.height) |uy| {
            const y = @as(u32, @intCast(uy));

            var runStart: i64 = -1;
            var runLength: u32 = 0;

            for (0..self.width) |ux| {
                const x = @as(u32, @intCast(ux));
                const currentCell = self.currentRenderBuffer.get(x, y);
                const nextCell = self.nextRenderBuffer.get(x, y);

                if (currentCell == null or nextCell == null) continue;

                if (!should_force) {
                    const charEqual = currentCell.?.char == nextCell.?.char;
                    const attrEqual = currentCell.?.attributes == nextCell.?.attributes;

                    if (charEqual and attrEqual and
                        buf.rgbaEqual(currentCell.?.fg, nextCell.?.fg) and
                        buf.rgbaEqual(currentCell.?.bg, nextCell.?.bg))
                    {
                        if (runLength > 0) {
                            writer.writeAll(ansi.ANSI.reset) catch {};
                            runStart = -1;
                            runLength = 0;
                        }
                        continue;
                    }
                }

                const cell = nextCell.?;

                if (!frame_started) {
                    beginRenderFrame(writer);
                    frame_started = true;
                }

                const fgMatch = currentFg != null and buf.rgbaEqual(currentFg.?, cell.fg);
                const bgMatch = currentBg != null and buf.rgbaEqual(currentBg.?, cell.bg);
                const sameAttributes = fgMatch and bgMatch and currentAttributes != null and cell.attributes == currentAttributes.?;

                const linkId = if (hyperlinksEnabled) ansi.TextAttributes.getLinkId(cell.attributes) else 0;

                if (hyperlinksEnabled and linkId != currentLinkId) {
                    if (currentLinkId != 0) {
                        writer.writeAll("\x1b]8;;\x1b\\") catch {};
                    }
                    currentLinkId = linkId;
                    if (currentLinkId != 0) {
                        const lp = link.initGlobalLinkPool(self.allocator);
                        if (lp.get(currentLinkId)) |url_bytes| {
                            writer.print("\x1b]8;id={d};{s}\x1b\\", .{ currentLinkId, url_bytes }) catch {};
                        } else |_| {
                            // Link not found, treat as no link
                            currentLinkId = 0;
                        }
                    }
                }

                if (!sameAttributes or runStart == -1) {
                    if (runLength > 0) {
                        writer.writeAll(ansi.ANSI.reset) catch {};
                    }

                    runStart = @intCast(x);
                    runLength = 0;

                    currentFg = cell.fg;
                    currentBg = cell.bg;
                    currentAttributes = cell.attributes;

                    ansi.ANSI.moveToOutput(writer, x + 1, y + 1 + self.renderOffset) catch {};

                    self.emitColor(writer, cell.fg, false);
                    self.emitColor(writer, cell.bg, true);

                    ansi.TextAttributes.applyAttributesOutputWriter(writer, cell.attributes) catch {};
                }

                // Handle grapheme characters
                if (gp.isGraphemeChar(cell.char)) {
                    const gid: u32 = gp.graphemeIdFromChar(cell.char);
                    const bytes = self.pool.get(gid) catch |err| {
                        self.performShutdownSequence();
                        std.debug.panic("Fatal: no grapheme bytes in pool for gid {d}: {}", .{ gid, err });
                    };
                    if (bytes.len > 0) {
                        const capabilities = self.terminal.getCapabilities();
                        const graphemeWidth = gp.charRightExtent(cell.char) + 1;
                        if (capabilities.explicit_width) {
                            ansi.ANSI.explicitWidthOutput(writer, graphemeWidth, bytes) catch {};
                        } else {
                            writer.writeAll(bytes) catch {};
                            if (capabilities.explicit_cursor_positioning) {
                                const nextX = x + graphemeWidth;
                                if (nextX < self.width) {
                                    ansi.ANSI.moveToOutput(writer, nextX + 1, y + 1 + self.renderOffset) catch {};
                                }
                            }
                        }
                    }
                } else if (gp.isContinuationChar(cell.char)) {
                    // Intentionally do not write a space for continuation cells.
                    // NOTE: disabled to fix 2-cell emoji rendering when the two
                    // cells have distinct colors (space overwrite can break glyph output)

                    // writer.writeByte(' ') catch {};
                } else {
                    const len = std.unicode.utf8Encode(@intCast(cell.char), &utf8Buf) catch 1;
                    writer.writeAll(utf8Buf[0..len]) catch {};
                }
                runLength += 1;

                // Sync this cell to the current buffer so the next frame's diff
                // is correct. Use syncCell (set without span cleanup) because
                // span cleanup would destroy continuation cells written by an
                // earlier iteration of this same left-to-right pass (#723).
                self.currentRenderBuffer.syncCell(x, y, nextCell.?);

                cellsUpdated += 1;
            }
        }

        if (hyperlinksEnabled and currentLinkId != 0) {
            if (!frame_started) {
                beginRenderFrame(writer);
                frame_started = true;
            }
            writer.writeAll("\x1b]8;;\x1b\\") catch {};
        }

        if (frame_started) {
            writer.writeAll(ansi.ANSI.reset) catch {};
        }

        const cursorPos = self.terminal.getCursorPosition();
        const cursorStyle = self.terminal.getCursorStyle();
        const cursorColor = self.terminal.getCursorColor();

        if (cursorPos.visible) {
            var cursorStyleCode: []const u8 = undefined;

            switch (cursorStyle.style) {
                .block => {
                    cursorStyleCode = if (cursorStyle.blinking)
                        ansi.ANSI.cursorBlockBlink
                    else
                        ansi.ANSI.cursorBlock;
                },
                .line => {
                    cursorStyleCode = if (cursorStyle.blinking)
                        ansi.ANSI.cursorLineBlink
                    else
                        ansi.ANSI.cursorLine;
                },
                .underline => {
                    cursorStyleCode = if (cursorStyle.blinking)
                        ansi.ANSI.cursorUnderlineBlink
                    else
                        ansi.ANSI.cursorUnderline;
                },
                .default => {
                    cursorStyleCode = ansi.ANSI.defaultCursorStyle;
                },
            }

            const cursorR = ansi.red(cursorColor);
            const cursorG = ansi.green(cursorColor);
            const cursorB = ansi.blue(cursorColor);

            const styleTag: u8 = @intFromEnum(cursorStyle.style);
            const styleChanged = (self.lastCursorStyleTag == null or self.lastCursorStyleTag.? != styleTag) or
                (self.lastCursorBlinking == null or self.lastCursorBlinking.? != cursorStyle.blinking);
            const colorChanged = (self.lastCursorColorRGB == null or self.lastCursorColorRGB.?[0] != cursorR or self.lastCursorColorRGB.?[1] != cursorG or self.lastCursorColorRGB.?[2] != cursorB);
            const cursorX = cursorPos.x;
            const cursorY = cursorPos.y + self.renderOffset;
            const positionChanged = self.lastCursorX == null or self.lastCursorY == null or self.lastCursorX.? != cursorX or self.lastCursorY.? != cursorY;
            const visibilityChanged = self.lastCursorVisible == null or !self.lastCursorVisible.?;
            // If any visual output was produced this frame, we must restore cursor
            // state (position + visibility). If frame is otherwise empty, only emit
            // cursor sequences when some cursor property actually changed.
            const needsCursorRestore = frame_started or styleChanged or colorChanged or positionChanged or visibilityChanged;

            if (needsCursorRestore) {
                if (!frame_started) {
                    beginRenderFrame(writer);
                    frame_started = true;
                }

                if (colorChanged) {
                    ansi.ANSI.cursorColorOutputWriter(writer, cursorR, cursorG, cursorB) catch {};
                    self.lastCursorColorRGB = .{ cursorR, cursorG, cursorB };
                }
                if (styleChanged) {
                    writer.writeAll(cursorStyleCode) catch {};
                    self.lastCursorStyleTag = styleTag;
                    self.lastCursorBlinking = cursorStyle.blinking;
                }

                ansi.ANSI.moveToOutput(writer, cursorX, cursorY) catch {};
                writer.writeAll(ansi.ANSI.showCursor) catch {};
            }

            self.lastCursorX = cursorX;
            self.lastCursorY = cursorY;
            self.lastCursorVisible = true;
        } else {
            if (!frame_started and (self.lastCursorVisible == null or self.lastCursorVisible.?)) {
                beginRenderFrame(writer);
                frame_started = true;
                writer.writeAll(ansi.ANSI.hideCursor) catch {};
            }

            self.lastCursorStyleTag = null;
            self.lastCursorBlinking = null;
            self.lastCursorColorRGB = null;
            self.lastCursorX = null;
            self.lastCursorY = null;
            self.lastCursorVisible = false;
        }

        const mousePointer = self.terminal.getMousePointer();
        if (mousePointer != self.lastMousePointerStyle) {
            if (!frame_started) {
                beginRenderFrame(writer);
                frame_started = true;
            }
            ansi.ANSI.setMousePointerOutput(writer, mousePointer.toName()) catch {};
            self.lastMousePointerStyle = mousePointer;
        }

        // Only close sync if we opened it. This keeps true no-op frames empty.
        if (frame_started) {
            writer.writeAll(ansi.ANSI.syncReset) catch {};
        }

        const renderEndTime = std.time.microTimestamp();
        const renderTime = @as(f64, @floatFromInt(renderEndTime - renderStartTime));

        self.renderStats.cellsUpdated = cellsUpdated;
        self.renderStats.renderTime = renderTime;
        self.last_rendered_palette_epoch = self.palette_epoch;
        self.force_full_repaint = false;

        self.nextRenderBuffer.clear(self.backgroundColor, null);

        // Compare hit grids before swap to detect changes. This allows TypeScript to
        // know if hover state needs rechecking without manually tracking dirty state.
        self.hitGridDirty = self.hitGridResizeInvalidated or !std.mem.eql(u32, self.currentHitGrid, self.nextHitGrid);

        // Swap hit grids: nextHitGrid (built this frame) becomes the active grid for
        // hit testing. The old currentHitGrid becomes nextHitGrid and is cleared for
        // the next frame.
        const temp = self.currentHitGrid;
        self.currentHitGrid = self.nextHitGrid;
        self.nextHitGrid = temp;
        @memset(self.nextHitGrid, 0);
    }

    pub fn setDebugOverlay(self: *CliRenderer, enabled: bool, corner: DebugOverlayCorner) void {
        self.debugOverlay.enabled = enabled;
        self.debugOverlay.corner = corner;
    }

    pub fn clearTerminal(self: *CliRenderer) void {
        self.writeOut(ansi.ANSI.clearAndHome);
    }

    pub fn writeOut(self: *CliRenderer, data: []const u8) void {
        self.backend.writeOut(data);
    }

    pub fn writeOutMultiple(self: *CliRenderer, data_slices: []const []const u8) void {
        self.backend.writeOutMultiple(data_slices);
    }

    /// Write a renderable's bounds to nextHitGrid for the upcoming frame.
    ///
    /// Called during render for each visible renderable. The rect is clipped to
    /// the current hit scissor stack, so elements inside overflow:hidden parents
    /// only register hits within the visible region. Later renderables overwrite
    /// earlier ones. Z-order is determined by render order.
    pub fn addToHitGrid(self: *CliRenderer, x: i32, y: i32, width: u32, height: u32, id: u32) void {
        const clipped = self.clipRectToHitScissor(x, y, width, height) orelse return;
        const startX = @max(0, clipped.x);
        const startY = @max(0, clipped.y);
        const endX = @min(
            @as(i32, @intCast(self.hitGridWidth)),
            clipped.x + @as(i32, @intCast(clipped.width)),
        );
        const endY = @min(
            @as(i32, @intCast(self.hitGridHeight)),
            clipped.y + @as(i32, @intCast(clipped.height)),
        );

        if (startX >= endX or startY >= endY) return;

        const uStartX: u32 = @intCast(startX);
        const uStartY: u32 = @intCast(startY);
        const uEndX: u32 = @intCast(endX);
        const uEndY: u32 = @intCast(endY);

        for (uStartY..uEndY) |row| {
            const rowStart = row * self.hitGridWidth;
            const startIdx = rowStart + uStartX;
            const endIdx = rowStart + uEndX;

            @memset(self.nextHitGrid[startIdx..endIdx], id);
        }
    }

    /// Clear currentHitGrid before an immediate rebuild.
    ///
    /// Used by syncHitGridIfNeeded in TypeScript when scroll/translate changes
    /// require updating hit targets without waiting for the next render.
    pub fn clearCurrentHitGrid(self: *CliRenderer) void {
        @memset(self.currentHitGrid, 0);
    }

    /// Return whether the hit grid changed during the last render.
    /// This is set by comparing the previous and current hit grids after render.
    /// TypeScript can use this to decide if hover state needs rechecking.
    pub fn getHitGridDirty(self: *CliRenderer) bool {
        const dirty = self.hitGridDirty;
        self.hitGridResizeInvalidated = false;
        return dirty;
    }

    /// Return the renderable ID at screen position (x, y), or 0 if none.
    pub fn checkHit(self: *CliRenderer, x: u32, y: u32) u32 {
        if (x >= self.hitGridWidth or y >= self.hitGridHeight) {
            return 0;
        }

        const index = y * self.hitGridWidth + x;
        return self.currentHitGrid[index];
    }

    /// Return the current (topmost) hit scissor rect, or null if the stack is empty.
    fn getCurrentHitScissorRect(self: *const CliRenderer) ?buf.ClipRect {
        if (self.hitScissorStack.items.len == 0) return null;
        return self.hitScissorStack.items[self.hitScissorStack.items.len - 1];
    }

    /// Intersect a rect with the current hit scissor. Returns null if fully clipped.
    fn clipRectToHitScissor(self: *const CliRenderer, x: i32, y: i32, width: u32, height: u32) ?buf.ClipRect {
        const scissor = self.getCurrentHitScissorRect() orelse return buf.ClipRect{
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
            return null;
        }

        return .{
            .x = intersect_x,
            .y = intersect_y,
            .width = @intCast(intersect_end_x - intersect_x),
            .height = @intCast(intersect_end_y - intersect_y),
        };
    }

    /// Push a scissor rect for hit grid clipping.
    ///
    /// The rect is intersected with any existing scissor, so nested overflow:hidden
    /// containers compound correctly. All coordinates are in screen space.
    pub fn hitGridPushScissorRect(self: *CliRenderer, x: i32, y: i32, width: u32, height: u32) void {
        var rect: buf.ClipRect = .{
            .x = x,
            .y = y,
            .width = width,
            .height = height,
        };

        if (self.getCurrentHitScissorRect() != null) {
            const intersect = self.clipRectToHitScissor(rect.x, rect.y, rect.width, rect.height);
            if (intersect) |clipped| {
                rect = clipped;
            } else {
                rect = buf.ClipRect{ .x = 0, .y = 0, .width = 0, .height = 0 };
            }
        }

        self.hitScissorStack.append(self.allocator, rect) catch |err| {
            logger.warn("Failed to push hit-grid scissor rect: {}", .{err});
        };
    }

    pub fn hitGridPopScissorRect(self: *CliRenderer) void {
        if (self.hitScissorStack.items.len > 0) {
            _ = self.hitScissorStack.pop();
        }
    }

    /// Clear all hit grid scissors. Called at start of render to reset state.
    pub fn hitGridClearScissorRects(self: *CliRenderer) void {
        self.hitScissorStack.clearRetainingCapacity();
    }

    /// Write directly to currentHitGrid with scissor clipping.
    ///
    /// Used for immediate hit grid sync when scroll/translate changes. Unlike
    /// addToHitGrid (which writes to nextHitGrid for the upcoming frame), this
    /// updates the grid that checkHit reads right now. Lets hover states update
    /// without waiting for the next render.
    pub fn addToCurrentHitGridClipped(self: *CliRenderer, x: i32, y: i32, width: u32, height: u32, id: u32) void {
        const clipped = self.clipRectToHitScissor(x, y, width, height) orelse return;

        const startX = @max(0, clipped.x);
        const startY = @max(0, clipped.y);
        const endX = @min(@as(i32, @intCast(self.hitGridWidth)), clipped.x + @as(i32, @intCast(clipped.width)));
        const endY = @min(@as(i32, @intCast(self.hitGridHeight)), clipped.y + @as(i32, @intCast(clipped.height)));

        if (startX >= endX or startY >= endY) return;

        const uStartX: u32 = @intCast(startX);
        const uStartY: u32 = @intCast(startY);
        const uEndX: u32 = @intCast(endX);
        const uEndY: u32 = @intCast(endY);

        for (uStartY..uEndY) |row| {
            const rowStart = row * self.hitGridWidth;
            const startIdx = rowStart + uStartX;
            const endIdx = rowStart + uEndX;

            @memset(self.currentHitGrid[startIdx..endIdx], id);
        }
    }

    pub fn dumpHitGrid(self: *CliRenderer) void {
        const timestamp = std.time.timestamp();
        var filename_buf: [64]u8 = undefined;
        const filename = std.fmt.bufPrint(&filename_buf, "hitgrid_{d}.txt", .{timestamp}) catch return;

        const file = std.fs.cwd().createFile(filename, .{}) catch return;
        defer file.close();

        var fileBuffer: [4096]u8 = undefined;
        var fileWriter = file.writer(&fileBuffer);
        const writer = &fileWriter.interface;

        for (0..self.hitGridHeight) |y| {
            for (0..self.hitGridWidth) |x| {
                const index = y * self.hitGridWidth + x;
                const id = self.currentHitGrid[index];

                const char = if (id == 0) '.' else ('0' + @as(u8, @intCast(id % 10)));
                writer.writeByte(char) catch return;
            }
            writer.writeByte('\n') catch return;
        }
        writer.flush() catch {};
    }

    fn dumpSingleBuffer(self: *CliRenderer, buffer: *OptimizedBuffer, buffer_name: []const u8, timestamp: i64) void {
        std.fs.cwd().makeDir("buffer_dump") catch |err| switch (err) {
            error.PathAlreadyExists => {},
            else => return,
        };

        var filename_buf: [128]u8 = undefined;
        const filename = std.fmt.bufPrint(&filename_buf, "buffer_dump/{s}_buffer_{d}.txt", .{ buffer_name, timestamp }) catch return;

        const file = std.fs.cwd().createFile(filename, .{}) catch return;
        defer file.close();

        var fileBuffer: [4096]u8 = undefined;
        var fileWriter = file.writer(&fileBuffer);
        const writer = &fileWriter.interface;

        writer.print("{s} Buffer ({d}x{d}):\n", .{ buffer_name, self.width, self.height }) catch return;
        writer.writeAll("Characters:\n") catch return;

        for (0..self.height) |y| {
            for (0..self.width) |x| {
                const cell = buffer.get(@intCast(x), @intCast(y));
                if (cell) |c| {
                    if (gp.isContinuationChar(c.char)) {
                        // skip
                    } else if (gp.isGraphemeChar(c.char)) {
                        const gid: u32 = gp.graphemeIdFromChar(c.char);
                        const bytes = self.pool.get(gid) catch &[_]u8{};
                        if (bytes.len > 0) writer.writeAll(bytes) catch return;
                    } else {
                        var utf8Buf: [4]u8 = undefined;
                        const len = std.unicode.utf8Encode(@intCast(c.char), &utf8Buf) catch 1;
                        writer.writeAll(utf8Buf[0..len]) catch return;
                    }
                } else {
                    writer.writeByte(' ') catch return;
                }
            }
            writer.writeByte('\n') catch return;
        }
        writer.flush() catch {};
    }

    /// Dump the last rendered output to a file. Backend-specific formatting
    /// is delegated to `backend.dumpTo(writer)` — no tag inspection here.
    pub fn dumpOutputBuffer(self: *CliRenderer, timestamp: i64) void {
        std.fs.cwd().makeDir("buffer_dump") catch |err| switch (err) {
            error.PathAlreadyExists => {},
            else => return,
        };

        var filename_buf: [128]u8 = undefined;
        const filename = std.fmt.bufPrint(&filename_buf, "buffer_dump/output_buffer_{d}.txt", .{timestamp}) catch return;

        const file = std.fs.cwd().createFile(filename, .{}) catch return;
        defer file.close();

        var fileBuffer: [4096]u8 = undefined;
        var fileWriter = file.writer(&fileBuffer);
        const writer = &fileWriter.interface;

        writer.print("Output Buffer Dump (timestamp: {d}):\n", .{timestamp}) catch return;
        writer.writeAll("Last Rendered ANSI Output:\n") catch return;
        writer.writeAll("================\n") catch return;

        self.backend.dumpTo(writer);

        writer.flush() catch {};
    }

    pub fn dumpBuffers(self: *CliRenderer, timestamp: i64) void {
        self.dumpSingleBuffer(self.currentRenderBuffer, "current", timestamp);
        self.dumpSingleBuffer(self.nextRenderBuffer, "next", timestamp);
        self.dumpOutputBuffer(timestamp);
    }

    pub fn restoreTerminalModes(self: *CliRenderer) void {
        var stream = std.io.fixedBufferStream(&self.writeOutBuf);
        self.terminal.restoreTerminalModes(stream.writer()) catch {};
        self.writeOut(stream.getWritten());
    }

    pub fn enableMouse(self: *CliRenderer, enableMovement: bool) void {
        var stream = std.io.fixedBufferStream(&self.writeOutBuf);
        self.terminal.setMouseMode(stream.writer(), true, enableMovement) catch {};
        self.writeOut(stream.getWritten());
    }

    pub fn queryPixelResolution(self: *CliRenderer) void {
        self.writeOut(ansi.ANSI.queryPixelSize);
    }

    pub fn queryThemeColors(self: *CliRenderer) void {
        var stream = std.io.fixedBufferStream(&self.writeOutBuf);
        self.terminal.queryThemeColors(stream.writer()) catch {};
        self.writeOut(stream.getWritten());
    }

    pub fn disableMouse(self: *CliRenderer) void {
        var stream = std.io.fixedBufferStream(&self.writeOutBuf);
        self.terminal.setMouseMode(stream.writer(), false, self.terminal.state.mouse_movement) catch {};
        self.writeOut(stream.getWritten());
    }

    pub fn enableKittyKeyboard(self: *CliRenderer, flags: u8) void {
        var stream = std.io.fixedBufferStream(&self.writeOutBuf);
        self.terminal.setKittyKeyboard(stream.writer(), true, flags) catch {};
        self.writeOut(stream.getWritten());
    }

    pub fn disableKittyKeyboard(self: *CliRenderer) void {
        var stream = std.io.fixedBufferStream(&self.writeOutBuf);
        self.terminal.setKittyKeyboard(stream.writer(), false, 0) catch {};
        self.writeOut(stream.getWritten());
    }

    pub fn getTerminalCapabilities(self: *CliRenderer) Terminal.Capabilities {
        return self.terminal.getCapabilities();
    }

    pub fn setTerminalEnvVar(self: *CliRenderer, key: []const u8, value: []const u8) bool {
        self.terminal.setHostEnvVar(self.allocator, key, value) catch return false;
        return true;
    }

    pub fn processCapabilityResponse(self: *CliRenderer, response: []const u8) void {
        self.terminal.processCapabilityResponse(response);
        var stream = std.io.fixedBufferStream(&self.writeOutBuf);
        _ = self.terminal.sendPendingQueries(stream.writer()) catch |err| blk: {
            logger.warn("Failed to send pending queries: {}", .{err});
            break :blk false;
        };
        const useKitty = self.terminal.opts.kitty_keyboard_flags > 0;
        self.terminal.enableDetectedFeatures(stream.writer(), useKitty) catch {};
        self.writeOut(stream.getWritten());
    }

    pub fn setKittyKeyboardFlags(self: *CliRenderer, flags: u8) void {
        self.terminal.setKittyKeyboardFlags(flags);
    }

    pub fn getKittyKeyboardFlags(self: *CliRenderer) u8 {
        return self.terminal.opts.kitty_keyboard_flags;
    }

    pub fn setTerminalTitle(self: *CliRenderer, title: []const u8) void {
        var stream = std.io.fixedBufferStream(&self.writeOutBuf);
        self.terminal.setTerminalTitle(stream.writer(), title);
        self.writeOut(stream.getWritten());
    }

    pub fn copyToClipboardOSC52(self: *CliRenderer, target: Terminal.ClipboardTarget, payload: []const u8) bool {
        var stream = std.io.fixedBufferStream(&self.writeOutBuf);
        self.terminal.writeClipboard(stream.writer(), target, payload) catch return false;
        self.writeOut(stream.getWritten());
        return true;
    }

    pub fn clearClipboardOSC52(self: *CliRenderer, target: Terminal.ClipboardTarget) bool {
        var stream = std.io.fixedBufferStream(&self.writeOutBuf);
        self.terminal.writeClipboard(stream.writer(), target, "") catch return false;
        self.writeOut(stream.getWritten());
        return true;
    }

    pub fn triggerNotification(self: *CliRenderer, message: []const u8, title: ?[]const u8) bool {
        var stream: std.ArrayListUnmanaged(u8) = .{};
        defer stream.deinit(self.allocator);

        const ok = self.terminal.writeNotification(self.allocator, stream.writer(self.allocator), message, title) catch return false;
        if (!ok) return false;
        self.writeOut(stream.items);
        return true;
    }

    fn renderDebugOverlay(self: *CliRenderer) void {
        if (!self.debugOverlay.enabled) return;

        const width: u32 = 40;
        const height: u32 = 11;
        var x: u32 = 0;
        var y: u32 = 0;

        if (self.width < width + 2 or self.height < height + 2) return;

        switch (self.debugOverlay.corner) {
            .topLeft => {
                x = 1;
                y = 1;
            },
            .topRight => {
                x = self.width - width - 1;
                y = 1;
            },
            .bottomLeft => {
                x = 1;
                y = self.height - height - 1;
            },
            .bottomRight => {
                x = self.width - width - 1;
                y = self.height - height - 1;
            },
        }

        self.nextRenderBuffer.fillRect(x, y, width, height, ansi.rgbColor(20, 20, 40, 255));
        self.nextRenderBuffer.drawText("Debug Information", x + 1, y + 1, ansi.rgbColor(255, 255, 100, 255), ansi.rgbColor(0, 0, 0, 0), ansi.TextAttributes.BOLD) catch {};

        var row: u32 = 2;
        const bg: RGBA = ansi.rgbColor(0, 0, 0, 0);
        const fg: RGBA = ansi.rgbColor(200, 200, 200, 255);

        // Calculate averages
        const lastFrameTimeAvg = getStatAverage(f64, &self.statSamples.lastFrameTime);
        const renderTimeAvg = getStatAverage(f64, &self.statSamples.renderTime);
        const overallFrameTimeAvg = getStatAverage(f64, &self.statSamples.overallFrameTime);
        const bufferResetTimeAvg = getStatAverage(f64, &self.statSamples.bufferResetTime);
        const outputWriteTimeAvg = getStatAverage(f64, &self.statSamples.outputWriteTime);
        const cellsUpdatedAvg = getStatAverage(u32, &self.statSamples.cellsUpdated);
        const frameCallbackTimeAvg = getStatAverage(f64, &self.statSamples.frameCallbackTime);

        // FPS
        var fpsText: [32]u8 = undefined;
        const fpsLen = std.fmt.bufPrint(&fpsText, "FPS: {d}", .{self.renderStats.fps}) catch return;
        self.nextRenderBuffer.drawText(fpsLen, x + 1, y + row, fg, bg, 0) catch {};
        row += 1;

        // Frame Time
        var frameTimeText: [64]u8 = undefined;
        const frameTimeLen = std.fmt.bufPrint(&frameTimeText, "Frame: {d:.3}ms (avg: {d:.3}ms)", .{ self.renderStats.lastFrameTime / 1000.0, lastFrameTimeAvg / 1000.0 }) catch return;
        self.nextRenderBuffer.drawText(frameTimeLen, x + 1, y + row, fg, bg, 0) catch {};
        row += 1;

        // Frame Callback Time
        if (self.renderStats.frameCallbackTime) |frameCallbackTime| {
            var frameCallbackTimeText: [64]u8 = undefined;
            const frameCallbackTimeLen = std.fmt.bufPrint(&frameCallbackTimeText, "Frame Callback: {d:.3}ms (avg: {d:.3}ms)", .{ frameCallbackTime, frameCallbackTimeAvg }) catch return;
            self.nextRenderBuffer.drawText(frameCallbackTimeLen, x + 1, y + row, fg, bg, 0) catch {};
            row += 1;
        }

        // Overall Time
        if (self.renderStats.overallFrameTime) |overallTime| {
            var overallTimeText: [64]u8 = undefined;
            const overallTimeLen = std.fmt.bufPrint(&overallTimeText, "Overall: {d:.3}ms (avg: {d:.3}ms)", .{ overallTime, overallFrameTimeAvg }) catch return;
            self.nextRenderBuffer.drawText(overallTimeLen, x + 1, y + row, fg, bg, 0) catch {};
            row += 1;
        }

        // Render Time
        if (self.renderStats.renderTime) |renderTime| {
            var renderTimeText: [64]u8 = undefined;
            const renderTimeLen = std.fmt.bufPrint(&renderTimeText, "Render: {d:.3}ms (avg: {d:.3}ms)", .{ renderTime / 1000.0, renderTimeAvg / 1000.0 }) catch return;
            self.nextRenderBuffer.drawText(renderTimeLen, x + 1, y + row, fg, bg, 0) catch {};
            row += 1;
        }

        // Buffer Reset Time
        if (self.renderStats.bufferResetTime) |resetTime| {
            var resetTimeText: [64]u8 = undefined;
            const resetTimeLen = std.fmt.bufPrint(&resetTimeText, "Reset: {d:.3}ms (avg: {d:.3}ms)", .{ resetTime / 1000.0, bufferResetTimeAvg / 1000.0 }) catch return;
            self.nextRenderBuffer.drawText(resetTimeLen, x + 1, y + row, fg, bg, 0) catch {};
            row += 1;
        }

        // Output Write Time
        if (self.renderStats.outputWriteTime) |writeTime| {
            var writeTimeText: [64]u8 = undefined;
            const writeTimeLen = std.fmt.bufPrint(&writeTimeText, "Output: {d:.3}ms (avg: {d:.3}ms)", .{ writeTime / 1000.0, outputWriteTimeAvg / 1000.0 }) catch return;
            self.nextRenderBuffer.drawText(writeTimeLen, x + 1, y + row, fg, bg, 0) catch {};
            row += 1;
        }

        // Cells Updated
        var cellsText: [64]u8 = undefined;
        const cellsLen = std.fmt.bufPrint(&cellsText, "Cells: {d} (avg: {d})", .{ self.renderStats.cellsUpdated, cellsUpdatedAvg }) catch return;
        self.nextRenderBuffer.drawText(cellsLen, x + 1, y + row, fg, bg, 0) catch {};
        row += 1;

        if (self.renderStats.heapUsed > 0 or self.renderStats.heapTotal > 0) {
            var memoryText: [64]u8 = undefined;
            const memoryLen = std.fmt.bufPrint(&memoryText, "Memory: {d:.2}MB / {d:.2}MB / {d:.2}MB", .{ @as(f64, @floatFromInt(self.renderStats.heapUsed)) / 1024.0 / 1024.0, @as(f64, @floatFromInt(self.renderStats.heapTotal)) / 1024.0 / 1024.0, @as(f64, @floatFromInt(self.renderStats.arrayBuffers)) / 1024.0 / 1024.0 }) catch return;
            self.nextRenderBuffer.drawText(memoryLen, x + 1, y + row, fg, bg, 0) catch {};
            row += 1;
        }

        // Is threaded?
        var isThreadedText: [64]u8 = undefined;
        const isThreadedLen = std.fmt.bufPrint(&isThreadedText, "Threaded: {s}", .{if (self.backend.isUseThread()) "Yes" else "No"}) catch return;
        self.nextRenderBuffer.drawText(isThreadedLen, x + 1, y + row, fg, bg, 0) catch {};
        row += 1;
    }
};
