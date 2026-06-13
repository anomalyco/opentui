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
const native_audio = @import("audio.zig");
const buffer_effects = @import("buffer-methods.zig");
const handles = @import("handles.zig");
const native_yoga = @import("yoga.zig");

pub const OptimizedBuffer = buffer.OptimizedBuffer;
pub const CliRenderer = renderer.CliRenderer;
pub const Terminal = terminal.Terminal;
pub const RGBA = buffer.RGBA;
pub const NativeHandle = handles.Handle;

const INVALID_HANDLE: NativeHandle = 0;
const EMPTY_U8 = [_]u8{0};
const EMPTY_U32 = [_]u32{0};

fn ptrToRGBA(color: [*]const u16) RGBA {
    return .{ color[0], color[1], color[2], color[3] };
}

fn optionalPtrToRGBA(color: ?[*]const u16) ?RGBA {
    if (color) |packed_color| {
        return ptrToRGBA(packed_color);
    }

    return null;
}

fn erasePtr(ptr_value: anytype) *anyopaque {
    return @ptrCast(ptr_value);
}

fn acquireRenderer(handle: NativeHandle) ?*renderer.CliRenderer {
    return handles.acquire(handle, .renderer, renderer.CliRenderer);
}

fn acquireBuffer(handle: NativeHandle) ?*buffer.OptimizedBuffer {
    return handles.acquire(handle, .optimized_buffer, buffer.OptimizedBuffer);
}

fn acquireTextBuffer(handle: NativeHandle) ?*text_buffer.UnifiedTextBuffer {
    return handles.acquire(handle, .text_buffer, text_buffer.UnifiedTextBuffer);
}

fn acquireTextBufferView(handle: NativeHandle) ?*text_buffer_view.UnifiedTextBufferView {
    return handles.acquire(handle, .text_buffer_view, text_buffer_view.UnifiedTextBufferView);
}

fn acquireEditBuffer(handle: NativeHandle) ?*edit_buffer_mod.EditBuffer {
    return handles.acquire(handle, .edit_buffer, edit_buffer_mod.EditBuffer);
}

fn acquireEditorView(handle: NativeHandle) ?*editor_view.EditorView {
    return handles.acquire(handle, .editor_view, editor_view.EditorView);
}

fn acquireSyntaxStyle(handle: NativeHandle) ?*syntax_style.SyntaxStyle {
    return handles.acquire(handle, .syntax_style, syntax_style.SyntaxStyle);
}

fn acquireEventSink(handle: NativeHandle) ?*event_bus.EventSink {
    return handles.acquire(handle, .event_sink, event_bus.EventSink);
}

fn acquireAudioEngine(handle: NativeHandle) ?*native_audio.Engine {
    return handles.acquire(handle, .audio_engine, native_audio.Engine);
}

fn emptyLineInfo(outPtr: *ExternalLineInfo) void {
    outPtr.* = .{
        .start_cols_ptr = EMPTY_U32[0..].ptr,
        .start_cols_len = 0,
        .width_cols_ptr = EMPTY_U32[0..].ptr,
        .width_cols_len = 0,
        .sources_ptr = EMPTY_U32[0..].ptr,
        .sources_len = 0,
        .wraps_ptr = EMPTY_U32[0..].ptr,
        .wraps_len = 0,
        .width_cols_max = 0,
    };
}

fn sliceFromPtrLen(ptr: ?[*]const u8, len: u32) []const u8 {
    if (len == 0) {
        return "";
    }

    return ptr.?[0..@as(usize, len)];
}

inline fn selectionStyle(bg: ?RGBA, fg: ?RGBA) text_buffer_view.SelectionStyle {
    return .{
        .bgColor = bg,
        .fgColor = fg,
    };
}

comptime {
    _ = native_span_feed;
    _ = native_audio;
    _ = native_yoga;
}

export fn setLogCallback(callback: ?*const fn (level: u8, msgPtr: [*]const u8, msgLen: u32) callconv(.c) void) void {
    logger.setLogCallback(callback);
}

export fn createEventSink(callback: ?event_bus.EventCallback) NativeHandle {
    const sink = event_bus.createEventSink(globalAllocator, callback orelse return INVALID_HANDLE) catch return INVALID_HANDLE;
    return handles.insert(.event_sink, erasePtr(sink)) catch {
        event_bus.destroyEventSink(globalAllocator, sink);
        return INVALID_HANDLE;
    };
}

fn clearEditBufferEventSinkRefs(sink: *event_bus.EventSink) void {
    var cursor: usize = 1;
    while (handles.nextByKind(.edit_buffer, &cursor)) |edit_handle| {
        const token = handles.pause(edit_handle, .edit_buffer, edit_buffer_mod.EditBuffer) orelse continue;
        if (token.ptr.event_sink == sink) {
            token.ptr.event_sink = null;
        }
        handles.unpause(token.handle);
    }
}

export fn destroyEventSink(sink_handle: NativeHandle) void {
    const token = handles.beginDestroy(sink_handle, .event_sink, event_bus.EventSink) orelse return;
    clearEditBufferEventSinkRefs(token.ptr);
    event_bus.destroyEventSink(globalAllocator, token.ptr);
    handles.finishDestroy(token.handle);
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

pub const ExternalRenderStats = extern struct {
    last_frame_time: f64,
    average_frame_time: f64,
    render_time: f64,
    // ABI names keep stdout terminology for compatibility; the value is the
    // backend output write time for stdout, memory, or feed output.
    stdout_write_time: f64,
    frame_count: u64,
    cells_updated: u32,
    average_cells_updated: u32,
    render_time_valid: bool,
    stdout_write_time_valid: bool,
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

export fn createAudioEngine(options_ptr: ?*const native_audio.CreateOptions) NativeHandle {
    const engine = native_audio.create(globalAllocator, options_ptr) orelse return INVALID_HANDLE;
    return handles.insert(.audio_engine, erasePtr(engine)) catch {
        native_audio.destroy(engine);
        return INVALID_HANDLE;
    };
}

export fn destroyAudioEngine(engine_handle: NativeHandle) void {
    const token = handles.beginDestroy(engine_handle, .audio_engine, native_audio.Engine) orelse return;
    native_audio.destroy(token.ptr);
    handles.finishDestroy(token.handle);
}

export fn audioRefreshPlaybackDevices(engine_handle: NativeHandle) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.refreshPlaybackDevices(object_ptr);
}

export fn audioGetPlaybackDeviceCount(engine_handle: NativeHandle) u32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return 0;
    return native_audio.getPlaybackDeviceCount(object_ptr);
}

export fn audioGetPlaybackDeviceName(engine_handle: NativeHandle, index: u32, out_ptr: [*]u8, max_len: u32) u32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return 0;
    return @intCast(native_audio.getPlaybackDeviceName(object_ptr, index, out_ptr, @as(usize, max_len)));
}

export fn audioIsPlaybackDeviceDefault(engine_handle: NativeHandle, index: u32) bool {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return false;
    return native_audio.isPlaybackDeviceDefault(object_ptr, index);
}

export fn audioSelectPlaybackDevice(engine_handle: NativeHandle, index: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.selectPlaybackDevice(object_ptr, index);
}

export fn audioClearPlaybackDeviceSelection(engine_handle: NativeHandle) void {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return;
    native_audio.clearPlaybackDeviceSelection(object_ptr);
}

export fn audioStart(engine_handle: NativeHandle, options_ptr: ?*const native_audio.StartOptions) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.start(object_ptr, options_ptr);
}

export fn audioStartMixer(engine_handle: NativeHandle) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.startMixer(object_ptr);
}

export fn audioStop(engine_handle: NativeHandle) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.stop(object_ptr);
}

export fn audioLoad(engine_handle: NativeHandle, data_ptr: ?[*]const u8, data_len: u32, out_sound_id: ?*u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.load(object_ptr, data_ptr, @as(usize, data_len), out_sound_id);
}

export fn audioUnload(engine_handle: NativeHandle, sound_id: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.unload(object_ptr, sound_id);
}

export fn audioPlay(engine_handle: NativeHandle, sound_id: u32, options_ptr: ?*const native_audio.VoiceOptions, out_voice_id: ?*u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.play(object_ptr, sound_id, options_ptr, out_voice_id);
}

export fn audioStopVoice(engine_handle: NativeHandle, voice_id: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.stopVoice(object_ptr, voice_id);
}

export fn audioSetVoiceGroup(engine_handle: NativeHandle, voice_id: u32, group_id: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.setVoiceGroup(object_ptr, voice_id, group_id);
}

export fn audioCreateGroup(engine_handle: NativeHandle, name_ptr: ?[*]const u8, name_len: u32, out_group_id: ?*u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.createGroup(object_ptr, name_ptr, @as(usize, name_len), out_group_id);
}

export fn audioSetGroupVolume(engine_handle: NativeHandle, group_id: u32, volume: f32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.setGroupVolume(object_ptr, group_id, volume);
}

export fn audioSetMasterVolume(engine_handle: NativeHandle, volume: f32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.setMasterVolume(object_ptr, volume);
}

export fn audioMixToBuffer(engine_handle: NativeHandle, out_ptr: ?[*]f32, frame_count: u32, channels: u8) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.mixToBuffer(object_ptr, out_ptr, frame_count, channels);
}

export fn audioEnableTap(engine_handle: NativeHandle, enabled: bool, capacity_frames: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.enableTap(object_ptr, enabled, capacity_frames);
}

export fn audioReadTap(engine_handle: NativeHandle, out_ptr: ?[*]f32, frame_count: u32, channels: u8, out_frames_read: ?*u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.readTap(object_ptr, out_ptr, frame_count, channels, out_frames_read);
}

export fn audioGetStats(engine_handle: NativeHandle, out_stats: ?*native_audio.Stats) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.getStats(object_ptr, out_stats);
}

