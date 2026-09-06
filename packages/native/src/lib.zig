const std = @import("std");
const builtin = @import("builtin");
const build_options = @import("build_options");
const Allocator = std.mem.Allocator;

pub const std_options: std.Options = .{
    .log_level = .debug,
    .logFn = handleStdLog,
};

fn handleStdLog(
    comptime message_level: std.log.Level,
    comptime scope: @EnumLiteral(),
    comptime format: []const u8,
    args: anytype,
) void {
    const ghostty_scope = switch (scope) {
        .parser,
        .stream,
        .stream_terminal,
        .screen,
        .terminal,
        .terminal_mem,
        .terminal_apc,
        .terminal_dcs,
        .osc,
        .osc_color,
        .osc_iterm2,
        .kitty_gfx,
        .key_encode,
        .mouse_encode,
        .render_state_c,
        => true,
        else => false,
    };
    if (!ghostty_scope) return;
    const configured = ghosttyLogLevel() orelse return;
    if (@intFromEnum(message_level) > @intFromEnum(configured)) return;

    const level: logger.LogLevel = switch (message_level) {
        .err => .err,
        .warn => .warn,
        .info => .info,
        .debug => .debug,
    };
    logger.logMessage(level, "(" ++ @tagName(scope) ++ ") " ++ format, args);
}

fn ghosttyLogLevel() ?std.log.Level {
    const Environment = struct {
        extern "c" fn getenv(name: [*:0]const u8) ?[*:0]const u8;
    };
    const value = std.mem.span(Environment.getenv("OTUI_GHOSTTY_LOG_LEVEL") orelse return null);
    if (std.ascii.eqlIgnoreCase(value, "error") or std.ascii.eqlIgnoreCase(value, "err")) return .err;
    if (std.ascii.eqlIgnoreCase(value, "warning") or std.ascii.eqlIgnoreCase(value, "warn")) return .warn;
    if (std.ascii.eqlIgnoreCase(value, "info")) return .info;
    if (std.ascii.eqlIgnoreCase(value, "debug")) return .debug;
    return null;
}

var io_threaded: std.Io.Threaded = .init_single_threaded;
pub const io = io_threaded.io();

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
const ghostty_vt_available = @import("ghostty_vt_options").available;
const ghostty_vt = if (ghostty_vt_available) @import("ghostty-vt.zig") else struct {
    const vt = struct {};
};
const embedded_terminal = if (ghostty_vt_available)
    @import("embedded-terminal/main.zig")
else
    @import("embedded-terminal/unavailable.zig");
const EmbeddedTerminal = embedded_terminal.EmbeddedTerminal;
const native_renderable = @import("native-renderable.zig");
const buffer_effects = @import("buffer-methods.zig");
const handles = @import("handles.zig");
const native_yoga = @import("yoga.zig");
const native_image = @import("image.zig");
const clipboard = @import("clipboard/host.zig");

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

fn acquireNativeRenderable(handle: NativeHandle) ?*native_renderable.NativeRenderable {
    return handles.acquire(handle, .native_renderable, native_renderable.NativeRenderable);
}

fn acquireImage(handle: NativeHandle) ?*native_image.Image {
    return handles.acquire(handle, .image, native_image.Image);
}

fn acquireEmbeddedTerminal(handle: NativeHandle) ?*EmbeddedTerminal {
    return handles.acquire(handle, .embedded_terminal, EmbeddedTerminal);
}

const EmbeddedTerminalStatus = struct {
    const invalid: i32 = -1;
    const out_of_memory: i32 = -2;
    const unsupported: i32 = -3;
    const out_of_space: i32 = -4;
    const processing_failed: i32 = -5;
};

pub const ExternalEmbeddedTerminalCursor = extern struct {
    x: u16 = 0,
    y: u16 = 0,
    has_value: u8 = 0,
    visible: u8 = 0,
    blinking: u8 = 0,
    wide_tail: u8 = 0,
    style: u8 = 1,
    color_has_value: u8 = 0,
    color_r: u8 = 0,
    color_g: u8 = 0,
    color_b: u8 = 0,
    _padding: u8 = 0,
};

pub const ExternalEmbeddedTerminalKeyOptions = extern struct {
    action: u8 = 1,
    composing: u8 = 0,
    mods: u16 = 0,
    consumed_mods: u16 = 0,
    _padding: u16 = 0,
    unshifted_codepoint: u32 = 0,
};

fn embeddedTerminalStatus(err: anyerror) i32 {
    return switch (err) {
        error.OutOfMemory => EmbeddedTerminalStatus.out_of_memory,
        error.Unsupported => EmbeddedTerminalStatus.unsupported,
        error.ResponseOverflow => EmbeddedTerminalStatus.out_of_space,
        error.ProcessingFailed => EmbeddedTerminalStatus.processing_failed,
        else => EmbeddedTerminalStatus.invalid,
    };
}

fn embeddedTerminalInput(ptr: ?[*]const u8, len: u32) ?[]const u8 {
    if (len == 0) return "";
    return (ptr orelse return null)[0..@as(usize, len)];
}

