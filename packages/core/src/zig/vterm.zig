const std = @import("std");
const ghostty_vt = @import("ghostty-vt");
const color = ghostty_vt.color;
const pagepkg = ghostty_vt.page;
const formatter = ghostty_vt.formatter;
const Screen = ghostty_vt.Screen;

// Reusable arena for stateless functions (ptyToJson, ptyToText).
// Reset after each call to reuse allocated pages - avoids mmap/munmap per call.
var stateless_arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);

pub const StyleFlags = packed struct(u8) {
    bold: bool = false,
    italic: bool = false,
    underline: bool = false,
    strikethrough: bool = false,
    inverse: bool = false,
    faint: bool = false,
    _padding: u2 = 0,

    pub fn toInt(self: StyleFlags) u8 {
        return @bitCast(self);
    }

    pub fn eql(self: StyleFlags, other: StyleFlags) bool {
        return self.toInt() == other.toInt();
    }
};

pub const CellStyle = struct {
    fg: ?color.RGB,
    bg: ?color.RGB,
    flags: StyleFlags,

    pub fn eql(self: CellStyle, other: CellStyle) bool {
        const fg_eq = if (self.fg) |a| (if (other.fg) |b| a.r == b.r and a.g == b.g and a.b == b.b else false) else other.fg == null;
        const bg_eq = if (self.bg) |a| (if (other.bg) |b| a.r == b.r and a.g == b.g and a.b == b.b else false) else other.bg == null;
        return fg_eq and bg_eq and self.flags.eql(other.flags);
    }
};

fn getStyleFromCell(
    cell: *const pagepkg.Cell,
    pin: ghostty_vt.Pin,
    palette: *const color.Palette,
    terminal_bg: ?color.RGB,
) CellStyle {
    var flags: StyleFlags = .{};
    var fg: ?color.RGB = null;
    var bg: ?color.RGB = null;

    const style = pin.style(cell);

    flags.bold = style.flags.bold;
    flags.italic = style.flags.italic;
    flags.faint = style.flags.faint;
    flags.inverse = style.flags.inverse;
    flags.strikethrough = style.flags.strikethrough;
    flags.underline = style.flags.underline != .none;

    fg = switch (style.fg_color) {
        .none => null,
        .palette => |idx| palette[idx],
        .rgb => |rgb| rgb,
    };

    bg = style.bg(cell, palette) orelse switch (cell.content_tag) {
        .bg_color_palette => palette[cell.content.color_palette],
        .bg_color_rgb => .{ .r = cell.content.color_rgb.r, .g = cell.content.color_rgb.g, .b = cell.content.color_rgb.b },
        else => null,
    };

    if (bg) |cell_bg| {
        if (terminal_bg) |term_bg| {
            if (cell_bg.r == term_bg.r and cell_bg.g == term_bg.g and cell_bg.b == term_bg.b) {
                bg = null;
            }
        }
    }

    return .{ .fg = fg, .bg = bg, .flags = flags };
}

fn writeJsonString(writer: anytype, s: []const u8) !void {
    try writer.writeByte('"');
    for (s) |c| {
        switch (c) {
            '"' => try writer.writeAll("\\\""),
            '\\' => try writer.writeAll("\\\\"),
            '\n' => try writer.writeAll("\\n"),
            '\r' => try writer.writeAll("\\r"),
            '\t' => try writer.writeAll("\\t"),
            else => {
                if (c < 0x20) {
                    try writer.print("\\u{x:0>4}", .{c});
                } else {
                    try writer.writeByte(c);
                }
            },
        }
    }
    try writer.writeByte('"');
}

fn writeColor(writer: anytype, rgb: ?color.RGB) !void {
    if (rgb) |c| {
        try writer.print("\"#{x:0>2}{x:0>2}{x:0>2}\"", .{ c.r, c.g, c.b });
    } else {
        try writer.writeAll("null");
    }
}

fn countLines(screen: *Screen) usize {
    var total: usize = 0;
    var iter = screen.pages.rowIterator(.right_down, .{ .screen = .{} }, null);
    while (iter.next()) |_| {
        total += 1;
    }
    return total;
}