export fn getArenaAllocatedBytes() u64 {
    return @intCast(arena.queryCapacity());
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

/// Create a renderer.
///
/// Output transport selection:
///   - `feedPtr != null`: writes go to the provided NativeSpanFeed stream
///     (FeedBackend), which the TS side pipes onward to a user-supplied Writable
///   - `feedPtr == null`: writes go through a buffered backend selected by
///     `bufferedDestinationKind` (0 = process stdout, 1 = memory)
///
/// `remoteModeValue` is 0 = auto, 1 = local, 2 = remote. The TS side decides
/// the appropriate default for process stdout, memory output, and feed output.
fn registerRendererBufferHandles(renderer_handle: NativeHandle, rendererPtr: *renderer.CliRenderer) bool {
    _ = handles.getOrInsertBorrowed(.optimized_buffer, erasePtr(rendererPtr.getCurrentBuffer()), renderer_handle) catch return false;
    _ = handles.getOrInsertBorrowed(.optimized_buffer, erasePtr(rendererPtr.getNextBuffer()), renderer_handle) catch return false;
    return true;
}

export fn createRenderer(
    width: u32,
    height: u32,
    bufferedDestinationKind: u8,
    remoteModeValue: u8,
    feedPtr: ?*native_span_feed.Stream,
) NativeHandle {
    if (width == 0 or height == 0) {
        logger.warn("Invalid renderer dimensions: {}x{}", .{ width, height });
        return INVALID_HANDLE;
    }

    const remote_mode: terminal.Terminal.RemoteMode = switch (remoteModeValue) {
        0 => .auto,
        1 => .local,
        2 => .remote,
        else => .local,
    };

    const pool = gp.initGlobalPool(globalArena);
    _ = link.initGlobalLinkPool(globalArena);
    const output_target: renderer.CliRenderer.OutputTarget = if (feedPtr) |feed|
        .{ .feed = feed }
    else switch (bufferedDestinationKind) {
        0 => .stdout,
        1 => .memory,
        else => {
            logger.warn("Invalid buffered destination kind: {}", .{bufferedDestinationKind});
            return INVALID_HANDLE;
        },
    };

    const rendererPtr = renderer.CliRenderer.createWithOptions(globalAllocator, width, height, pool, .{
        .remote_mode = remote_mode,
        .output = output_target,
    }) catch |err| {
        logger.err("Failed to create renderer: {}", .{err});
        return INVALID_HANDLE;
    };

    const renderer_handle = handles.insert(.renderer, erasePtr(rendererPtr)) catch {
        rendererPtr.destroy();
        return INVALID_HANDLE;
    };
    if (!registerRendererBufferHandles(renderer_handle, rendererPtr)) {
        if (handles.beginDestroy(renderer_handle, .renderer, renderer.CliRenderer)) |token| {
            handles.invalidateChildren(token.handle);
            rendererPtr.destroy();
            handles.finishDestroy(token.handle);
        }
        return INVALID_HANDLE;
    }

    return renderer_handle;
}

export fn setTerminalEnvVar(renderer_handle: NativeHandle, keyPtr: ?[*]const u8, keyLen: u32, valuePtr: ?[*]const u8, valueLen: u32) bool {
    const object_ptr = acquireRenderer(renderer_handle) orelse return false;
    const key = sliceFromPtrLen(keyPtr, keyLen);
    const value = sliceFromPtrLen(valuePtr, valueLen);
    return object_ptr.setTerminalEnvVar(key, value);
}

export fn setUseThread(renderer_handle: NativeHandle, useThread: bool) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.setUseThread(useThread);
}

export fn setClearOnShutdown(renderer_handle: NativeHandle, clear: bool) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.setClearOnShutdown(clear);
}

export fn destroyRenderer(renderer_handle: NativeHandle) void {
    const token = handles.beginDestroy(renderer_handle, .renderer, renderer.CliRenderer) orelse return;
    handles.invalidateChildren(token.handle);
    token.ptr.destroy();
    handles.finishDestroy(token.handle);
}

export fn setBackgroundColor(renderer_handle: NativeHandle, color: [*]const u16) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.setBackgroundColor(ptrToRGBA(color));
}

export fn setRenderOffset(renderer_handle: NativeHandle, offset: u32) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.setRenderOffset(offset);
}

export fn resetSplitScrollback(renderer_handle: NativeHandle, seedRows: u32, pinnedRenderOffset: u32) u32 {
    const object_ptr = acquireRenderer(renderer_handle) orelse return 0;
    return object_ptr.resetSplitScrollback(seedRows, pinnedRenderOffset);
}

export fn syncSplitScrollback(renderer_handle: NativeHandle, pinnedRenderOffset: u32) u32 {
    const object_ptr = acquireRenderer(renderer_handle) orelse return 0;
    return object_ptr.syncSplitScrollback(pinnedRenderOffset);
}

export fn getSplitOutputOffset(renderer_handle: NativeHandle, surfaceOffset: u32) u32 {
    const object_ptr = acquireRenderer(renderer_handle) orelse return 0;
    return object_ptr.getSplitOutputOffset(surfaceOffset);
}

export fn setPendingSplitFooterTransition(
    renderer_handle: NativeHandle,
    mode: u8,
    sourceTopLine: u32,
    sourceHeight: u32,
    targetTopLine: u32,
    targetHeight: u32,
    scrollLines: u32,
) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.setPendingSplitFooterTransition(
        @enumFromInt(mode),
        sourceTopLine,
        sourceHeight,
        targetTopLine,
        targetHeight,
        scrollLines,
    );
}

export fn clearPendingSplitFooterTransition(renderer_handle: NativeHandle) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.clearPendingSplitFooterTransition();
}

export fn updateStats(renderer_handle: NativeHandle, time: f64, fps: u32, frameCallbackTime: f64) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.updateStats(time, fps, frameCallbackTime);
}

export fn updateMemoryStats(renderer_handle: NativeHandle, heapUsed: u32, heapTotal: u32, arrayBuffers: u32) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.updateMemoryStats(heapUsed, heapTotal, arrayBuffers);
}

export fn getRenderStats(renderer_handle: NativeHandle, outPtr: *ExternalRenderStats) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse {
        outPtr.* = std.mem.zeroes(ExternalRenderStats);
        return;
    };
    const stats = object_ptr.getRenderStats();

    outPtr.* = .{
        .last_frame_time = stats.lastFrameTime,
        .average_frame_time = stats.averageFrameTime,
        .render_time = stats.renderTime orelse 0,
        .stdout_write_time = stats.outputWriteTime orelse 0,
        .frame_count = stats.frameCount,
        .cells_updated = stats.cellsUpdated,
        .average_cells_updated = stats.averageCellsUpdated,
        .render_time_valid = stats.renderTime != null,
        .stdout_write_time_valid = stats.outputWriteTime != null,
    };
}

export fn getNextBuffer(renderer_handle: NativeHandle) NativeHandle {
    const object_ptr = acquireRenderer(renderer_handle) orelse return INVALID_HANDLE;
    return handles.getOrInsertBorrowed(.optimized_buffer, erasePtr(object_ptr.getNextBuffer()), renderer_handle) catch INVALID_HANDLE;
}

export fn getCurrentBuffer(renderer_handle: NativeHandle) NativeHandle {
    const object_ptr = acquireRenderer(renderer_handle) orelse return INVALID_HANDLE;
    return handles.getOrInsertBorrowed(.optimized_buffer, erasePtr(object_ptr.getCurrentBuffer()), renderer_handle) catch INVALID_HANDLE;
}

export fn setHyperlinksCapability(renderer_handle: NativeHandle, enabled: bool) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.terminal.caps.hyperlinks = enabled;
}

export fn clearGlobalLinkPool() void {
    link.deinitGlobalLinkPool();
}

export fn getBufferWidth(buffer_handle: NativeHandle) u32 {
    const object_ptr = acquireBuffer(buffer_handle) orelse return 0;
    return object_ptr.width;
}

export fn getBufferHeight(buffer_handle: NativeHandle) u32 {
    const object_ptr = acquireBuffer(buffer_handle) orelse return 0;
    return object_ptr.height;
}

fn packRenderResult(result: renderer.RenderResult) u64 {
    return @as(u64, result.renderOffset) | (@as(u64, @intFromEnum(result.status)) << 32);
}

fn packFailedRenderResult() u64 {
    return packRenderResult(.{ .renderOffset = 0, .status = .failed });
}

export fn render(renderer_handle: NativeHandle, force: bool) u8 {
    const object_ptr = acquireRenderer(renderer_handle) orelse return @intFromEnum(renderer.RenderStatus.failed);
    return @intFromEnum(object_ptr.render(force));
}

export fn repaintSplitFooter(
    renderer_handle: NativeHandle,
    pinnedRenderOffset: u32,
    force: bool,
) u64 {
    const object_ptr = acquireRenderer(renderer_handle) orelse return packFailedRenderResult();
    return packRenderResult(object_ptr.repaintSplitFooter(pinnedRenderOffset, force));
}

export fn commitSplitFooterSnapshot(
    renderer_handle: NativeHandle,
    snapshot_buffer_handle: NativeHandle,
    rowColumns: u32,
    startOnNewLine: bool,
    trailingNewline: bool,
    pinnedRenderOffset: u32,
    force: bool,
    beginFrame: bool,
    finalizeFrame: bool,
) u64 {
    const renderer_ptr = acquireRenderer(renderer_handle) orelse return packFailedRenderResult();
    const snapshot_ptr = acquireBuffer(snapshot_buffer_handle) orelse return packFailedRenderResult();

    // JS passes rowColumns/startOnNewLine/trailingNewline per commit from
    // writeToScrollback or captured stdout chunking. This entrypoint is the ABI
    // boundary where that metadata enters the native split append algorithm.
    // Route all commits through the batched renderer path so sync/cursor framing
    // happens exactly once per JS flush cycle.
    if (beginFrame and finalizeFrame) {
        return packRenderResult(renderer_ptr.commitSplitFooterSnapshotBatched(
            snapshot_ptr,
            rowColumns,
            startOnNewLine,
            trailingNewline,
            pinnedRenderOffset,
            force,
            true,
            true,
        ));
    }

    return packRenderResult(renderer_ptr.commitSplitFooterSnapshotBatched(
        snapshot_ptr,
        rowColumns,
        startOnNewLine,
        trailingNewline,
        pinnedRenderOffset,
        force,
        beginFrame,
        finalizeFrame,
    ));
}