fn embeddedTerminalOutput(ptr: ?[*]u8, len: u32) ?[]u8 {
    if (len == 0) return &.{};
    return (ptr orelse return null)[0..@as(usize, len)];
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

inline fn selectionOccupancy(value: u8) text_buffer_view.SelectionOccupancy {
    return if (value == 1) .boundary else .cell;
}

inline fn selectionBehavior(value: u8) text_buffer_view.SelectionBehavior {
    return switch (value) {
        1 => .word,
        2 => .line,
        else => .cell,
    };
}

comptime {
    std.debug.assert(@sizeOf(ExternalEmbeddedTerminalCursor) == 14);
    std.debug.assert(@sizeOf(ExternalEmbeddedTerminalKeyOptions) == 12);
    _ = native_span_feed;
    _ = native_audio;
    _ = ghostty_vt.vt;
    _ = native_renderable;
    _ = native_yoga;
    _ = native_image;
}

export fn createEmbeddedTerminal(cols: u16, rows: u16, max_scrollback: u32, out_handle_ptr: ?*NativeHandle) i32 {
    const out_handle = out_handle_ptr orelse return EmbeddedTerminalStatus.invalid;
    out_handle.* = INVALID_HANDLE;
    const terminal_value = EmbeddedTerminal.init(io, globalAllocator, .{
        .cols = cols,
        .rows = rows,
        .max_scrollback = max_scrollback,
    }) catch |err| return embeddedTerminalStatus(err);
    out_handle.* = handles.insert(.embedded_terminal, erasePtr(terminal_value)) catch {
        terminal_value.deinit();
        return EmbeddedTerminalStatus.out_of_memory;
    };
    return 0;
}

export fn destroyEmbeddedTerminal(handle: NativeHandle) void {
    const token = handles.beginDestroy(handle, .embedded_terminal, EmbeddedTerminal) orelse return;
    token.ptr.deinit();
    handles.finishDestroy(token.handle);
}

export fn embeddedTerminalWrite(handle: NativeHandle, bytes_ptr: ?[*]const u8, bytes_len: u32) i32 {
    const terminal_value = acquireEmbeddedTerminal(handle) orelse return EmbeddedTerminalStatus.invalid;
    const bytes = embeddedTerminalInput(bytes_ptr, bytes_len) orelse return EmbeddedTerminalStatus.invalid;
    terminal_value.write(bytes) catch |err| return embeddedTerminalStatus(err);
    return 0;
}

export fn embeddedTerminalResize(handle: NativeHandle, cols: u16, rows: u16) i32 {
    const terminal_value = acquireEmbeddedTerminal(handle) orelse return EmbeddedTerminalStatus.invalid;
    terminal_value.resize(cols, rows) catch |err| return embeddedTerminalStatus(err);
    return 0;
}

export fn embeddedTerminalInvalidate(handle: NativeHandle) i32 {
    const terminal_value = acquireEmbeddedTerminal(handle) orelse return EmbeddedTerminalStatus.invalid;
    terminal_value.invalidate();
    return 0;
}

export fn embeddedTerminalScroll(handle: NativeHandle, delta: i32) i32 {
    const terminal_value = acquireEmbeddedTerminal(handle) orelse return EmbeddedTerminalStatus.invalid;
    terminal_value.scroll(delta);
    return 0;
}

export fn embeddedTerminalSetSelection(
    handle: NativeHandle,
    start_x: u16,
    start_y: u16,
    end_x: u16,
    end_y: u16,
) i32 {
    const terminal_value = acquireEmbeddedTerminal(handle) orelse return EmbeddedTerminalStatus.invalid;
    terminal_value.setSelection(
        .{ .x = start_x, .y = start_y },
        .{ .x = end_x, .y = end_y },
    ) catch |err| return embeddedTerminalStatus(err);
    return 0;
}

export fn embeddedTerminalClearSelection(handle: NativeHandle) i32 {
    const terminal_value = acquireEmbeddedTerminal(handle) orelse return EmbeddedTerminalStatus.invalid;
    terminal_value.clearSelection();
    return 0;
}

export fn embeddedTerminalGetSelectedText(
    handle: NativeHandle,
    out_ptr: ?[*]u8,
    out_len: u32,
    out_required_ptr: ?*u32,
) i32 {
    const out_required = out_required_ptr orelse return EmbeddedTerminalStatus.invalid;
    out_required.* = 0;
    const terminal_value = acquireEmbeddedTerminal(handle) orelse return EmbeddedTerminalStatus.invalid;
    const output = embeddedTerminalOutput(out_ptr, out_len) orelse return EmbeddedTerminalStatus.invalid;
    const text = terminal_value.selectedText() catch |err| return embeddedTerminalStatus(err);
    defer terminal_value.freeSelectedText(text);
    out_required.* = std.math.cast(u32, text.len) orelse return EmbeddedTerminalStatus.out_of_memory;
    if (text.len > output.len) return EmbeddedTerminalStatus.out_of_space;
    @memcpy(output[0..text.len], text);
    return @intCast(text.len);
}

export fn embeddedTerminalCompose(
    handle: NativeHandle,
    buffer_handle: NativeHandle,
    x: i32,
    y: i32,
) i32 {
    const terminal_value = acquireEmbeddedTerminal(handle) orelse return EmbeddedTerminalStatus.invalid;
    const target = acquireBuffer(buffer_handle) orelse return EmbeddedTerminalStatus.invalid;
    terminal_value.compose(target, x, y) catch |err| return embeddedTerminalStatus(err);
    return 0;
}

export fn embeddedTerminalCursor(handle: NativeHandle, out_cursor_ptr: ?*ExternalEmbeddedTerminalCursor) i32 {
    const out_cursor = out_cursor_ptr orelse return EmbeddedTerminalStatus.invalid;
    out_cursor.* = .{};
    const terminal_value = acquireEmbeddedTerminal(handle) orelse return EmbeddedTerminalStatus.invalid;
    const cursor = terminal_value.cursor();
    out_cursor.* = .{
        .x = cursor.x,
        .y = cursor.y,
        .has_value = @intFromBool(cursor.has_value),
        .visible = @intFromBool(cursor.visible),
        .blinking = @intFromBool(cursor.blinking),
        .wide_tail = @intFromBool(cursor.wide_tail),
        .style = cursor.style,
        .color_has_value = @intFromBool(cursor.color != null),
        .color_r = if (cursor.color) |value| value.r else 0,
        .color_g = if (cursor.color) |value| value.g else 0,
        .color_b = if (cursor.color) |value| value.b else 0,
    };
    return 0;
}

export fn embeddedTerminalEncodeKey(
    handle: NativeHandle,
    options_ptr: ?*const ExternalEmbeddedTerminalKeyOptions,
    key_ptr: ?[*]const u8,
    key_len: u32,
    utf8_ptr: ?[*]const u8,
    utf8_len: u32,
    out_ptr: ?[*]u8,
    out_len: u32,
    out_required_ptr: ?*u32,
) i32 {
    if (comptime !ghostty_vt_available) return EmbeddedTerminalStatus.unsupported;
    const options = options_ptr orelse return EmbeddedTerminalStatus.invalid;
    const out_required = out_required_ptr orelse return EmbeddedTerminalStatus.invalid;
    out_required.* = 0;
    const terminal_value = acquireEmbeddedTerminal(handle) orelse return EmbeddedTerminalStatus.invalid;
    const key_code = embeddedTerminalInput(key_ptr, key_len) orelse return EmbeddedTerminalStatus.invalid;
    const utf8_bytes = embeddedTerminalInput(utf8_ptr, utf8_len) orelse return EmbeddedTerminalStatus.invalid;
    const output = embeddedTerminalOutput(out_ptr, out_len) orelse return EmbeddedTerminalStatus.invalid;
    if (options.composing > 1 or options.mods & ~@as(u16, 0x3f) != 0 or options.consumed_mods & ~@as(u16, 0x3f) != 0) return EmbeddedTerminalStatus.invalid;
    const key_value = ghostty_vt.vt.input.Key.fromW3C(key_code) orelse .unidentified;
    if (options.unshifted_codepoint > std.math.maxInt(u21)) return EmbeddedTerminalStatus.invalid;
    const encoded = terminal_value.encodeKey(.{
        .action = switch (options.action) {
            0 => .release,
            1 => .press,
            2 => .repeat,
            else => return EmbeddedTerminalStatus.invalid,
        },
        .key = key_value,
        .mods = @bitCast(options.mods),
        .consumed_mods = @bitCast(options.consumed_mods),
        .composing = options.composing == 1,
        .utf8 = utf8_bytes,
        .unshifted_codepoint = @intCast(options.unshifted_codepoint),
    }) catch |err| return embeddedTerminalStatus(err);
    defer terminal_value.freeEncoded(encoded);
    out_required.* = @intCast(encoded.len);
    if (encoded.len > output.len) return EmbeddedTerminalStatus.out_of_space;
    @memcpy(output[0..encoded.len], encoded);
    return @intCast(encoded.len);
}

export fn embeddedTerminalEncodeMouse(
    handle: NativeHandle,
    action: u8,
    button: i8,
    mods: u16,
    x: f32,
    y: f32,
    any_button_pressed: u8,
    out_ptr: ?[*]u8,
    out_len: u32,
) i32 {
    if (comptime !ghostty_vt_available) return EmbeddedTerminalStatus.unsupported;
    const terminal_value = acquireEmbeddedTerminal(handle) orelse return EmbeddedTerminalStatus.invalid;
    const output = embeddedTerminalOutput(out_ptr, out_len) orelse return EmbeddedTerminalStatus.invalid;
    if (any_button_pressed > 1 or mods & ~@as(u16, 0x3f) != 0) return EmbeddedTerminalStatus.invalid;
    const encoded = terminal_value.encodeMouse(.{
        .action = switch (action) {
            0 => .press,
            1 => .release,
            2 => .motion,
            else => return EmbeddedTerminalStatus.invalid,
        },
        .button = switch (button) {
            -1 => null,
            0 => .unknown,
            1 => .left,
            2 => .right,
            3 => .middle,
            4 => .four,
            5 => .five,
            6 => .six,
            7 => .seven,
            else => return EmbeddedTerminalStatus.invalid,
        },
        .mods = @bitCast(mods),
        .x = x,
        .y = y,
        .any_button_pressed = any_button_pressed == 1,
    }) catch |err| return embeddedTerminalStatus(err);
    defer terminal_value.freeEncoded(encoded);
    if (encoded.len > output.len) return EmbeddedTerminalStatus.out_of_space;
    @memcpy(output[0..encoded.len], encoded);
    return @intCast(encoded.len);
}

export fn embeddedTerminalEncodePaste(
    handle: NativeHandle,
    input_ptr: ?[*]const u8,
    input_len: u32,
    out_ptr: ?[*]u8,
    out_len: u32,
) i32 {
    const terminal_value = acquireEmbeddedTerminal(handle) orelse return EmbeddedTerminalStatus.invalid;
    const input = embeddedTerminalInput(input_ptr, input_len) orelse return EmbeddedTerminalStatus.invalid;
    const output = embeddedTerminalOutput(out_ptr, out_len) orelse return EmbeddedTerminalStatus.invalid;
    const encoded = terminal_value.encodePaste(input) catch |err| return embeddedTerminalStatus(err);
    defer terminal_value.freeEncoded(encoded);
    if (encoded.len > output.len) return EmbeddedTerminalStatus.out_of_space;
    @memcpy(output[0..encoded.len], encoded);
    return @intCast(encoded.len);
}

export fn embeddedTerminalEncodeFocus(handle: NativeHandle, focused: u8, out_ptr: ?[*]u8, out_len: u32) i32 {
    const terminal_value = acquireEmbeddedTerminal(handle) orelse return EmbeddedTerminalStatus.invalid;
    const output = embeddedTerminalOutput(out_ptr, out_len) orelse return EmbeddedTerminalStatus.invalid;
    if (focused > 1) return EmbeddedTerminalStatus.invalid;
    const encoded = terminal_value.encodeFocus(focused == 1) catch |err| return embeddedTerminalStatus(err);
    defer terminal_value.freeEncoded(encoded);
    if (encoded.len > output.len) return EmbeddedTerminalStatus.out_of_space;
    @memcpy(output[0..encoded.len], encoded);
    return @intCast(encoded.len);
}

export fn embeddedTerminalDrainResponses(handle: NativeHandle, out_ptr: ?[*]u8, out_len: u32) i32 {
    const terminal_value = acquireEmbeddedTerminal(handle) orelse return EmbeddedTerminalStatus.invalid;
    const output = embeddedTerminalOutput(out_ptr, out_len) orelse return EmbeddedTerminalStatus.invalid;
    const written = terminal_value.drainResponses(output) catch |err| return embeddedTerminalStatus(err);
    return @intCast(written);
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

export fn createNativeRenderable() NativeHandle {
    const renderable = globalAllocator.create(native_renderable.NativeRenderable) catch return INVALID_HANDLE;
    renderable.* = .{};
    return handles.insert(.native_renderable, erasePtr(renderable)) catch {
        globalAllocator.destroy(renderable);
        return INVALID_HANDLE;
    };
}

export fn destroyNativeRenderable(native_renderable_handle: NativeHandle) void {
    const token = handles.beginDestroy(native_renderable_handle, .native_renderable, native_renderable.NativeRenderable) orelse return;
    token.ptr.deinit();
    globalAllocator.destroy(token.ptr);
    handles.finishDestroy(token.handle);
}

export fn nativeRenderableAttachYogaNode(native_renderable_handle: NativeHandle, node: native_yoga.YGNodeRef) bool {
    // Temporary bridge: JS-created Renderables still own Yoga nodes, so native
    // renderables borrow and attach them after construction. This should go away
    // when the renderable tree and Yoga ownership move native-side.
    const renderable = acquireNativeRenderable(native_renderable_handle) orelse return false;
    if (node == null) return false;
    renderable.attachYogaNode(node);
    return true;
}

export fn nativeRenderableSetMeasureTarget(
    native_renderable_handle: NativeHandle,
    kind: u32,
    target_handle: NativeHandle,
) bool {
    const renderable = acquireNativeRenderable(native_renderable_handle) orelse return false;

    // Resolve handles once at setup time. The Yoga measure callback then uses raw
    // native pointers and does not pay handle-registry lookup cost on the hot path.
    // Kind `none` clears the measure target; unknown kinds are rejected.
    const measure_kind: native_renderable.MeasureTargetKind = switch (kind) {
        @intFromEnum(native_renderable.MeasureTargetKind.none) => .none,
        @intFromEnum(native_renderable.MeasureTargetKind.text_buffer_view) => .text_buffer_view,
        @intFromEnum(native_renderable.MeasureTargetKind.editor_view) => .editor_view,
        else => return false,
    };

    const target: native_renderable.MeasureTarget = switch (measure_kind) {
        .none => .none,
        .text_buffer_view => .{ .text_buffer_view = acquireTextBufferView(target_handle) orelse return false },
        .editor_view => .{ .editor_view = acquireEditorView(target_handle) orelse return false },
    };

    renderable.setMeasureTarget(target);
    return true;
}

export fn destroyEventSink(sink_handle: NativeHandle) void {
    const token = handles.beginDestroy(sink_handle, .event_sink, event_bus.EventSink) orelse return;
    clearEditBufferEventSinkRefs(token.ptr);
    event_bus.destroyEventSink(globalAllocator, token.ptr);
    handles.finishDestroy(token.handle);
}

var gpa: std.heap.DebugAllocator(.{
    .enable_memory_limit = build_options.gpa_safe_stats,
    .safety = build_options.gpa_safe_stats,
}) = .init;
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

export fn clipboardServiceCreate(
    max_operations: u32,
    max_provider_transfers: u32,
    wayland_seat_pointer: ?[*]const u8,
    wayland_seat_length: u32,
) NativeHandle {
    return clipboard.createService(
        globalAllocator,
        max_operations,
        max_provider_transfers,
        wayland_seat_pointer,
        wayland_seat_length,
    );
}

export fn clipboardServiceBeginShutdown(service_handle: NativeHandle) u8 {
    return @intFromEnum(clipboard.beginServiceShutdown(service_handle));
}

export fn clipboardServicePollShutdown(service_handle: NativeHandle) u8 {
    return @intFromEnum(clipboard.pollServiceShutdown(service_handle));
}

export fn clipboardServiceDestroy(service_handle: NativeHandle) u8 {
    return @intFromEnum(clipboard.destroyService(service_handle));
}

export fn clipboardServiceDrain(service_handle: NativeHandle) u8 {
    return clipboard.drainService(service_handle);
}

export fn clipboardReadOperationStart(
    service_handle: NativeHandle,
    request_pointer: ?[*]const u8,
    request_length: u32,
    selection: u8,
    max_bytes: u32,
    max_image_pixels: u32,
    max_conversion_bytes: u32,
    timeout_ms: u32,
    out_operation_handle: ?*NativeHandle,
) u8 {
    return @intFromEnum(clipboard.startReadOperation(
        service_handle,
        request_pointer,
        request_length,
        selection,
        max_bytes,
        max_image_pixels,
        max_conversion_bytes,
        timeout_ms,
        out_operation_handle,
    ));
}

export fn clipboardWriteOperationStart(
    service_handle: NativeHandle,
    text_pointer: ?[*]const u8,
    text_length: u32,
    selection: u8,
    timeout_ms: u32,
    out_operation_handle: ?*NativeHandle,
) u8 {
    return @intFromEnum(clipboard.startWriteOperation(
        service_handle,
        text_pointer,
        text_length,
        selection,
        timeout_ms,
        out_operation_handle,
    ));
}

export fn clipboardClearOperationStart(
    service_handle: NativeHandle,
    selection: u8,
    timeout_ms: u32,
    out_operation_handle: ?*NativeHandle,
) u8 {
    return @intFromEnum(clipboard.startClearOperation(
        service_handle,
        selection,
        timeout_ms,
        out_operation_handle,
    ));
}

export fn clipboardOperationPoll(operation_handle: NativeHandle) u8 {
    return @intFromEnum(clipboard.pollOperation(operation_handle));
}

export fn clipboardOperationCancel(operation_handle: NativeHandle) u8 {
    return @intFromEnum(clipboard.cancelOperation(operation_handle));
}

export fn clipboardOperationResultMimeLength(operation_handle: NativeHandle, out_length: ?*u32) u8 {
    return @intFromEnum(clipboard.resultMimeLength(operation_handle, out_length));
}

export fn clipboardOperationResultMimeCopy(operation_handle: NativeHandle, out_pointer: ?[*]u8, capacity: u32) u8 {
    return @intFromEnum(clipboard.resultMimeCopy(operation_handle, out_pointer, capacity));
}

export fn clipboardOperationResultDataLength(operation_handle: NativeHandle, out_length: ?*u32) u8 {
    return @intFromEnum(clipboard.resultDataLength(operation_handle, out_length));
}

export fn clipboardOperationResultDataCopy(operation_handle: NativeHandle, out_pointer: ?[*]u8, capacity: u32) u8 {
    return @intFromEnum(clipboard.resultDataCopy(operation_handle, out_pointer, capacity));
}

export fn clipboardOperationResultErrorCode(operation_handle: NativeHandle, out_error_code: ?*u32) u8 {
    return @intFromEnum(clipboard.resultErrorCode(operation_handle, out_error_code));
}

export fn clipboardOperationResultDiagnosticLength(operation_handle: NativeHandle, out_length: ?*u32) u8 {
    return @intFromEnum(clipboard.resultDiagnosticLength(operation_handle, out_length));
}

export fn clipboardOperationResultDiagnosticCopy(operation_handle: NativeHandle, out_pointer: ?[*]u8, capacity: u32) u8 {
    return @intFromEnum(clipboard.resultDiagnosticCopy(operation_handle, out_pointer, capacity));
}

export fn clipboardOperationDestroy(operation_handle: NativeHandle) u8 {
    return @intFromEnum(clipboard.destroyOperation(operation_handle));
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

export fn audioRefreshCaptureDevices(engine_handle: NativeHandle) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.refreshCaptureDevices(object_ptr);
}

export fn audioGetCaptureDeviceCount(engine_handle: NativeHandle) u32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return 0;
    return native_audio.getCaptureDeviceCount(object_ptr);
}

export fn audioGetCaptureDeviceName(engine_handle: NativeHandle, index: u32, out_ptr: [*]u8, max_len: u32) u32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return 0;
    return @intCast(native_audio.getCaptureDeviceName(object_ptr, index, out_ptr, @as(usize, max_len)));
}

