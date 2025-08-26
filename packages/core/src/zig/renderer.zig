const std = @import("std");
const Allocator = std.mem.Allocator;
const ansi = @import("ansi.zig");
const buf = @import("buffer.zig");

pub const RGBA = ansi.RGBA;
pub const OptimizedBuffer = buf.OptimizedBuffer;
pub const TextAttributes = ansi.TextAttributes;

const CLEAR_CHAR = '\u{0a00}';
const MAX_STAT_SAMPLES = 30;
const STAT_SAMPLE_CAPACITY = 30;
const DEFAULT_CURSOR_X = 1;
const DEFAULT_CURSOR_Y = 1;
const COLOR_EPSILON_DEFAULT: f32 = 0.00001;
const RUN_BUFFER_SIZE = 1024;
const OUTPUT_BUFFER_SIZE = 1024 * 1024 * 2; // 2MB

pub const RendererError = error{
    OutOfMemory,
    InvalidDimensions,
    ThreadingFailed,
    WriteFailed,
};

fn rgbaComponentToU8(component: f32) u8 {
    if (!std.math.isFinite(component)) return 0;

    const clamped = std.math.clamp(component, 0.0, 1.0);
    return @intFromFloat(@round(clamped * 255.0));
}

pub const CursorStyle = enum {
    block,
    line,
    underline,
};

pub const DebugOverlayCorner = enum {
    topLeft,
    topRight,
    bottomLeft,
    bottomRight,
};

var globalCursor = struct {
    x: u32 = DEFAULT_CURSOR_X,
    y: u32 = DEFAULT_CURSOR_Y,
    visible: bool = true,
    style: CursorStyle = .block,
    blinking: bool = false,
    color: RGBA = .{ 1.0, 1.0, 1.0, 1.0 },
    mutex: std.Thread.Mutex = .{},
}{};