export fn createOptimizedBuffer(width: u32, height: u32, respectAlpha: bool, widthMethod: u8, idPtr: ?[*]const u8, idLen: u32) NativeHandle {
    if (width == 0 or height == 0) {
        logger.warn("Invalid buffer dimensions: {}x{}", .{ width, height });
        return INVALID_HANDLE;
    }

    const pool = gp.initGlobalPool(globalArena);
    const link_pool = link.initGlobalLinkPool(globalArena);
    const wMethod: utf8.WidthMethod = if (widthMethod == 0) .wcwidth else .unicode;
    const id = sliceFromPtrLen(idPtr, idLen);

    const bufferPtr = buffer.OptimizedBuffer.init(globalAllocator, width, height, .{
        .respectAlpha = respectAlpha,
        .pool = pool,
        .width_method = wMethod,
        .id = id,
        .link_pool = link_pool,
    }) catch |err| {
        logger.err("Failed to create optimized buffer: {}", .{err});
        return INVALID_HANDLE;
    };

    return handles.insert(.optimized_buffer, erasePtr(bufferPtr)) catch {
        bufferPtr.deinit();
        return INVALID_HANDLE;
    };
}

export fn destroyOptimizedBuffer(buffer_handle: NativeHandle) void {
    const token = handles.beginDestroy(buffer_handle, .optimized_buffer, buffer.OptimizedBuffer) orelse return;
    token.ptr.deinit();
    handles.finishDestroy(token.handle);
}

export fn destroyFrameBuffer(frame_buffer_handle: NativeHandle) void {
    destroyOptimizedBuffer(frame_buffer_handle);
}

export fn drawFrameBuffer(target_handle: NativeHandle, destX: i32, destY: i32, frame_buffer_handle: NativeHandle, sourceX: u32, sourceY: u32, sourceWidth: u32, sourceHeight: u32) void {
    const target_ptr = acquireBuffer(target_handle) orelse return;
    const frame_ptr = acquireBuffer(frame_buffer_handle) orelse return;
    const srcX = if (sourceX == 0) null else sourceX;
    const srcY = if (sourceY == 0) null else sourceY;
    const srcWidth = if (sourceWidth == 0) null else sourceWidth;
    const srcHeight = if (sourceHeight == 0) null else sourceHeight;

    target_ptr.drawFrameBuffer(destX, destY, frame_ptr, srcX, srcY, srcWidth, srcHeight);
}

export fn setCursorPosition(renderer_handle: NativeHandle, x: i32, y: i32, visible: bool) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.terminal.setCursorPosition(@intCast(@max(1, x)), @intCast(@max(1, y)), visible);
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
    notifications: bool,
    explicit_cursor_positioning: bool,
    remote: bool,
    multiplexer: u8,
    term_name_ptr: [*]const u8,
    term_name_len: usize,
    term_version_ptr: [*]const u8,
    term_version_len: usize,
    term_from_xtversion: bool,
};

export fn getTerminalCapabilities(renderer_handle: NativeHandle, capsPtr: *ExternalCapabilities) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse {
        capsPtr.* = std.mem.zeroes(ExternalCapabilities);
        capsPtr.term_name_ptr = EMPTY_U8[0..].ptr;
        capsPtr.term_version_ptr = EMPTY_U8[0..].ptr;
        return;
    };
    const caps = object_ptr.getTerminalCapabilities();
    const term = &object_ptr.terminal;

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
        .notifications = caps.notifications,
        .explicit_cursor_positioning = caps.explicit_cursor_positioning,
        .remote = caps.remote,
        .multiplexer = @intFromEnum(term.multiplexer),
        .term_name_ptr = &term.term_info.name,
        .term_name_len = term.term_info.name_len,
        .term_version_ptr = &term.term_info.version,
        .term_version_len = term.term_info.version_len,
        .term_from_xtversion = term.term_info.from_xtversion,
    };
}

export fn processCapabilityResponse(renderer_handle: NativeHandle, responsePtr: ?[*]const u8, responseLen: u32) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    const response = sliceFromPtrLen(responsePtr, responseLen);
    object_ptr.processCapabilityResponse(response);
}

export fn setCursorColor(renderer_handle: NativeHandle, color: [*]const u16) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.terminal.setCursorColor(ptrToRGBA(color));
}

export fn rendererSetPaletteState(
    renderer_handle: NativeHandle,
    palettePtr: [*]const u16,
    paletteLen: u32,
    defaultFgPtr: [*]const u16,
    defaultBgPtr: [*]const u16,
    paletteEpoch: u32,
) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    if (paletteLen < 256) return;

    var palette: [256]renderer.RGBA = undefined;
    var index: usize = 0;
    while (index < palette.len) : (index += 1) {
        const base = index * 4;
        palette[index] = .{ palettePtr[base], palettePtr[base + 1], palettePtr[base + 2], palettePtr[base + 3] };
    }

    object_ptr.setPaletteState(palette[0..], ptrToRGBA(defaultFgPtr), ptrToRGBA(defaultBgPtr), paletteEpoch);
}

pub const CursorStyleOptions = extern struct {
    style: u8,
    blinking: u8,
    color: ?[*]const u16,
    cursor: u8,
};

export fn setCursorStyleOptions(renderer_handle: NativeHandle, options: *const CursorStyleOptions) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    const current = object_ptr.terminal.getCursorStyle();

    const style = if (options.style <= 3) @as(terminal.CursorStyle, @enumFromInt(options.style)) else current.style;
    const blinking = if (options.blinking <= 1) options.blinking == 1 else current.blinking;

    if (options.style <= 3 or options.blinking <= 1) {
        object_ptr.terminal.setCursorStyle(style, blinking);
    }
    if (options.color) |rgba| {
        object_ptr.terminal.setCursorColor(ptrToRGBA(rgba));
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

export fn getCursorState(renderer_handle: NativeHandle, outPtr: *ExternalCursorState) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse {
        outPtr.* = std.mem.zeroes(ExternalCursorState);
        return;
    };
    const pos = object_ptr.terminal.getCursorPosition();
    const style = object_ptr.terminal.getCursorStyle();
    const color = object_ptr.terminal.getCursorColor();

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

export fn setDebugOverlay(renderer_handle: NativeHandle, enabled: bool, corner: u8) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    const cornerEnum: renderer.DebugOverlayCorner = switch (corner) {
        0 => .topLeft,
        1 => .topRight,
        2 => .bottomLeft,
        else => .bottomRight,
    };

    object_ptr.setDebugOverlay(enabled, cornerEnum);
}

export fn clearTerminal(renderer_handle: NativeHandle) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.clearTerminal();
}

export fn setTerminalTitle(renderer_handle: NativeHandle, titlePtr: ?[*]const u8, titleLen: u32) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    const title = sliceFromPtrLen(titlePtr, titleLen);
    object_ptr.setTerminalTitle(title);
}

export fn copyToClipboardOSC52(renderer_handle: NativeHandle, target: u8, payloadPtr: ?[*]const u8, payloadLen: u32) bool {
    const object_ptr = acquireRenderer(renderer_handle) orelse return false;
    const targetEnum = std.meta.intToEnum(terminal.ClipboardTarget, target) catch .clipboard;
    const payload = sliceFromPtrLen(payloadPtr, payloadLen);
    return object_ptr.copyToClipboardOSC52(targetEnum, payload);
}

export fn clearClipboardOSC52(renderer_handle: NativeHandle, target: u8) bool {
    const object_ptr = acquireRenderer(renderer_handle) orelse return false;
    const targetEnum = std.meta.intToEnum(terminal.ClipboardTarget, target) catch .clipboard;
    return object_ptr.clearClipboardOSC52(targetEnum);
}

export fn triggerNotification(renderer_handle: NativeHandle, messagePtr: [*]const u8, messageLen: u32, titlePtr: ?[*]const u8, titleLen: u32) bool {
    const object_ptr = acquireRenderer(renderer_handle) orelse return false;
    const message = messagePtr[0..@as(usize, messageLen)];
    const title = if (titlePtr) |ptr| ptr[0..@as(usize, titleLen)] else null;
    return object_ptr.triggerNotification(message, title);
}

// Buffer functions
export fn bufferClear(buffer_handle: NativeHandle, bg: [*]const u16) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.clear(ptrToRGBA(bg), null);
}

export fn bufferGetCharPtr(buffer_handle: NativeHandle) ?[*]u32 {
    const object_ptr = acquireBuffer(buffer_handle) orelse return null;
    return object_ptr.getCharPtr();
}

export fn bufferGetFgPtr(buffer_handle: NativeHandle) ?[*]RGBA {
    const object_ptr = acquireBuffer(buffer_handle) orelse return null;
    return object_ptr.getFgPtr();
}

export fn bufferGetBgPtr(buffer_handle: NativeHandle) ?[*]RGBA {
    const object_ptr = acquireBuffer(buffer_handle) orelse return null;
    return object_ptr.getBgPtr();
}

export fn bufferGetAttributesPtr(buffer_handle: NativeHandle) ?[*]u32 {
    const object_ptr = acquireBuffer(buffer_handle) orelse return null;
    return object_ptr.getAttributesPtr();
}

export fn bufferGetRespectAlpha(buffer_handle: NativeHandle) bool {
    const object_ptr = acquireBuffer(buffer_handle) orelse return false;
    return object_ptr.getRespectAlpha();
}

export fn bufferSetRespectAlpha(buffer_handle: NativeHandle, respectAlpha: bool) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.setRespectAlpha(respectAlpha);
}

export fn bufferGetId(buffer_handle: NativeHandle, outPtr: ?[*]u8, maxLen: u32) u32 {
    const object_ptr = acquireBuffer(buffer_handle) orelse return 0;
    if (maxLen == 0) return 0;

    const out = outPtr orelse return 0;
    const id = object_ptr.getId();
    const copyLen = @min(id.len, @as(usize, maxLen));
    @memcpy(out[0..copyLen], id[0..copyLen]);
    return @intCast(copyLen);
}

export fn bufferGetRealCharSize(buffer_handle: NativeHandle) u32 {
    const object_ptr = acquireBuffer(buffer_handle) orelse return 0;
    return object_ptr.getRealCharSize();
}

export fn bufferWriteResolvedChars(buffer_handle: NativeHandle, outputPtr: ?[*]u8, outputLen: u32, addLineBreaks: bool) u32 {
    const object_ptr = acquireBuffer(buffer_handle) orelse return 0;
    if (outputLen == 0) return 0;

    const output = outputPtr orelse return 0;
    const output_slice = output[0..@as(usize, outputLen)];
    return object_ptr.writeResolvedChars(output_slice, addLineBreaks) catch 0;
}

export fn bufferDrawText(buffer_handle: NativeHandle, text: ?[*]const u8, textLen: u32, x: u32, y: u32, fg: [*]const u16, bg: ?[*]const u16, attributes: u32) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.drawText(
        sliceFromPtrLen(text, textLen),
        x,
        y,
        ptrToRGBA(fg),
        optionalPtrToRGBA(bg),
        attributes,
    ) catch {};
}