export fn audioIsCaptureDeviceDefault(engine_handle: NativeHandle, index: u32) bool {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return false;
    return native_audio.isCaptureDeviceDefault(object_ptr, index);
}

export fn audioSelectCaptureDevice(engine_handle: NativeHandle, index: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.selectCaptureDevice(object_ptr, index);
}

export fn audioClearCaptureDeviceSelection(engine_handle: NativeHandle) void {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return;
    native_audio.clearCaptureDeviceSelection(object_ptr);
}

export fn audioStartCapture(
    engine_handle: NativeHandle,
    options_ptr: ?*const native_audio.StartOptions,
    channels: u32,
    capacity_frames: u32,
) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.startCapture(object_ptr, options_ptr, channels, capacity_frames);
}

export fn audioStopCapture(engine_handle: NativeHandle) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.stopCapture(object_ptr);
}

export fn audioIsCaptureRunning(engine_handle: NativeHandle) bool {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return false;
    return native_audio.isCaptureRunning(object_ptr);
}

export fn audioReadCapture(
    engine_handle: NativeHandle,
    out_ptr: ?[*]f32,
    out_sample_capacity: u32,
    frame_count: u32,
    out_frames_read: ?*u32,
) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.readCapture(object_ptr, out_ptr, out_sample_capacity, frame_count, out_frames_read);
}