fn hasEnoughLines(screen: *Screen, threshold: usize) bool {
    var count: usize = 0;
    var iter = screen.pages.rowIterator(.right_down, .{ .screen = .{} }, null);
    while (iter.next()) |_| {
        count += 1;
        if (count >= threshold) return true;
    }
    return false;
}

pub fn writeJsonOutput(
    writer: anytype,
    t: *ghostty_vt.Terminal,
    offset: usize,
    limit: ?usize,
    show_cursor: bool,
) !void {
    const screen = t.screens.active;
    const palette = &t.colors.palette.current;
    const terminal_bg = t.colors.background.get();

    const total_lines = countLines(screen);

    // Calculate cursor row in absolute screen coordinates (for inverting cursor cell)
    const cursor_abs_row: ?usize = if (show_cursor) blk: {
        const rows: usize = screen.pages.rows;
        const viewport_start = if (total_lines >= rows) total_lines - rows else 0;
        break :blk viewport_start + screen.cursor.y;
    } else null;
    const cursor_col: usize = screen.cursor.x;

    try writer.writeAll("{");
    try writer.print("\"cols\":{},\"rows\":{},", .{ screen.pages.cols, screen.pages.rows });
    try writer.print("\"cursor\":[{},{}],", .{ screen.cursor.x, screen.cursor.y });
    try writer.print("\"offset\":{},\"totalLines\":{},", .{ offset, total_lines });
    try writer.writeAll("\"lines\":[");

    var text_buf: [4096]u8 = undefined;
    var row_iter = screen.pages.rowIterator(.right_down, .{ .screen = .{} }, null);
    var row_idx: usize = 0;
    var output_idx: usize = 0;

    while (row_iter.next()) |pin| {
        if (row_idx < offset) {
            row_idx += 1;
            continue;
        }

        if (limit) |lim| {
            if (output_idx >= lim) break;
        }

        if (output_idx > 0) try writer.writeByte(',');
        try writer.writeByte('[');

        const cells = pin.cells(.all);
        var span_start: usize = 0;
        var span_len: usize = 0;
        var current_style: ?CellStyle = null;
        var text_len: usize = 0;
        var span_idx: usize = 0;

        // Check if cursor is on this row
        const is_cursor_row = if (cursor_abs_row) |crow| row_idx == crow else false;

        for (cells, 0..) |*cell, col_idx| {
            if (cell.wide == .spacer_tail) continue;

            const cp = cell.codepoint();
            const is_null = cp == 0;

            // Check if this cell is at cursor position
            const is_cursor_cell = is_cursor_row and col_idx == cursor_col;

            // Handle cursor on empty cell - emit a single-char inverted span
            if (is_null and is_cursor_cell) {
                // First flush any pending span
                if (text_len > 0) {
                    if (span_idx > 0) try writer.writeByte(',');
                    try writer.writeByte('[');
                    try writeJsonString(writer, text_buf[0..text_len]);
                    try writer.writeByte(',');
                    try writeColor(writer, current_style.?.fg);
                    try writer.writeByte(',');
                    try writeColor(writer, current_style.?.bg);
                    try writer.print(",{},{}", .{ current_style.?.flags.toInt(), span_len });
                    try writer.writeByte(']');
                    span_idx += 1;
                    text_len = 0;
                    span_len = 0;
                    current_style = null;
                }
                // Emit cursor span with space and inverse flag
                if (span_idx > 0) try writer.writeByte(',');
                try writer.writeByte('[');
                try writeJsonString(writer, " ");
                try writer.writeAll(",null,null,");
                const cursor_flags = StyleFlags{ .inverse = true };
                try writer.print("{},1", .{cursor_flags.toInt()});
                try writer.writeByte(']');
                span_idx += 1;
                continue;
            }

            if (is_null) {
                if (text_len > 0) {
                    if (span_idx > 0) try writer.writeByte(',');
                    try writer.writeByte('[');
                    try writeJsonString(writer, text_buf[0..text_len]);
                    try writer.writeByte(',');
                    try writeColor(writer, current_style.?.fg);
                    try writer.writeByte(',');
                    try writeColor(writer, current_style.?.bg);
                    try writer.print(",{},{}", .{ current_style.?.flags.toInt(), span_len });
                    try writer.writeByte(']');
                    span_idx += 1;
                    text_len = 0;
                    span_len = 0;
                }
                current_style = null;
                continue;
            }

            var style = getStyleFromCell(cell, pin, palette, terminal_bg);

            // Toggle inverse for cursor cell
            if (is_cursor_cell) {
                style.flags.inverse = !style.flags.inverse;
            }

            const style_changed = if (current_style) |cs| !cs.eql(style) else true;

            if (style_changed and text_len > 0) {
                if (span_idx > 0) try writer.writeByte(',');
                try writer.writeByte('[');
                try writeJsonString(writer, text_buf[0..text_len]);
                try writer.writeByte(',');
                try writeColor(writer, current_style.?.fg);
                try writer.writeByte(',');
                try writeColor(writer, current_style.?.bg);
                try writer.print(",{},{}", .{ current_style.?.flags.toInt(), span_len });
                try writer.writeByte(']');
                span_idx += 1;
                text_len = 0;
                span_len = 0;
            }

            if (style_changed) {
                span_start = col_idx;
                current_style = style;
            }

            const cp21: u21 = @intCast(cp);
            const len = std.unicode.utf8CodepointSequenceLength(cp21) catch 1;
            if (text_len + len <= text_buf.len) {
                _ = std.unicode.utf8Encode(cp21, text_buf[text_len..]) catch 0;
                text_len += len;
            }

            span_len += if (cell.wide == .wide) 2 else 1;
        }

        if (text_len > 0) {
            if (span_idx > 0) try writer.writeByte(',');
            try writer.writeByte('[');
            try writeJsonString(writer, text_buf[0..text_len]);
            try writer.writeByte(',');
            try writeColor(writer, current_style.?.fg);
            try writer.writeByte(',');
            try writeColor(writer, current_style.?.bg);
            try writer.print(",{},{}", .{ current_style.?.flags.toInt(), span_len });
            try writer.writeByte(']');
        }

        try writer.writeByte(']');
        row_idx += 1;
        output_idx += 1;
    }

    try writer.writeAll("]}");
}