export fn bufferSetCellWithAlphaBlending(buffer_handle: NativeHandle, x: u32, y: u32, char: u32, fg: [*]const u16, bg: [*]const u16, attributes: u32) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.setCellWithAlphaBlending(x, y, char, ptrToRGBA(fg), ptrToRGBA(bg), attributes);
}

export fn bufferSetCell(buffer_handle: NativeHandle, x: u32, y: u32, char: u32, fg: [*]const u16, bg: [*]const u16, attributes: u32) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.set(x, y, .{
        .char = char,
        .fg = ptrToRGBA(fg),
        .bg = ptrToRGBA(bg),
        .attributes = attributes,
    });
}

export fn bufferFillRect(buffer_handle: NativeHandle, x: u32, y: u32, width: u32, height: u32, bg: [*]const u16) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.fillRect(x, y, width, height, ptrToRGBA(bg));
}

export fn bufferColorMatrix(buffer_handle: NativeHandle, matrixPtr: [*]const f32, cellMaskPtr: [*]const f32, cellMaskCount: u32, strength: f32, target: u8) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    if (cellMaskCount == 0) return;
    const matrix = matrixPtr[0..16];
    const len = @as(usize, cellMaskCount) * 3;
    const cellMask = cellMaskPtr[0..len];
    const targetEnum: buffer_effects.ColorTarget = @enumFromInt(target);
    buffer_effects.colorMatrix(object_ptr, matrix, cellMask, strength, targetEnum);
}

export fn bufferColorMatrixUniform(buffer_handle: NativeHandle, matrixPtr: [*]const f32, strength: f32, target: u8) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    const matrix = matrixPtr[0..16];
    const targetEnum: buffer_effects.ColorTarget = @enumFromInt(target);
    buffer_effects.colorMatrixUniform(object_ptr, matrix, strength, targetEnum);
}

export fn bufferDrawPackedBuffer(buffer_handle: NativeHandle, data: [*]const u8, dataLen: u32, posX: u32, posY: u32, terminalWidthCells: u32, terminalHeightCells: u32) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.drawPackedBuffer(data, dataLen, posX, posY, terminalWidthCells, terminalHeightCells);
}

export fn bufferDrawGrayscaleBuffer(buffer_handle: NativeHandle, posX: i32, posY: i32, intensities: [*]const f32, srcWidth: u32, srcHeight: u32, fg: ?[*]const u16, bg: ?[*]const u16) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.drawGrayscaleBuffer(
        posX,
        posY,
        intensities,
        srcWidth,
        srcHeight,
        optionalPtrToRGBA(fg),
        optionalPtrToRGBA(bg),
    );
}

export fn bufferDrawGrayscaleBufferSupersampled(buffer_handle: NativeHandle, posX: i32, posY: i32, intensities: [*]const f32, srcWidth: u32, srcHeight: u32, fg: ?[*]const u16, bg: ?[*]const u16) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.drawGrayscaleBufferSupersampled(
        posX,
        posY,
        intensities,
        srcWidth,
        srcHeight,
        optionalPtrToRGBA(fg),
        optionalPtrToRGBA(bg),
    );
}

export fn bufferPushScissorRect(buffer_handle: NativeHandle, x: i32, y: i32, width: u32, height: u32) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.pushScissorRect(x, y, width, height) catch {};
}

export fn bufferPopScissorRect(buffer_handle: NativeHandle) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.popScissorRect();
}

export fn bufferClearScissorRects(buffer_handle: NativeHandle) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.clearScissorRects();
}

// Opacity stack functions
export fn bufferPushOpacity(buffer_handle: NativeHandle, opacity: f32) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.pushOpacity(opacity) catch {};
}

export fn bufferPopOpacity(buffer_handle: NativeHandle) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.popOpacity();
}

export fn bufferGetCurrentOpacity(buffer_handle: NativeHandle) f32 {
    const object_ptr = acquireBuffer(buffer_handle) orelse return 1;
    return object_ptr.getCurrentOpacity();
}

export fn bufferClearOpacity(buffer_handle: NativeHandle) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.clearOpacity();
}

export fn bufferDrawSuperSampleBuffer(buffer_handle: NativeHandle, x: u32, y: u32, pixelData: [*]const u8, len: u32, format: u8, alignedBytesPerRow: u32) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.drawSuperSampleBuffer(x, y, pixelData, len, format, alignedBytesPerRow);
}

export fn linkAlloc(urlPtr: ?[*]const u8, urlLen: u32) u32 {
    const url = sliceFromPtrLen(urlPtr, urlLen);
    const link_pool = link.initGlobalLinkPool(globalArena);
    return link_pool.alloc(url) catch 0;
}

export fn linkGetUrl(id: u32, outPtr: ?[*]u8, maxLen: u32) u32 {
    if (maxLen == 0) return 0;

    const out = outPtr orelse return 0;
    const link_pool = link.initGlobalLinkPool(globalArena);
    const url_bytes = link_pool.get(id) catch return 0;
    const copyLen = @min(url_bytes.len, @as(usize, maxLen));
    @memcpy(out[0..copyLen], url_bytes[0..copyLen]);
    return @intCast(copyLen);
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
    buffer_handle: NativeHandle,
    borderChars: [*]const u32,
    borderFg: [*]const u16,
    borderBg: [*]const u16,
    columnOffsets: [*]const i32,
    columnCount: u32,
    rowOffsets: [*]const i32,
    rowCount: u32,
    options: *const ExternalGridDrawOptions,
) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.drawGrid(
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
    buffer_handle: NativeHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    borderChars: [*]const u32,
    packedOptions: u32,
    borderColor: [*]const u16,
    backgroundColor: [*]const u16,
    titleColor: [*]const u16,
    title: ?[*]const u8,
    titleLen: u32,
    bottomTitle: ?[*]const u8,
    bottomTitleLen: u32,
) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
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

    object_ptr.drawBox(
        x,
        y,
        width,
        height,
        borderChars,
        borderSides,
        ptrToRGBA(borderColor),
        ptrToRGBA(backgroundColor),
        ptrToRGBA(titleColor),
        shouldFill,
        titleSlice,
        titleAlignment,
        bottomTitleSlice,
        bottomTitleAlignment,
    ) catch {};
}

export fn bufferResize(buffer_handle: NativeHandle, width: u32, height: u32) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.resize(width, height) catch {};
}

export fn resizeRenderer(renderer_handle: NativeHandle, width: u32, height: u32) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.resize(width, height) catch {};
}

export fn addToHitGrid(renderer_handle: NativeHandle, x: i32, y: i32, width: u32, height: u32, id: u32) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.addToHitGrid(x, y, width, height, id);
}

export fn clearCurrentHitGrid(renderer_handle: NativeHandle) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.clearCurrentHitGrid();
}

export fn hitGridPushScissorRect(renderer_handle: NativeHandle, x: i32, y: i32, width: u32, height: u32) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.hitGridPushScissorRect(x, y, width, height);
}

export fn hitGridPopScissorRect(renderer_handle: NativeHandle) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.hitGridPopScissorRect();
}

export fn hitGridClearScissorRects(renderer_handle: NativeHandle) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.hitGridClearScissorRects();
}

export fn addToCurrentHitGridClipped(renderer_handle: NativeHandle, x: i32, y: i32, width: u32, height: u32, id: u32) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.addToCurrentHitGridClipped(x, y, width, height, id);
}

export fn checkHit(renderer_handle: NativeHandle, x: u32, y: u32) u32 {
    const object_ptr = acquireRenderer(renderer_handle) orelse return 0;
    return object_ptr.checkHit(x, y);
}

export fn getHitGridDirty(renderer_handle: NativeHandle) bool {
    const object_ptr = acquireRenderer(renderer_handle) orelse return false;
    return object_ptr.getHitGridDirty();
}

export fn dumpHitGrid(renderer_handle: NativeHandle) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.dumpHitGrid();
}

export fn dumpBuffers(renderer_handle: NativeHandle, timestamp: i64) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.dumpBuffers(timestamp);
}

export fn dumpOutputBuffer(renderer_handle: NativeHandle, timestamp: i64) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.dumpOutputBuffer(timestamp);
}

export fn restoreTerminalModes(renderer_handle: NativeHandle) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.restoreTerminalModes();
}

export fn enableMouse(renderer_handle: NativeHandle, enableMovement: bool) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.enableMouse(enableMovement);
}

export fn disableMouse(renderer_handle: NativeHandle) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.disableMouse();
}

export fn queryPixelResolution(renderer_handle: NativeHandle) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.queryPixelResolution();
}

export fn queryThemeColors(renderer_handle: NativeHandle) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.queryThemeColors();
}

export fn enableKittyKeyboard(renderer_handle: NativeHandle, flags: u8) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.enableKittyKeyboard(flags);
}

export fn disableKittyKeyboard(renderer_handle: NativeHandle) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.disableKittyKeyboard();
}

export fn setKittyKeyboardFlags(renderer_handle: NativeHandle, flags: u8) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.setKittyKeyboardFlags(flags);
}

export fn getKittyKeyboardFlags(renderer_handle: NativeHandle) u8 {
    const object_ptr = acquireRenderer(renderer_handle) orelse return 0;
    return object_ptr.getKittyKeyboardFlags();
}

export fn setupTerminal(renderer_handle: NativeHandle, useAlternateScreen: bool) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.setupTerminal(useAlternateScreen);
}

export fn suspendRenderer(renderer_handle: NativeHandle) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.suspendRenderer();
}

export fn resumeRenderer(renderer_handle: NativeHandle) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    object_ptr.resumeRenderer();
}

export fn writeOut(renderer_handle: NativeHandle, dataPtr: ?[*]const u8, dataLen: u32) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    const data = sliceFromPtrLen(dataPtr, dataLen);
    if (data.len == 0) return;
    object_ptr.writeOut(data);
}

fn destroyTextBufferViewHandle(view_handle: NativeHandle) void {
    const token = handles.beginDestroy(view_handle, .text_buffer_view, text_buffer_view.UnifiedTextBufferView) orelse return;
    token.ptr.deinit();
    handles.finishDestroy(token.handle);
}

fn destroyTextBufferViewChildren(owner: NativeHandle) void {
    while (handles.findChild(owner, .text_buffer_view)) |view_handle| {
        destroyTextBufferViewHandle(view_handle);
    }
}