export fn audioGetCaptureStats(engine_handle: NativeHandle, out_stats: ?*native_audio.CaptureStats) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.getCaptureStats(object_ptr, out_stats);
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

export fn audioCreateStream(
    engine_handle: NativeHandle,
    options_ptr: ?*const native_audio.StreamOptions,
    out_stream_id: ?*u32,
) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.createStream(object_ptr, options_ptr, out_stream_id);
}

export fn audioWriteStream(
    engine_handle: NativeHandle,
    stream_id: u32,
    data_ptr: ?[*]const u8,
    data_len: u32,
) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.writeStream(object_ptr, stream_id, data_ptr, data_len);
}

export fn audioEndStream(engine_handle: NativeHandle, stream_id: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.endStream(object_ptr, stream_id);
}

export fn audioRestartStream(engine_handle: NativeHandle, stream_id: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.restartStream(object_ptr, stream_id);
}

export fn audioSetStreamVolume(engine_handle: NativeHandle, stream_id: u32, volume: f32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.setStreamVolume(object_ptr, stream_id, volume);
}

export fn audioSetStreamPan(engine_handle: NativeHandle, stream_id: u32, pan: f32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.setStreamPan(object_ptr, stream_id, pan);
}

export fn audioSetStreamGroup(engine_handle: NativeHandle, stream_id: u32, group_id: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.setStreamGroup(object_ptr, stream_id, group_id);
}

export fn audioGetStreamStats(engine_handle: NativeHandle, stream_id: u32, out_stats: ?*native_audio.StreamStats) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.getStreamStats(object_ptr, stream_id, out_stats);
}

export fn audioCloseStream(
    engine_handle: NativeHandle,
    stream_id: u32,
    reason: u32,
    out_final_stats: ?*native_audio.StreamStats,
) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.closeStream(object_ptr, stream_id, reason, out_final_stats);
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