pub const CliRenderer = struct {
    width: u32,
    height: u32,
    currentRenderBuffer: *OptimizedBuffer,
    nextRenderBuffer: *OptimizedBuffer,
    backgroundColor: RGBA,
    renderOffset: u32,

    renderStats: struct {
        lastFrameTime: f64,
        averageFrameTime: f64,
        frameCount: u64,
        fps: u32,
        cellsUpdated: u32,
        renderTime: ?f64,
        overallFrameTime: ?f64,
        bufferResetTime: ?f64,
        stdoutWriteTime: ?f64,
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
        stdoutWriteTime: std.ArrayListUnmanaged(f64),
        cellsUpdated: std.ArrayListUnmanaged(u32),
        frameCallbackTime: std.ArrayListUnmanaged(f64),
    },
    lastRenderTime: i64,
    allocator: Allocator,
    renderThread: ?std.Thread = null,
    stdoutBuffer: [4096]u8,
    debugOverlay: struct {
        enabled: bool,
        corner: DebugOverlayCorner,
    } = .{
        .enabled = false,
        .corner = .bottomRight,
    },
    // Threading
    useThread: bool = false,
    renderMutex: std.Thread.Mutex = .{},
    renderCondition: std.Thread.Condition = .{},
    renderRequested: bool = false,
    shouldTerminate: bool = false,
    renderInProgress: bool = false,
    currentOutputBuffer: []u8 = &[_]u8{},
    currentOutputLen: usize = 0,

    currentHitGrid: []u32,
    nextHitGrid: []u32,
    hitGridWidth: u32,
    hitGridHeight: u32,

    mouseEnabled: bool,
    mouseMovementEnabled: bool,

    // Preallocated output buffer
    var outputBuffer: [OUTPUT_BUFFER_SIZE]u8 = undefined;
    var outputBufferLen: usize = 0;
    var outputBufferB: [OUTPUT_BUFFER_SIZE]u8 = undefined;
    var outputBufferBLen: usize = 0;
    var activeBuffer: enum { A, B } = .A;

    const OutputBufferWriter = struct {
        pub fn write(_: void, data: []const u8) !usize {
            const bufferLen = if (activeBuffer == .A) &outputBufferLen else &outputBufferBLen;
            const buffer = if (activeBuffer == .A) &outputBuffer else &outputBufferB;

            if (bufferLen.* + data.len > buffer.len) {
                // TODO: Resize buffer when necessary
                return error.BufferFull;
            }

            @memcpy(buffer.*[bufferLen.*..][0..data.len], data);
            bufferLen.* += data.len;

            return data.len;
        }

        // TODO: std.io.GenericWriter is deprecated, however the "correct" option seems to be much more involved
        // So I have simply used GenericWriter here, and then the proper migration can be done later
        // As GenericWriter still exists and works here in 0.15.1
        pub fn writer() std.io.GenericWriter(void, error{BufferFull}, write) {
            return .{ .context = {} };
        }
    };

    fn codepointDisplayWidth(cp: u32) u2 {
        // Treat NULL and control characters as width 0 (render as space)
        if (cp == 0) return 0;
        if (cp < 32) return 0;
        // Basic control DEL
        if (cp == 0x7F) return 0;

        // Simple combining diacriticals range (partial; keeps minimal set)
        if ((cp >= 0x0300 and cp <= 0x036F) or (cp >= 0x1AB0 and cp <= 0x1AFF) or (cp >= 0x1DC0 and cp <= 0x1DFF) or (cp >= 0x20D0 and cp <= 0x20FF) or (cp >= 0xFE20 and cp <= 0xFE2F)) {
            return 0;
        }

        // Emoji and common East Asian Wide blocks (coarse coverage sufficient for terminals)
        if ((cp >= 0x1100 and cp <= 0x115F) or // Hangul Jamo init
            (cp == 0x2329 or cp == 0x232A) or // angle brackets
            (cp >= 0x2E80 and cp <= 0xA4CF) or // CJK ... Yi
            (cp >= 0xAC00 and cp <= 0xD7A3) or // Hangul syllables
            (cp >= 0xF900 and cp <= 0xFAFF) or // CJK compatibility ideographs
            (cp >= 0xFE10 and cp <= 0xFE19) or // vertical forms
            (cp >= 0xFE30 and cp <= 0xFE6F) or // CJK forms
            (cp >= 0xFF00 and cp <= 0xFF60) or // fullwidth forms
            (cp >= 0xFFE0 and cp <= 0xFFE6) or // fullwidth signs
            (cp >= 0x1F300 and cp <= 0x1FAFF)) // emoji blocks (broad)
        {
            return 2;
        }

        return 1;
    }

    pub fn create(allocator: Allocator, width: u32, height: u32) !*CliRenderer {
        const self = try allocator.create(CliRenderer);

        const currentBuffer = try OptimizedBuffer.init(allocator, width, height, .{});
        const nextBuffer = try OptimizedBuffer.init(allocator, width, height, .{});

        // stat sample arrays
        var lastFrameTime = std.ArrayListUnmanaged(f64){};
        var renderTime = std.ArrayListUnmanaged(f64){};
        var overallFrameTime = std.ArrayListUnmanaged(f64){};
        var bufferResetTime = std.ArrayListUnmanaged(f64){};
        var stdoutWriteTime = std.ArrayListUnmanaged(f64){};
        var cellsUpdated = std.ArrayListUnmanaged(u32){};
        var frameCallbackTimes = std.ArrayListUnmanaged(f64){};

        try lastFrameTime.ensureTotalCapacity(allocator, STAT_SAMPLE_CAPACITY);
        try renderTime.ensureTotalCapacity(allocator, STAT_SAMPLE_CAPACITY);
        try overallFrameTime.ensureTotalCapacity(allocator, STAT_SAMPLE_CAPACITY);
        try bufferResetTime.ensureTotalCapacity(allocator, STAT_SAMPLE_CAPACITY);
        try stdoutWriteTime.ensureTotalCapacity(allocator, STAT_SAMPLE_CAPACITY);
        try cellsUpdated.ensureTotalCapacity(allocator, STAT_SAMPLE_CAPACITY);
        try frameCallbackTimes.ensureTotalCapacity(allocator, STAT_SAMPLE_CAPACITY);

        const hitGridSize = width * height;
        const currentHitGrid = try allocator.alloc(u32, hitGridSize);
        const nextHitGrid = try allocator.alloc(u32, hitGridSize);
        @memset(currentHitGrid, 0); // Initialize with 0 (no renderable)
        @memset(nextHitGrid, 0);

        self.* = .{
            .width = width,
            .height = height,
            .currentRenderBuffer = currentBuffer,
            .nextRenderBuffer = nextBuffer,
            .backgroundColor = .{ 0.0, 0.0, 0.0, 1.0 },
            .renderOffset = 0,

            .renderStats = .{
                .lastFrameTime = 0,
                .averageFrameTime = 0,
                .frameCount = 0,
                .fps = 0,
                .cellsUpdated = 0,
                .renderTime = null,
                .overallFrameTime = null,
                .bufferResetTime = null,
                .stdoutWriteTime = null,
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
                .stdoutWriteTime = stdoutWriteTime,
                .cellsUpdated = cellsUpdated,
                .frameCallbackTime = frameCallbackTimes,
            },
            .lastRenderTime = std.time.microTimestamp(),
            .allocator = allocator,
            .stdoutBuffer = undefined,
            .currentHitGrid = currentHitGrid,
            .nextHitGrid = nextHitGrid,
            .hitGridWidth = width,
            .hitGridHeight = height,
            .mouseEnabled = false,
            .mouseMovementEnabled = false,
        };

        try currentBuffer.clear(.{ self.backgroundColor[0], self.backgroundColor[1], self.backgroundColor[2], 1.0 }, CLEAR_CHAR);
        try nextBuffer.clear(.{ self.backgroundColor[0], self.backgroundColor[1], self.backgroundColor[2], 1.0 }, null);

        return self;
    }

    pub fn destroy(self: *CliRenderer, useAlternateScreen: bool, splitHeight: u32) void {
        self.renderMutex.lock();
        while (self.renderInProgress) {
            self.renderCondition.wait(&self.renderMutex);
        }

        self.shouldTerminate = true;
        self.renderRequested = true;
        self.renderCondition.signal();
        self.renderMutex.unlock();

        if (self.renderThread) |thread| {
            thread.join();
        }

        self.performShutdownSequence(useAlternateScreen, splitHeight);

        self.currentRenderBuffer.deinit();
        self.nextRenderBuffer.deinit();

        // Free stat sample arrays
        self.statSamples.lastFrameTime.deinit(self.allocator);
        self.statSamples.renderTime.deinit(self.allocator);
        self.statSamples.overallFrameTime.deinit(self.allocator);
        self.statSamples.bufferResetTime.deinit(self.allocator);
        self.statSamples.stdoutWriteTime.deinit(self.allocator);
        self.statSamples.cellsUpdated.deinit(self.allocator);
        self.statSamples.frameCallbackTime.deinit(self.allocator);

        self.allocator.free(self.currentHitGrid);
        self.allocator.free(self.nextHitGrid);

        self.allocator.destroy(self);
    }

    fn performShutdownSequence(self: *CliRenderer, useAlternateScreen: bool, splitHeight: u32) void {
        self.disableMouse();

        var writer = std.fs.File.stdout().writer(&self.stdoutBuffer);
        const direct = &writer.interface;

        if (useAlternateScreen) {
            direct.writeAll(ansi.ANSI.switchToMainScreen) catch {};
            direct.flush() catch {};
        } else if (splitHeight == 0) {
            ansi.ANSI.clearRendererSpaceOutput(direct, self.height) catch {};
        } else if (splitHeight > 0) {
            // Currently still handled in typescript
            // const consoleEndLine = self.height - splitHeight;
            // ansi.ANSI.moveToOutput(direct, 1, consoleEndLine) catch {};
        }

        direct.writeAll(ansi.ANSI.resetCursorColor) catch {};
        direct.writeAll(ansi.ANSI.restoreCursorState) catch {};
        direct.writeAll(ansi.ANSI.defaultCursorStyle) catch {};

        direct.writeAll(ansi.ANSI.showCursor) catch {};

        // Workaround for Ghostty not showing the cursor after shutdown for some reason
        direct.flush() catch {};
        std.Thread.sleep(10 * std.time.ns_per_ms);
        direct.writeAll(ansi.ANSI.showCursor) catch {};
        direct.flush() catch {};
        std.Thread.sleep(10 * std.time.ns_per_ms);
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

    pub fn setUseThread(self: *CliRenderer, useThread: bool) void {
        if (self.useThread == useThread) return;

        if (useThread) {
            if (self.renderThread == null) {
                self.renderThread = std.Thread.spawn(.{}, renderThreadFn, .{self}) catch |err| {
                    std.log.warn("Failed to spawn render thread: {}, falling back to non-threaded mode", .{err});
                    self.useThread = false;
                    return;
                };
            }
        } else {
            if (self.renderThread) |thread| {
                thread.join();
                self.renderThread = null;
            }
        }

        self.useThread = useThread;
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

    pub fn resize(self: *CliRenderer, width: u32, height: u32) !void {
        if (self.width == width and self.height == height) return;

        self.width = width;
        self.height = height;

        try self.currentRenderBuffer.resize(width, height);
        try self.nextRenderBuffer.resize(width, height);

        try self.currentRenderBuffer.clear(.{ 0.0, 0.0, 0.0, 1.0 }, CLEAR_CHAR);
        try self.nextRenderBuffer.clear(.{ self.backgroundColor[0], self.backgroundColor[1], self.backgroundColor[2], 1.0 }, null);

        const newHitGridSize = width * height;
        const currentHitGridSize = self.hitGridWidth * self.hitGridHeight;
        if (newHitGridSize > currentHitGridSize) {
            const newCurrentHitGrid = try self.allocator.alloc(u32, newHitGridSize);
            const newNextHitGrid = try self.allocator.alloc(u32, newHitGridSize);
            @memset(newCurrentHitGrid, 0);
            @memset(newNextHitGrid, 0);

            self.allocator.free(self.currentHitGrid);
            self.allocator.free(self.nextHitGrid);
            self.currentHitGrid = newCurrentHitGrid;
            self.nextHitGrid = newNextHitGrid;
            self.hitGridWidth = width;
            self.hitGridHeight = height;
        }

        globalCursor.mutex.lock();
        globalCursor.x = @min(globalCursor.x, width);
        globalCursor.y = @min(globalCursor.y, height);
        globalCursor.mutex.unlock();
    }

    pub fn setBackgroundColor(self: *CliRenderer, rgba: RGBA) void {
        self.backgroundColor = rgba;
    }

    pub fn setRenderOffset(self: *CliRenderer, offset: u32) void {
        self.renderOffset = offset;
    }

    fn renderThreadFn(self: *CliRenderer) void {
        while (true) {
            self.renderMutex.lock();
            while (!self.renderRequested and !self.shouldTerminate) {
                self.renderCondition.wait(&self.renderMutex);
            }

            if (self.shouldTerminate and !self.renderRequested) {
                self.renderMutex.unlock();
                break;
            }

            self.renderRequested = false;

            const outputData = self.currentOutputBuffer;
            const outputLen = self.currentOutputLen;

            const writeStart = std.time.microTimestamp();
            if (outputLen > 0) {
                var writer = std.fs.File.stdout().writer(&self.stdoutBuffer);
                const w = &writer.interface;
                w.writeAll(outputData[0..outputLen]) catch {};
                w.flush() catch {};
            }

            // Signal that rendering is complete
            self.renderStats.stdoutWriteTime = @as(f64, @floatFromInt(std.time.microTimestamp() - writeStart));
            self.renderInProgress = false;
            self.renderCondition.signal();
            self.renderMutex.unlock();
        }
    }

    // Render once with current state
    pub fn render(self: *CliRenderer, force: bool) void {
        const now = std.time.microTimestamp();
        const deltaTimeMs = @as(f64, @floatFromInt(now - self.lastRenderTime));
        const deltaTime = deltaTimeMs / 1000.0; // Convert to seconds

        self.lastRenderTime = now;
        self.renderDebugOverlay();

        self.prepareRenderFrame(force);

        if (self.useThread) {
            self.renderMutex.lock();
            while (self.renderInProgress) {
                self.renderCondition.wait(&self.renderMutex);
            }

            if (activeBuffer == .A) {
                activeBuffer = .B;
                self.currentOutputBuffer = &outputBuffer;
                self.currentOutputLen = outputBufferLen;
            } else {
                activeBuffer = .A;
                self.currentOutputBuffer = &outputBufferB;
                self.currentOutputLen = outputBufferBLen;
            }

            self.renderRequested = true;
            self.renderInProgress = true;
            self.renderCondition.signal();
            self.renderMutex.unlock();
        } else {
            const writeStart = std.time.microTimestamp();
            var writer = std.fs.File.stdout().writer(&self.stdoutBuffer);
            const w = &writer.interface;
            w.writeAll(outputBuffer[0..outputBufferLen]) catch {};
            w.flush() catch {};
            self.renderStats.stdoutWriteTime = @as(f64, @floatFromInt(std.time.microTimestamp() - writeStart));
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
        if (self.renderStats.stdoutWriteTime) |swt| {
            self.addStatSample(f64, &self.statSamples.stdoutWriteTime, swt);
        }
        self.addStatSample(u32, &self.statSamples.cellsUpdated, self.renderStats.cellsUpdated);
    }

    pub fn getNextBuffer(self: *CliRenderer) *OptimizedBuffer {
        return self.nextRenderBuffer;
    }

    pub fn getCurrentBuffer(self: *CliRenderer) *OptimizedBuffer {
        return self.currentRenderBuffer;
    }

    fn prepareRenderFrame(self: *CliRenderer, force: bool) void {
        const renderStartTime = std.time.microTimestamp();
        var cellsUpdated: u32 = 0;

        if (activeBuffer == .A) {
            outputBufferLen = 0;
        } else {
            outputBufferBLen = 0;
        }

        var writer = OutputBufferWriter.writer();

        writer.writeAll(ansi.ANSI.hideCursor) catch {};

        var currentFg: ?RGBA = null;
        var currentBg: ?RGBA = null;
        var currentAttributes: i16 = -1;
        var utf8Buf: [4]u8 = undefined;

        var runBuffer: [RUN_BUFFER_SIZE]u8 = undefined;
        var runBufferLen: usize = 0;

        const colorEpsilon: f32 = COLOR_EPSILON_DEFAULT;

        for (0..self.height) |uy| {
            const y = @as(u32, @intCast(uy));

            var runStart: i64 = -1;
            var runStartVisualCol: i64 = -1;
            var runLength: u32 = 0;
            runBufferLen = 0;
            var currentVisualCol: u32 = 0;

            for (0..self.width) |ux| {
                const x = @as(u32, @intCast(ux));
                const currentCell = self.currentRenderBuffer.get(x, y);
                const nextCell = self.nextRenderBuffer.get(x, y);

                if (currentCell == null or nextCell == null) continue;

                if (!force) {
                    const charEqual = currentCell.?.char == nextCell.?.char;
                    const attrEqual = currentCell.?.attributes == nextCell.?.attributes;

                    if (charEqual and attrEqual and
                        buf.rgbaEqual(currentCell.?.fg, nextCell.?.fg, colorEpsilon) and
                        buf.rgbaEqual(currentCell.?.bg, nextCell.?.bg, colorEpsilon))
                    {
                        if (runLength > 0) {
                            const startCol: u32 = @intCast(runStartVisualCol + 1);
                            ansi.ANSI.moveToOutput(writer, startCol, @as(u32, @intCast(y + 1 + self.renderOffset))) catch {};

                            writer.writeAll(runBuffer[0..runBufferLen]) catch {};
                            writer.writeAll(ansi.ANSI.reset) catch {};

                            runStart = -1;
                            runStartVisualCol = -1;
                            runLength = 0;
                            runBufferLen = 0;
                        }
                        const nextChar = nextCell.?.char;
                        const w = codepointDisplayWidth(nextChar);
                        currentVisualCol += if (w == 0) 1 else w;
                        continue;
                    }
                }

                const cell = nextCell.?;

                const fgMatch = currentFg != null and buf.rgbaEqual(currentFg.?, cell.fg, colorEpsilon);
                const bgMatch = currentBg != null and buf.rgbaEqual(currentBg.?, cell.bg, colorEpsilon);
                const sameAttributes = fgMatch and bgMatch and @as(i16, cell.attributes) == currentAttributes;

                if (!sameAttributes or runStart == -1) {
                    if (runLength > 0) {
                        const startCol: u32 = @intCast(runStartVisualCol + 1);
                        ansi.ANSI.moveToOutput(writer, startCol, @as(u32, @intCast(y + 1 + self.renderOffset))) catch {};

                        writer.writeAll(runBuffer[0..runBufferLen]) catch {};
                        writer.writeAll(ansi.ANSI.reset) catch {};
                        runBufferLen = 0;
                    }

                    runStart = @intCast(x);
                    runStartVisualCol = @intCast(currentVisualCol);
                    runLength = 0;

                    currentFg = cell.fg;
                    currentBg = cell.bg;
                    currentAttributes = @intCast(cell.attributes);

                    ansi.ANSI.moveToOutput(writer, @as(u32, @intCast(currentVisualCol + 1)), y + 1 + self.renderOffset) catch {};

                    const fgR = rgbaComponentToU8(cell.fg[0]);
                    const fgG = rgbaComponentToU8(cell.fg[1]);
                    const fgB = rgbaComponentToU8(cell.fg[2]);

                    const bgR = rgbaComponentToU8(cell.bg[0]);
                    const bgG = rgbaComponentToU8(cell.bg[1]);
                    const bgB = rgbaComponentToU8(cell.bg[2]);

                    ansi.ANSI.fgColorOutput(writer, fgR, fgG, fgB) catch {};
                    ansi.ANSI.bgColorOutput(writer, bgR, bgG, bgB) catch {};

                    ansi.TextAttributes.applyAttributesOutputWriter(writer, cell.attributes) catch {};
                }

                var outChar: u32 = cell.char;
                const w = codepointDisplayWidth(outChar);
                if (w == 0) {
                    outChar = ' ';
                }
                const len = std.unicode.utf8Encode(@intCast(outChar), &utf8Buf) catch 1;
                if (runBufferLen + len <= runBuffer.len) {
                    @memcpy(runBuffer[runBufferLen..][0..len], utf8Buf[0..len]);
                    runBufferLen += len;
                }
                runLength += 1;

                self.currentRenderBuffer.set(x, y, nextCell.?);

                cellsUpdated += 1;
                currentVisualCol += if (w == 0) 1 else w;

                // append an extra space if previous char was double-width next is a narrow glyph
                const prevWidth = codepointDisplayWidth(currentCell.?.char);
                if (prevWidth == 2 and (w == 0 or w == 1)) {
                    if (runBufferLen + 1 <= runBuffer.len) {
                        runBuffer[runBufferLen] = ' ';
                        runBufferLen += 1;
                        currentVisualCol += 1;
                    }
                }
            }

            if (runLength > 0) {
                const startCol: u32 = @intCast(runStartVisualCol + 1);
                ansi.ANSI.moveToOutput(writer, startCol, @as(u32, @intCast(y + 1 + self.renderOffset))) catch {};
                writer.writeAll(runBuffer[0..runBufferLen]) catch {};
                writer.writeAll(ansi.ANSI.reset) catch {};
            }
        }

        writer.writeAll(ansi.ANSI.reset) catch {};

        globalCursor.mutex.lock();
        if (globalCursor.visible) {
            var cursorStyleCode: []const u8 = undefined;

            switch (globalCursor.style) {
                .block => {
                    cursorStyleCode = if (globalCursor.blinking)
                        ansi.ANSI.cursorBlockBlink
                    else
                        ansi.ANSI.cursorBlock;
                },
                .line => {
                    cursorStyleCode = if (globalCursor.blinking)
                        ansi.ANSI.cursorLineBlink
                    else
                        ansi.ANSI.cursorLine;
                },
                .underline => {
                    cursorStyleCode = if (globalCursor.blinking)
                        ansi.ANSI.cursorUnderlineBlink
                    else
                        ansi.ANSI.cursorUnderline;
                },
            }

            const cursorR = rgbaComponentToU8(globalCursor.color[0]);
            const cursorG = rgbaComponentToU8(globalCursor.color[1]);
            const cursorB = rgbaComponentToU8(globalCursor.color[2]);

            ansi.ANSI.cursorColorOutputWriter(writer, cursorR, cursorG, cursorB) catch {};
            writer.writeAll(cursorStyleCode) catch {};
            ansi.ANSI.moveToOutput(writer, globalCursor.x, globalCursor.y + self.renderOffset) catch {};
            writer.writeAll(ansi.ANSI.showCursor) catch {};
        } else {
            writer.writeAll(ansi.ANSI.hideCursor) catch {};
        }
        globalCursor.mutex.unlock();

        const renderEndTime = std.time.microTimestamp();
        const renderTime = @as(f64, @floatFromInt(renderEndTime - renderStartTime));

        self.renderStats.cellsUpdated = cellsUpdated;
        self.renderStats.renderTime = renderTime;

        self.nextRenderBuffer.clear(.{ self.backgroundColor[0], self.backgroundColor[1], self.backgroundColor[2], 1.0 }, null) catch {};

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
        var writer = std.fs.File.stdout().writer(&self.stdoutBuffer);
        const w = &writer.interface;
        w.writeAll(ansi.ANSI.clearAndHome) catch {};
        w.flush() catch {};
    }

    pub fn addToHitGrid(self: *CliRenderer, x: i32, y: i32, width: u32, height: u32, id: u32) void {
        const startX = @max(0, x);
        const startY = @max(0, y);
        const endX = @min(@as(i32, @intCast(self.hitGridWidth)), x + @as(i32, @intCast(width)));
        const endY = @min(@as(i32, @intCast(self.hitGridHeight)), y + @as(i32, @intCast(height)));

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

    pub fn checkHit(self: *CliRenderer, x: u32, y: u32) u32 {
        if (x >= self.hitGridWidth or y >= self.hitGridHeight) {
            return 0;
        }

        const index = y * self.hitGridWidth + x;
        return self.currentHitGrid[index];
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
                    var utf8Buf: [4]u8 = undefined;
                    const len = std.unicode.utf8Encode(@intCast(c.char), &utf8Buf) catch 1;
                    writer.writeAll(utf8Buf[0..len]) catch return;
                } else {
                    writer.writeByte(' ') catch return;
                }
            }
            writer.writeByte('\n') catch return;
        }
        writer.flush() catch {};
    }

    pub fn dumpStdoutBuffer(self: *CliRenderer, timestamp: i64) void {
        _ = self;
        std.fs.cwd().makeDir("buffer_dump") catch |err| switch (err) {
            error.PathAlreadyExists => {},
            else => return,
        };

        var filename_buf: [128]u8 = undefined;
        const filename = std.fmt.bufPrint(&filename_buf, "buffer_dump/stdout_buffer_{d}.txt", .{timestamp}) catch return;

        const file = std.fs.cwd().createFile(filename, .{}) catch return;
        defer file.close();

        var fileBuffer: [4096]u8 = undefined;
        var fileWriter = file.writer(&fileBuffer);
        const writer = &fileWriter.interface;

        writer.print("Stdout Buffer Output (timestamp: {d}):\n", .{timestamp}) catch return;
        writer.writeAll("Last Rendered ANSI Output:\n") catch return;
        writer.writeAll("================\n") catch return;

        const lastBuffer = if (activeBuffer == .A) &outputBufferB else &outputBuffer;
        const lastLen = if (activeBuffer == .A) outputBufferBLen else outputBufferLen;

        if (lastLen > 0) {
            writer.writeAll(lastBuffer.*[0..lastLen]) catch return;
        } else {
            writer.writeAll("(no output rendered yet)\n") catch return;
        }

        writer.writeAll("\n================\n") catch return;
        writer.print("Buffer size: {d} bytes\n", .{lastLen}) catch return;
        writer.print("Active buffer: {s}\n", .{if (activeBuffer == .A) "A" else "B"}) catch return;
        writer.flush() catch {};
    }

    pub fn dumpBuffers(self: *CliRenderer, timestamp: i64) void {
        self.dumpSingleBuffer(self.currentRenderBuffer, "current", timestamp);
        self.dumpSingleBuffer(self.nextRenderBuffer, "next", timestamp);
        self.dumpStdoutBuffer(timestamp);
    }

    pub fn enableMouse(self: *CliRenderer, enableMovement: bool) void {
        self.mouseEnabled = true;
        self.mouseMovementEnabled = enableMovement;

        var bufferedWriter = std.fs.File.stdout().writer(&self.stdoutBuffer);
        const writer = &bufferedWriter.interface;

        writer.writeAll(ansi.ANSI.enableSGRMouseMode) catch {};
        writer.writeAll(ansi.ANSI.enableMouseTracking) catch {};
        writer.writeAll(ansi.ANSI.enableButtonEventTracking) catch {};

        if (enableMovement) {
            writer.writeAll(ansi.ANSI.enableAnyEventTracking) catch {};
        }

        writer.flush() catch {};
    }

    pub fn disableMouse(self: *CliRenderer) void {
        if (!self.mouseEnabled) return;

        self.mouseEnabled = false;
        self.mouseMovementEnabled = false;

        var writer = std.fs.File.stdout().writer(&self.stdoutBuffer);
        const w = &writer.interface;

        w.writeAll(ansi.ANSI.disableAnyEventTracking) catch {};
        w.writeAll(ansi.ANSI.disableButtonEventTracking) catch {};
        w.writeAll(ansi.ANSI.disableMouseTracking) catch {};
        w.writeAll(ansi.ANSI.disableSGRMouseMode) catch {};

        w.flush() catch {};
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

        self.nextRenderBuffer.fillRect(x, y, width, height, .{ 20.0 / 255.0, 20.0 / 255.0, 40.0 / 255.0, 1.0 }) catch {};
        self.nextRenderBuffer.drawText("Debug Information", x + 1, y + 1, .{ 1.0, 1.0, 100.0 / 255.0, 1.0 }, .{ 0.0, 0.0, 0.0, 0.0 }, ansi.TextAttributes.BOLD) catch {};

        var row: u32 = 2;
        const bg: RGBA = .{ 0.0, 0.0, 0.0, 0.0 };
        const fg: RGBA = .{ 200.0 / 255.0, 200.0 / 255.0, 200.0 / 255.0, 1.0 };

        // Calculate averages
        const lastFrameTimeAvg = getStatAverage(f64, &self.statSamples.lastFrameTime);
        const renderTimeAvg = getStatAverage(f64, &self.statSamples.renderTime);
        const overallFrameTimeAvg = getStatAverage(f64, &self.statSamples.overallFrameTime);
        const bufferResetTimeAvg = getStatAverage(f64, &self.statSamples.bufferResetTime);
        const stdoutWriteTimeAvg = getStatAverage(f64, &self.statSamples.stdoutWriteTime);
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

        // Stdout Write Time
        if (self.renderStats.stdoutWriteTime) |writeTime| {
            var writeTimeText: [64]u8 = undefined;
            const writeTimeLen = std.fmt.bufPrint(&writeTimeText, "Stdout: {d:.3}ms (avg: {d:.3}ms)", .{ writeTime / 1000.0, stdoutWriteTimeAvg / 1000.0 }) catch return;
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
        const isThreadedLen = std.fmt.bufPrint(&isThreadedText, "Threaded: {s}", .{if (self.useThread) "Yes" else "No"}) catch return;
        self.nextRenderBuffer.drawText(isThreadedLen, x + 1, y + row, fg, bg, 0) catch {};
        row += 1;
    }
};

pub fn setCursorPositionGlobal(x: i32, y: i32, visible: bool) void {
    globalCursor.mutex.lock();
    globalCursor.x = @intCast(@max(1, x));
    globalCursor.y = @intCast(@max(1, y));
    globalCursor.visible = visible;
    globalCursor.mutex.unlock();
}

pub fn setCursorStyleGlobal(styleStr: []const u8, blinking: bool) void {
    if (styleStr.len == 0) return;

    globalCursor.mutex.lock();
    globalCursor.style = std.meta.stringToEnum(CursorStyle, styleStr) orelse .block;
    globalCursor.blinking = blinking;
    globalCursor.mutex.unlock();
}

pub fn setCursorColorGlobal(color: RGBA) void {
    globalCursor.mutex.lock();
    globalCursor.color = color;
    globalCursor.mutex.unlock();
}