export fn createTextBuffer(widthMethod: u8) NativeHandle {
    const pool = gp.initGlobalPool(globalArena);
    const link_pool = link.initGlobalLinkPool(globalArena);
    const wMethod: utf8.WidthMethod = if (widthMethod == 0) .wcwidth else .unicode;

    const tb = text_buffer.UnifiedTextBuffer.init(globalAllocator, pool, link_pool, wMethod) catch {
        return INVALID_HANDLE;
    };
    return handles.insert(.text_buffer, erasePtr(tb)) catch {
        tb.deinit();
        return INVALID_HANDLE;
    };
}

export fn destroyTextBuffer(tb_handle: NativeHandle) void {
    const token = handles.beginDestroy(tb_handle, .text_buffer, text_buffer.UnifiedTextBuffer) orelse return;
    destroyTextBufferViewChildren(token.handle);
    token.ptr.deinit();
    handles.finishDestroy(token.handle);
}

export fn textBufferGetLength(tb_handle: NativeHandle) u32 {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return 0;
    return object_ptr.getLength();
}

export fn textBufferGetByteSize(tb_handle: NativeHandle) u32 {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return 0;
    return object_ptr.getByteSize();
}

export fn textBufferReset(tb_handle: NativeHandle) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    object_ptr.reset();
}

export fn textBufferClear(tb_handle: NativeHandle) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    object_ptr.clear();
}

export fn textBufferSetDefaultFg(tb_handle: NativeHandle, fg: ?[*]const u16) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    object_ptr.setDefaultFg(optionalPtrToRGBA(fg));
}

export fn textBufferSetDefaultBg(tb_handle: NativeHandle, bg: ?[*]const u16) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    object_ptr.setDefaultBg(optionalPtrToRGBA(bg));
}

export fn textBufferSetDefaultAttributes(tb_handle: NativeHandle, attr: ?[*]const u32) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    const attributes = if (attr) |a| a[0] else null;
    object_ptr.setDefaultAttributes(attributes);
}

export fn textBufferResetDefaults(tb_handle: NativeHandle) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    object_ptr.resetDefaults();
}

export fn textBufferGetTabWidth(tb_handle: NativeHandle) u8 {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return 0;
    return object_ptr.tabWidth();
}

export fn textBufferSetTabWidth(tb_handle: NativeHandle, width: u8) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    object_ptr.setTabWidth(width);
}

export fn textBufferRegisterMemBuffer(tb_handle: NativeHandle, dataPtr: ?[*]const u8, dataLen: u32, owned: bool) u16 {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return 0xFFFF;
    const data = sliceFromPtrLen(dataPtr, dataLen);
    const mem_id = object_ptr.registerMemBuffer(data, owned) catch return 0xFFFF;
    return @intCast(mem_id);
}

export fn textBufferReplaceMemBuffer(tb_handle: NativeHandle, id: u8, dataPtr: ?[*]const u8, dataLen: u32, owned: bool) bool {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return false;
    const data = sliceFromPtrLen(dataPtr, dataLen);
    object_ptr.replaceMemBuffer(id, data, owned) catch return false;
    return true;
}

export fn textBufferClearMemRegistry(tb_handle: NativeHandle) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    object_ptr.clearMemRegistry();
}

export fn textBufferSetTextFromMem(tb_handle: NativeHandle, id: u8) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    object_ptr.setTextFromMemId(id) catch {};
}

export fn textBufferAppend(tb_handle: NativeHandle, dataPtr: ?[*]const u8, dataLen: u32) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    const data = sliceFromPtrLen(dataPtr, dataLen);
    object_ptr.append(data) catch {};
}

export fn textBufferAppendFromMemId(tb_handle: NativeHandle, id: u8) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    object_ptr.appendFromMemId(id) catch {};
}

export fn textBufferLoadFile(tb_handle: NativeHandle, pathPtr: ?[*]const u8, pathLen: u32) bool {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return false;
    const path = sliceFromPtrLen(pathPtr, pathLen);
    object_ptr.loadFile(path) catch return false;
    return true;
}

export fn textBufferSetStyledText(
    tb_handle: NativeHandle,
    chunksPtr: ?[*]const text_buffer.StyledChunk,
    chunkCount: u32,
) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    if (chunkCount == 0) return;
    const chunks = chunksPtr.?[0..@as(usize, chunkCount)];
    object_ptr.setStyledText(chunks) catch {};
}

export fn textBufferGetLineCount(tb_handle: NativeHandle) u32 {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return 0;
    return object_ptr.getLineCount();
}

export fn textBufferGetPlainText(tb_handle: NativeHandle, outPtr: ?[*]u8, maxLen: u32) u32 {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return 0;
    if (maxLen == 0) return 0;

    const out = outPtr orelse return 0;
    const outBuffer = out[0..@as(usize, maxLen)];
    return @intCast(object_ptr.getPlainTextIntoBuffer(outBuffer));
}

// TextBufferView functions (Array-based for backward compatibility)
export fn createTextBufferView(tb_handle: NativeHandle) NativeHandle {
    if (!handles.isOwned(tb_handle, .text_buffer)) return INVALID_HANDLE;

    const object_ptr = acquireTextBuffer(tb_handle) orelse return INVALID_HANDLE;
    const view = text_buffer_view.UnifiedTextBufferView.init(globalAllocator, object_ptr) catch {
        return INVALID_HANDLE;
    };
    return handles.insertOwnedChild(.text_buffer_view, erasePtr(view), tb_handle) catch {
        view.deinit();
        return INVALID_HANDLE;
    };
}

export fn destroyTextBufferView(view_handle: NativeHandle) void {
    destroyTextBufferViewHandle(view_handle);
}

export fn textBufferViewSetSelection(view_handle: NativeHandle, start: u32, end: u32, bgColor: ?[*]const u16, fgColor: ?[*]const u16) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse return;
    object_ptr.setSelectionStyle(start, end, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
}

export fn textBufferViewResetSelection(view_handle: NativeHandle) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse return;
    object_ptr.resetSelection();
}

export fn textBufferViewGetSelectionInfo(view_handle: NativeHandle) u64 {
    const object_ptr = acquireTextBufferView(view_handle) orelse return std.math.maxInt(u64);
    return object_ptr.packSelectionInfo();
}

export fn textBufferViewSetLocalSelection(view_handle: NativeHandle, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?[*]const u16, fgColor: ?[*]const u16) bool {
    const object_ptr = acquireTextBufferView(view_handle) orelse return false;
    return object_ptr.setLocalSelectionStyle(anchorX, anchorY, focusX, focusY, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
}

export fn textBufferViewUpdateSelection(view_handle: NativeHandle, end: u32, bgColor: ?[*]const u16, fgColor: ?[*]const u16) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse return;
    object_ptr.updateSelectionStyle(end, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
}

export fn textBufferViewUpdateLocalSelection(view_handle: NativeHandle, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?[*]const u16, fgColor: ?[*]const u16) bool {
    const object_ptr = acquireTextBufferView(view_handle) orelse return false;
    return object_ptr.updateLocalSelectionStyle(anchorX, anchorY, focusX, focusY, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
}

export fn textBufferViewResetLocalSelection(view_handle: NativeHandle) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse return;
    object_ptr.resetLocalSelection();
}

export fn textBufferViewSetWrapWidth(view_handle: NativeHandle, width: u32) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse return;
    object_ptr.setWrapWidth(if (width == 0) null else width);
}

export fn textBufferViewSetWrapMode(view_handle: NativeHandle, mode: u8) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse return;
    const wrapMode: text_buffer.WrapMode = switch (mode) {
        0 => .none,
        1 => .char,
        2 => .word,
        else => .none,
    };
    object_ptr.setWrapMode(wrapMode);
}

export fn textBufferViewSetFirstLineOffset(view_handle: NativeHandle, offset: u32) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse return;
    object_ptr.setFirstLineOffset(offset);
}

export fn textBufferViewSetViewportSize(view_handle: NativeHandle, width: u32, height: u32) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse return;
    object_ptr.setViewportSize(width, height);
}

export fn textBufferViewSetViewport(view_handle: NativeHandle, x: u32, y: u32, width: u32, height: u32) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse return;
    object_ptr.setViewport(.{
        .x = x,
        .y = y,
        .width = width,
        .height = height,
    });
}

export fn textBufferViewGetVirtualLineCount(view_handle: NativeHandle) u32 {
    const object_ptr = acquireTextBufferView(view_handle) orelse return 0;
    return object_ptr.getVirtualLineCount();
}

export fn textBufferViewGetLineInfoDirect(view_handle: NativeHandle, outPtr: *ExternalLineInfo) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse {
        emptyLineInfo(outPtr);
        return;
    };
    const line_info = object_ptr.getCachedLineInfo();

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

export fn textBufferViewGetLogicalLineInfoDirect(view_handle: NativeHandle, outPtr: *ExternalLineInfo) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse {
        emptyLineInfo(outPtr);
        return;
    };
    const line_info = object_ptr.getLogicalLineInfo();

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

export fn textBufferViewGetSelectedText(view_handle: NativeHandle, outPtr: ?[*]u8, maxLen: u32) u32 {
    const object_ptr = acquireTextBufferView(view_handle) orelse return 0;
    if (maxLen == 0) return 0;

    const out = outPtr orelse return 0;
    const outBuffer = out[0..@as(usize, maxLen)];
    return @intCast(object_ptr.getSelectedTextIntoBuffer(outBuffer));
}

export fn textBufferViewGetPlainText(view_handle: NativeHandle, outPtr: ?[*]u8, maxLen: u32) u32 {
    const object_ptr = acquireTextBufferView(view_handle) orelse return 0;
    if (maxLen == 0) return 0;

    const out = outPtr orelse return 0;
    const outBuffer = out[0..@as(usize, maxLen)];
    return @intCast(object_ptr.getPlainTextIntoBuffer(outBuffer));
}

export fn textBufferViewSetTabIndicator(view_handle: NativeHandle, indicator: u32) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse return;
    object_ptr.setTabIndicator(indicator);
}

export fn textBufferViewSetTabIndicatorColor(view_handle: NativeHandle, color: [*]const u16) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse return;
    object_ptr.setTabIndicatorColor(ptrToRGBA(color));
}

export fn textBufferViewSetTruncate(view_handle: NativeHandle, truncate: bool) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse return;
    object_ptr.setTruncate(truncate);
}