export fn audioEnableTap(engine_handle: NativeHandle, enabled: u8, capacity_frames: u32) i32 {
    const object_ptr = acquireAudioEngine(engine_handle) orelse return native_audio.Status.err_invalid;
    return native_audio.enableTap(object_ptr, enabled == 1, capacity_frames);
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

export fn destroyRenderer(renderer_handle: NativeHandle, flush_input: bool) void {
    const token = handles.beginDestroy(renderer_handle, .renderer, renderer.CliRenderer) orelse return;
    handles.invalidateChildren(token.handle);
    token.ptr.destroy();
    if (flush_input) flushTerminalInput();
    handles.finishDestroy(token.handle);
}

fn flushTerminalInput() void {
    if (builtin.os.tag == .windows) {
        const WindowsConsole = struct {
            extern "kernel32" fn GetStdHandle(handle: std.os.windows.DWORD) callconv(.winapi) std.os.windows.HANDLE;
            extern "kernel32" fn FlushConsoleInputBuffer(handle: std.os.windows.HANDLE) callconv(.winapi) std.os.windows.BOOL;
        };
        const stdin_handle = WindowsConsole.GetStdHandle(@bitCast(@as(i32, -10)));
        _ = WindowsConsole.FlushConsoleInputBuffer(stdin_handle);
        return;
    }

    const tciflush = switch (builtin.os.tag) {
        .linux => 0,
        .macos => 1,
        else => return,
    };
    const PosixTerminal = struct {
        extern "c" fn tcflush(fd: c_int, queue_selector: c_int) c_int;
    };
    _ = PosixTerminal.tcflush(0, tciflush);
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

fn widthMethodFromInt(value: u8) utf8.WidthMethod {
    return switch (value) {
        @intFromEnum(utf8.WidthMethod.wcwidth) => .wcwidth,
        @intFromEnum(utf8.WidthMethod.unicode_wide) => .unicode_wide,
        else => .unicode,
    };
}

test "widthMethodFromInt preserves legacy numeric inputs" {
    try std.testing.expectEqual(utf8.WidthMethod.wcwidth, widthMethodFromInt(0));
    try std.testing.expectEqual(utf8.WidthMethod.unicode, widthMethodFromInt(1));
    try std.testing.expectEqual(utf8.WidthMethod.unicode, widthMethodFromInt(2));
    try std.testing.expectEqual(utf8.WidthMethod.unicode_wide, widthMethodFromInt(3));
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

export fn getBufferWidthMethod(buffer_handle: NativeHandle) u8 {
    const object_ptr = acquireBuffer(buffer_handle) orelse return @intFromEnum(utf8.WidthMethod.unicode);
    return @intFromEnum(object_ptr.width_method);
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
    flags: u8,
    pinnedRenderOffset: u32,
) u64 {
    const renderer_ptr = acquireRenderer(renderer_handle) orelse return packFailedRenderResult();
    const snapshot_ptr = acquireBuffer(snapshot_buffer_handle) orelse return packFailedRenderResult();
    const start_on_new_line = (flags & (1 << 0)) != 0;
    const trailing_newline = (flags & (1 << 1)) != 0;
    const force = (flags & (1 << 2)) != 0;
    const begin_frame = (flags & (1 << 3)) != 0;
    const finalize_frame = (flags & (1 << 4)) != 0;
    const control_output = (flags & (1 << 5)) != 0;

    // JS passes rowColumns/startOnNewLine/trailingNewline per commit from
    // writeToScrollback or captured stdout chunking. This entrypoint is the ABI
    // boundary where that metadata enters the native split append algorithm.
    // Route all commits through the batched renderer path so sync/cursor framing
    // happens exactly once per JS flush cycle.
    return packRenderResult(renderer_ptr.commitSplitFooterSnapshotWithOptions(
        snapshot_ptr,
        rowColumns,
        start_on_new_line,
        trailing_newline,
        pinnedRenderOffset,
        force,
        .{
            .begin_frame = begin_frame,
            .finalize_frame = finalize_frame,
            .control_output = control_output,
        },
    ));
}

export fn createOptimizedBuffer(width: u32, height: u32, respectAlpha: u8, widthMethod: u8, idPtr: ?[*]const u8, idLen: u32) NativeHandle {
    if (width == 0 or height == 0) {
        logger.warn("Invalid buffer dimensions: {}x{}", .{ width, height });
        return INVALID_HANDLE;
    }

    const pool = gp.initGlobalPool(globalArena);
    const link_pool = link.initGlobalLinkPool(globalArena);
    const wMethod = widthMethodFromInt(widthMethod);
    const id = sliceFromPtrLen(idPtr, idLen);

    const bufferPtr = buffer.OptimizedBuffer.init(globalAllocator, width, height, .{
        .respectAlpha = respectAlpha == 1,
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
    image_protocol: u8,
    term_name_ptr: [*]const u8,
    term_name_len: usize,
    term_version_ptr: [*]const u8,
    term_version_len: usize,
    term_from_xtversion: bool,
    osc52_support: u8,
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
        .unicode = switch (caps.unicode) {
            .wcwidth => 0,
            .unicode_wide => 3,
            .unicode, .no_zwj => 1,
        },
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
        .osc52_support = @intFromEnum(term.osc52_support),
        .notifications = caps.notifications,
        .explicit_cursor_positioning = caps.explicit_cursor_positioning,
        .remote = caps.remote,
        .multiplexer = @intFromEnum(term.multiplexer),
        .image_protocol = @intFromEnum(term.image_protocol),
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

export fn setKittyImageTransport(renderer_handle: NativeHandle, mode: u32) u32 {
    const object = acquireRenderer(renderer_handle) orelse return 0;
    return @intFromBool(object.setKittyImageTransport(mode));
}

export fn getKittyImageTransport(renderer_handle: NativeHandle, out: [*]u32) void {
    const object = acquireRenderer(renderer_handle) orelse return;
    const transport = &object.kittyTransport;
    out[0..6].* = .{ @intFromEnum(transport.mode), @intFromEnum(transport.effective), @intFromEnum(transport.file_state), @intFromEnum(transport.fallback), transport.pendingCount(), @intCast(transport.pendingBytes()) };
}

export fn pollKittyImageTransport(renderer_handle: NativeHandle) u32 {
    const object = acquireRenderer(renderer_handle) orelse return 0;
    return @intFromBool(object.pollKittyImageTransport());
}

export fn cancelKittyImageTransport(renderer_handle: NativeHandle, failed: u32) void {
    const object = acquireRenderer(renderer_handle) orelse return;
    object.kittyTransport.cancel(if (failed != 0) .io_error else .cancelled);
    _ = object.pollKittyImageTransport();
}

export fn processKittyImageReply(renderer_handle: NativeHandle, response: [*]const u8, len: u32) u32 {
    const object = acquireRenderer(renderer_handle) orelse return 0;
    return object.processKittyImageReply(response[0..len]);
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
    if (options.cursor <= 5) {
        object_ptr.terminal.setMousePointerStyle(@enumFromInt(options.cursor));
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

export fn setDebugOverlay(renderer_handle: NativeHandle, enabled: u8, corner: u8) void {
    const object_ptr = acquireRenderer(renderer_handle) orelse return;
    const cornerEnum: renderer.DebugOverlayCorner = switch (corner) {
        0 => .topLeft,
        1 => .topRight,
        2 => .bottomLeft,
        else => .bottomRight,
    };

    object_ptr.setDebugOverlay(enabled == 1, cornerEnum);
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

export fn copyToClipboardOSC52(renderer_handle: NativeHandle, target: u8, text_ptr: ?[*]const u8, text_len: u32) bool {
    const object_ptr = acquireRenderer(renderer_handle) orelse return false;
    const targetEnum = std.enums.fromInt(terminal.ClipboardTarget, target) orelse .clipboard;
    const text_utf8 = sliceFromPtrLen(text_ptr, text_len);
    return object_ptr.copyToClipboardOSC52(targetEnum, text_utf8);
}

export fn clearClipboardOSC52(renderer_handle: NativeHandle, target: u8) bool {
    const object_ptr = acquireRenderer(renderer_handle) orelse return false;
    const targetEnum = std.enums.fromInt(terminal.ClipboardTarget, target) orelse .clipboard;
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

pub const ExternalImageDrawOptions = extern struct {
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
    protocol: u32,
};

export fn bufferDrawImage(
    buffer_handle: NativeHandle,
    image_handle: NativeHandle,
    options: *const ExternalImageDrawOptions,
) u8 {
    const buffer_ptr = acquireBuffer(buffer_handle) orelse return 0;
    const image_ptr = acquireImage(image_handle) orelse return 0;
    const protocol = std.enums.fromInt(native_image.RenderProtocol, options.protocol) orelse return 0;
    return @intFromBool(buffer_ptr.drawImage(
        image_ptr,
        image_handle,
        options.x,
        options.y,
        options.width,
        options.height,
        options.pixel_width,
        options.pixel_height,
        options.source_x,
        options.source_y,
        options.source_width,
        options.source_height,
        protocol,
    ) catch false);
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
    const wMethod = widthMethodFromInt(widthMethod);

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
    if (handles.getOwner(tb_handle, .text_buffer)) |owner| {
        if (acquireEditBuffer(owner)) |edit_buffer| {
            edit_buffer.setTabWidth(width);
            return;
        }
    }
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

export fn textBufferViewSetLocalSelection(view_handle: NativeHandle, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?[*]const u16, fgColor: ?[*]const u16, behavior: u8) bool {
    const object_ptr = acquireTextBufferView(view_handle) orelse return false;
    return object_ptr.setLocalSelectionStyle(anchorX, anchorY, focusX, focusY, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)), selectionBehavior(behavior));
}

export fn textBufferViewUpdateSelection(view_handle: NativeHandle, end: u32, bgColor: ?[*]const u16, fgColor: ?[*]const u16) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse return;
    object_ptr.updateSelectionStyle(end, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)));
}

export fn textBufferViewUpdateLocalSelection(view_handle: NativeHandle, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?[*]const u16, fgColor: ?[*]const u16, behavior: u8) bool {
    const object_ptr = acquireTextBufferView(view_handle) orelse return false;
    return object_ptr.updateLocalSelectionStyle(anchorX, anchorY, focusX, focusY, selectionStyle(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor)), selectionBehavior(behavior));
}

export fn textBufferViewResetLocalSelection(view_handle: NativeHandle) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse return;
    object_ptr.resetLocalSelection();
}

export fn textBufferViewSetSelectionOccupancy(view_handle: NativeHandle, occupancy: u8) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse return;
    object_ptr.setSelectionOccupancy(selectionOccupancy(occupancy));
}

export fn textBufferViewGetSelectionOccupancy(view_handle: NativeHandle) u8 {
    const object_ptr = acquireTextBufferView(view_handle) orelse return 0;
    return @intFromEnum(object_ptr.getSelectionOccupancy());
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

export fn textBufferViewSetWrapIndent(view_handle: NativeHandle, indent: u8) void {
    const object_ptr = acquireTextBufferView(view_handle) orelse return;
    const wrapIndent: text_buffer.WrapIndent = switch (indent) {
        0 => .none,
        1 => .same,
        else => .none,
    };
    object_ptr.setWrapIndent(wrapIndent);
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
    const wMethod = widthMethodFromInt(widthMethod);
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

export fn editBufferSetTabWidth(edit_handle: NativeHandle, width: u8) void {
    const object_ptr = acquireEditBuffer(edit_handle) orelse return;
    object_ptr.setTabWidth(width);
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

export fn editorViewSetWrapIndent(view_handle: NativeHandle, indent: u8) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    const wrapIndent: text_buffer.WrapIndent = switch (indent) {
        0 => .none,
        1 => .same,
        else => .none,
    };
    object_ptr.setWrapIndent(wrapIndent);
}

// EditorView selection methods - delegate to TextBufferView
export fn editorViewSetSelection(view_handle: NativeHandle, start: u32, end: u32, bgColor: ?[*]const u16, fgColor: ?[*]const u16) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.setSelection(start, end, optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor));
}

export fn editorViewResetSelection(view_handle: NativeHandle) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.resetSelection();
}

export fn editorViewGetSelection(view_handle: NativeHandle) u64 {
    const object_ptr = acquireEditorView(view_handle) orelse return std.math.maxInt(u64);
    return object_ptr.text_buffer_view.packSelectionInfo();
}

export fn editorViewSetLocalSelection(view_handle: NativeHandle, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?[*]const u16, fgColor: ?[*]const u16, flags: u8) bool {
    const object_ptr = acquireEditorView(view_handle) orelse return false;
    object_ptr.setSelectionFollowCursor(flags & 2 != 0);
    return object_ptr.setLocalSelectionBehavior(anchorX, anchorY, focusX, focusY, optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor), flags & 1 != 0, selectionBehavior(flags >> 2));
}

export fn editorViewUpdateSelection(view_handle: NativeHandle, end: u32, bgColor: ?[*]const u16, fgColor: ?[*]const u16) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.updateSelection(end, optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor));
}