const ReadonlyStream = @typeInfo(@TypeOf(ghostty_vt.Terminal.vtStream)).@"fn".return_type.?;

pub const PersistentTerminal = struct {
    terminal: ghostty_vt.Terminal,
    arena: std.heap.ArenaAllocator,
    stream: ?ReadonlyStream,

    /// Create an uninitialized PersistentTerminal. Must call initTerminal() after
    /// the struct is in its final memory location (heap-allocated).
    pub fn create(backing_alloc: std.mem.Allocator) PersistentTerminal {
        return .{
            .terminal = undefined,
            .arena = std.heap.ArenaAllocator.init(backing_alloc),
            .stream = null,
        };
    }

    /// Initialize the terminal. Must be called after the struct is heap-allocated
    /// so the arena's address is stable when stored in the terminal.
    pub fn initTerminal(self: *PersistentTerminal, cols: u16, rows: u16) !void {
        self.terminal = try ghostty_vt.Terminal.init(self.arena.allocator(), .{
            .cols = cols,
            .rows = rows,
            .max_scrollback = std.math.maxInt(usize),
        });
        self.terminal.modes.set(.linefeed, true);
    }

    pub fn initStream(self: *PersistentTerminal) void {
        self.stream = self.terminal.vtStream();
    }

    pub fn deinit(self: *PersistentTerminal) void {
        // Arena deinit frees everything: terminal internals, stream, and output strings
        self.arena.deinit();
    }

    pub fn allocator(self: *PersistentTerminal) std.mem.Allocator {
        return self.arena.allocator();
    }

    pub fn feed(self: *PersistentTerminal, data: []const u8) !void {
        try self.stream.?.nextSlice(data);
    }

    pub fn isReady(self: *const PersistentTerminal) bool {
        if (self.stream) |s| {
            return s.parser.state == .ground;
        }
        return true;
    }

    pub fn resize(self: *PersistentTerminal, cols: u16, rows: u16) !void {
        try self.terminal.resize(self.arena.allocator(), cols, rows);
    }

    pub fn reset(self: *PersistentTerminal) void {
        self.terminal.fullReset();
        if (self.stream) |*s| {
            s.deinit();
        }
        self.stream = self.terminal.vtStream();
    }
};