pub const ExternalMeasureResult = extern struct {
    line_count: u32,
    width_cols_max: u32,
};

export fn textBufferViewMeasureForDimensions(view_handle: NativeHandle, width: u32, height: u32, outPtr: *ExternalMeasureResult) bool {
    const object_ptr = acquireTextBufferView(view_handle) orelse {
        outPtr.* = std.mem.zeroes(ExternalMeasureResult);
        return false;
    };
    const result = object_ptr.measureForDimensions(width, height) catch return false;
    outPtr.* = .{
        .line_count = result.line_count,
        .width_cols_max = result.width_cols_max,
    };
    return true;
}

// ===== EditBuffer Exports =====

fn destroyEditorViewHandle(view_handle: NativeHandle) void {
    const token = handles.beginDestroy(view_handle, .editor_view, editor_view.EditorView) orelse return;
    handles.invalidateChildren(token.handle);
    token.ptr.deinit();
    handles.finishDestroy(token.handle);
}

fn destroyEditorViewChildren(owner: NativeHandle) void {
    while (handles.findChild(owner, .editor_view)) |view_handle| {
        destroyEditorViewHandle(view_handle);
    }
}

export fn createEditBuffer(widthMethod: u8, event_sink_handle: NativeHandle) NativeHandle {
    const pool = gp.initGlobalPool(globalArena);
    const link_pool = link.initGlobalLinkPool(globalArena);
    const wMethod: utf8.WidthMethod = if (widthMethod == 0) .wcwidth else .unicode;
    const event_sink_ptr = if (event_sink_handle == INVALID_HANDLE) null else acquireEventSink(event_sink_handle);
    const event_sink = if (event_sink_ptr) |object_ptr| object_ptr else null;

    const edit_buffer = edit_buffer_mod.EditBuffer.init(
        globalAllocator,
        pool,
        link_pool,
        wMethod,
        event_sink,
    ) catch return INVALID_HANDLE;

    const edit_handle = handles.insert(.edit_buffer, erasePtr(edit_buffer)) catch {
        edit_buffer.deinit();
        return INVALID_HANDLE;
    };
    _ = handles.getOrInsertBorrowed(.text_buffer, erasePtr(edit_buffer.getTextBuffer()), edit_handle) catch {
        if (handles.beginDestroy(edit_handle, .edit_buffer, edit_buffer_mod.EditBuffer)) |token| {
            token.ptr.deinit();
            handles.finishDestroy(token.handle);
        }
        return INVALID_HANDLE;
    };
    return edit_handle;
}

export fn destroyEditBuffer(edit_handle: NativeHandle) void {
    const token = handles.beginDestroy(edit_handle, .edit_buffer, edit_buffer_mod.EditBuffer) orelse return;
    destroyEditorViewChildren(token.handle);
    handles.invalidateChildren(token.handle);
    token.ptr.deinit();
    handles.finishDestroy(token.handle);
}

export fn editBufferGetTextBuffer(edit_handle: NativeHandle) NativeHandle {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return INVALID_HANDLE;
    return handles.getOrInsertBorrowed(.text_buffer, erasePtr(object_ptr.getTextBuffer()), edit_handle) catch INVALID_HANDLE;
}

export fn editBufferInsertText(edit_handle: NativeHandle, textPtr: ?[*]const u8, textLen: u32) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    const text = sliceFromPtrLen(textPtr, textLen);
    object_ptr.insertText(text) catch {};
}

export fn editBufferDeleteRange(edit_handle: NativeHandle, start_row: u32, start_col: u32, end_row: u32, end_col: u32) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    const start: edit_buffer_mod.Cursor = .{ .row = start_row, .col = start_col };
    const end: edit_buffer_mod.Cursor = .{ .row = end_row, .col = end_col };
    object_ptr.deleteRange(start, end) catch {};
}

export fn editBufferDeleteCharBackward(edit_handle: NativeHandle) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.backspace() catch {};
}

export fn editBufferDeleteChar(edit_handle: NativeHandle) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.deleteForward() catch {};
}

export fn editBufferMoveCursorLeft(edit_handle: NativeHandle) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.moveLeft();
}

export fn editBufferMoveCursorRight(edit_handle: NativeHandle) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.moveRight();
}

export fn editBufferMoveCursorUp(edit_handle: NativeHandle) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.moveUp();
}

export fn editBufferMoveCursorDown(edit_handle: NativeHandle) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.moveDown();
}

export fn editBufferGetCursor(edit_handle: NativeHandle, outRow: *u32, outCol: *u32) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse {
        outRow.* = 0;
        outCol.* = 0;
        return;
    };
    const cursor = object_ptr.getPrimaryCursor();
    outRow.* = cursor.row;
    outCol.* = cursor.col;
}

export fn editBufferSetCursor(edit_handle: NativeHandle, row: u32, col: u32) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.setCursor(row, col) catch {};
}

export fn editBufferSetCursorToLineCol(edit_handle: NativeHandle, row: u32, col: u32) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.setCursor(row, col) catch {};
}

export fn editBufferSetCursorByOffset(edit_handle: NativeHandle, offset: u32) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.setCursorByOffset(offset) catch {};
}

export fn editBufferGetNextWordBoundary(edit_handle: NativeHandle, outPtr: *ExternalLogicalCursor) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse {
        outPtr.* = std.mem.zeroes(ExternalLogicalCursor);
        return;
    };
    const cursor = object_ptr.getNextWordBoundary();
    outPtr.* = .{
        .row = cursor.row,
        .col = cursor.col,
        .offset = cursor.offset,
    };
}

export fn editBufferGetPrevWordBoundary(edit_handle: NativeHandle, outPtr: *ExternalLogicalCursor) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse {
        outPtr.* = std.mem.zeroes(ExternalLogicalCursor);
        return;
    };
    const cursor = object_ptr.getPrevWordBoundary();
    outPtr.* = .{
        .row = cursor.row,
        .col = cursor.col,
        .offset = cursor.offset,
    };
}

export fn editBufferGetEOL(edit_handle: NativeHandle, outPtr: *ExternalLogicalCursor) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse {
        outPtr.* = std.mem.zeroes(ExternalLogicalCursor);
        return;
    };
    const cursor = object_ptr.getEOL();
    outPtr.* = .{
        .row = cursor.row,
        .col = cursor.col,
        .offset = cursor.offset,
    };
}

export fn editBufferOffsetToPosition(edit_handle: NativeHandle, offset: u32, outPtr: *ExternalLogicalCursor) bool {
    const object_ptr = acquireEditBuffer(edit_handle) orelse {
        outPtr.* = std.mem.zeroes(ExternalLogicalCursor);
        return false;
    };
    const coords = text_buffer_iterators.offsetToCoords(object_ptr.tb.rope(), offset) orelse return false;
    outPtr.* = .{
        .row = coords.row,
        .col = coords.col,
        .offset = offset,
    };
    return true;
}

export fn editBufferPositionToOffset(edit_handle: NativeHandle, row: u32, col: u32) u32 {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return 0;
    return text_buffer_iterators.coordsToOffset(object_ptr.tb.rope(), row, col) orelse 0;
}

export fn editBufferGetLineStartOffset(edit_handle: NativeHandle, row: u32) u32 {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return 0;
    return text_buffer_iterators.coordsToOffset(object_ptr.tb.rope(), row, 0) orelse 0;
}

export fn editBufferGetTextRange(edit_handle: NativeHandle, start_offset: u32, end_offset: u32, outPtr: ?[*]u8, maxLen: u32) u32 {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return 0;
    if (maxLen == 0) return 0;

    const out = outPtr orelse return 0;
    const outBuffer = out[0..@as(usize, maxLen)];
    return @intCast(object_ptr.getTextRange(start_offset, end_offset, outBuffer) catch 0);
}

export fn editBufferGetTextRangeByCoords(edit_handle: NativeHandle, start_row: u32, start_col: u32, end_row: u32, end_col: u32, outPtr: ?[*]u8, maxLen: u32) u32 {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return 0;
    if (maxLen == 0) return 0;

    const out = outPtr orelse return 0;
    const outBuffer = out[0..@as(usize, maxLen)];
    return @intCast(object_ptr.getTextRangeByCoords(start_row, start_col, end_row, end_col, outBuffer));
}

export fn editBufferSetText(edit_handle: NativeHandle, textPtr: ?[*]const u8, textLen: u32) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    const text = sliceFromPtrLen(textPtr, textLen);
    object_ptr.setText(text) catch {};
}

export fn editBufferSetTextFromMem(edit_handle: NativeHandle, mem_id: u8) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.setTextFromMemId(mem_id) catch {};
}

export fn editBufferReplaceText(edit_handle: NativeHandle, textPtr: ?[*]const u8, textLen: u32) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    const text = sliceFromPtrLen(textPtr, textLen);
    object_ptr.replaceText(text) catch {};
}

export fn editBufferReplaceTextFromMem(edit_handle: NativeHandle, mem_id: u8) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.replaceTextFromMemId(mem_id) catch {};
}

export fn editBufferGetText(edit_handle: NativeHandle, outPtr: ?[*]u8, maxLen: u32) u32 {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return 0;
    if (maxLen == 0) return 0;

    const out = outPtr orelse return 0;
    const outBuffer = out[0..@as(usize, maxLen)];
    return @intCast(object_ptr.getText(outBuffer));
}

export fn editBufferInsertChar(edit_handle: NativeHandle, charPtr: ?[*]const u8, charLen: u32) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    const text = sliceFromPtrLen(charPtr, charLen);
    object_ptr.insertText(text) catch {};
}

export fn editBufferNewLine(edit_handle: NativeHandle) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.insertText("\n") catch {};
}

export fn editBufferDeleteLine(edit_handle: NativeHandle) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.deleteLine() catch {};
}

export fn editBufferGotoLine(edit_handle: NativeHandle, line: u32) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.gotoLine(line) catch {};
}

export fn editBufferGetCursorPosition(edit_handle: NativeHandle, outPtr: *ExternalLogicalCursor) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse {
        outPtr.* = std.mem.zeroes(ExternalLogicalCursor);
        return;
    };
    const pos = object_ptr.getCursorPosition();
    outPtr.* = .{
        .row = pos.line,
        .col = pos.visual_col,
        .offset = pos.offset,
    };
}

export fn editBufferGetId(edit_handle: NativeHandle) u16 {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return 0;
    return object_ptr.getId();
}