export fn editorViewUpdateLocalSelection(view_handle: NativeHandle, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?[*]const u16, fgColor: ?[*]const u16, flags: u8) bool {
    const object_ptr = acquireEditorView(view_handle) orelse return false;
    object_ptr.setSelectionFollowCursor(flags & 2 != 0);
    return object_ptr.updateLocalSelectionBehavior(anchorX, anchorY, focusX, focusY, optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor), flags & 1 != 0, selectionBehavior(flags >> 2));
}

export fn editorViewResetLocalSelection(view_handle: NativeHandle) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.setSelectionFollowCursor(false);
    object_ptr.resetLocalSelection();
}

export fn editorViewConvertSelectionToCell(view_handle: NativeHandle) bool {
    const object_ptr = acquireEditorView(view_handle) orelse return false;
    return object_ptr.convertSelectionToCell();
}

export fn editorViewSetSelectionOccupancy(view_handle: NativeHandle, occupancy: u8) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.setSelectionOccupancy(selectionOccupancy(occupancy));
}

export fn editorViewGotoVisualLineEnd(view_handle: NativeHandle) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.gotoVisualLineEnd();
}

export fn editorViewSetSelectionInclusive(view_handle: NativeHandle, start: u32, end: u32, bgColor: ?[*]const u16, fgColor: ?[*]const u16) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.setSelectionInclusive(start, end, optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor));
}

