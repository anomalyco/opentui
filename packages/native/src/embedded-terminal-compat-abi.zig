const std = @import("std");
const compat = &@import("compatibility-context.zig").compatDefault;
const registry = &compat.registry;
const globalAllocator = compat.gpa.allocator();
const NativeHandle = @import("handles.zig").Handle;
const INVALID_HANDLE: NativeHandle = 0;
const io = compat.io_threaded.io();
const ghostty_vt_available = @import("ghostty_vt_options").available;
const ghostty_vt = if (ghostty_vt_available) @import("ghostty-vt.zig") else struct {
    const vt = struct {};
};
const embedded_terminal = if (ghostty_vt_available)
    @import("embedded-terminal/main.zig")
else
    @import("embedded-terminal/unavailable.zig");
const EmbeddedTerminal = embedded_terminal.EmbeddedTerminal;

fn acquireEmbeddedTerminal(handle: NativeHandle) ?*EmbeddedTerminal {
    return registry.acquire(handle, .embedded_terminal, EmbeddedTerminal);
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

comptime {
    std.debug.assert(@sizeOf(ExternalEmbeddedTerminalCursor) == 14);
    std.debug.assert(@sizeOf(ExternalEmbeddedTerminalKeyOptions) == 12);
    _ = ghostty_vt.vt;
}

export fn createEmbeddedTerminal(cols: u16, rows: u16, max_scrollback: u32, out_handle_ptr: ?*NativeHandle) i32 {
    const out_handle = out_handle_ptr orelse return EmbeddedTerminalStatus.invalid;
    out_handle.* = INVALID_HANDLE;
    const terminal_value = EmbeddedTerminal.init(io, globalAllocator, .{
        .cols = cols,
        .rows = rows,
        .max_scrollback = max_scrollback,
    }) catch |err| return embeddedTerminalStatus(err);
    out_handle.* = registry.insert(.embedded_terminal, @ptrCast(terminal_value)) catch {
        terminal_value.deinit();
        return EmbeddedTerminalStatus.out_of_memory;
    };
    return 0;
}

export fn destroyEmbeddedTerminal(handle: NativeHandle) void {
    const token = registry.beginDestroy(handle, .embedded_terminal, EmbeddedTerminal) orelse return;
    token.ptr.deinit();
    registry.finishDestroy(token.handle);
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