export fn editBufferDebugLogRope(edit_handle: NativeHandle) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.debugLogRope();
}

export fn editBufferUndo(edit_handle: NativeHandle, outPtr: ?[*]u8, maxLen: u32) u32 {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return 0;
    if (maxLen == 0) return 0;

    const out = outPtr orelse return 0;
    const prev_meta = object_ptr.undo() catch return 0;
    const copyLen = @min(prev_meta.len, @as(usize, maxLen));
    @memcpy(out[0..copyLen], prev_meta[0..copyLen]);
    return @intCast(copyLen);
}

export fn editBufferRedo(edit_handle: NativeHandle, outPtr: ?[*]u8, maxLen: u32) u32 {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return 0;
    if (maxLen == 0) return 0;

    const out = outPtr orelse return 0;
    const next_meta = object_ptr.redo() catch return 0;
    const copyLen = @min(next_meta.len, @as(usize, maxLen));
    @memcpy(out[0..copyLen], next_meta[0..copyLen]);
    return @intCast(copyLen);
}

export fn editBufferCanUndo(edit_handle: NativeHandle) bool {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return false;
    return object_ptr.canUndo();
}

export fn editBufferCanRedo(edit_handle: NativeHandle) bool {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return false;
    return object_ptr.canRedo();
}

export fn editBufferClearHistory(edit_handle: NativeHandle) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.clearHistory();
}

export fn editBufferClear(edit_handle: NativeHandle) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.clear() catch {};
}

// ===== EditorView Exports =====

export fn createEditorView(edit_handle: NativeHandle, viewport_width: u32, viewport_height: u32) NativeHandle {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return INVALID_HANDLE;
    const view = editor_view.EditorView.init(globalArena, object_ptr, viewport_width, viewport_height) catch return INVALID_HANDLE;
    const view_handle = handles.insertOwnedChild(.editor_view, erasePtr(view), edit_handle) catch {
        view.deinit();
        return INVALID_HANDLE;
    };
    _ = handles.getOrInsertBorrowed(.text_buffer_view, erasePtr(view.getTextBufferView()), view_handle) catch {
        if (handles.beginDestroy(view_handle, .editor_view, editor_view.EditorView)) |token| {
            token.ptr.deinit();
            handles.finishDestroy(token.handle);
        }
        return INVALID_HANDLE;
    };
    return view_handle;
}

export fn destroyEditorView(view_handle: NativeHandle) void {
    destroyEditorViewHandle(view_handle);
}

export fn editorViewSetViewport(view_handle: NativeHandle, x: u32, y: u32, width: u32, height: u32, moveCursor: bool) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.setViewport(.{ .x = x, .y = y, .width = width, .height = height }, moveCursor);
}

export fn editorViewClearViewport(view_handle: NativeHandle) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.setViewport(null, false);
}

export fn editorViewGetViewport(view_handle: NativeHandle, outX: *u32, outY: *u32, outWidth: *u32, outHeight: *u32) bool {
    const object_ptr = acquireEditorView(view_handle) orelse {
        outX.* = 0;
        outY.* = 0;
        outWidth.* = 0;
        outHeight.* = 0;
        return false;
    };
    if (object_ptr.getViewport()) |vp| {
        outX.* = vp.x;
        outY.* = vp.y;
        outWidth.* = vp.width;
        outHeight.* = vp.height;
        return true;
    }
    return false;
}

export fn editorViewSetScrollMargin(view_handle: NativeHandle, margin: f32) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.setScrollMargin(margin);
}

export fn editorViewGetVirtualLineCount(view_handle: NativeHandle) u32 {
    const object_ptr = acquireEditorView(view_handle) orelse return 0;
    // TODO: There is a getter for that directly, no?
    return @intCast(object_ptr.getVirtualLines().len);
}

export fn editorViewGetTotalVirtualLineCount(view_handle: NativeHandle) u32 {
    const object_ptr = acquireEditorView(view_handle) orelse return 0;
    return object_ptr.getTotalVirtualLineCount();
}

export fn editorViewGetLineInfoDirect(view_handle: NativeHandle, outPtr: *ExternalLineInfo) void {
    const object_ptr = acquireEditorView(view_handle) orelse {
        emptyLineInfo(outPtr);
        return;
    };
    const line_info = object_ptr.getCachedLineInfo();
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

export fn editorViewGetTextBufferView(view_handle: NativeHandle) NativeHandle {
    const object_ptr = acquireEditorView(view_handle) orelse return INVALID_HANDLE;
    return handles.getOrInsertBorrowed(.text_buffer_view, erasePtr(object_ptr.getTextBufferView()), view_handle) catch INVALID_HANDLE;
}

export fn editorViewGetLogicalLineInfoDirect(view_handle: NativeHandle, outPtr: *ExternalLineInfo) void {
    const object_ptr = acquireEditorView(view_handle) orelse {
        emptyLineInfo(outPtr);
        return;
    };
    const line_info = object_ptr.getLogicalLineInfo();
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

export fn editorViewSetViewportSize(view_handle: NativeHandle, width: u32, height: u32) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.setViewportSize(width, height);
}

export fn editorViewSetWrapMode(view_handle: NativeHandle, mode: u8) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    const wrapMode: text_buffer.WrapMode = switch (mode) {
        0 => .none,
        1 => .char,
        2 => .word,
        else => .none,
    };
    object_ptr.setWrapMode(wrapMode);
}

// EditorView selection methods - delegate to TextBufferView
export fn editorViewSetSelection(view_handle: NativeHandle, start: u32, end: u32, bgColor: ?[*]const u16, fgColor: ?[*]const u16) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.text_buffer_view.setSelectionStyle(start, end, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
}

export fn editorViewResetSelection(view_handle: NativeHandle) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.text_buffer_view.resetSelection();
}

export fn editorViewGetSelection(view_handle: NativeHandle) u64 {
    const object_ptr = acquireEditorView(view_handle) orelse return std.math.maxInt(u64);
    return object_ptr.text_buffer_view.packSelectionInfo();
}

export fn editorViewSetLocalSelection(view_handle: NativeHandle, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?[*]const u16, fgColor: ?[*]const u16, updateCursor: bool, followCursor: bool) bool {
    const object_ptr = acquireEditorView(view_handle) orelse return false;
    object_ptr.setSelectionFollowCursor(followCursor);
    const changed = object_ptr.text_buffer_view.setLocalSelectionStyle(anchorX, anchorY, focusX, focusY, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
    if (changed and updateCursor) {
        object_ptr.syncCursorToSelectionFocus();
    }
    return changed;
}

export fn editorViewUpdateSelection(view_handle: NativeHandle, end: u32, bgColor: ?[*]const u16, fgColor: ?[*]const u16) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.text_buffer_view.updateSelectionStyle(end, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
}

export fn editorViewUpdateLocalSelection(view_handle: NativeHandle, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?[*]const u16, fgColor: ?[*]const u16, updateCursor: bool, followCursor: bool) bool {
    const object_ptr = acquireEditorView(view_handle) orelse return false;
    object_ptr.setSelectionFollowCursor(followCursor);
    const changed = object_ptr.text_buffer_view.updateLocalSelectionStyle(anchorX, anchorY, focusX, focusY, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
    if (changed and updateCursor) {
        object_ptr.syncCursorToSelectionFocus();
    }
    return changed;
}

export fn editorViewResetLocalSelection(view_handle: NativeHandle) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.setSelectionFollowCursor(false);
    object_ptr.text_buffer_view.resetLocalSelection();
}

export fn editorViewGetSelectedTextBytes(view_handle: NativeHandle, outPtr: ?[*]u8, maxLen: u32) u32 {
    const object_ptr = acquireEditorView(view_handle) orelse return 0;
    if (maxLen == 0) return 0;

    const out = outPtr orelse return 0;
    const outBuffer = out[0..@as(usize, maxLen)];
    return @intCast(object_ptr.text_buffer_view.getSelectedTextIntoBuffer(outBuffer));
}

// EditorView cursor and text methods
export fn editorViewGetCursor(view_handle: NativeHandle, outRow: *u32, outCol: *u32) void {
    const object_ptr = acquireEditorView(view_handle) orelse {
        outRow.* = 0;
        outCol.* = 0;
        return;
    };
    const cursor = object_ptr.getPrimaryCursor();
    outRow.* = cursor.row;
    outCol.* = cursor.col;
}

export fn editorViewGetText(view_handle: NativeHandle, outPtr: ?[*]u8, maxLen: u32) u32 {
    const object_ptr = acquireEditorView(view_handle) orelse return 0;
    if (maxLen == 0) return 0;

    const out = outPtr orelse return 0;
    const outBuffer = out[0..@as(usize, maxLen)];
    return @intCast(object_ptr.getText(outBuffer));
}

// ===== EditorView VisualCursor Exports =====

export fn editorViewGetVisualCursor(view_handle: NativeHandle, outPtr: *ExternalVisualCursor) void {
    const object_ptr = acquireEditorView(view_handle) orelse {
        outPtr.* = std.mem.zeroes(ExternalVisualCursor);
        return;
    };
    const vcursor = object_ptr.getVisualCursor();
    outPtr.* = .{
        .visual_row = vcursor.visual_row,
        .visual_col = vcursor.visual_col,
        .logical_row = vcursor.logical_row,
        .logical_col = vcursor.logical_col,
        .offset = vcursor.offset,
    };
}

export fn editorViewMoveUpVisual(view_handle: NativeHandle) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.moveUpVisual();
}

export fn editorViewMoveDownVisual(view_handle: NativeHandle) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.moveDownVisual();
}

export fn editorViewDeleteSelectedText(view_handle: NativeHandle) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.deleteSelectedText() catch {};
}

export fn editorViewSetCursorByOffset(view_handle: NativeHandle, offset: u32) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.setCursorByOffset(offset) catch {};
}

export fn editorViewGetNextWordBoundary(view_handle: NativeHandle, outPtr: *ExternalVisualCursor) void {
    const object_ptr = acquireEditorView(view_handle) orelse {
        outPtr.* = std.mem.zeroes(ExternalVisualCursor);
        return;
    };
    const vcursor = object_ptr.getNextWordBoundary();
    outPtr.* = .{
        .visual_row = vcursor.visual_row,
        .visual_col = vcursor.visual_col,
        .logical_row = vcursor.logical_row,
        .logical_col = vcursor.logical_col,
        .offset = vcursor.offset,
    };
}

