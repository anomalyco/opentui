//! An independent decoder for encoded frames: a Ghostty VT terminal, and the rule that its screen
//! shows a renderer's cells. Shared by the twin parity harness and the output simulation.
const std = @import("std");
const testing = std.testing;
const ghostty_vt = @import("../ghostty-vt.zig");
const ansi = @import("../ansi.zig");
const gp = @import("../grapheme.zig");
const buffer = @import("../buffer.zig");

pub const Terminal = ghostty_vt.vt.Terminal;

pub fn newTerminal(width: u32, height: u32) !Terminal {
    var terminal: Terminal = try .init(testing.io, testing.allocator, .{ .cols = @intCast(width), .rows = @intCast(height) });
    var stream = terminal.vtStream();
    defer stream.deinit();
    // Grapheme clustering, as the renderer assumes.
    stream.nextSlice("\x1b[?2027h");
    return terminal;
}

/// A renderer's cells, borrowed from a buffer or from a copy of one.
pub const Cells = struct {
    width: u32,
    height: u32,
    char: []const u32,
    fg: []const ansi.RGBA,
    bg: []const ansi.RGBA,
    attributes: []const u32,

    pub fn of(target: *const buffer.OptimizedBuffer) Cells {
        return .{ .width = target.width, .height = target.height, .char = target.buffer.char, .fg = target.buffer.fg, .bg = target.buffer.bg, .attributes = target.buffer.attributes };
    }
};

pub const Mismatch = struct { x: u32, y: u32, field: []const u8 };

/// The first cell where the terminal's active screen does not show `cells`, or null.
/// Grapheme cells are skipped; colors are compared where the terminal holds RGB.
pub fn mismatch(terminal: *Terminal, cells: Cells) ?Mismatch {
    const pages = &terminal.screens.active.pages;
    for (0..cells.height) |y| for (0..cells.width) |x| {
        const index = y * cells.width + x;
        const char = cells.char[index];
        if (char & gp.CHAR_TYPE_MASK != 0) continue;
        const at: Mismatch = .{ .x = @intCast(x), .y = @intCast(y), .field = "" };
        const decoded = pages.getCell(.{ .active = .{ .x = @intCast(x), .y = @intCast(y) } }) orelse return withField(at, "cell");
        const codepoint: u32 = decoded.cell.codepoint();
        const glyph = if (char == 0) ' ' else char;
        if (glyph != (if (codepoint == 0) ' ' else codepoint)) return withField(at, "char");
        const style = decoded.style();
        const bg = cells.bg[index];
        switch (style.bg_color) {
            .rgb => |rgb| if (!std.meta.eql([3]u8{ ansi.red(bg), ansi.green(bg), ansi.blue(bg) }, [3]u8{ rgb.r, rgb.g, rgb.b })) return withField(at, "bg"),
            else => {},
        }
        const fg = cells.fg[index];
        if (glyph != ' ') switch (style.fg_color) {
            .rgb => |rgb| if (!std.meta.eql([3]u8{ ansi.red(fg), ansi.green(fg), ansi.blue(fg) }, [3]u8{ rgb.r, rgb.g, rgb.b })) return withField(at, "fg"),
            else => {},
        };
        const attributes = cells.attributes[index];
        if ((attributes & ansi.TextAttributes.BOLD != 0) != style.flags.bold) return withField(at, "bold");
        if ((attributes & ansi.TextAttributes.ITALIC != 0) != style.flags.italic) return withField(at, "italic");
        if ((attributes & ansi.TextAttributes.INVERSE != 0) != style.flags.inverse) return withField(at, "inverse");
        if ((attributes & ansi.TextAttributes.STRIKETHROUGH != 0) != style.flags.strikethrough) return withField(at, "strikethrough");
    };
    return null;
}

fn withField(at: Mismatch, field: []const u8) Mismatch {
    var result = at;
    result.field = field;
    return result;
}

pub fn expectScreen(terminal: *Terminal, cells: Cells) !void {
    if (mismatch(terminal, cells)) |found| {
        std.debug.print("decoded screen differs at {d},{d}: {s}\n", .{ found.x, found.y, found.field });
        return error.TestExpectedEqual;
    }
}