export fn editorViewSetSelectionColors(view_handle: NativeHandle, bgColor: ?[*]const u16, fgColor: ?[*]const u16) void {
    const object_ptr = acquireEditorView(view_handle) orelse return;
    object_ptr.text_buffer_view.setSelectionColors(optionalPtrToRGBA(bgColor), optionalPtrToRGBA(fgColor));
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

// Image functions
fn insertImage(image: *native_image.Image, out_handle: *NativeHandle) native_image.Status {
    out_handle.* = handles.insert(.image, erasePtr(image)) catch {
        image.deinit();
        return .out_of_memory;
    };
    return .ok;
}

export fn imageInfo(data_ptr: ?[*]const u8, data_len: u32, out_info: ?*native_image.Info) u32 {
    const output = out_info orelse return @intFromEnum(native_image.Status.invalid_argument);
    if (data_len == 0 or data_ptr == null) return @intFromEnum(native_image.Status.invalid_argument);
    return @intFromEnum(native_image.inspect(globalAllocator, data_ptr.?[0..data_len], .{}, output));
}

export fn imageRetainIccCache() void {
    native_image.retainIccCache();
}

export fn imageReleaseIccCache() void {
    native_image.releaseIccCache();
}

export fn imageTestFailIccProfileCopyAllocationOnce() void {
    native_image.testFailIccProfileCopyAllocationOnce();
}

export fn imageDecode(data_ptr: ?[*]const u8, data_len: u32, out_handle: ?*NativeHandle) u32 {
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    if (data_len == 0 or data_ptr == null) return @intFromEnum(native_image.Status.invalid_argument);
    const image = native_image.decode(globalAllocator, data_ptr.?[0..data_len], .{}) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    return @intFromEnum(insertImage(image, output));
}

export fn imageCreateFromRgba(
    pixels_ptr: ?[*]const u8,
    pixels_len: u64,
    width: u32,
    height: u32,
    stride: u32,
    out_handle: ?*NativeHandle,
) u32 {
    return imageCreateFromPixels(
        pixels_ptr,
        pixels_len,
        width,
        height,
        stride,
        @intFromEnum(native_image.PixelFormat.rgba8),
        @intFromEnum(native_image.PixelAlpha.straight),
        out_handle,
    );
}

fn pixelImportOptions(stride: u32, format: u32, alpha: u32) !native_image.PixelImportOptions {
    return .{
        .stride = stride,
        .format = std.enums.fromInt(native_image.PixelFormat, format) orelse return error.InvalidArgument,
        .alpha = std.enums.fromInt(native_image.PixelAlpha, alpha) orelse return error.InvalidArgument,
    };
}

export fn imageCreateFromPixels(
    pixels_ptr: ?[*]const u8,
    pixels_len: u64,
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
    alpha: u32,
    out_handle: ?*NativeHandle,
) u32 {
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    if (pixels_len > std.math.maxInt(usize) or (pixels_len > 0 and pixels_ptr == null)) {
        return @intFromEnum(native_image.Status.invalid_argument);
    }
    const pixels = if (pixels_len == 0) "" else pixels_ptr.?[0..@intCast(pixels_len)];
    const options = pixelImportOptions(stride, format, alpha) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    const image = native_image.createFromPixels(globalAllocator, pixels, width, height, options) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    return @intFromEnum(insertImage(image, output));
}

test "pixel import FFI validates pointers and enum values without publishing a handle" {
    const pixels = [_]u8{ 3, 2, 1, 0 };
    const invalid = @intFromEnum(native_image.Status.invalid_argument);
    var handle: NativeHandle = 123;
    try std.testing.expectEqual(invalid, imageCreateFromPixels(&pixels, 4, 1, 1, 4, 2, 0, &handle));
    try std.testing.expectEqual(INVALID_HANDLE, handle);
    handle = 123;
    try std.testing.expectEqual(invalid, imageCreateFromPixels(&pixels, 4, 1, 1, 4, 0, 2, &handle));
    try std.testing.expectEqual(INVALID_HANDLE, handle);
    try std.testing.expectEqual(invalid, imageCreateFromPixels(&pixels, 4, 1, 1, 4, 0, 0, null));
    try std.testing.expectEqual(invalid, imageCreateFromPixels(null, 4, 1, 1, 4, 0, 0, &handle));
    try std.testing.expectEqual(invalid, imageCreateFromPixels(null, 0, 1, 1, 4, 0, 0, &handle));
    try std.testing.expectEqual(INVALID_HANDLE, handle);

    try std.testing.expectEqual(@as(u32, 0), imageCreateFromPixels(&pixels, 4, 1, 1, 4, 1, 1, &handle));
    defer imageDestroy(handle);
    const value = acquireImage(handle) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqualSlices(u8, &.{ 1, 2, 3, 255 }, value.pixels);
    try std.testing.expectEqual(@as(u32, 0), value.info().has_alpha);
}

export fn imageUpdatePixels(
    image_handle: NativeHandle,
    pixels_ptr: ?[*]const u8,
    pixels_len: u64,
    stride: u32,
    format: u32,
    alpha: u32,
) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    if (pixels_len > std.math.maxInt(usize) or (pixels_len > 0 and pixels_ptr == null)) {
        return @intFromEnum(native_image.Status.invalid_argument);
    }
    const pixels = if (pixels_len == 0) "" else pixels_ptr.?[0..@intCast(pixels_len)];
    const options = pixelImportOptions(stride, format, alpha) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    native_image.updatePixels(image, pixels, options) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    return @intFromEnum(native_image.Status.ok);
}

export fn imageDestroy(image_handle: NativeHandle) void {
    const token = handles.beginDestroy(image_handle, .image, native_image.Image) orelse return;
    token.ptr.deinit();
    handles.finishDestroy(token.handle);
}

test "pixel update FFI rejects invalid input before mutation or busy" {
    const pixels = [_]u8{ 3, 2, 1, 0 };
    var handle: NativeHandle = INVALID_HANDLE;
    try std.testing.expectEqual(@as(u32, 0), imageCreateFromRgba(&pixels, 4, 1, 1, 4, &handle));
    defer imageDestroy(handle);
    const value = acquireImage(handle) orelse return error.TestUnexpectedResult;
    _ = try value.ensureEncodedPng();
    const encoded = value.encoded_png.?;
    const metadata = value.info();
    const invalid = @intFromEnum(native_image.Status.invalid_argument);
    value.retain();
    try std.testing.expectEqual(invalid, imageUpdatePixels(handle, &pixels, 4, 4, 2, 0));
    try std.testing.expectEqual(invalid, imageUpdatePixels(handle, &pixels, 4, 4, 0, 2));
    try std.testing.expectEqual(invalid, imageUpdatePixels(handle, null, 4, 4, 0, 0));
    try std.testing.expectEqual(invalid, imageUpdatePixels(handle, null, 0, 4, 0, 0));
    try std.testing.expectEqual(invalid, imageUpdatePixels(handle, &pixels, 3, 4, 0, 0));
    try std.testing.expectEqual(invalid, imageUpdatePixels(handle, &pixels, 4, 3, 0, 0));
    try std.testing.expectEqual(@intFromEnum(native_image.Status.busy), imageUpdatePixels(handle, &pixels, 4, 4, 1, 1));
    try std.testing.expectEqualSlices(u8, &pixels, value.pixels);
    try std.testing.expectEqual(metadata, value.info());
    try std.testing.expectEqual(encoded.ptr, value.encoded_png.?.ptr);
    value.deinit();
    try std.testing.expectEqual(@as(u32, 0), imageUpdatePixels(handle, &pixels, 4, 4, 1, 1));
    try std.testing.expectEqualSlices(u8, &.{ 1, 2, 3, 255 }, value.pixels);
    try std.testing.expect(value.encoded_png == null);
    try std.testing.expectEqual(@intFromEnum(native_image.Status.invalid_handle), imageUpdatePixels(INVALID_HANDLE, &pixels, 4, 4, 1, 1));
}

export fn imageRetain(image_handle: NativeHandle, out_handle: ?*NativeHandle) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    if (image.ref_count == std.math.maxInt(u32)) return @intFromEnum(native_image.Status.memory_limit);
    image.retain();
    return @intFromEnum(insertImage(image, output));
}

export fn imageGetInfo(image_handle: NativeHandle, out_info: ?*native_image.Info) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const output = out_info orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = image.info();
    return @intFromEnum(native_image.Status.ok);
}

export fn imageGetPixelsPtr(image_handle: NativeHandle) ?[*]u8 {
    const image = acquireImage(image_handle) orelse return null;
    if (image.ref_count != 1) return null;
    const pixels = image.ensurePixels() catch return null;
    image.discardEncoded();
    // Callers receive mutable pixels, so opacity can no longer be proven.
    image.metadata.has_alpha = 1;
    return pixels.ptr;
}

export fn imageMaterialize(image_handle: NativeHandle) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    if (image.ref_count != 1) return @intFromEnum(native_image.Status.invalid_argument);
    _ = image.ensurePixels() catch |err| return @intFromEnum(native_image.statusFromError(err));
    return @intFromEnum(native_image.Status.ok);
}

export fn imageEnsureEncodedPng(image_handle: NativeHandle) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    _ = image.ensureEncodedPng() catch |err| return @intFromEnum(native_image.statusFromError(err));
    return @intFromEnum(native_image.Status.ok);
}