export fn editorViewGetPrevWordBoundary(view_handle: NativeHandle, outPtr: *ExternalVisualCursor) void {
    const object_ptr = acquireEditorView(view_handle) orelse {
        outPtr.* = std.mem.zeroes(ExternalVisualCursor);
        return;
    };
    const vcursor = object_ptr.getPrevWordBoundary();
    outPtr.* = .{
        .visual_row = vcursor.visual_row,
        .visual_col = vcursor.visual_col,
        .logical_row = vcursor.logical_row,
        .logical_col = vcursor.logical_col,
        .offset = vcursor.offset,
    };
}

export fn editorViewGetEOL(view_handle: NativeHandle, outPtr: *ExternalVisualCursor) void {
    const object_ptr = acquireEditorView(view_handle) orelse {
        outPtr.* = std.mem.zeroes(ExternalVisualCursor);
        return;
    };
    const vcursor = object_ptr.getEOL();
    outPtr.* = .{
        .visual_row = vcursor.visual_row,
        .visual_col = vcursor.visual_col,
        .logical_row = vcursor.logical_row,
        .logical_col = vcursor.logical_col,
        .offset = vcursor.offset,
    };
}

export fn editorViewGetVisualSOL(view_handle: NativeHandle, outPtr: *ExternalVisualCursor) void {
    const object_ptr = acquireEditorView(view_handle) orelse {
        outPtr.* = std.mem.zeroes(ExternalVisualCursor);
        return;
    };
    const vcursor = object_ptr.getVisualSOL();
    outPtr.* = .{
        .visual_row = vcursor.visual_row,
        .visual_col = vcursor.visual_col,
        .logical_row = vcursor.logical_row,
        .logical_col = vcursor.logical_col,
        .offset = vcursor.offset,
    };
}

export fn editorViewGetVisualEOL(view_handle: NativeHandle, outPtr: *ExternalVisualCursor) void {
    const object_ptr = acquireEditorView(view_handle) orelse {
        outPtr.* = std.mem.zeroes(ExternalVisualCursor);
        return;
    };
    const vcursor = object_ptr.getVisualEOL();
    outPtr.* = .{
        .visual_row = vcursor.visual_row,
        .visual_col = vcursor.visual_col,
        .logical_row = vcursor.logical_row,
        .logical_col = vcursor.logical_col,
        .offset = vcursor.offset,
    };
}

export fn editorViewSetPlaceholderStyledText(
    view_handle: NativeHandle,
    chunksPtr: ?[*]const text_buffer.StyledChunk,
    chunkCount: u32,
) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    if (chunkCount == 0) {
        object_ptr.setPlaceholderStyledText(&[_]text_buffer.StyledChunk{}) catch {};
        return;
    }
    const chunks = chunksPtr.?[0..@as(usize, chunkCount)];
    object_ptr.setPlaceholderStyledText(chunks) catch {};
}

export fn editorViewSetTabIndicator(view_handle: NativeHandle, indicator: u32) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.setTabIndicator(indicator);
}

export fn editorViewSetTabIndicatorColor(view_handle: NativeHandle, color: [*]const u16) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.setTabIndicatorColor(ptrToRGBA(color));
}

export fn bufferDrawEditorView(
    buffer_handle: NativeHandle,
    view_handle: NativeHandle,
    x: i32,
    y: i32,
) void {
    const buffer_ptr = acquireBuffer(buffer_handle) orelse return;
    const view_ptr = acquireEditorView(view_handle) orelse return;
    buffer_ptr.drawEditorView(view_ptr, x, y);
}

export fn bufferDrawTextBufferView(
    buffer_handle: NativeHandle,
    view_handle: NativeHandle,
    x: i32,
    y: i32,
) void {
    const buffer_ptr = acquireBuffer(buffer_handle) orelse return;
    const view_ptr = acquireTextBufferView(view_handle) orelse return;
    buffer_ptr.drawTextBuffer(view_ptr, x, y);
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
    tb_handle: NativeHandle,
    hl_ptr: [*]const ExternalHighlight,
) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    const hl = hl_ptr[0];
    // For char-range highlights, start/end in the struct are unused (passed as char_start/char_end)
    object_ptr.addHighlightByCharRange(hl.start, hl.end, hl.style_id, hl.priority, hl.hl_ref) catch {};
}

export fn textBufferAddHighlight(
    tb_handle: NativeHandle,
    line_idx: u32,
    hl_ptr: [*]const ExternalHighlight,
) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    const hl = hl_ptr[0];
    // For line-based highlights, start/end are column offsets
    object_ptr.addHighlight(line_idx, hl.start, hl.end, hl.style_id, hl.priority, hl.hl_ref) catch {};
}

export fn textBufferRemoveHighlightsByRef(tb_handle: NativeHandle, hl_ref: u16) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    object_ptr.removeHighlightsByRef(hl_ref);
}

export fn textBufferClearLineHighlights(tb_handle: NativeHandle, line_idx: u32) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    object_ptr.clearLineHighlights(line_idx);
}

export fn textBufferClearAllHighlights(tb_handle: NativeHandle) void {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return;
    object_ptr.clearAllHighlights();
}

export fn textBufferSetSyntaxStyle(tb_handle: NativeHandle, style_handle: NativeHandle) bool {
    const tb_ptr = acquireTextBuffer(tb_handle) orelse return false;
    if (style_handle == INVALID_HANDLE) {
        tb_ptr.setSyntaxStyle(null);
        return true;
    }
    const style_ptr = acquireSyntaxStyle(style_handle) orelse return false;
    tb_ptr.setSyntaxStyle(style_ptr);
    return tb_ptr.getSyntaxStyle() == style_ptr;
}

export fn textBufferGetLineHighlightsPtr(
    tb_handle: NativeHandle,
    line_idx: u32,
    out_count: *u32,
) ?[*]const ExternalHighlight {
    const object_ptr = acquireTextBuffer(tb_handle) orelse {
        out_count.* = 0;
        return null;
    };
    const highs = object_ptr.getLineHighlightsSlice(@intCast(line_idx));

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

    out_count.* = @intCast(highs.len);
    return slice.ptr;
}

export fn textBufferFreeLineHighlights(ptr: [*]const ExternalHighlight, count: u32) void {
    globalAllocator.free(@constCast(ptr)[0..@as(usize, count)]);
}

export fn textBufferGetHighlightCount(tb_handle: NativeHandle) u32 {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return 0;
    return object_ptr.getHighlightCount();
}

export fn textBufferGetTextRange(tb_handle: NativeHandle, start_offset: u32, end_offset: u32, outPtr: ?[*]u8, maxLen: u32) u32 {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return 0;
    if (maxLen == 0) return 0;

    const out = outPtr orelse return 0;
    const outBuffer = out[0..@as(usize, maxLen)];
    return @intCast(object_ptr.getTextRange(start_offset, end_offset, outBuffer));
}

export fn textBufferGetTextRangeByCoords(tb_handle: NativeHandle, start_row: u32, start_col: u32, end_row: u32, end_col: u32, outPtr: ?[*]u8, maxLen: u32) u32 {
    const object_ptr = acquireTextBuffer(tb_handle) orelse return 0;
    if (maxLen == 0) return 0;

    const out = outPtr orelse return 0;
    const outBuffer = out[0..@as(usize, maxLen)];
    return @intCast(object_ptr.getTextRangeByCoords(start_row, start_col, end_row, end_col, outBuffer));
}

// SyntaxStyle functions
export fn createSyntaxStyle() NativeHandle {
    const style = syntax_style.SyntaxStyle.init(globalAllocator) catch |err| {
        logger.err("Failed to create SyntaxStyle: {}", .{err});
        return INVALID_HANDLE;
    };
    return handles.insert(.syntax_style, erasePtr(style)) catch {
        style.deinit();
        return INVALID_HANDLE;
    };
}

export fn destroySyntaxStyle(style_handle: NativeHandle) void {
    const token = handles.beginDestroy(style_handle, .syntax_style, syntax_style.SyntaxStyle) orelse return;
    token.ptr.deinit();
    handles.finishDestroy(token.handle);
}

export fn syntaxStyleRegister(style_handle: NativeHandle, namePtr: ?[*]const u8, nameLen: u32, fg: ?[*]const u16, bg: ?[*]const u16, attributes: u32) u32 {
    const object_ptr = acquireSyntaxStyle(style_handle) orelse return 0;
    const name = sliceFromPtrLen(namePtr, nameLen);
    return object_ptr.registerStyleDefinition(name, .{
        .fg = optionalPtrToRGBA(fg),
        .bg = optionalPtrToRGBA(bg),
        .attributes = attributes,
    }) catch 0;
}

export fn syntaxStyleResolveByName(style_handle: NativeHandle, namePtr: ?[*]const u8, nameLen: u32) u32 {
    const object_ptr = acquireSyntaxStyle(style_handle) orelse return 0;
    const name = sliceFromPtrLen(namePtr, nameLen);
    return object_ptr.resolveByName(name) orelse 0;
}

export fn syntaxStyleGetStyleCount(style_handle: NativeHandle) u32 {
    const object_ptr = acquireSyntaxStyle(style_handle) orelse return 0;
    return @intCast(object_ptr.getStyleCount());
}

// Unicode encoding API

pub const EncodedChar = extern struct {
    width: u8,
    char: u32,
};

export fn encodeUnicode(
    textPtr: ?[*]const u8,
    textLen: u32,
    outPtr: *?[*]EncodedChar,
    outLenPtr: *usize,
    widthMethod: u8,
) bool {
    const text = sliceFromPtrLen(textPtr, textLen);

    if (text.len == 0) {
        outPtr.* = @ptrFromInt(0);
        outLenPtr.* = 0;
        return true;
    }

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

export fn freeUnicode(charsPtr: ?[*]const EncodedChar, charsLen: u32) void {
    if (charsLen == 0 or charsPtr == null) {
        return;
    }

    const chars = charsPtr.?[0..@as(usize, charsLen)];
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
    buffer_handle: NativeHandle,
    char: u32,
    x: u32,
    y: u32,
    fg: [*]const u16,
    bg: [*]const u16,
    attributes: u32,
) void {
    const object_ptr = acquireBuffer(buffer_handle) orelse return;
    object_ptr.drawChar(char, x, y, ptrToRGBA(fg), ptrToRGBA(bg), attributes);
}
