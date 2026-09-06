const std = @import("std");
const builtin = @import("builtin");
const compatibility_io = if (builtin.is_test) std.testing.io else if (@hasDecl(@import("root"), "io")) @import("root").io else std.Io.failing;
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
const terminal_image = @import("terminal-image.zig");
const kitty_transport = @import("kitty-transport.zig");
const native_image = @import("image.zig");

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

pub const PresentationOutcome = enum { presented, failed };

pub const RenderResult = struct {
    renderOffset: u32,
    status: RenderStatus,
};

pub const SplitSnapshot = struct {
    snapshot: *OptimizedBuffer,
    row_columns: u32,
    start_on_new_line: bool = false,
    trailing_newline: bool = true,
};

pub const SplitRender = struct {
    snapshots: []const SplitSnapshot,
    pinned_render_offset: u32,
    paint_footer: bool,
    suspended: bool,
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

pub const SplitFooterTransition = struct {
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

const SplitFrameState = struct {
    scrollback: split_scrollback.SplitScrollback,
    render_offset: u32,
    transition: SplitFooterTransition,
    kitty_history_next_image_id: ?u32 = null,
};

const CommittedImage = struct {
    placement_id: u32,
    image_handle: u32,
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
    protocol: ImageProtocol,
    background_hash: u64 = 0,
    lower_occupancy_hash: u64 = 0,
};

// Per-frame invalidation state for one placement. Sixel pixels live inside the
// covered cells, so a changed Sixel placement must clear and repaint its own
// rectangle; everything outside placements diffs normally. The resolved
// protocol is cached here so the per-cell render loop stays a table lookup.
const ImageDirty = struct {
    clear: bool,
    protocol: ImageProtocol,
    background_hash: u64,
    lower_occupancy_hash: u64,
    propagated: bool = false,
};

const ImageProtocol = enum { fallback, sixel, kitty };

const SnapshotImageState = struct {
    protocol: ImageProtocol = .fallback,
    kitty_base: ?u32 = null,
};

const SixelCacheKey = struct {
    image_handle: u32,
    source_x: u32,
    source_y: u32,
    source_width: u32,
    source_height: u32,
    cell_width: u32,
    cell_height: u32,
    pixel_width: u32,
    pixel_height: u32,
    opacity: u8,
    background_hash: u64,
};

const SixelCacheEntry = struct {
    payload: []u8,
    last_used: u64,
};

const SIXEL_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const SIXEL_CACHE_MAX_ENTRIES = 256;

// Cache the transformed, encoded payload: crop, size, opacity, and source identity determine its bytes;
// terminal position and DCS/tmux framing do not. Translucent placements also blend toward the covered
// cell backgrounds, so those payloads carry a background fingerprint. Byte and entry limits bound
// payload and metadata retention. An empty payload is cached for fully transparent placements.

pub const CliRenderer = struct {
    image_resolution: struct {
        terminal_width: u32 = 0,
        terminal_height: u32 = 0,
        pixel_width: u32 = 0,
        pixel_height: u32 = 0,
    } = .{},
    width: u32,
    height: u32,
    currentRenderBuffer: *OptimizedBuffer,
    nextRenderBuffer: *OptimizedBuffer,
    currentImages: std.ArrayListUnmanaged(CommittedImage) = .empty,
    pendingImages: std.ArrayListUnmanaged(CommittedImage) = .empty,
    imageDirty: std.ArrayListUnmanaged(ImageDirty) = .empty,
    imageIdSalt: u32,
    kittyHistoryNextImageId: ?u32,
    imageRenderFailed: bool = false,
    imageScreenInvalidated: bool = false,
    pool: *gp.GraphemePool,
    backgroundColor: RGBA,
    renderOffset: u32,
    terminal: Terminal,
    useAlternateScreen: bool = true,
    terminalSetup: bool = false,
    terminalSuspended: bool = false,
    clearOnShutdown: bool = true,

    splitScrollback: split_scrollback.SplitScrollback = .{},
    // Batch state for split-footer commit flushing. A single JS render tick can
    // enqueue multiple stdout snapshots; batching keeps all of them inside one
    // sync frame so terminals do not repeatedly enter/exit synchronized update.
    splitBatchActive: bool = false,
    splitBatchRedrawFooter: bool = false,
    splitBatchDeltaTime: f64 = 0,
    splitBatchStartState: SplitFrameState = .{ .scrollback = .{}, .render_offset = 0, .transition = .{} },
    pendingSplitFooterTransition: SplitFooterTransition = .{},

    /// Output transport. Owned by the renderer; destroyed in `destroy()`.
    backend: OutputBackend,

    pendingPresentation: ?struct {
        timestamp_us: i64,
        cells_updated: u32,
        render_time: ?f64,
        split_state: ?SplitFrameState = null,
        snapshot_only: bool = false,
    } = null,
    presentationFailed: bool = false,

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
    io: std.Io,
    logger: *const logger.Logger,
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
    mousePointerStateValid: bool = true,
    palette_rgba: [256]RGBA,
    default_fg_rgba: RGBA,
    default_bg_rgba: RGBA,
    palette_epoch: u32,
    last_rendered_palette_epoch: ?u32 = null,
    force_full_repaint: bool = false,
    palette_index_cache: std.AutoHashMapUnmanaged(u64, u8) = .empty,
    sixelCache: std.AutoHashMapUnmanaged(SixelCacheKey, SixelCacheEntry) = .empty,
    sixelCacheBytes: usize = 0,
    sixelCacheClock: u64 = 0,
    sixelCacheHits: u64 = 0,
    sixelCacheMisses: u64 = 0,
    kittyTransport: kitty_transport.Transport = .{},

    pub const OutputTarget = union(enum) {
        stdout,
        memory,
        buffered: BufferedOutput,
        feed: *NativeSpanFeed.Stream,
    };

    /// Full set of options for `createWithOptions`. `output` determines the
    /// backend variant: buffered stdout, injected buffered output, or feed.
    pub const CreateOptions = struct {
        io: std.Io = compatibility_io,
        logger: *const logger.Logger = logger.compatibilityLogger(),
        remote_mode: Terminal.RemoteMode = .local,
        output: OutputTarget = .stdout,
        clearOnShutdown: bool = true,
        // Borrowed: when provided, both frame buffers share this caller-owned pool.
        link_pool: ?*link.LinkPool = null,
        // Optional override for terminal environment lookups. Borrowed: the
        // caller owns the map and must keep it alive for the renderer's lifetime.
        env_map: ?*const std.process.Environ.Map = null,
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

        const currentBuffer = try OptimizedBuffer.init(allocator, width, height, .{
            .pool = pool,
            .link_pool = opts.link_pool,
            .logger = opts.logger,
            .width_method = .unicode,
            .id = "current buffer",
        });
        errdefer currentBuffer.deinit();
        const nextBuffer = try OptimizedBuffer.init(allocator, width, height, .{
            .pool = pool,
            .link_pool = opts.link_pool,
            .logger = opts.logger,
            .width_method = .unicode,
            .id = "next buffer",
        });
        errdefer nextBuffer.deinit();

        // stat sample arrays
        var lastFrameTime: std.ArrayListUnmanaged(f64) = .empty;
        errdefer lastFrameTime.deinit(allocator);
        var renderTime: std.ArrayListUnmanaged(f64) = .empty;
        errdefer renderTime.deinit(allocator);
        var overallFrameTime: std.ArrayListUnmanaged(f64) = .empty;
        errdefer overallFrameTime.deinit(allocator);
        var bufferResetTime: std.ArrayListUnmanaged(f64) = .empty;
        errdefer bufferResetTime.deinit(allocator);
        var outputWriteTime: std.ArrayListUnmanaged(f64) = .empty;
        errdefer outputWriteTime.deinit(allocator);
        var cellsUpdated: std.ArrayListUnmanaged(u32) = .empty;
        errdefer cellsUpdated.deinit(allocator);
        var frameCallbackTimes: std.ArrayListUnmanaged(f64) = .empty;
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
        const hitScissorStack: std.ArrayListUnmanaged(buf.ClipRect) = .empty;

        // Backend variant selected once by opts.output.
        var backend: OutputBackend = switch (opts.output) {
            .stdout => .{ .buffered = try BufferedBackend.createStdoutWithIo(allocator, opts.io) },
            .memory => .{ .buffered = try BufferedBackend.createMemoryWithIo(allocator, opts.io) },
            .buffered => |buffered_output| .{ .buffered = try BufferedBackend.createWithIo(allocator, opts.io, buffered_output) },
            .feed => |feed_ptr| .{ .feed = FeedBackend.createWithIo(opts.io, feed_ptr) },
        };
        errdefer backend.deinit();
        if (backend == .buffered) backend.buffered.logger = opts.logger;

        const timestamp: u96 = @bitCast(std.Io.Clock.now(.real, opts.io).nanoseconds);
        const image_id_salt = 1 + @as(u32, @truncate(@as(u128, timestamp) ^ @as(u128, @intFromPtr(self)))) % (std.math.maxInt(u32) - gp.IMAGE_ID_MASK - 1);
        self.* = .{
            .width = width,
            .height = height,
            .currentRenderBuffer = currentBuffer,
            .nextRenderBuffer = nextBuffer,
            .imageIdSalt = image_id_salt,
            .kittyHistoryNextImageId = image_id_salt + gp.IMAGE_ID_MASK + 1,
            .pool = pool,
            .backgroundColor = ansi.rgbColor(0, 0, 0, 0),
            .renderOffset = 0,
            .terminal = Terminal.init(.{ .remote_mode = opts.remote_mode, .env_map = opts.env_map }),
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
            .lastRenderTime = std.Io.Clock.now(.awake, opts.io).toMicroseconds(),
            .allocator = allocator,
            .io = opts.io,
            .logger = opts.logger,
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

        self.syncWidthMethod();
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
        self.destroyStorage();
    }

    /// Release renderer storage after the owner restores or disconnects its terminal.
    pub fn destroyStorage(self: *CliRenderer) void {
        self.kittyTransport.cancel(.cancelled);
        self.backend.deinit();
        self.terminal.deinit();

        self.currentRenderBuffer.deinit();
        self.nextRenderBuffer.deinit();
        self.currentImages.deinit(self.allocator);
        self.pendingImages.deinit(self.allocator);
        self.imageDirty.deinit(self.allocator);

        // Free stat sample arrays
        self.statSamples.lastFrameTime.deinit(self.allocator);
        self.statSamples.renderTime.deinit(self.allocator);
        self.statSamples.overallFrameTime.deinit(self.allocator);
        self.statSamples.bufferResetTime.deinit(self.allocator);
        self.statSamples.outputWriteTime.deinit(self.allocator);
        self.statSamples.cellsUpdated.deinit(self.allocator);
        self.statSamples.frameCallbackTime.deinit(self.allocator);
        self.palette_index_cache.deinit(self.allocator);
        var sixel_cache = self.sixelCache.iterator();
        while (sixel_cache.next()) |entry| self.allocator.free(entry.value_ptr.payload);
        self.sixelCache.deinit(self.allocator);

        self.allocator.free(self.currentHitGrid);
        self.allocator.free(self.nextHitGrid);
        self.hitScissorStack.deinit(self.allocator);

        self.allocator.destroy(self);
    }

    pub fn setupTerminal(self: *CliRenderer, useAlternateScreen: bool) void {
        if (self.pendingPresentation != null or self.presentationFailed) return;
        self.useAlternateScreen = useAlternateScreen;
        self.terminalSetup = true;
        self.terminalSuspended = false;

        // Build capability query into a stack buffer, then emit via backend.
        // Buffer sized to accommodate all capability-query sequences with margin.
        var queryBuf: [4096]u8 = undefined;
        var writer: std.Io.Writer = .fixed(&queryBuf);
        self.terminal.queryTerminalSend(&writer) catch {
            self.logger.warn("Failed to query terminal capabilities", .{});
        };
        self.backend.writeOut(writer.buffered());

        self.startKittyFileProbe();

        self.setupTerminalWithoutDetection(useAlternateScreen, true);
    }

    fn setupTerminalWithoutDetection(self: *CliRenderer, useAlternateScreen: bool, reserve_non_alt_surface: bool) void {
        var setupBuf: [4096]u8 = undefined;
        var fixed_writer: std.Io.Writer = .fixed(&setupBuf);
        const writer = &fixed_writer;

        writer.writeAll(ansi.ANSI.saveCursorState) catch {};

        if (useAlternateScreen) {
            self.terminal.enterAltScreen(writer) catch {};
        } else if (reserve_non_alt_surface) {
            ansi.ANSI.makeRoomForRendererOutput(writer, @max(self.height, 1)) catch {};
        }

        self.terminal.setCursorPosition(1, 1, false);
        const useKitty = self.terminal.opts.kitty_keyboard_flags > 0;
        self.terminal.enableDetectedFeatures(writer, useKitty) catch {};

        self.backend.writeOut(fixed_writer.buffered());
    }

    pub fn suspendRenderer(self: *CliRenderer) void {
        if (!self.terminalSetup) return;
        self.performShutdownSequence();
    }

    pub fn resumeRenderer(self: *CliRenderer) void {
        if (self.pendingPresentation != null or self.presentationFailed) return;
        if (!self.terminalSetup) return;
        self.terminalSuspended = false;
        self.setupTerminalWithoutDetection(self.useAlternateScreen, self.renderOffset == 0);
        self.startKittyFileProbe();
    }

    fn clearSplitFooterSurface(self: *CliRenderer, writer: anytype) void {
        if (self.renderOffset == 0) return;

        const footer_top_line = @max(self.renderOffset + 1, @as(u32, 1));
        writer.writeAll("\x1b[r") catch {};
        ansi.ANSI.moveToOutput(writer, 1, footer_top_line) catch {};
        writer.writeAll(ansi.ANSI.eraseBelowCursor) catch {};
        ansi.ANSI.moveToOutput(writer, 1, footer_top_line) catch {};
    }

    pub fn writeShutdownImage(self: *CliRenderer, writer: anytype, index: usize) !void {
        std.debug.assert(index < self.currentImages.items.len);
        const current = self.currentImages.items[index];
        if (current.protocol != .kitty) return;
        try terminal_image.writeKittyDelete(
            writer,
            self.kittyImageId(current.placement_id),
            null,
            true,
            self.terminal.isInTmux(),
        );
    }

    pub fn performShutdownSequence(self: *CliRenderer) void {
        self.terminalSuspended = true;
        self.kittyTransport.cancel(.cancelled);
        self.completePresentation(.failed) catch {};
        if (!self.terminalSetup) return;
        switch (self.backend) {
            .feed => |*backend| {
                if (backend.feed.producing) return;
                if (backend.frameActive) backend.cancelFrame();
            },
            .buffered => {},
        }
        if (self.splitBatchActive) {
            self.finishSplitBatch(false);
            _ = self.finishFailedFrame();
        }

        for (0..self.currentImages.items.len) |index| {
            var delete_buf: [128]u8 = undefined;
            var delete_writer: std.Io.Writer = .fixed(&delete_buf);
            self.writeShutdownImage(&delete_writer, index) catch {};
            if (delete_writer.buffered().len != 0 and !self.writeShutdown(delete_writer.buffered())) return;
        }

        // Build the shutdown ANSI sequence into a stack buffer, then emit.
        var shutdownBuf: [4096]u8 = undefined;
        var fixed_writer: std.Io.Writer = .fixed(&shutdownBuf);
        const writer = &fixed_writer;
        const previous_state = self.terminal.state;

        self.terminal.resetState(writer) catch {
            self.terminal.state = previous_state;
            self.logger.warn("Failed to reset terminal state", .{});
            return;
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

        if (!self.writeShutdown(fixed_writer.buffered())) {
            self.terminal.state = previous_state;
            return;
        }
        self.currentImages.clearRetainingCapacity();

        // Workaround for Ghostty not showing the cursor after shutdown for some reason.
        // Keep this backend-agnostic: the active output transport owns delivery.
        self.io.sleep(.fromMilliseconds(10), .awake) catch {};
        self.backend.writeOut(ansi.ANSI.showCursor);
        self.io.sleep(.fromMilliseconds(10), .awake) catch {};
    }

    fn writeShutdown(self: *CliRenderer, data: []const u8) bool {
        switch (self.backend) {
            .feed => |*backend| backend.writeOutChecked(data) catch return false,
            .buffered => |*backend| backend.writeOut(data),
        }
        return true;
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
        return self.resizeWithOutput(width, height, null);
    }

    /// Session screen transitions reserve storage before publishing their control packet.
    pub fn resizeWithOutput(self: *CliRenderer, width: u32, height: u32, bytes: ?[]const u8) !void {
        if (self.pendingPresentation != null) return error.PresentationPending;
        if (self.presentationFailed) return error.PresentationFailed;
        if (self.width == width and self.height == height) {
            if (bytes) |packet| try self.backend.feed.feed.writeAtomic(packet);
            return;
        }
        const newHitGridSize = std.math.mul(u32, width, height) catch return error.InvalidDimensions;
        var current = try self.currentRenderBuffer.prepareResize(width, height);
        defer current.deinit();
        var next = try self.nextRenderBuffer.prepareResize(width, height);
        defer next.deinit();
        const newHitGrids: ?[2][]u32 = if (newHitGridSize > self.currentHitGrid.len) grids: {
            const newCurrentHitGrid = try self.allocator.alloc(u32, newHitGridSize);
            errdefer self.allocator.free(newCurrentHitGrid);
            const newNextHitGrid = try self.allocator.alloc(u32, newHitGridSize);
            break :grids .{ newCurrentHitGrid, newNextHitGrid };
        } else null;
        errdefer if (newHitGrids) |grids| {
            self.allocator.free(grids[0]);
            self.allocator.free(grids[1]);
        };
        if (bytes) |packet| try self.backend.feed.feed.writeAtomic(packet);

        // Every fallible allocation finishes before any visible state changes.
        current.commit();
        next.commit();
        self.width = width;
        self.height = height;
        self.nextRenderBuffer.setBlendBackdropColor(ansi.rgbColor(ansi.red(self.backgroundColor), ansi.green(self.backgroundColor), ansi.blue(self.backgroundColor), 255));
        self.currentRenderBuffer.clear(ansi.rgbColor(0, 0, 0, 255), CLEAR_CHAR);
        self.nextRenderBuffer.clear(self.backgroundColor, null);
        if (newHitGrids) |grids| {
            self.allocator.free(self.currentHitGrid);
            self.allocator.free(self.nextHitGrid);
            self.currentHitGrid = grids[0];
            self.nextHitGrid = grids[1];
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
        if (self.pendingPresentation != null) return;
        if (self.terminalSetup and !self.useAlternateScreen and self.renderOffset > 0 and offset == 0) {
            var clearBuf: [256]u8 = undefined;
            var fixed_writer: std.Io.Writer = .fixed(&clearBuf);
            const writer = &fixed_writer;
            self.clearSplitFooterSurface(writer);
            self.backend.writeOut(fixed_writer.buffered());
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
        self.pendingImages.clearRetainingCapacity();
        self.clearSkippedFrameState();
        return .skipped;
    }

    fn finishFailedFrame(self: *CliRenderer) RenderStatus {
        self.kittyTransport.cancel(.io_error);
        self.pendingImages.clearRetainingCapacity();
        @memset(self.nextHitGrid, 0);
        self.invalidateTerminalState();
        return .failed;
    }

    pub fn invalidateTerminalState(self: *CliRenderer) void {
        self.force_full_repaint = true;
        self.lastCursorStyleTag = null;
        self.lastCursorBlinking = null;
        self.lastCursorColorRGB = null;
        self.lastCursorX = null;
        self.lastCursorY = null;
        self.lastCursorVisible = null;
        self.mousePointerStateValid = false;
    }

    fn commitPendingHitGrid(self: *CliRenderer) void {
        self.hitGridDirty = self.hitGridResizeInvalidated or !std.mem.eql(u32, self.currentHitGrid, self.nextHitGrid);
        const previous = self.currentHitGrid;
        self.currentHitGrid = self.nextHitGrid;
        self.nextHitGrid = previous;
        @import("utils.zig").fillU32(self.nextHitGrid, 0);
    }

    fn renderResult(self: *CliRenderer, status: RenderStatus) RenderResult {
        return .{ .renderOffset = self.renderOffset, .status = status };
    }

    fn splitFrameState(self: *const CliRenderer) SplitFrameState {
        return .{
            .scrollback = self.splitScrollback,
            .render_offset = self.renderOffset,
            .transition = self.pendingSplitFooterTransition,
            .kitty_history_next_image_id = self.kittyHistoryNextImageId,
        };
    }

    fn restoreSplitFrameState(self: *CliRenderer, state: SplitFrameState) void {
        self.splitScrollback = state.scrollback;
        self.renderOffset = state.render_offset;
        self.pendingSplitFooterTransition = state.transition;
        self.kittyHistoryNextImageId = state.kitty_history_next_image_id;
    }

    fn finishSplitBatch(self: *CliRenderer, published: bool) void {
        if (!published) self.restoreSplitFrameState(self.splitBatchStartState);
        self.splitBatchActive = false;
        self.splitBatchRedrawFooter = false;
        self.splitBatchDeltaTime = 0;
    }

    pub fn render(self: *CliRenderer, force: bool) RenderStatus {
        return self.renderFrame(force, false, null);
    }

    /// Accept an ordinary frame into a callback-free feed without publishing its
    /// hit grid, images, or statistics. The owner must finish or discard the frame's
    /// bytes before calling completePresentation. Failed output stops presentation
    /// permanently; this helper cannot repair partially delivered terminal commands.
    /// The owner also controls terminal lifecycle. Legacy setup and split prefixes
    /// remain on the legacy render path until their Session adapters are available.
    pub fn renderDeferred(self: *CliRenderer, force: bool) error{
        PresentationPending,
        PresentationFailed,
        IncompatibleOutput,
        SplitRenderPending,
    }!RenderStatus {
        if (self.pendingPresentation != null) return error.PresentationPending;
        if (self.presentationFailed) return error.PresentationFailed;
        if (self.terminalSetup or self.backend != .feed or
            self.backend.feed.feed.callback != null or self.backend.feed.feed.in_callback)
        {
            return error.IncompatibleOutput;
        }
        if (self.splitBatchActive or self.pendingSplitFooterTransition.mode != .none) {
            return error.SplitRenderPending;
        }
        if (self.backend.feed.frameActive) return error.IncompatibleOutput;
        return self.renderFrame(force, true, null);
    }

    pub fn renderSplitDeferred(self: *CliRenderer, split: SplitRender, force: bool) !RenderStatus {
        if (self.pendingPresentation != null) return error.PresentationPending;
        if (self.presentationFailed) return error.PresentationFailed;
        if (self.terminalSetup or self.backend != .feed or self.backend.feed.feed.callback != null or
            self.backend.feed.feed.in_callback or self.backend.feed.frameActive or self.splitBatchActive)
            return error.IncompatibleOutput;
        return self.renderFrame(force, true, split);
    }

    pub fn completePresentation(
        self: *CliRenderer,
        outcome: PresentationOutcome,
    ) error{NoPendingPresentation}!void {
        const pending = self.pendingPresentation orelse return error.NoPendingPresentation;
        self.pendingPresentation = null;
        if (outcome == .failed) {
            self.presentationFailed = true;
            _ = self.finishFailedFrame();
            return;
        }

        const delta_time = @as(f64, @floatFromInt(pending.timestamp_us - self.lastRenderTime)) / 1000.0;
        self.lastRenderTime = pending.timestamp_us;
        self.renderStats.cellsUpdated = pending.cells_updated;
        self.renderStats.renderTime = pending.render_time;
        if (pending.split_state) |state| self.restoreSplitFrameState(state);
        if (!pending.snapshot_only) {
            self.commitPendingHitGrid();
            self.commitPendingImageState();
        } else {
            self.invalidateTerminalState();
        }
        self.collectFrameStats(delta_time);
    }

    // One code path; backend selects writer type at compile time.
    fn renderFrame(self: *CliRenderer, force: bool, deferred: bool, split: ?SplitRender) RenderStatus {
        if (self.pendingPresentation != null) return .skipped;
        if (self.presentationFailed) return .failed;
        // Backpressure: skipping must NOT update lastRenderTime so the next
        // successful render sees the full accumulated delta (catch-up).
        if (self.backend.prepareFrame() != .ok) {
            return self.finishSkippedFrame();
        }

        const now = std.Io.Clock.now(.awake, self.io).toMicroseconds();
        const deltaTimeMs = @as(f64, @floatFromInt(now - self.lastRenderTime));
        const deltaTime = deltaTimeMs / 1000.0;

        if (!deferred) self.lastRenderTime = now;
        const paint_footer = if (split) |options| options.paint_footer else true;
        if (paint_footer) self.renderDebugOverlay();
        const start_split_state = self.splitFrameState();
        const previous_stats = self.renderStats;
        self.imageRenderFailed = false;

        // Batch small ANSI fragments before backend admission without retaining bytes between frames.
        var write_status: output.WriteStatus = .ok;
        switch (self.backend) {
            inline else => |*b| {
                b.beginFrame();
                var w = b.writer();
                var scratch: [4096]u8 = undefined;
                w.interface.buffer = &scratch;
                const writer = &w.interface;
                var frame_started = false;
                var redraw_footer = force;
                if (split) |options| {
                    const previous_offset = self.renderOffset;
                    const transition = if (options.suspended) SplitFooterTransition{} else self.pendingSplitFooterTransition;
                    self.renderOffset = if (transition.mode == .viewport_scroll and transition.target_top_line > 0 and transition.scroll_lines > 0)
                        transition.target_top_line - 1
                    else
                        self.clampSplitSurfaceOffset(previous_offset, options.pinned_render_offset);
                    redraw_footer = redraw_footer or previous_offset != self.renderOffset;
                    if (options.snapshots.len != 0) {
                        beginRenderFrame(writer);
                        frame_started = true;
                        if (!options.suspended) self.applyPendingSplitFooterTransition(writer, &frame_started);
                        for (options.snapshots) |commit| {
                            const redraw = self.appendSplitFooterSnapshotCommit(writer, commit.snapshot, commit.row_columns, commit.start_on_new_line, commit.trailing_newline, options.pinned_render_offset, force) catch blk: {
                                self.imageRenderFailed = true;
                                b.failFrame();
                                break :blk false;
                            };
                            redraw_footer = redraw_footer or redraw;
                            if (self.imageRenderFailed) break;
                        }
                    }
                }
                if (paint_footer) {
                    self.prepareRenderFrameWithWriter(writer, redraw_footer, frame_started) catch b.failFrame();
                } else {
                    if (frame_started) {
                        if (split.?.suspended) {
                            ansi.ANSI.moveToOutput(writer, 1, self.renderOffset + 1) catch b.failFrame();
                            writer.writeAll(ansi.ANSI.showCursor) catch b.failFrame();
                        }
                        writer.writeAll(ansi.ANSI.syncReset) catch b.failFrame();
                    }
                    writer.flush() catch b.failFrame();
                }
                if (self.imageRenderFailed) b.failFrame();
                write_status = b.endFrame();
            },
        }

        const status = renderStatusFromWrite(write_status);
        if (status == .failed or self.imageRenderFailed) {
            self.renderStats = previous_stats;
            const result = self.finishFailedFrame();
            self.restoreSplitFrameState(start_split_state);
            return result;
        }
        if (deferred) {
            self.pendingPresentation = .{
                .timestamp_us = now,
                .cells_updated = if (paint_footer) self.renderStats.cellsUpdated else 0,
                .render_time = if (paint_footer) self.renderStats.renderTime else null,
                .split_state = if (split != null) self.splitFrameState() else null,
                .snapshot_only = !paint_footer,
            };
            if (split != null) self.restoreSplitFrameState(start_split_state);
            self.renderStats = previous_stats;
            return status;
        }
        self.commitPendingHitGrid();
        self.commitPendingImageState();

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
        if (self.pendingPresentation != null) return self.renderOffset;
        self.splitScrollback.reset(seed_rows);
        self.renderOffset = self.splitScrollback.renderOffset(pinned_render_offset);
        return self.renderOffset;
    }

    pub fn syncSplitScrollback(self: *CliRenderer, pinned_render_offset: u32) u32 {
        if (self.pendingPresentation != null) return self.renderOffset;
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
        if (self.pendingPresentation != null) return;
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
        if (self.pendingPresentation != null) return;
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
        if (self.pendingPresentation != null) return self.renderResult(.skipped);
        if (self.presentationFailed) return self.renderResult(.failed);
        if (self.backend.prepareFrame() != .ok) {
            const status = self.finishSkippedFrame();
            return self.renderResult(status);
        }

        const now = std.Io.Clock.now(.awake, self.io).toMicroseconds();
        const deltaTimeMs = @as(f64, @floatFromInt(now - self.lastRenderTime));
        const deltaTime = deltaTimeMs / 1000.0;

        self.lastRenderTime = now;
        self.renderDebugOverlay();

        const start_split_state = self.splitFrameState();
        const previous_stats = self.renderStats;
        const status = self.prepareSplitFooterRepaintFrame(pinned_render_offset, force);
        var result_status = status;
        if (status == .failed) {
            self.renderStats = previous_stats;
            result_status = self.finishFailedFrame();
            self.restoreSplitFrameState(start_split_state);
        } else {
            self.collectFrameStats(deltaTime);
        }

        return self.renderResult(result_status);
    }

    pub fn commitSplitFooterSnapshotBatched(
        self: *CliRenderer,
        snapshot: *OptimizedBuffer,
        row_columns: u32,
        start_on_new_line: bool,
        trailing_newline: bool,
        pinned_render_offset: u32,
        force: bool,
        begin_frame: bool,
        finalize_frame: bool,
    ) RenderResult {
        return self.commitSplitFooterSnapshotWithOptions(
            snapshot,
            row_columns,
            start_on_new_line,
            trailing_newline,
            pinned_render_offset,
            force,
            .{ .begin_frame = begin_frame, .finalize_frame = finalize_frame },
        );
    }

    pub fn commitSplitFooterSnapshotWithOptions(
        self: *CliRenderer,
        snapshot: *OptimizedBuffer,
        row_columns: u32,
        start_on_new_line: bool,
        trailing_newline: bool,
        pinned_render_offset: u32,
        force: bool,
        options: struct {
            begin_frame: bool = true,
            finalize_frame: bool = true,
            control_output: bool = false,
        },
    ) RenderResult {
        if (self.pendingPresentation != null) return self.renderResult(.skipped);
        if (self.presentationFailed) return self.renderResult(.failed);
        // Batched commit protocol:
        // - first call starts frame and appends payload
        // - middle calls append payload only
        // - final call renders footer diff/cursor and closes frame
        // This avoids repeated syncSet/syncReset and cursor toggles per chunk.
        const previous_stats = self.renderStats;
        if (options.begin_frame) {
            const ready = if (options.control_output)
                self.backend.prepareControlFrame()
            else
                self.backend.prepareFrame();
            if (ready != .ok) {
                const status = self.finishSkippedFrame();
                return self.renderResult(status);
            }

            const now = std.Io.Clock.now(.awake, self.io).toMicroseconds();
            const deltaTimeMs = @as(f64, @floatFromInt(now - self.lastRenderTime));
            const deltaTime = deltaTimeMs / 1000.0;

            self.lastRenderTime = now;
            self.renderDebugOverlay();
            self.imageRenderFailed = false;

            var write_status: output.WriteStatus = .ok;
            var result_status: RenderStatus = .rendered;
            switch (self.backend) {
                inline else => |*b| {
                    b.beginFrame();
                    var w = b.writer();
                    beginRenderFrame(&w);
                    var frame_started = true;
                    self.splitBatchStartState = self.splitFrameState();
                    self.applyPendingSplitFooterTransition(&w, &frame_started);

                    // Track batch lifetime so subsequent calls can append into the same
                    // output buffer without restarting frame state.
                    self.splitBatchActive = !options.finalize_frame;
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
                    ) catch blk: {
                        self.imageRenderFailed = true;
                        break :blk false;
                    };

                    if (options.finalize_frame) {
                        self.prepareRenderFrameWithWriter(&w, redraw_footer, true) catch b.failFrame();
                        if (self.imageRenderFailed) b.failFrame();
                        write_status = b.endFrame();
                        const status = renderStatusFromWrite(write_status);
                        if (status == .failed or self.imageRenderFailed) {
                            self.renderStats = previous_stats;
                            result_status = self.finishFailedFrame();
                        } else {
                            self.commitPendingHitGrid();
                            self.commitPendingImageState();
                            result_status = status;
                            self.collectFrameStats(deltaTime);
                        }

                        self.finishSplitBatch(result_status != .failed);
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
            return self.commitSplitFooterSnapshotWithOptions(
                snapshot,
                row_columns,
                start_on_new_line,
                trailing_newline,
                pinned_render_offset,
                force,
                .{ .control_output = options.control_output },
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
                ) catch blk: {
                    self.imageRenderFailed = true;
                    break :blk false;
                };
                self.splitBatchRedrawFooter = self.splitBatchRedrawFooter or redraw_footer;

                if (options.finalize_frame) {
                    self.prepareRenderFrameWithWriter(&w, self.splitBatchRedrawFooter, true) catch b.failFrame();
                    if (self.imageRenderFailed) b.failFrame();
                    // Publication callbacks must not cancel the completed split batch.
                    self.splitBatchActive = false;
                    write_status = b.endFrame();

                    const status = renderStatusFromWrite(write_status);
                    if (status == .failed or self.imageRenderFailed) {
                        self.renderStats = previous_stats;
                        result_status = self.finishFailedFrame();
                    } else {
                        self.commitPendingHitGrid();
                        self.commitPendingImageState();
                        result_status = status;
                        self.collectFrameStats(self.splitBatchDeltaTime);
                    }

                    self.finishSplitBatch(result_status != .failed);
                } else {
                    result_status = .rendered;
                }
            },
        }

        return self.renderResult(result_status);
    }

    fn reserveKittyHistoryImageIds(self: *CliRenderer, count: usize) ?u32 {
        if (count == 0 or count > std.math.maxInt(u32)) return null;
        const first = self.kittyHistoryNextImageId orelse return null;
        const last = std.math.add(u32, first, @as(u32, @intCast(count)) - 1) catch return null;
        self.kittyHistoryNextImageId = if (last == std.math.maxInt(u32)) null else last + 1;
        return first - 1;
    }

    fn snapshotDirectImagesAddressable(
        placements: []const OptimizedBuffer.ImagePlacement,
        row_columns: u32,
        start_on_new_line: bool,
        previous_output_column: u32,
        pinned_render_offset: u32,
    ) bool {
        if (pinned_render_offset == 0 or (!start_on_new_line and previous_output_column != 0)) return false;
        // Images are placed after their last row is written. Even while the footer
        // is settling, the rectangle remains addressable if it fits the upper pane.
        for (placements) |placement| {
            if (placement.x < 0 or placement.y < 0 or
                @as(u64, @intCast(placement.x)) + placement.width > row_columns or
                placement.height > pinned_render_offset) return false;
        }
        return true;
    }

    fn snapshotPlacementUncovered(snapshot: *const OptimizedBuffer, placement: OptimizedBuffer.ImagePlacement) bool {
        var y: u32 = 0;
        while (y < placement.height) : (y += 1) {
            var x: u32 = 0;
            while (x < placement.width) : (x += 1) {
                const cell = snapshot.get(
                    @intCast(placement.x + @as(i32, @intCast(x))),
                    @intCast(placement.y + @as(i32, @intCast(y))),
                ) orelse return false;
                if (!gp.isImageChar(cell.char) or gp.imageIdFromChar(cell.char) != placement.placement_id) return false;
            }
        }
        return true;
    }

    fn prepareSnapshotImages(
        self: *CliRenderer,
        snapshot: *OptimizedBuffer,
        row_columns: u32,
        start_on_new_line: bool,
        previous_output_column: u32,
        pinned_render_offset: u32,
    ) !SnapshotImageState {
        const placements = snapshot.image_placements.items;
        if (placements.len == 0) return .{};
        const protocol = self.nextPlacementProtocol(placements[0]);
        for (placements, 0..) |placement, index| {
            if (self.nextPlacementProtocol(placement) != protocol) {
                try snapshot.materializeImageFallbacks();
                return .{};
            }
            for (placements[0..index]) |previous| {
                if (placementsOverlap(previous, placement)) {
                    try snapshot.materializeImageFallbacks();
                    return .{};
                }
            }
        }
        if (protocol == .sixel) {
            if (!snapshotDirectImagesAddressable(
                placements,
                row_columns,
                start_on_new_line,
                previous_output_column,
                pinned_render_offset,
            )) {
                try snapshot.materializeImageFallbacks();
                return .{};
            }
            for (placements) |placement| {
                if (!snapshotPlacementUncovered(snapshot, placement)) {
                    try snapshot.materializeImageFallbacks();
                    return .{};
                }
            }
            return .{ .protocol = .sixel };
        }
        if (protocol != .kitty) {
            try snapshot.materializeImageFallbacks();
            return .{};
        }
        if (!snapshotDirectImagesAddressable(
            placements,
            row_columns,
            start_on_new_line,
            previous_output_column,
            pinned_render_offset,
        )) {
            try snapshot.materializeImageFallbacks();
            return .{};
        }
        const base = self.reserveKittyHistoryImageIds(placements.len) orelse {
            try snapshot.materializeImageFallbacks();
            return .{};
        };
        return .{ .protocol = .kitty, .kitty_base = base };
    }

    fn writeSnapshotSixelImage(
        self: *CliRenderer,
        writer: anytype,
        snapshot: *OptimizedBuffer,
        placement: OptimizedBuffer.ImagePlacement,
    ) !void {
        const source = placement.image;
        var prepared = source;
        var prepared_owned = false;
        defer if (prepared_owned) prepared.deinit();
        if (placement.source_x != 0 or placement.source_y != 0 or
            placement.source_width != source.width() or placement.source_height != source.height())
        {
            prepared = try native_image.extract(
                self.allocator,
                source,
                placement.source_x,
                placement.source_y,
                placement.source_width,
                placement.source_height,
            );
            prepared_owned = true;
        }
        if (placement.pixel_width != prepared.width() or placement.pixel_height != prepared.height()) {
            const resized = try native_image.resize(self.allocator, prepared, placement.pixel_width, placement.pixel_height, .area);
            if (prepared_owned) prepared.deinit();
            prepared = resized;
            prepared_owned = true;
        }
        if (placement.opacity < 255) {
            if (!prepared_owned) {
                prepared = try source.clone();
                prepared_owned = true;
            }
            try dimSixelPixels(snapshot, placement, prepared);
        }
        var quantized = try terminal_image.quantizeSixel(self.allocator, prepared, 255);
        defer quantized.deinit();
        if (quantized.palette_len == 0) return;
        var payload: std.Io.Writer.Allocating = .init(self.allocator);
        defer payload.deinit();
        try terminal_image.writeSixelIndexedPayload(
            self.allocator,
            &payload.writer,
            quantized.indices,
            quantized.palette[0..quantized.palette_len],
            prepared.width(),
            prepared.height(),
        );
        try terminal_image.writeSixelFramedPayload(writer, payload.written(), self.terminal.isInTmux());
    }

    fn writeSnapshotKittyImage(
        self: *CliRenderer,
        writer: anytype,
        placement: OptimizedBuffer.ImagePlacement,
        image_id: u32,
    ) !void {
        const transmit = try self.kittyPlacementTransmit(placement, .pixels);
        defer if (transmit.owned) transmit.image.deinit();
        // Scrollback has no retained source to retry after a failed file upload.
        // Keep it self-contained; compression still applies when explicitly requested.
        self.kittyTransport.effective = try terminal_image.writeKittyTransmitEncoded(
            self.allocator,
            writer,
            transmit.image,
            image_id,
            self.terminal.isInTmux(),
            self.kittyTransport.mode == .zlib,
        );
        self.kittyTransport.fallback = if (self.kittyTransport.mode == .file)
            .unavailable
        else if (self.kittyTransport.mode == .zlib and self.kittyTransport.effective == .raw)
            .compression
        else
            .none;
        try terminal_image.writeKittyPlacementAtCursor(
            writer,
            image_id,
            placement.placement_id,
            placement.width,
            placement.height,
            -1_500_000_000 + @as(i32, @intCast(placement.placement_id)),
            self.terminal.isInTmux(),
        );
    }

    fn writeSnapshotNativeImagesForRow(
        self: *CliRenderer,
        writer: anytype,
        snapshot: *OptimizedBuffer,
        row: u32,
        image_state: SnapshotImageState,
    ) !void {
        for (snapshot.image_placements.items) |placement| {
            const last_row = @as(u32, @intCast(placement.y)) + placement.height - 1;
            if (last_row != row) continue;
            try writer.writeAll(ansi.ANSI.saveCursorState);
            if (placement.height > 1) try writer.print("\x1b[{d}A", .{placement.height - 1});
            try writer.writeByte('\r');
            if (placement.x > 0) try writer.print("\x1b[{d}C", .{placement.x});
            if (image_state.protocol == .sixel) {
                try self.writeSnapshotSixelImage(writer, snapshot, placement);
            } else if (image_state.protocol == .kitty) {
                try self.writeSnapshotKittyImage(writer, placement, image_state.kitty_base.? + placement.placement_id);
            }
            try writer.writeAll(ansi.ANSI.restoreCursorState);
        }
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
        snapshot: *OptimizedBuffer,
        row_columns: u32,
        trailing_newline: bool,
        image_state: SnapshotImageState,
    ) !void {
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

                if (image_state.protocol == .kitty and gp.isImageChar(cell.char)) {
                    writer.writeAll(ansi.ANSI.reset) catch {};
                    writer.writeByte(' ') catch {};
                    currentFg = null;
                    currentBg = null;
                    currentAttributes = null;
                    continue;
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
                        const lp = snapshot.link_pool;
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
                } else if (gp.isImageChar(cell.char)) {
                    if (image_state.protocol == .sixel or image_state.protocol == .kitty) {
                        writer.writeByte(' ') catch {};
                    } else {
                        const fallback = buf.quadrantChars[gp.imageFallbackFromChar(cell.char)];
                        const len = std.unicode.utf8Encode(@intCast(fallback), &utf8Buf) catch unreachable;
                        writer.writeAll(utf8Buf[0..len]) catch {};
                    }
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
            if (image_state.protocol == .sixel or image_state.protocol == .kitty) {
                try self.writeSnapshotNativeImagesForRow(writer, snapshot, y, image_state);
            }
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
        snapshot: *OptimizedBuffer,
        row_columns: u32,
        start_on_new_line: bool,
        trailing_newline: bool,
        pinned_render_offset: u32,
        force: bool,
    ) !bool {
        const previousSurfaceOffset = self.renderOffset;
        const previousOutputOffset = self.splitOutputOffset(previousSurfaceOffset);
        const previousOutputColumn = self.splitScrollback.tail_column;
        const snapshot_has_content = snapshot.width > 0 and snapshot.height > 0;
        const normalized_row_columns = @min(row_columns, snapshot.width);
        const kitty_history_state = try self.prepareSnapshotImages(
            snapshot,
            normalized_row_columns,
            start_on_new_line,
            previousOutputColumn,
            pinned_render_offset,
        );
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
        // When split scrollback is settled at the pinned boundary, newlines/wraps from
        // appended output must scroll only the upper pane. Without a temporary DECSTBM
        // region, terminals advance into the footer rows and overwrite them in place.
        const use_bounded_scroll_region = snapshot_has_content and
            pinned_render_offset > 0 and
            next_render_offset == pinned_render_offset and
            next_output_offset == next_render_offset;
        // DECSTBM protects footer cells, but terminals can still scroll native
        // graphics placements. Repaint those placements after every pinned append.
        const repaint_native_images = use_bounded_scroll_region and
            (self.hasCommittedProtocol(.kitty) or self.hasCommittedProtocol(.sixel));
        const redraw_footer = force or previousSurfaceOffset != next_render_offset or repaint_native_images;

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
                try self.writeSnapshotCommit(writer, snapshot, normalized_row_columns, trailing_newline, kitty_history_state);

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
        self.imageRenderFailed = false;
        // Do not pre-start sync frame here. prepareRenderFrameWithWriter now lazily starts
        // frame output only when something actually changes; this prevents no-op
        // repaint ticks from emitting hide/show cursor and sync envelopes.
        var write_status: output.WriteStatus = .ok;
        switch (self.backend) {
            inline else => |*b| {
                b.beginFrame();
                var w = b.writer();
                self.prepareRenderFrameWithWriter(&w, redraw_footer, false) catch b.failFrame();
                if (self.imageRenderFailed) b.failFrame();
                write_status = b.endFrame();
            },
        }
        const status = renderStatusFromWrite(write_status);
        if (status == .failed or self.imageRenderFailed) return self.finishFailedFrame();
        self.commitPendingHitGrid();
        self.commitPendingImageState();
        return status;
    }

    pub fn getNextBuffer(self: *CliRenderer) *OptimizedBuffer {
        return self.nextRenderBuffer;
    }

    pub fn getCurrentBuffer(self: *CliRenderer) *OptimizedBuffer {
        return self.currentRenderBuffer;
    }

    fn imageStateChanged(self: *CliRenderer) bool {
        const next = self.nextRenderBuffer.image_placements.items;
        if (next.len != self.currentImages.items.len) return true;
        for (next, self.currentImages.items, 0..) |a, b, index| {
            if (a.placement_id != b.placement_id or a.image_handle != b.image_handle or a.x != b.x or a.y != b.y or a.width != b.width or a.height != b.height or
                a.pixel_width != b.pixel_width or a.pixel_height != b.pixel_height) return true;
            if (a.source_x != b.source_x or a.source_y != b.source_y or a.source_width != b.source_width or a.source_height != b.source_height or a.opacity != b.opacity) return true;
            if (self.nextPlacementProtocol(a) != b.protocol) return true;
            if (index < self.imageDirty.items.len and self.imageDirty.items[index].background_hash != b.background_hash) return true;
            if (index < self.imageDirty.items.len and self.imageDirty.items[index].lower_occupancy_hash != b.lower_occupancy_hash) return true;
        }
        return false;
    }

    fn resolveImageProtocol(self: *CliRenderer, requested: native_image.RenderProtocol) ImageProtocol {
        const configured = if (requested == .auto) self.terminal.image_protocol else switch (requested) {
            .auto => unreachable,
            .kitty => Terminal.ImageProtocol.kitty,
            .sixel => Terminal.ImageProtocol.sixel,
            .blocks => Terminal.ImageProtocol.blocks,
        };
        if (configured == .sixel and self.terminal.refusesForcedSixel()) {
            return .fallback;
        }
        switch (configured) {
            .kitty => return .kitty,
            .sixel => return .sixel,
            .blocks => return .fallback,
            .auto => {},
        }
        // Multiplexers need pane-aware placeholder/native graphics handling.
        if (self.terminal.isInTmux()) return .fallback;
        const caps = self.terminal.getCapabilities();
        if (caps.kitty_graphics) return .kitty;
        if (caps.sixel) return .sixel;
        return .fallback;
    }

    fn hasCommittedProtocol(self: *CliRenderer, protocol: ImageProtocol) bool {
        for (self.currentImages.items) |image| if (image.protocol == protocol) return true;
        return false;
    }

    fn hasNextProtocol(self: *CliRenderer, protocol: ImageProtocol) bool {
        for (self.nextRenderBuffer.image_placements.items) |placement| {
            if (self.nextPlacementProtocol(placement) == protocol) return true;
        }
        return false;
    }

    fn nextPlacementProtocol(self: *CliRenderer, placement: OptimizedBuffer.ImagePlacement) ImageProtocol {
        const protocol = self.resolveImageProtocol(placement.protocol);
        if (protocol == .sixel and !native_image.dimensionsWithinLimits(placement.pixel_width, placement.pixel_height)) return .fallback;
        return protocol;
    }

    // Existing overlay cells are repainted by normal cell diffing. The Sixel
    // image only needs retransmission when an overlay disappears and exposes it.
    fn placementExposed(self: *CliRenderer, placement: OptimizedBuffer.ImagePlacement) bool {
        var py: u32 = 0;
        while (py < placement.height) : (py += 1) {
            const y = placement.y + @as(i32, @intCast(py));
            if (y < 0 or y >= self.height) continue;
            var px: u32 = 0;
            while (px < placement.width) : (px += 1) {
                const x = placement.x + @as(i32, @intCast(px));
                if (x < 0 or x >= self.width) continue;
                const current = self.currentRenderBuffer.get(@intCast(x), @intCast(y)) orelse continue;
                const next = self.nextRenderBuffer.get(@intCast(x), @intCast(y)) orelse continue;
                if (gp.isImageChar(next.char) and gp.imageIdFromChar(next.char) == placement.placement_id and
                    (!gp.isImageChar(current.char) or gp.imageIdFromChar(current.char) != placement.placement_id)) return true;
            }
        }
        return false;
    }

    fn placementNeedsClear(
        self: *CliRenderer,
        placement: OptimizedBuffer.ImagePlacement,
        protocol: ImageProtocol,
        background_hash: u64,
        lower_occupancy_hash: u64,
        forced: bool,
    ) bool {
        // Fallback placements materialize into ordinary cells; diffing covers them.
        if (protocol == .fallback) return false;
        if (forced) return true;
        const committed = self.currentImageForPlacement(placement.placement_id) orelse return true;
        if (committed.protocol != protocol or committed.x != placement.x or committed.y != placement.y or
            committed.width != placement.width or committed.height != placement.height or
            committed.pixel_width != placement.pixel_width or committed.pixel_height != placement.pixel_height or
            committed.source_x != placement.source_x or committed.source_y != placement.source_y or
            committed.source_width != placement.source_width or committed.source_height != placement.source_height or
            committed.opacity != placement.opacity) return true;
        // Kitty replaces image data server side, so content changes do not
        // require clearing cells. Sixel pixels are the cells, so content and
        // blended-background changes repaint the rectangle.
        if (protocol == .sixel and (committed.image_handle != placement.image_handle or
            committed.background_hash != background_hash or
            committed.lower_occupancy_hash != lower_occupancy_hash)) return true;
        return protocol == .sixel and self.placementExposed(placement);
    }

    fn currentImageForPlacement(self: *const CliRenderer, placement_id: u32) ?CommittedImage {
        if (placement_id == 0 or placement_id > self.currentImages.items.len) return null;
        const committed = self.currentImages.items[placement_id - 1];
        return if (committed.placement_id == placement_id) committed else null;
    }

    fn placementsOverlap(a: OptimizedBuffer.ImagePlacement, b: OptimizedBuffer.ImagePlacement) bool {
        const a_left: i64 = a.x;
        const a_top: i64 = a.y;
        const b_left: i64 = b.x;
        const b_top: i64 = b.y;
        return a_left < b_left + b.width and b_left < a_left + a.width and
            a_top < b_top + b.height and b_top < a_top + a.height;
    }

    fn computeImageDirtyFlags(self: *CliRenderer, forced: bool) void {
        self.imageDirty.clearRetainingCapacity();
        const placements = self.nextRenderBuffer.image_placements.items;
        self.imageDirty.ensureTotalCapacity(self.allocator, placements.len) catch {
            self.imageRenderFailed = true;
            self.force_full_repaint = true;
            return;
        };
        for (placements) |placement| {
            const protocol = self.nextPlacementProtocol(placement);
            const background_hash = if (protocol == .sixel and placement.opacity < 255)
                self.placementBackgroundHash(placement)
            else
                0;
            const lower_occupancy_hash = if (protocol == .sixel and placement.image.metadata.has_alpha != 0)
                self.placementLowerOccupancyHash(placement)
            else
                0;
            self.imageDirty.appendAssumeCapacity(.{
                .clear = self.placementNeedsClear(placement, protocol, background_hash, lower_occupancy_hash, forced),
                .protocol = protocol,
                .background_hash = background_hash,
                .lower_occupancy_hash = lower_occupancy_hash,
            });
        }
        while (true) {
            var dirty_index: ?usize = null;
            for (self.imageDirty.items, 0..) |state, index| {
                if (state.protocol == .sixel and state.clear and !state.propagated) {
                    dirty_index = index;
                    break;
                }
            }
            const index = dirty_index orelse break;
            self.imageDirty.items[index].propagated = true;
            for (placements, 0..) |overlap, overlap_index| {
                if (index == overlap_index) continue;
                const overlap_state = &self.imageDirty.items[overlap_index];
                if (overlap_state.protocol == .sixel and placementsOverlap(placements[index], overlap)) overlap_state.clear = true;
            }
        }
    }

    fn placementDirty(self: *const CliRenderer, placement_id: u32) bool {
        if (placement_id == 0 or placement_id > self.imageDirty.items.len) return true;
        return self.imageDirty.items[placement_id - 1].clear;
    }

    fn placementFrameState(self: *const CliRenderer, char: u32) ?ImageDirty {
        const id = gp.imageIdFromChar(char);
        if (id == 0 or id > self.imageDirty.items.len) return null;
        return self.imageDirty.items[id - 1];
    }

    inline fn dirtyImageChar(items: []const ImageDirty, char: u32) bool {
        const id = gp.imageIdFromChar(char);
        if (id == 0 or id > items.len) return false;
        const state = &items[id - 1];
        return state.clear and state.protocol != .fallback;
    }

    fn materializeFallbackImages(self: *CliRenderer) !void {
        for (self.nextRenderBuffer.image_placements.items) |placement| {
            if (self.nextPlacementProtocol(placement) == .fallback) {
                try self.nextRenderBuffer.materializeImageFallback(placement.placement_id);
            }
        }
    }

    fn stageImageState(self: *CliRenderer) void {
        self.pendingImages.clearRetainingCapacity();
        std.debug.assert(self.pendingImages.capacity >= self.nextRenderBuffer.image_placements.items.len);
        for (self.nextRenderBuffer.image_placements.items, 0..) |placement, index| {
            self.pendingImages.appendAssumeCapacity(.{
                .image_handle = placement.image_handle,
                .placement_id = placement.placement_id,
                .x = placement.x,
                .y = placement.y,
                .width = placement.width,
                .height = placement.height,
                .pixel_width = placement.pixel_width,
                .pixel_height = placement.pixel_height,
                .source_x = placement.source_x,
                .source_y = placement.source_y,
                .source_width = placement.source_width,
                .source_height = placement.source_height,
                .opacity = placement.opacity,
                .protocol = self.nextPlacementProtocol(placement),
                .background_hash = if (index < self.imageDirty.items.len) self.imageDirty.items[index].background_hash else 0,
                .lower_occupancy_hash = if (index < self.imageDirty.items.len) self.imageDirty.items[index].lower_occupancy_hash else 0,
            });
        }
    }

    fn commitPendingImageState(self: *CliRenderer) void {
        self.imageScreenInvalidated = false;
        if (self.imageRenderFailed) {
            self.pendingImages.clearRetainingCapacity();
            return;
        }
        if (self.currentImages.items.len == 0 and self.pendingImages.items.len == 0) return;
        std.mem.swap(std.ArrayListUnmanaged(CommittedImage), &self.currentImages, &self.pendingImages);
        self.pendingImages.clearRetainingCapacity();
    }

    fn kittyImageId(self: *CliRenderer, placement_id: u32) u32 {
        return self.imageIdSalt + placement_id;
    }

    fn hasLowerImageAtCell(self: *CliRenderer, placement: OptimizedBuffer.ImagePlacement, protocol: ImageProtocol, x: i32, y: i32) bool {
        for (self.nextRenderBuffer.image_placements.items) |candidate| {
            if (candidate.placement_id >= placement.placement_id) break;
            if (self.nextPlacementProtocol(candidate) != protocol) continue;
            if (x >= candidate.x and y >= candidate.y and
                @as(i64, x) < @as(i64, candidate.x) + candidate.width and
                @as(i64, y) < @as(i64, candidate.y) + candidate.height) return true;
        }
        return false;
    }

    fn applyAlphaOpacity(target: *native_image.Image, opacity: u8) !void {
        const pixels = try target.ensurePixels();
        target.discardEncoded();
        var index: usize = 3;
        while (index < pixels.len) : (index += 4) {
            pixels[index] = @intCast((@as(u16, pixels[index]) * opacity + 127) / 255);
        }
        target.metadata.has_alpha = 1;
    }

    fn imageWithOpacity(source: *native_image.Image, opacity: u8) !?*native_image.Image {
        if (opacity == 255) return null;
        const copy = try source.clone();
        errdefer copy.deinit();
        try applyAlphaOpacity(copy, opacity);
        return copy;
    }

    // Large stills carry far more pixels than the placement can show. With a
    // known pixel size and at least 4x the area, transmit a downscaled copy;
    // the terminal scales the remainder. PNG passthrough is skipped for these
    // because the raw downscaled payload is smaller than the original file.
    fn kittyDownscaleAppliesTo(source_width: u32, source_height: u32, pixel_width: u32, pixel_height: u32) bool {
        const pixel_area = @as(u64, pixel_width) * pixel_height;
        const source_area = @as(u64, source_width) * source_height;
        return pixel_area > 0 and source_area >= pixel_area * 4;
    }

    fn kittyDownscaleApplies(placement: OptimizedBuffer.ImagePlacement) bool {
        return kittyDownscaleAppliesTo(placement.source_width, placement.source_height, placement.pixel_width, placement.pixel_height);
    }

    const KittyTransmit = struct {
        image: *native_image.Image,
        owned: bool,
    };

    // How a placement's source rectangle reaches the terminal: the live render
    // path selects it in the placement escape so scrolling a clipped image never
    // retransmits, while scrollback snapshots must bake it into the transmitted
    // pixels because their placements cannot carry a source rectangle and the
    // terminal would otherwise retain the full image in its history.
    const KittyTransmitCrop = enum { escape, pixels };

    fn kittyCropApplies(placement: OptimizedBuffer.ImagePlacement) bool {
        return placement.source_x != 0 or placement.source_y != 0 or
            placement.source_width != placement.image.width() or placement.source_height != placement.image.height();
    }

    fn kittyPlacementTransmit(
        self: *CliRenderer,
        placement: OptimizedBuffer.ImagePlacement,
        crop: KittyTransmitCrop,
    ) !KittyTransmit {
        const source = placement.image;
        const downscaled = kittyDownscaleApplies(placement);
        if (downscaled or (crop == .pixels and kittyCropApplies(placement))) {
            const cropped = try native_image.extract(
                self.allocator,
                source,
                placement.source_x,
                placement.source_y,
                placement.source_width,
                placement.source_height,
            );
            if (downscaled) {
                defer cropped.deinit();
                const resized = try native_image.resize(self.allocator, cropped, placement.pixel_width, placement.pixel_height, .area);
                if (placement.opacity < 255) try applyAlphaOpacity(resized, placement.opacity);
                return .{ .image = resized, .owned = true };
            }
            if (placement.opacity < 255) try applyAlphaOpacity(cropped, placement.opacity);
            return .{ .image = cropped, .owned = true };
        }
        const opacity_image = try imageWithOpacity(source, placement.opacity);
        return .{ .image = opacity_image orelse source, .owned = opacity_image != null };
    }

    fn writeKittyImages(self: *CliRenderer, writer: anytype, force_place: bool) !void {
        const tmux = self.terminal.isInTmux();
        const next = self.nextRenderBuffer.image_placements.items;
        for (self.currentImages.items) |current| {
            if (current.protocol != .kitty) continue;
            const placement_found = if (current.placement_id > 0 and current.placement_id <= next.len) blk: {
                const placement = next[current.placement_id - 1];
                break :blk placement.placement_id == current.placement_id and placement.image_handle == current.image_handle and
                    self.nextPlacementProtocol(placement) == .kitty;
            } else false;
            if (!placement_found) try terminal_image.writeKittyDelete(
                writer,
                self.kittyImageId(current.placement_id),
                null,
                true,
                tmux,
            );
        }
        for (next) |placement| {
            if (self.nextPlacementProtocol(placement) != .kitty) continue;
            const previous = if (!self.imageScreenInvalidated) (if (self.currentImageForPlacement(placement.placement_id)) |current|
                if (current.protocol == .kitty and current.image_handle == placement.image_handle) current else null
            else
                null) else null;
            const image_id = self.kittyImageId(placement.placement_id);
            const downscaled = kittyDownscaleApplies(placement);
            const retransmit = if (previous) |committed| blk: {
                const previous_downscaled = kittyDownscaleAppliesTo(
                    committed.source_width,
                    committed.source_height,
                    committed.pixel_width,
                    committed.pixel_height,
                );
                const source_changed = committed.source_x != placement.source_x or committed.source_y != placement.source_y or
                    committed.source_width != placement.source_width or committed.source_height != placement.source_height;
                break :blk committed.opacity != placement.opacity or previous_downscaled != downscaled or
                    (downscaled and (source_changed or committed.pixel_width != placement.pixel_width or committed.pixel_height != placement.pixel_height));
            } else false;
            if (previous == null or retransmit) {
                if (retransmit) try terminal_image.writeKittyDelete(writer, image_id, null, true, tmux);
                const transmit = try self.kittyPlacementTransmit(placement, .escape);
                defer if (transmit.owned) transmit.image.deinit();
                const directory = if (self.kittyTransport.mode == .file) self.kittyTempDirectory() else "";
                try self.kittyTransport.transmit(self.allocator, writer, transmit.image, image_id, tmux, directory);
            } else if (force_place or previous.?.x != placement.x or previous.?.y != placement.y or previous.?.width != placement.width or previous.?.height != placement.height or
                previous.?.source_x != placement.source_x or previous.?.source_y != placement.source_y or previous.?.source_width != placement.source_width or
                previous.?.source_height != placement.source_height)
            {
                try terminal_image.writeKittyDelete(writer, image_id, placement.placement_id, false, tmux);
            } else continue;
            if (placement.x < 0 or placement.y < 0) continue;
            // A downscaled transmit already contains exactly the placement's
            // source rectangle; otherwise the full image was transmitted and the
            // placement escape selects the visible portion.
            const normalized = downscaled;
            try terminal_image.writeKittyPlacement(
                writer,
                image_id,
                placement.placement_id,
                @intCast(placement.x),
                @intCast(placement.y + @as(i32, @intCast(self.renderOffset))),
                placement.width,
                placement.height,
                if (normalized) 0 else placement.source_x,
                if (normalized) 0 else placement.source_y,
                if (downscaled) placement.pixel_width else placement.source_width,
                if (downscaled) placement.pixel_height else placement.source_height,
                -1_500_000_000 + @as(i32, @intCast(placement.placement_id)),
                tmux,
            );
        }
    }

    fn writeSixelImages(self: *CliRenderer, writer: anytype) !void {
        for (self.nextRenderBuffer.image_placements.items) |placement| {
            if (self.nextPlacementProtocol(placement) != .sixel or !self.placementDirty(placement.placement_id)) continue;
            if (placement.pixel_width == 0 or placement.pixel_height == 0 or placement.x < 0 or placement.y < 0) continue;
            const cache_key = SixelCacheKey{
                .image_handle = placement.image_handle,
                .source_x = placement.source_x,
                .source_y = placement.source_y,
                .source_width = placement.source_width,
                .source_height = placement.source_height,
                .cell_width = placement.width,
                .cell_height = placement.height,
                .pixel_width = placement.pixel_width,
                .pixel_height = placement.pixel_height,
                .opacity = placement.opacity,
                .background_hash = if (placement.placement_id <= self.imageDirty.items.len)
                    self.imageDirty.items[placement.placement_id - 1].background_hash
                else
                    0,
            };
            self.advanceSixelCacheClock();
            if (self.sixelCache.getPtr(cache_key)) |cached| {
                cached.last_used = self.sixelCacheClock;
                self.sixelCacheHits += 1;
                if (cached.payload.len == 0) continue;
                try ansi.ANSI.moveToOutput(writer, @intCast(placement.x + 1), @intCast(placement.y + 1 + @as(i32, @intCast(self.renderOffset))));
                try terminal_image.writeSixelFramedPayload(writer, cached.payload, self.terminal.isInTmux());
                continue;
            }
            self.sixelCacheMisses += 1;
            const source = placement.image;
            var prepared = source;
            var prepared_owned = false;
            defer if (prepared_owned) prepared.deinit();
            if (placement.source_x != 0 or placement.source_y != 0 or
                placement.source_width != source.width() or placement.source_height != source.height())
            {
                prepared = try native_image.extract(
                    self.allocator,
                    source,
                    placement.source_x,
                    placement.source_y,
                    placement.source_width,
                    placement.source_height,
                );
                prepared_owned = true;
            }
            if (placement.pixel_width != prepared.width() or placement.pixel_height != prepared.height()) {
                const resized = try native_image.resize(self.allocator, prepared, placement.pixel_width, placement.pixel_height, .area);
                if (prepared_owned) prepared.deinit();
                prepared = resized;
                prepared_owned = true;
            }
            if (placement.opacity < 255) {
                if (!prepared_owned) {
                    prepared = try source.clone();
                    prepared_owned = true;
                }
                try dimSixelPixels(self.nextRenderBuffer, placement, prepared);
            }
            var quantized = try terminal_image.quantizeSixel(self.allocator, prepared, 255);
            defer quantized.deinit();
            var payload: std.Io.Writer.Allocating = .init(self.allocator);
            defer payload.deinit();
            if (quantized.palette_len > 0) {
                try terminal_image.writeSixelIndexedPayload(
                    self.allocator,
                    &payload.writer,
                    quantized.indices,
                    quantized.palette[0..quantized.palette_len],
                    prepared.width(),
                    prepared.height(),
                );
                try ansi.ANSI.moveToOutput(writer, @intCast(placement.x + 1), @intCast(placement.y + 1 + @as(i32, @intCast(self.renderOffset))));
                try terminal_image.writeSixelFramedPayload(writer, payload.written(), self.terminal.isInTmux());
            }
            self.cacheSixelPayload(cache_key, &payload);
        }
    }

    // Sixel cannot composite in the terminal, so placement opacity blends pixel
    // colors toward the covered cell backgrounds (composited over black for
    // non-opaque backgrounds). Image alpha is left untouched: holes stay holes
    // and the encoder's visibility threshold keeps applying to the image alpha.
    fn dimSixelPixels(
        source_buffer: *OptimizedBuffer,
        placement: OptimizedBuffer.ImagePlacement,
        resized: *native_image.Image,
    ) !void {
        const pixels = try resized.ensurePixels();
        const opacity: u32 = placement.opacity;
        const inverse: u32 = 255 - opacity;
        var py: u32 = 0;
        while (py < resized.height()) : (py += 1) {
            const cell_y = placement.y + @as(i32, @intCast((@as(u64, py) * placement.height) / placement.pixel_height));
            var px: u32 = 0;
            while (px < resized.width()) : (px += 1) {
                const cell_x = placement.x + @as(i32, @intCast((@as(u64, px) * placement.width) / placement.pixel_width));
                const cell = if (cell_x >= 0 and cell_y >= 0 and
                    cell_x < @as(i32, @intCast(source_buffer.width)) and cell_y < @as(i32, @intCast(source_buffer.height)))
                    source_buffer.get(@intCast(cell_x), @intCast(cell_y))
                else
                    null;
                const bg = if (cell) |value| value.bg else ansi.rgbColor(0, 0, 0, 0);
                const bg_alpha: u32 = ansi.alpha(bg);
                const bg_channels = [3]u32{ ansi.red(bg), ansi.green(bg), ansi.blue(bg) };
                const offset = (@as(usize, py) * resized.width() + px) * 4;
                inline for (0..3) |channel| {
                    const bg_effective = (bg_channels[channel] * bg_alpha + 127) / 255;
                    const value: u32 = pixels[offset + channel];
                    pixels[offset + channel] = @intCast((value * opacity + bg_effective * inverse + 127) / 255);
                }
            }
        }
    }

    fn placementBackgroundHash(self: *CliRenderer, placement: OptimizedBuffer.ImagePlacement) u64 {
        var hasher = std.hash.Wyhash.init(0x6f70656e_74756921);
        var cy: u32 = 0;
        while (cy < placement.height) : (cy += 1) {
            const y = placement.y + @as(i32, @intCast(cy));
            if (y < 0 or y >= self.height) continue;
            var cx: u32 = 0;
            while (cx < placement.width) : (cx += 1) {
                const x = placement.x + @as(i32, @intCast(cx));
                if (x < 0 or x >= self.width) continue;
                const cell = self.nextRenderBuffer.get(@intCast(x), @intCast(y)) orelse continue;
                hasher.update(std.mem.asBytes(&cell.bg));
            }
        }
        return hasher.final();
    }

    fn placementLowerOccupancyHash(self: *CliRenderer, placement: OptimizedBuffer.ImagePlacement) u64 {
        var hasher = std.hash.Wyhash.init(0x696d6167_652d6c6f);
        var cy: u32 = 0;
        while (cy < placement.height) : (cy += 1) {
            const y = placement.y + @as(i32, @intCast(cy));
            if (y < 0 or y >= self.height) continue;
            var cx: u32 = 0;
            while (cx < placement.width) : (cx += 1) {
                const x = placement.x + @as(i32, @intCast(cx));
                if (x < 0 or x >= self.width) continue;
                const lower: u8 = @intFromBool(self.hasLowerImageAtCell(placement, .sixel, x, y));
                hasher.update(&.{lower});
            }
        }
        return hasher.final();
    }

    fn cacheSixelPayload(self: *CliRenderer, key: SixelCacheKey, payload: *std.Io.Writer.Allocating) void {
        if (payload.written().len > SIXEL_CACHE_MAX_BYTES) return;
        const owned = payload.toOwnedSlice() catch return;
        self.sixelCache.ensureUnusedCapacity(self.allocator, 1) catch {
            self.allocator.free(owned);
            return;
        };
        while ((self.sixelCacheBytes + owned.len > SIXEL_CACHE_MAX_BYTES or self.sixelCache.count() >= SIXEL_CACHE_MAX_ENTRIES) and self.sixelCache.count() > 0) {
            var iterator = self.sixelCache.iterator();
            var oldest_key: ?SixelCacheKey = null;
            var oldest_tick: u64 = std.math.maxInt(u64);
            while (iterator.next()) |entry| {
                if (oldest_key == null or entry.value_ptr.last_used < oldest_tick) {
                    oldest_tick = entry.value_ptr.last_used;
                    oldest_key = entry.key_ptr.*;
                }
            }
            const removed = self.sixelCache.fetchRemove(oldest_key.?) orelse break;
            self.sixelCacheBytes -= removed.value.payload.len;
            self.allocator.free(removed.value.payload);
        }
        self.sixelCache.putAssumeCapacity(key, .{ .payload = owned, .last_used = self.sixelCacheClock });
        self.sixelCacheBytes += owned.len;
    }

    fn advanceSixelCacheClock(self: *CliRenderer) void {
        if (self.sixelCacheClock == std.math.maxInt(u64)) {
            var iterator = self.sixelCache.iterator();
            while (iterator.next()) |entry| entry.value_ptr.last_used = 0;
            self.sixelCacheClock = 1;
        } else {
            self.sixelCacheClock += 1;
        }
    }

    /// Encode and flush a frame before recording its render time.
    /// `sync_started` is true only when the caller already opened the
    /// synchronized-update envelope for a batched split-footer commit.
    pub fn prepareRenderFrameWithWriter(self: *CliRenderer, writer: anytype, force: bool, sync_started: bool) error{ OutOfMemory, TrackerLimit, PresentationPending, PresentationFailed }!void {
        if (self.pendingPresentation != null) return error.PresentationPending;
        if (self.presentationFailed) return error.PresentationFailed;
        _ = self.pollKittyImageTransport();
        const renderStartTime = std.Io.Clock.now(.awake, self.io).toMicroseconds();
        var cellsUpdated: u32 = 0;
        const palette_force = self.last_rendered_palette_epoch == null or self.last_rendered_palette_epoch.? != self.palette_epoch;
        const should_force = force or self.force_full_repaint or palette_force;
        const has_image_state = self.nextRenderBuffer.image_placements.items.len != 0 or self.currentImages.items.len != 0;
        if (self.nextRenderBuffer.image_placements.items.len != 0) {
            self.materializeFallbackImages() catch {
                self.imageRenderFailed = true;
                self.force_full_repaint = true;
                self.clearSkippedFrameState();
                return;
            };
            self.computeImageDirtyFlags(should_force);
        } else {
            self.imageDirty.clearRetainingCapacity();
        }
        self.pendingImages.clearRetainingCapacity();
        if (has_image_state) {
            self.pendingImages.ensureTotalCapacity(self.allocator, self.nextRenderBuffer.image_placements.items.len) catch {
                self.imageRenderFailed = true;
                self.force_full_repaint = true;
                self.clearSkippedFrameState();
                return;
            };
        }
        const images_changed = has_image_state and self.imageStateChanged();

        const current = self.currentRenderBuffer;
        const next = self.nextRenderBuffer;
        // Sync retains one replacement before removing old references. Its distinct
        // IDs fit in the source/destination union, capped at cells plus that replacement.
        const entries_max = @as(u64, current.buffer.char.len) + 1;
        try current.storage.ensureTrackerCapacity(
            @min(@as(u64, current.grapheme_tracker.used_ids.count()) + next.grapheme_tracker.used_ids.count(), entries_max),
            @min(@as(u64, current.link_tracker.used_ids.count()) + next.link_tracker.used_ids.count(), entries_max),
        );
        // Current cells and leases retain their image resources after the next buffer clears.
        try current.syncImagePlacements(next);

        // Lazy frame start is the core no-op suppression mechanism. If diffing,
        // cursor state, and pointer state are unchanged, frame_started stays false
        // and we emit nothing at all for this tick.
        var frame_started = sync_started;
        self.applyPendingSplitFooterTransition(writer, &frame_started);

        if ((images_changed or should_force) and (self.hasCommittedProtocol(.kitty) or self.hasNextProtocol(.kitty))) {
            if (!frame_started) {
                beginRenderFrame(writer);
                frame_started = true;
            }
            self.writeKittyImages(writer, should_force) catch {
                self.kittyTransport.cancel(.io_error);
                self.force_full_repaint = true;
                self.imageRenderFailed = true;
            };
        }

        var currentFg: ?RGBA = null;
        var currentBg: ?RGBA = null;
        var currentAttributes: ?u32 = null;
        var currentLinkId: u32 = 0;
        var utf8Buf: [4]u8 = undefined;
        var clearRunY: i64 = -1;
        var clearRunEnd: i64 = -1;
        const image_dirty_items = self.imageDirty.items;
        // Whether any identical-looking reserved cell may still need a clear
        // this frame; keeps the per-cell diff free of graphics work otherwise.
        var clears_pending = should_force;
        for (image_dirty_items) |entry| {
            if (entry.clear and entry.protocol != .fallback) {
                clears_pending = true;
                break;
            }
        }

        const hyperlinksEnabled = self.terminal.getCapabilities().hyperlinks;
        var use_row_equality = !should_force and !clears_pending;

        for (0..self.height) |uy| {
            const y = @as(u32, @intCast(uy));

            if (use_row_equality) {
                const row_start = @as(usize, y) * self.width;
                const row_end = row_start + self.width;
                if (std.mem.eql(u32, self.currentRenderBuffer.buffer.char[row_start..row_end], self.nextRenderBuffer.buffer.char[row_start..row_end]) and
                    std.mem.eql(RGBA, self.currentRenderBuffer.buffer.fg[row_start..row_end], self.nextRenderBuffer.buffer.fg[row_start..row_end]) and
                    std.mem.eql(RGBA, self.currentRenderBuffer.buffer.bg[row_start..row_end], self.nextRenderBuffer.buffer.bg[row_start..row_end]) and
                    std.mem.eql(u32, self.currentRenderBuffer.buffer.attributes[row_start..row_end], self.nextRenderBuffer.buffer.attributes[row_start..row_end])) continue;
            }

            var runStart: i64 = -1;
            var runLength: u32 = 0;
            const cells_updated_before_row = cellsUpdated;

            for (0..self.width) |ux| {
                const x = @as(u32, @intCast(ux));
                const currentCell = self.currentRenderBuffer.get(x, y);
                const nextCell = self.nextRenderBuffer.get(x, y);

                if (currentCell == null or nextCell == null) continue;

                const cell = nextCell.?;
                const cell_type = cell.char & gp.CHAR_TYPE_MASK;

                if (!should_force) {
                    const cellsEqual = currentCell.?.char == cell.char and currentCell.?.attributes == cell.attributes and
                        buf.rgbaEqual(currentCell.?.fg, cell.fg) and buf.rgbaEqual(currentCell.?.bg, cell.bg);
                    // Identical reserved cells still repaint when their
                    // placement's pixels are dirty (e.g. Sixel content change).
                    if (cellsEqual and !(clears_pending and cell_type == gp.CHAR_FLAG_IMAGE and dirtyImageChar(image_dirty_items, cell.char))) {
                        if (runLength > 0) {
                            writer.writeAll(ansi.ANSI.reset) catch {};
                            runStart = -1;
                            runLength = 0;
                        }
                        continue;
                    }
                }

                // Reserved graphics cells display as cleared space; their diff
                // is placement-level. Only placements whose pixels must be
                // (re)painted clear their cells, as one batched space run.
                // Fallback placements materialize as ordinary cells and fall
                // through to normal diffing.
                if (cell_type == gp.CHAR_FLAG_IMAGE) blk: {
                    const id = gp.imageIdFromChar(cell.char);
                    if (id == 0 or id > image_dirty_items.len) break :blk;
                    const state = &image_dirty_items[id - 1];
                    if (state.protocol == .fallback) break :blk;
                    if (!should_force and !state.clear and gp.isImageChar(currentCell.?.char)) {
                        if (runLength > 0) {
                            writer.writeAll(ansi.ANSI.reset) catch {};
                            runStart = -1;
                            runLength = 0;
                        }
                        if (currentCell.?.char != cell.char) self.currentRenderBuffer.syncCell(x, y, cell);
                        continue;
                    }
                    if (!frame_started) {
                        beginRenderFrame(writer);
                        frame_started = true;
                    }
                    if (clearRunY != y or clearRunEnd != x) {
                        writer.writeAll(ansi.ANSI.reset) catch {};
                        ansi.ANSI.moveToOutput(writer, x + 1, y + 1 + self.renderOffset) catch {};
                    }
                    writer.writeByte(' ') catch {};
                    clearRunY = y;
                    clearRunEnd = x + 1;
                    currentFg = null;
                    currentBg = null;
                    currentAttributes = null;
                    runStart = -1;
                    runLength = 0;
                    self.currentRenderBuffer.syncCell(x, y, cell);
                    cellsUpdated += 1;
                    continue;
                }

                if (cell_type == gp.CHAR_FLAG_CONTINUATION) {
                    // A continuation has no bytes to emit. Starting a run here can
                    // position the next printable cell inside the wide grapheme.
                    self.currentRenderBuffer.syncCell(x, y, cell);
                    cellsUpdated += 1;
                    continue;
                }

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
                        const lp = self.nextRenderBuffer.link_pool;
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
                switch (cell_type) {
                    gp.CHAR_FLAG_IMAGE => {
                        const fallback = buf.quadrantChars[gp.imageFallbackFromChar(cell.char)];
                        const len = std.unicode.utf8Encode(@intCast(fallback), &utf8Buf) catch unreachable;
                        writer.writeAll(utf8Buf[0..len]) catch {};
                    },
                    gp.CHAR_FLAG_GRAPHEME => {
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
                    },
                    gp.CHAR_FLAG_CONTINUATION => {},
                    else => {
                        if (cell.char >= 32 and cell.char <= 126) {
                            writer.writeByte(@intCast(cell.char)) catch {};
                        } else {
                            const len = std.unicode.utf8Encode(@intCast(cell.char), &utf8Buf) catch 1;
                            writer.writeAll(utf8Buf[0..len]) catch {};
                        }
                    },
                }
                runLength += 1;

                // Sync this cell to the current buffer so the next frame's diff
                // is correct. Use syncCell (set without span cleanup) because
                // span cleanup would destroy continuation cells written by an
                // earlier iteration of this same left-to-right pass (#723).
                self.currentRenderBuffer.syncCell(x, y, nextCell.?);

                cellsUpdated += 1;
            }
            if (cellsUpdated - cells_updated_before_row == self.width) use_row_equality = false;
        }

        var sixel_dirty = false;
        for (self.nextRenderBuffer.image_placements.items) |placement| {
            if (self.nextPlacementProtocol(placement) == .sixel and self.placementDirty(placement.placement_id)) {
                sixel_dirty = true;
                break;
            }
        }
        if (sixel_dirty) {
            if (!frame_started) {
                beginRenderFrame(writer);
                frame_started = true;
            }
            if (hyperlinksEnabled and currentLinkId != 0) {
                writer.writeAll("\x1b]8;;\x1b\\") catch {};
                currentLinkId = 0;
            }
            self.writeSixelImages(writer) catch {
                self.force_full_repaint = true;
                self.imageRenderFailed = true;
            };
            // Cells that replaced reservation markers were painted after the image.
            for (self.nextRenderBuffer.image_placements.items) |placement| {
                if (self.nextPlacementProtocol(placement) != .sixel or !self.placementDirty(placement.placement_id)) continue;
                var py: u32 = 0;
                while (py < placement.height) : (py += 1) {
                    const y_i = placement.y + @as(i32, @intCast(py));
                    if (y_i < 0 or y_i >= self.height) continue;
                    var px: u32 = 0;
                    while (px < placement.width) : (px += 1) {
                        const x_i = placement.x + @as(i32, @intCast(px));
                        if (x_i < 0 or x_i >= self.width) continue;
                        var draw_x_i = x_i;
                        var cell = self.nextRenderBuffer.get(@intCast(x_i), @intCast(y_i)) orelse continue;
                        if (gp.isImageChar(cell.char)) {
                            if (self.placementFrameState(cell.char)) |state| {
                                if (state.protocol != .fallback) continue;
                            }
                        }
                        if (gp.isContinuationChar(cell.char)) {
                            const start_x_i = x_i - @as(i32, @intCast(gp.charLeftExtent(cell.char)));
                            const first_visible_placement_x = @max(placement.x, 0);
                            if (start_x_i >= placement.x or x_i != first_visible_placement_x or start_x_i < 0) continue;
                            draw_x_i = start_x_i;
                            cell = self.nextRenderBuffer.get(@intCast(draw_x_i), @intCast(y_i)) orelse continue;
                            if (!gp.isGraphemeChar(cell.char)) continue;
                        }
                        writer.writeAll(ansi.ANSI.reset) catch {};
                        ansi.ANSI.moveToOutput(writer, @intCast(draw_x_i + 1), @intCast(y_i + 1 + @as(i32, @intCast(self.renderOffset)))) catch {};
                        self.emitColor(writer, cell.fg, false);
                        self.emitColor(writer, cell.bg, true);
                        ansi.TextAttributes.applyAttributesOutputWriter(writer, cell.attributes) catch {};
                        const replay_link_id = if (hyperlinksEnabled) ansi.TextAttributes.getLinkId(cell.attributes) else 0;
                        if (replay_link_id != 0) {
                            const lp = self.nextRenderBuffer.link_pool;
                            if (lp.get(replay_link_id)) |url_bytes| {
                                writer.print("\x1b]8;id={d};{s}\x1b\\", .{ replay_link_id, url_bytes }) catch {};
                            } else |_| {}
                        }
                        if (gp.isGraphemeChar(cell.char)) {
                            if (self.pool.get(gp.graphemeIdFromChar(cell.char))) |bytes| {
                                const capabilities = self.terminal.getCapabilities();
                                const grapheme_width = gp.charRightExtent(cell.char) + 1;
                                if (capabilities.explicit_width) {
                                    ansi.ANSI.explicitWidthOutput(writer, grapheme_width, bytes) catch {};
                                } else {
                                    writer.writeAll(bytes) catch {};
                                }
                            } else |_| {}
                        } else if (!gp.isContinuationChar(cell.char)) {
                            const draw_char = if (gp.isImageChar(cell.char)) buf.quadrantChars[gp.imageFallbackFromChar(cell.char)] else cell.char;
                            if (std.unicode.utf8Encode(@intCast(draw_char), &utf8Buf)) |len| {
                                writer.writeAll(utf8Buf[0..len]) catch {};
                            } else |_| {}
                        }
                        if (replay_link_id != 0) writer.writeAll("\x1b]8;;\x1b\\") catch {};
                    }
                }
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
        if (!self.mousePointerStateValid or mousePointer != self.lastMousePointerStyle) {
            if (!frame_started) {
                beginRenderFrame(writer);
                frame_started = true;
            }
            ansi.ANSI.setMousePointerOutput(writer, mousePointer.toName()) catch {};
            self.lastMousePointerStyle = mousePointer;
            self.mousePointerStateValid = true;
        }

        // Only close sync if we opened it. This keeps true no-op frames empty.
        if (frame_started) {
            writer.writeAll(ansi.ANSI.syncReset) catch {};
        }

        writer.flush() catch {};
        const renderEndTime = std.Io.Clock.now(.awake, self.io).toMicroseconds();
        const renderTime = @as(f64, @floatFromInt(renderEndTime - renderStartTime));

        self.renderStats.cellsUpdated = cellsUpdated;
        self.renderStats.renderTime = renderTime;
        self.last_rendered_palette_epoch = self.palette_epoch;
        if (self.imageRenderFailed) {
            self.force_full_repaint = true;
            self.pendingImages.clearRetainingCapacity();
        } else {
            self.force_full_repaint = false;
            if (has_image_state) {
                self.stageImageState();
            } else {
                self.pendingImages.clearRetainingCapacity();
            }
        }

        self.nextRenderBuffer.clear(self.backgroundColor, null);
    }

    pub fn setDebugOverlay(self: *CliRenderer, enabled: bool, corner: DebugOverlayCorner) void {
        self.debugOverlay.enabled = enabled;
        self.debugOverlay.corner = corner;
    }

    pub fn clearTerminal(self: *CliRenderer) void {
        if (self.pendingPresentation != null) return;
        if (self.hasCommittedProtocol(.kitty)) {
            for (self.currentImages.items) |current| {
                if (current.protocol != .kitty) continue;
                var delete_buf: [128]u8 = undefined;
                var delete_writer: std.Io.Writer = .fixed(&delete_buf);
                terminal_image.writeKittyDelete(
                    &delete_writer,
                    self.kittyImageId(current.placement_id),
                    null,
                    true,
                    self.terminal.isInTmux(),
                ) catch {};
                self.writeOut(delete_writer.buffered());
            }
        }
        self.writeOut(ansi.ANSI.clearAndHome);
        self.currentImages.clearRetainingCapacity();
        self.force_full_repaint = true;
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
        if (self.pendingPresentation != null) return;
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
        if (self.pendingPresentation != null) return;
        @memset(self.currentHitGrid, 0);
    }

    /// Return whether the hit grid changed during the last completed presentation.
    /// Pending presentation queries do not consume resize invalidation.
    /// TypeScript can use this to decide if hover state needs rechecking.
    pub fn getHitGridDirty(self: *CliRenderer) bool {
        const dirty = self.hitGridDirty;
        if (self.pendingPresentation == null) self.hitGridResizeInvalidated = false;
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
            self.logger.warn("Failed to push hit-grid scissor rect: {}", .{err});
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
        if (self.pendingPresentation != null) return;
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
        const timestamp = std.Io.Clock.now(.real, self.io).toSeconds();
        var filename_buf: [64]u8 = undefined;
        const filename = std.fmt.bufPrint(&filename_buf, "hitgrid_{d}.txt", .{timestamp}) catch return;

        const file = std.Io.Dir.cwd().createFile(self.io, filename, .{}) catch return;
        defer file.close(self.io);

        var fileBuffer: [4096]u8 = undefined;
        var fileWriter = file.writer(self.io, &fileBuffer);
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

    pub fn restoreTerminalModes(self: *CliRenderer) void {
        var writer: std.Io.Writer = .fixed(&self.writeOutBuf);
        self.terminal.restoreTerminalModes(&writer) catch {};
        self.writeOut(writer.buffered());
    }

    pub fn enableMouse(self: *CliRenderer, enableMovement: bool) void {
        var writer: std.Io.Writer = .fixed(&self.writeOutBuf);
        self.terminal.setMouseMode(&writer, true, enableMovement) catch {};
        self.writeOut(writer.buffered());
    }

    pub fn queryPixelResolution(self: *CliRenderer) void {
        self.writeOut(ansi.ANSI.queryPixelSize);
    }

    pub fn queryThemeColors(self: *CliRenderer) void {
        var writer: std.Io.Writer = .fixed(&self.writeOutBuf);
        self.terminal.queryThemeColors(&writer) catch {};
        self.writeOut(writer.buffered());
    }

    pub fn disableMouse(self: *CliRenderer) void {
        var writer: std.Io.Writer = .fixed(&self.writeOutBuf);
        self.terminal.setMouseMode(&writer, false, self.terminal.state.mouse_movement) catch {};
        self.writeOut(writer.buffered());
    }

    pub fn enableKittyKeyboard(self: *CliRenderer, flags: u8) void {
        var writer: std.Io.Writer = .fixed(&self.writeOutBuf);
        self.terminal.setKittyKeyboard(&writer, true, flags) catch {};
        self.writeOut(writer.buffered());
    }

    pub fn disableKittyKeyboard(self: *CliRenderer) void {
        var writer: std.Io.Writer = .fixed(&self.writeOutBuf);
        self.terminal.setKittyKeyboard(&writer, false, 0) catch {};
        self.writeOut(writer.buffered());
    }

    pub fn getTerminalCapabilities(self: *CliRenderer) Terminal.Capabilities {
        return self.terminal.getCapabilities();
    }

    pub fn setTerminalEnvVar(self: *CliRenderer, key: []const u8, value: []const u8) bool {
        self.terminal.setHostEnvVar(self.allocator, key, value) catch return false;
        self.syncWidthMethod();
        return true;
    }

    pub fn syncWidthMethod(self: *CliRenderer) void {
        const width_method = if (self.terminal.caps.unicode == .no_zwj) .unicode else self.terminal.caps.unicode;
        self.currentRenderBuffer.width_method = width_method;
        self.nextRenderBuffer.width_method = width_method;
    }

    pub fn processCapabilityResponse(self: *CliRenderer, response: []const u8) void {
        self.terminal.processCapabilityResponse(response);
        var writer: std.Io.Writer = .fixed(&self.writeOutBuf);
        _ = self.terminal.sendPendingQueries(&writer) catch |err| blk: {
            self.logger.warn("Failed to send pending queries: {}", .{err});
            break :blk false;
        };
        const useKitty = self.terminal.opts.kitty_keyboard_flags > 0;
        self.terminal.enableDetectedFeatures(&writer, useKitty) catch {};
        self.writeOut(writer.buffered());
    }

    fn kittyTempDirectory(self: *const CliRenderer) []const u8 {
        if (builtin.os.tag == .windows) return "";
        const env_map = self.terminal.opts.env_map orelse return "/tmp";
        return env_map.get("TMPDIR") orelse "/tmp";
    }

    pub fn setKittyImageTransport(self: *CliRenderer, mode: u32) bool {
        const requested = std.enums.fromInt(kitty_transport.Mode, mode) orelse return false;
        if (self.kittyTransport.mode == requested) return true;
        self.kittyTransport.mode = requested;
        self.invalidateKittyImages();
        self.startKittyFileProbe();
        return true;
    }

    fn startKittyFileProbe(self: *CliRenderer) void {
        if (!self.terminalSetup) return;
        self.startKittyFileProbeFromSession();
    }

    /// Session-managed terminals never set terminalSetup; probe only while active.
    pub fn startKittyFileProbeFromSession(self: *CliRenderer) void {
        if (self.terminalSuspended or self.kittyTransport.mode != .file) return;
        _ = self.pollKittyImageTransport();
        if (self.kittyTransport.file_state != .disabled) return;
        if (self.reserveKittyHistoryImageIds(2)) |base| {
            var buffer: [4096]u8 = undefined;
            var writer: std.Io.Writer = .fixed(&buffer);
            self.kittyTransport.startProbe(&writer, base + 1, self.kittyTempDirectory()) catch {};
            self.backend.writeOut(writer.buffered());
        } else self.kittyTransport.cancel(.unsupported);
    }

    pub fn kittyImageTransportStatus(self: *const CliRenderer) [6]u32 {
        const transport = &self.kittyTransport;
        return .{
            @intFromEnum(transport.mode),
            @intFromEnum(transport.effective),
            @intFromEnum(transport.file_state),
            @intFromEnum(transport.fallback),
            transport.pendingCount(),
            @intCast(transport.pendingBytes()),
        };
    }

    pub fn cancelKittyImageTransport(self: *CliRenderer, failed: bool) void {
        self.kittyTransport.cancel(if (failed) .io_error else .cancelled);
        _ = self.pollKittyImageTransport();
    }

    pub fn pollKittyImageTransport(self: *CliRenderer) bool {
        if (self.backend == .buffered) {
            if (self.backend.buffered.ownedStdoutOutput) |stdout| {
                if (stdout.failed.load(.acquire)) self.kittyTransport.cancel(.io_error);
            }
        }
        if (builtin.os.tag == .windows or self.terminal.remote or self.terminal.multiplexer != .none or !self.terminal.graphics_enabled) {
            self.kittyTransport.cancel(.unsupported);
        }
        self.kittyTransport.expire(kitty_transport.Transport.nowMs());
        if (!self.kittyTransport.retry_images) return false;
        self.kittyTransport.retry_images = false;
        self.invalidateKittyImages();
        return true;
    }

    fn invalidateKittyImages(self: *CliRenderer) void {
        // A custom sink can reply synchronously while pending images are being published.
        for ([_][]CommittedImage{ self.currentImages.items, self.pendingImages.items }) |images| {
            for (images) |*image| {
                if (image.protocol == .kitty) image.image_handle = 0;
            }
        }
        self.force_full_repaint = true;
    }

    pub fn processKittyImageReply(self: *CliRenderer, response: []const u8) u32 {
        if (!self.kittyTransport.handleReply(response)) return 0;
        return if (self.pollKittyImageTransport()) 2 else 1;
    }

    pub fn setKittyKeyboardFlags(self: *CliRenderer, flags: u8) void {
        self.terminal.setKittyKeyboardFlags(flags);
    }

    pub fn getKittyKeyboardFlags(self: *CliRenderer) u8 {
        return self.terminal.opts.kitty_keyboard_flags;
    }

    pub fn setTerminalTitle(self: *CliRenderer, title: []const u8) void {
        var writer: std.Io.Writer = .fixed(&self.writeOutBuf);
        self.terminal.setTerminalTitle(&writer, title);
        self.writeOut(writer.buffered());
    }

    pub fn copyToClipboardOSC52(self: *CliRenderer, target: Terminal.ClipboardTarget, text_utf8: []const u8) bool {
        const output_len = self.terminal.clipboardSequenceSize(text_utf8.len) catch return false;
        const output_bytes = self.allocator.alloc(u8, output_len) catch return false;
        defer self.allocator.free(output_bytes);

        var writer: std.Io.Writer = .fixed(output_bytes);
        self.terminal.writeClipboard(&writer, target, text_utf8) catch return false;
        const written = writer.buffered();
        std.debug.assert(written.len == output_len);
        self.writeOut(written);
        return true;
    }

    pub fn clearClipboardOSC52(self: *CliRenderer, target: Terminal.ClipboardTarget) bool {
        var stream: std.Io.Writer.Allocating = .init(self.allocator);
        defer stream.deinit();
        self.terminal.writeClipboard(&stream.writer, target, "") catch return false;
        self.writeOut(stream.written());
        return true;
    }

    pub fn triggerNotification(self: *CliRenderer, message: []const u8, title: ?[]const u8) bool {
        var stream: std.Io.Writer.Allocating = .init(self.allocator);
        defer stream.deinit();

        const ok = self.terminal.writeNotification(self.allocator, &stream.writer, message, title) catch return false;
        if (!ok) return false;
        self.writeOut(stream.written());
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