var terminals_mutex: std.Thread.Mutex = .{};
var terminals: ?std.AutoHashMap(u32, *PersistentTerminal) = null;

fn getTerminalsMap() *std.AutoHashMap(u32, *PersistentTerminal) {
    if (terminals == null) {
        terminals = std.AutoHashMap(u32, *PersistentTerminal).init(std.heap.page_allocator);
    }
    return &terminals.?;
}

/// Stateless: parse PTY input and write JSON to caller-provided buffer.
/// Returns bytes written, or 0 on error.
pub fn ptyToJson(
    input_ptr: [*]const u8,
    input_len: usize,
    cols: u16,
    rows: u16,
    offset: usize,
    limit: usize,
    out_ptr: [*]u8,
    max_len: usize,
) usize {
    // Reset arena after use - keeps allocated pages for next call
    defer _ = stateless_arena.reset(.retain_capacity);
    const alloc = stateless_arena.allocator();

    const input = input_ptr[0..input_len];
    const lim: ?usize = if (limit == 0) null else limit;
    const out_buffer = out_ptr[0..max_len];

    var t: ghostty_vt.Terminal = ghostty_vt.Terminal.init(alloc, .{
        .cols = cols,
        .rows = rows,
        .max_scrollback = std.math.maxInt(usize),
    }) catch return 0;

    t.modes.set(.linefeed, true);

    var stream = t.vtStream();
    defer stream.deinit();

    if (lim) |line_limit| {
        const chunk_size: usize = 4096;
        const threshold = line_limit + offset + 20;
        var pos: usize = 0;

        while (pos < input.len) {
            const end = @min(pos + chunk_size, input.len);
            stream.nextSlice(input[pos..end]) catch return 0;
            pos = end;

            if (stream.parser.state == .ground) {
                if (hasEnoughLines(t.screens.active, threshold)) {
                    break;
                }
            }
        }
    } else {
        stream.nextSlice(input) catch return 0;
    }

    // Write directly to the caller-provided buffer
    var fbs = std.io.fixedBufferStream(out_buffer);
    writeJsonOutput(fbs.writer(), &t, offset, lim, false) catch return 0;

    return fbs.pos;
}

/// Stateless: parse PTY input and write plain text to caller-provided buffer.
/// Returns bytes written, or 0 on error.
pub fn ptyToText(
    input_ptr: [*]const u8,
    input_len: usize,
    cols: u16,
    rows: u16,
    out_ptr: [*]u8,
    max_len: usize,
) usize {
    // Reset arena after use - keeps allocated pages for next call
    defer _ = stateless_arena.reset(.retain_capacity);
    const alloc = stateless_arena.allocator();

    const input = input_ptr[0..input_len];
    const out_buffer = out_ptr[0..max_len];

    var t: ghostty_vt.Terminal = ghostty_vt.Terminal.init(alloc, .{
        .cols = cols,
        .rows = rows,
        .max_scrollback = std.math.maxInt(usize),
    }) catch return 0;

    t.modes.set(.linefeed, true);

    var stream = t.vtStream();
    defer stream.deinit();

    stream.nextSlice(input) catch return 0;

    // TerminalFormatter requires std.Io.Writer.Allocating, so write to temp buffer first
    var builder: std.Io.Writer.Allocating = .init(alloc);
    var fmt: formatter.TerminalFormatter = formatter.TerminalFormatter.init(&t, .plain);
    fmt.format(&builder.writer) catch return 0;

    const temp_output = builder.writer.buffered();
    const copy_len = @min(temp_output.len, max_len);
    @memcpy(out_buffer[0..copy_len], temp_output[0..copy_len]);

    return copy_len;
}

pub fn createTerminal(id: u32, cols: u32, rows: u32) bool {
    terminals_mutex.lock();
    defer terminals_mutex.unlock();

    const map = getTerminalsMap();

    if (map.get(id)) |existing| {
        existing.deinit();
        std.heap.page_allocator.destroy(existing);
        _ = map.remove(id);
    }

    // Two-phase init: first allocate struct to heap, then init terminal in-place.
    // This ensures the arena's address is stable when stored in the terminal.
    const term_ptr = std.heap.page_allocator.create(PersistentTerminal) catch return false;
    term_ptr.* = PersistentTerminal.create(std.heap.page_allocator);

    term_ptr.initTerminal(@intCast(cols), @intCast(rows)) catch {
        term_ptr.arena.deinit();
        std.heap.page_allocator.destroy(term_ptr);
        return false;
    };

    term_ptr.initStream();

    map.put(id, term_ptr) catch {
        term_ptr.deinit();
        std.heap.page_allocator.destroy(term_ptr);
        return false;
    };

    return true;
}