export fn imageClone(image_handle: NativeHandle, out_handle: ?*NativeHandle) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    const cloned = image.clone() catch |err| return @intFromEnum(native_image.statusFromError(err));
    return @intFromEnum(insertImage(cloned, output));
}

export fn imageCopyPixels(
    image_handle: NativeHandle,
    destination_ptr: ?[*]u8,
    destination_len: u64,
    stride: u32,
    bgra: u8,
) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    if (destination_len > std.math.maxInt(usize) or destination_ptr == null or bgra > 1) {
        return @intFromEnum(native_image.Status.invalid_argument);
    }
    const destination = destination_ptr.?[0..@intCast(destination_len)];
    return @intFromEnum(native_image.copyPixels(image, destination, stride, bgra == 1));
}

test "imageGetPixelsPtr aliases the image pixel allocation" {
    const pixels = [_]u8{ 1, 2, 3, 4, 5, 6, 7, 8 };
    var handle: NativeHandle = INVALID_HANDLE;
    try std.testing.expectEqual(
        @as(u32, @intFromEnum(native_image.Status.ok)),
        imageCreateFromRgba(&pixels, pixels.len, 2, 1, 8, &handle),
    );
    defer imageDestroy(handle);

    const pointer = imageGetPixelsPtr(handle) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqualSlices(u8, &pixels, pointer[0..pixels.len]);
    pointer[0] = 42;

    var copied: [pixels.len]u8 = undefined;
    try std.testing.expectEqual(
        @as(u32, @intFromEnum(native_image.Status.ok)),
        imageCopyPixels(handle, &copied, copied.len, 8, 0),
    );
    try std.testing.expectEqual(@as(u8, 42), copied[0]);
}

test "imageGetPixelsPtr requires exclusive ownership and invalidates encoded state" {
    const value = try native_image.createFromRgba(globalAllocator, &[_]u8{ 1, 2, 3, 255 }, 1, 1, 4);
    value.encoded_png = try globalAllocator.dupe(u8, "encoded");
    var handle: NativeHandle = INVALID_HANDLE;
    try std.testing.expectEqual(native_image.Status.ok, insertImage(value, &handle));
    defer imageDestroy(handle);

    value.retain();
    try std.testing.expectEqual(@as(?[*]u8, null), imageGetPixelsPtr(handle));
    value.deinit();

    try std.testing.expect(imageGetPixelsPtr(handle) != null);
    try std.testing.expectEqual(@as(?[]u8, null), value.encoded_png);
    try std.testing.expectEqual(@as(u32, 1), value.metadata.has_alpha);
}

test "imageEnsureEncodedPng attaches an encoding that pixel mutation discards" {
    const pixels = [_]u8{ 1, 2, 3, 255, 4, 5, 6, 255 };
    var handle: NativeHandle = INVALID_HANDLE;
    try std.testing.expectEqual(
        @as(u32, @intFromEnum(native_image.Status.ok)),
        imageCreateFromRgba(&pixels, pixels.len, 2, 1, 8, &handle),
    );
    defer imageDestroy(handle);

    try std.testing.expectEqual(
        @as(u32, @intFromEnum(native_image.Status.invalid_handle)),
        imageEnsureEncodedPng(INVALID_HANDLE),
    );
    try std.testing.expectEqual(@as(u32, @intFromEnum(native_image.Status.ok)), imageEnsureEncodedPng(handle));
    const image = acquireImage(handle) orelse return error.TestUnexpectedResult;
    try std.testing.expect(image.encoded_png != null);

    try std.testing.expect(imageGetPixelsPtr(handle) != null);
    try std.testing.expectEqual(@as(?[]u8, null), image.encoded_png);
}

test "imageRetain creates independently disposable handles without copying pixels" {
    const pixels = [_]u8{ 1, 2, 3, 255 };
    var handle: NativeHandle = INVALID_HANDLE;
    try std.testing.expectEqual(
        @as(u32, @intFromEnum(native_image.Status.ok)),
        imageCreateFromRgba(&pixels, pixels.len, 1, 1, 4, &handle),
    );
    defer imageDestroy(handle);

    var retained_handle: NativeHandle = INVALID_HANDLE;
    try std.testing.expectEqual(
        @as(u32, @intFromEnum(native_image.Status.ok)),
        imageRetain(handle, &retained_handle),
    );
    defer imageDestroy(retained_handle);
    try std.testing.expect(handle != retained_handle);
    const image = acquireImage(handle) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqual(image, acquireImage(retained_handle));

    imageDestroy(handle);
    try std.testing.expect(acquireImage(handle) == null);
    try std.testing.expectEqual(image, acquireImage(retained_handle));
}

export fn imageResize(image_handle: NativeHandle, width: u32, height: u32, filter: u32, out_handle: ?*NativeHandle) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    const resize_filter = std.enums.fromInt(native_image.ResizeFilter, filter) orelse return @intFromEnum(native_image.Status.invalid_argument);
    const resized = native_image.resize(globalAllocator, image, width, height, resize_filter) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    return @intFromEnum(insertImage(resized, output));
}

export fn imageExtract(
    image_handle: NativeHandle,
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    out_handle: ?*NativeHandle,
) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    const extracted = native_image.extract(globalAllocator, image, left, top, width, height) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    return @intFromEnum(insertImage(extracted, output));
}

export fn imageExtend(
    image_handle: NativeHandle,
    top: u32,
    right: u32,
    bottom: u32,
    left: u32,
    background_ptr: ?[*]const u8,
    out_handle: ?*NativeHandle,
) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    const background = background_ptr orelse return @intFromEnum(native_image.Status.invalid_argument);
    const extended = native_image.extend(globalAllocator, image, top, right, bottom, left, .{
        background[0], background[1], background[2], background[3],
    }) catch |err| return @intFromEnum(native_image.statusFromError(err));
    return @intFromEnum(insertImage(extended, output));
}

export fn imageTransform(image_handle: NativeHandle, operation: u32, out_handle: ?*NativeHandle) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    const transform_operation = std.enums.fromInt(native_image.Transform, operation) orelse return @intFromEnum(native_image.Status.invalid_argument);
    const transformed = native_image.transform(globalAllocator, image, transform_operation) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    return @intFromEnum(insertImage(transformed, output));
}

export fn imageComposite(
    base_handle: NativeHandle,
    overlay_handle: NativeHandle,
    left: i32,
    top: i32,
    blend: u32,
    opacity: u8,
    out_handle: ?*NativeHandle,
) u32 {
    const base = acquireImage(base_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const overlay = acquireImage(overlay_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    const blend_mode = std.enums.fromInt(native_image.Blend, blend) orelse return @intFromEnum(native_image.Status.invalid_argument);
    const composited = native_image.composite(globalAllocator, base, overlay, left, top, blend_mode, opacity) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    return @intFromEnum(insertImage(composited, output));
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
    const wMethod = widthMethodFromInt(widthMethod);

    // Check if ASCII only for optimization
    const is_ascii_only = utf8.isAsciiOnly(text);

    // Find sparse render-cluster metadata.
    var render_cluster_list: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
    defer render_cluster_list.deinit(globalAllocator);

    const tab_width: u8 = 2;
    utf8.findRenderClusterInfo(globalAllocator, text, tab_width, is_ascii_only, wMethod, &render_cluster_list) catch return false;
    const render_clusters = render_cluster_list.items;

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

        const cell_width = utf8.getWidthAt(text, if (at_special) render_clusters[special_idx - 1].byte_start else byte_offset - 1, tab_width, wMethod);
        if (cell_width == 0) {
            col += cluster_width_cols;
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
        col += cluster_width_cols;
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
