const std = @import("std");
const ansi = @import("../ansi.zig");
const buffer = @import("../buffer.zig");
const ghostty = @import("ghostty.zig");

pub const Error = std.mem.Allocator.Error || buffer.BufferError;

pub fn compose(
    allocator: std.mem.Allocator,
    state: *ghostty.RenderState,
    target: *buffer.OptimizedBuffer,
    origin_x: i32,
    origin_y: i32,
) Error!void {
    const dirty = state.dirty;
    if (dirty == .false) return;

    const rows = state.row_data.slice();
    const row_dirty = rows.items(.dirty);
    const row_cells = rows.items(.cells);
    const row_selection = rows.items(.selection);
    for (0..state.rows) |y| {
        if (dirty == .partial and !row_dirty[y]) continue;

        const dest_y = origin_y + @as(i32, @intCast(y));
        if (dest_y >= 0 and dest_y < target.getHeight()) {
            clearRow(target, origin_x, @intCast(dest_y), state.cols, state.colors.foreground, state.colors.background);
            try composeRow(
                allocator,
                row_cells[y].slice(),
                row_selection[y],
                target,
                origin_x,
                @intCast(dest_y),
                &state.colors,
            );
        }

        row_dirty[y] = false;
    }

    state.dirty = .false;
}

fn clearRow(target: *buffer.OptimizedBuffer, origin_x: i32, y: u32, cols: u16, foreground: anytype, background: anytype) void {
    const fg = color(foreground);
    const bg = color(background);
    var x: u32 = 0;
    while (x < target.getWidth()) : (x += 1) {
        const source_x = @as(i32, @intCast(x)) - origin_x;
        if (source_x < 0 or source_x >= cols) continue;
        target.set(x, y, .{
            .char = buffer.DEFAULT_SPACE_CHAR,
            .fg = fg,
            .bg = bg,
            .attributes = 0,
        });
    }
}

fn composeRow(
    allocator: std.mem.Allocator,
    cells: anytype,
    selection: ?[2]u16,
    target: *buffer.OptimizedBuffer,
    origin_x: i32,
    dest_y: u32,
    colors: *const ghostty.RenderState.Colors,
) Error!void {
    const raw_items = cells.items(.raw);
    const graphemes = cells.items(.grapheme);
    const styles = cells.items(.style);
    const text_end = if (selection != null) end: {
        var x = raw_items.len;
        while (x > 0) {
            x -= 1;
            const raw = raw_items[x];
            if (raw.wide == .spacer_tail or raw.wide == .spacer_head) continue;
            // Keep explicit spaces and gaps within text, but not unused row tails.
            if (raw.codepoint() != 0) break :end x + raw.gridWidth();
        }
        break :end 0;
    } else 0;

    cell_loop: for (raw_items, 0..) |raw, x| {
        const dest_x = origin_x + @as(i32, @intCast(x));
        if (dest_x < 0 or dest_x >= target.getWidth()) continue;
        if (raw.wide == .spacer_tail or raw.wide == .spacer_head) continue;

        const grapheme: []const u21 = if (raw.hasGrapheme()) graphemes[x] else &.{};
        const style = if (raw.hasStyling()) styles[x] else @TypeOf(styles[x]){};
        var fg = style.fg(.{ .default = colors.foreground, .palette = &colors.palette });
        var bg = style.bg(&raw, &colors.palette) orelse colors.background;
        if (style.flags.inverse) std.mem.swap(@TypeOf(fg), &fg, &bg);
        if (selection) |range| {
            if (x < text_end and x + raw.gridWidth() > range[0] and x <= range[1]) std.mem.swap(@TypeOf(fg), &fg, &bg);
        }

        var stack: [128]u8 = undefined;
        var writer: std.Io.Writer = .fixed(&stack);
        encodeCodepoint(&writer, raw.codepoint()) catch {
            try drawAllocated(allocator, target, raw, grapheme, @intCast(dest_x), dest_y, fg, bg, style);
            continue :cell_loop;
        };
        for (grapheme) |codepoint| encodeCodepoint(&writer, codepoint) catch {
            try drawAllocated(allocator, target, raw, grapheme, @intCast(dest_x), dest_y, fg, bg, style);
            continue :cell_loop;
        };

        try draw(target, writer.buffered(), raw.gridWidth(), @intCast(dest_x), dest_y, fg, bg, style);
    }
}

fn drawAllocated(
    allocator: std.mem.Allocator,
    target: *buffer.OptimizedBuffer,
    raw: anytype,
    grapheme: []const u21,
    x: u32,
    y: u32,
    foreground: anytype,
    background: anytype,
    style: anytype,
) Error!void {
    var output: std.Io.Writer.Allocating = .init(allocator);
    defer output.deinit();
    encodeCodepoint(&output.writer, raw.codepoint()) catch return error.OutOfMemory;
    for (grapheme) |codepoint| encodeCodepoint(&output.writer, codepoint) catch return error.OutOfMemory;
    try draw(target, output.written(), raw.gridWidth(), x, y, foreground, background, style);
}

fn encodeCodepoint(writer: *std.Io.Writer, codepoint: u21) std.Io.Writer.Error!void {
    if (codepoint == 0) return;
    var bytes: [4]u8 = undefined;
    const len = std.unicode.utf8Encode(codepoint, &bytes) catch return;
    try writer.writeAll(bytes[0..len]);
}

fn draw(target: *buffer.OptimizedBuffer, text: []const u8, cell_width: u8, x: u32, y: u32, foreground: anytype, background: anytype, style: anytype) buffer.BufferError!void {
    const cell_attributes = attributes(style);
    if (text.len == 0 or style.flags.invisible) {
        target.set(x, y, .{
            .char = buffer.DEFAULT_SPACE_CHAR,
            .fg = color(foreground),
            .bg = color(background),
            .attributes = cell_attributes,
        });
        return;
    }
    try target.drawGrapheme(text, cell_width, x, y, color(foreground), color(background), cell_attributes);
}

fn color(value: anytype) buffer.RGBA {
    return ansi.rgbColor(value.r, value.g, value.b, 255);
}

fn attributes(style: anytype) u32 {
    var value: u32 = 0;
    if (style.flags.bold) value |= ansi.TextAttributes.BOLD;
    if (style.flags.faint) value |= ansi.TextAttributes.DIM;
    if (style.flags.italic) value |= ansi.TextAttributes.ITALIC;
    if (style.flags.underline != .none) value |= ansi.TextAttributes.UNDERLINE;
    if (style.flags.blink) value |= ansi.TextAttributes.BLINK;
    if (style.flags.invisible) value |= ansi.TextAttributes.HIDDEN;
    if (style.flags.strikethrough) value |= ansi.TextAttributes.STRIKETHROUGH;
    return value;
}