pub fn destroyTerminal(id: u32) void {
    terminals_mutex.lock();
    defer terminals_mutex.unlock();

    const map = getTerminalsMap();
    if (map.get(id)) |term| {
        term.deinit();
        std.heap.page_allocator.destroy(term);
        _ = map.remove(id);
    }
}

pub fn feedTerminal(id: u32, data_ptr: [*]const u8, data_len: usize) bool {
    terminals_mutex.lock();
    defer terminals_mutex.unlock();

    const map = getTerminalsMap();
    const term = map.get(id) orelse return false;
    term.feed(data_ptr[0..data_len]) catch return false;
    return true;
}

pub fn resizeTerminal(id: u32, cols: u32, rows: u32) bool {
    terminals_mutex.lock();
    defer terminals_mutex.unlock();

    const map = getTerminalsMap();
    const term = map.get(id) orelse return false;
    term.resize(@intCast(cols), @intCast(rows)) catch return false;
    return true;
}

pub fn resetTerminal(id: u32) bool {
    terminals_mutex.lock();
    defer terminals_mutex.unlock();

    const map = getTerminalsMap();
    const term = map.get(id) orelse return false;
    term.reset();
    return true;
}

/// Write terminal JSON to caller-provided buffer. Returns bytes written.
pub fn getTerminalJson(id: u32, offset: u32, limit: u32, out_ptr: [*]u8, max_len: usize) usize {
    terminals_mutex.lock();
    defer terminals_mutex.unlock();

    const map = getTerminalsMap();
    const term = map.get(id) orelse return 0;

    const lim: ?usize = if (limit == 0) null else @intCast(limit);
    const out_buffer = out_ptr[0..max_len];

    var fbs = std.io.fixedBufferStream(out_buffer);
    writeJsonOutput(fbs.writer(), &term.terminal, @intCast(offset), lim, true) catch return 0;

    return fbs.pos;
}

/// Write terminal plain text to caller-provided buffer. Returns bytes written.
pub fn getTerminalText(id: u32, out_ptr: [*]u8, max_len: usize) usize {
    terminals_mutex.lock();
    defer terminals_mutex.unlock();

    const map = getTerminalsMap();
    const term = map.get(id) orelse return 0;

    const out_buffer = out_ptr[0..max_len];

    // TerminalFormatter requires std.Io.Writer.Allocating, so write to temp buffer first
    var builder: std.Io.Writer.Allocating = .init(term.allocator());
    var fmt: formatter.TerminalFormatter = formatter.TerminalFormatter.init(&term.terminal, .plain);
    fmt.format(&builder.writer) catch return 0;

    const temp_output = builder.writer.buffered();
    const copy_len = @min(temp_output.len, max_len);
    @memcpy(out_buffer[0..copy_len], temp_output[0..copy_len]);

    return copy_len;
}

/// Write terminal cursor position JSON to caller-provided buffer. Returns bytes written.
pub fn getTerminalCursor(id: u32, out_ptr: [*]u8, max_len: usize) usize {
    terminals_mutex.lock();
    defer terminals_mutex.unlock();

    const map = getTerminalsMap();
    const term = map.get(id) orelse return 0;

    const screen = term.terminal.screens.active;
    const out_buffer = out_ptr[0..max_len];

    var fbs = std.io.fixedBufferStream(out_buffer);
    fbs.writer().print("[{},{}]", .{ screen.cursor.x, screen.cursor.y }) catch return 0;

    return fbs.pos;
}

pub fn isTerminalReady(id: u32) i32 {
    terminals_mutex.lock();
    defer terminals_mutex.unlock();

    const map = getTerminalsMap();
    const term = map.get(id) orelse return -1;

    return if (term.isReady()) 1 else 0;
}
