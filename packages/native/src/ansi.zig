const std = @import("std");
const Allocator = std.mem.Allocator;

/// Packed color with embedded metadata.
///
/// Each of the four u16 components stores an 8-bit channel value in its low
/// byte and one byte of a 32-bit metadata word in its high byte:
///
///   component[i] = channel_byte | (meta_byte << 8)
///
/// The metadata encodes a ColorIntent (rgb, indexed, or default) and an
/// optional ANSI palette slot index. This layout keeps color + intent in a
/// single 64-bit value so the renderer can compare current and next frame
/// colors with exact integer equality, and palette intent survives the
/// TypeScript/native boundary without a sidecar field.
///
/// Use the constructor functions (rgbColor, indexedColor, defaultColor,
/// rgbaFromFloats) to build values, and the accessor functions (red, green,
/// blue, alpha, intent, slot) to read them.
pub const RGBA = [4]u16;

/// Records the original color intent so the renderer emits the right ANSI
/// sequence: literal RGB (38;2;r;g;b), indexed palette (38;5;n), or terminal
/// default (39/49).
pub const ColorIntent = enum(u8) {
    rgb = 0,
    indexed = 1,
    default = 2,
};

pub const AnsiError = error{
    InvalidFormat,
    WriteFailed,
};

/// Standard ANSI 16-color palette RGB values (colors 0-15).
pub const ANSI16_RGB = [_][3]u8{
    .{ 0x00, 0x00, 0x00 },
    .{ 0x80, 0x00, 0x00 },
    .{ 0x00, 0x80, 0x00 },
    .{ 0x80, 0x80, 0x00 },
    .{ 0x00, 0x00, 0x80 },
    .{ 0x80, 0x00, 0x80 },
    .{ 0x00, 0x80, 0x80 },
    .{ 0xc0, 0xc0, 0xc0 },
    .{ 0x80, 0x80, 0x80 },
    .{ 0xff, 0x00, 0x00 },
    .{ 0x00, 0xff, 0x00 },
    .{ 0xff, 0xff, 0x00 },
    .{ 0x00, 0x00, 0xff },
    .{ 0xff, 0x00, 0xff },
    .{ 0x00, 0xff, 0xff },
    .{ 0xff, 0xff, 0xff },
};

/// The six intensity levels used by ANSI 256-color cube (indices 16-231).
pub const ANSI_256_CUBE_LEVELS = [_]u8{ 0, 95, 135, 175, 215, 255 };

/// Quantize a 0.0-1.0 float channel to a 0-255 byte. Clamps out-of-range
/// and non-finite inputs.
pub fn rgbaComponentToU8(component: f32) u8 {
    if (!std.math.isFinite(component)) return 0;

    const clamped = std.math.clamp(component, 0.0, 1.0);
    return @intFromFloat(@round(clamped * 255.0));
}

/// Convert a 0-255 byte back to a 0.0-1.0 float.
pub inline fn u8ToComponent(component: u8) f32 {
    return @as(f32, @floatFromInt(component)) / 255.0;
}

/// Pack a ColorIntent and palette slot into a 32-bit metadata word.
/// Layout: bits 0-7 = slot, bits 8-9 = intent.
pub fn packMeta(intent_value: ColorIntent, slot_value: u8) u32 {
    return @as(u32, slot_value) | (@as(u32, @intFromEnum(intent_value)) << 8);
}

/// Build an RGBA value from 8-bit channels and a metadata word.
/// Each u16 component gets channel in the low byte, one metadata byte in
/// the high byte. See the RGBA doc comment for the full layout.
pub fn packRGBA8(r: u8, g: u8, b: u8, a: u8, meta: u32) RGBA {
    return .{
        @as(u16, r) | (@as(u16, @truncate(meta)) << 8),
        @as(u16, g) | (@as(u16, @truncate(meta >> 8)) << 8),
        @as(u16, b) | (@as(u16, @truncate(meta >> 16)) << 8),
        @as(u16, a) | (@as(u16, @truncate(meta >> 24)) << 8),
    };
}

pub inline fn red(c: RGBA) u8 {
    return @truncate(c[0]);
}

pub inline fn green(c: RGBA) u8 {
    return @truncate(c[1]);
}

pub inline fn blue(c: RGBA) u8 {
    return @truncate(c[2]);
}

pub inline fn alpha(c: RGBA) u8 {
    return @truncate(c[3]);
}

pub inline fn redF(c: RGBA) f32 {
    return u8ToComponent(red(c));
}

pub inline fn greenF(c: RGBA) f32 {
    return u8ToComponent(green(c));
}

pub inline fn blueF(c: RGBA) f32 {
    return u8ToComponent(blue(c));
}

pub inline fn alphaF(c: RGBA) f32 {
    return u8ToComponent(alpha(c));
}

/// Reassemble the 32-bit metadata word from the high bytes of each component.
pub fn getMeta(c: RGBA) u32 {
    return @as(u32, c[0] >> 8) |
        (@as(u32, c[1] >> 8) << 8) |
        (@as(u32, c[2] >> 8) << 16) |
        (@as(u32, c[3] >> 8) << 24);
}

/// Returns the color intent (rgb, indexed, or default).
pub inline fn intent(c: RGBA) ColorIntent {
    return switch (@as(u8, @truncate(getMeta(c) >> 8))) {
        1 => .indexed,
        2 => .default,
        else => .rgb,
    };
}

/// Returns the ANSI palette slot (0-255). Only meaningful when intent is .indexed.
pub inline fn slot(c: RGBA) u8 {
    return @truncate(getMeta(c));
}

/// Copy a color with different metadata, preserving the RGBA channels.
pub fn withMeta(c: RGBA, meta: u32) RGBA {
    return packRGBA8(red(c), green(c), blue(c), alpha(c), meta);
}

/// Create a literal RGB color. The renderer emits `38;2;r;g;b`.
pub fn rgbColor(r: u8, g: u8, b: u8, a: u8) RGBA {
    return packRGBA8(r, g, b, a, packMeta(.rgb, 0));
}

/// Create a literal RGB color from 0.0-1.0 float channels. Values are
/// quantized to 8-bit.
pub fn rgbaFromFloats(r: f32, g: f32, b: f32, a: f32) RGBA {
    return rgbColor(rgbaComponentToU8(r), rgbaComponentToU8(g), rgbaComponentToU8(b), rgbaComponentToU8(a));
}

/// Create an indexed ANSI color. Stores both the palette slot and an RGB
/// snapshot so alpha blending and non-ANSI renderers still work. The
/// renderer emits `38;5;index`.
pub fn indexedColor(index: u8, r: u8, g: u8, b: u8) RGBA {
    return packRGBA8(r, g, b, 255, packMeta(.indexed, index));
}

/// Create a terminal-default color. The renderer emits SGR 39/49 so the
/// terminal picks its configured foreground or background.
pub fn defaultColor(r: u8, g: u8, b: u8, a: u8) RGBA {
    return packRGBA8(r, g, b, a, packMeta(.default, 0));
}

/// Shorthand for rgbColor with full opacity.
pub fn u8RgbToRgba(r: u8, g: u8, b: u8) RGBA {
    return rgbColor(r, g, b, 255);
}

/// Convert an ANSI 256-color palette index to an RGB color. Handles
/// the three regions: base 16 colors, 6x6x6 color cube, and grayscale ramp.
pub fn fallbackAnsi256Color(index: usize) RGBA {
    if (index < ANSI16_RGB.len) {
        return u8RgbToRgba(ANSI16_RGB[index][0], ANSI16_RGB[index][1], ANSI16_RGB[index][2]);
    }

    if (index < 232) {
        const cube_index = index - 16;
        const r = ANSI_256_CUBE_LEVELS[(cube_index / 36) % 6];
        const g = ANSI_256_CUBE_LEVELS[(cube_index / 6) % 6];
        const b = ANSI_256_CUBE_LEVELS[cube_index % 6];
        return u8RgbToRgba(r, g, b);
    }

    const gray_value: u8 = @intCast(8 + (index - 232) * 10);
    return u8RgbToRgba(gray_value, gray_value, gray_value);
}

/// Squared Euclidean distance between two colors in RGB space (ignores alpha).
pub fn colorDistanceSquared(a: RGBA, b: RGBA) f32 {
    const dr = @as(f32, @floatFromInt(red(a))) - @as(f32, @floatFromInt(red(b)));
    const dg = @as(f32, @floatFromInt(green(a))) - @as(f32, @floatFromInt(green(b)));
    const db = @as(f32, @floatFromInt(blue(a))) - @as(f32, @floatFromInt(blue(b)));
    return dr * dr + dg * dg + db * db;
}

/// Pack the RGB channels into a 24-bit integer (0xRRGGBB). Ignores alpha
/// and metadata.
pub fn rgbaToRgb24(rgba: RGBA) u32 {
    return (@as(u32, red(rgba)) << 16) | (@as(u32, green(rgba)) << 8) | @as(u32, blue(rgba));
}

/// ANSI escape sequence constants and writer helpers for terminal output.
pub const ANSI = struct {
    pub const reset = "\x1b[0m";
    pub const clear = "\x1b[2J";
    pub const home = "\x1b[H";
    pub const clearAndHome = "\x1b[H\x1b[2J";
    pub const eraseToEndOfLine = "\x1b[K";
    pub const hideCursor = "\x1b[?25l";
    pub const showCursor = "\x1b[?25h";
    pub const defaultCursorStyle = "\x1b[0 q";
    pub const queryPixelSize = "\x1b[14t";
    pub const nextLine = "\x1b[E";

    // Direct writing to any writer - the most efficient option
    pub fn moveToOutput(writer: anytype, x: u32, y: u32) AnsiError!void {
        writer.print("\x1b[{d};{d}H", .{ y, x }) catch return AnsiError.WriteFailed;
    }

    pub fn fgColorOutput(writer: anytype, r: u8, g: u8, b: u8) AnsiError!void {
        writer.print("\x1b[38;2;{d};{d};{d}m", .{ r, g, b }) catch return AnsiError.WriteFailed;
    }

    pub fn fgIndexedColorOutput(writer: anytype, index: u8) AnsiError!void {
        writer.print("\x1b[38;5;{d}m", .{index}) catch return AnsiError.WriteFailed;
    }

    pub fn fgDefaultOutput(writer: anytype) AnsiError!void {
        writer.writeAll("\x1b[39m") catch return AnsiError.WriteFailed;
    }

    pub fn bgColorOutput(writer: anytype, r: u8, g: u8, b: u8) AnsiError!void {
        writer.print("\x1b[48;2;{d};{d};{d}m", .{ r, g, b }) catch return AnsiError.WriteFailed;
    }

    pub fn bgIndexedColorOutput(writer: anytype, index: u8) AnsiError!void {
        writer.print("\x1b[48;5;{d}m", .{index}) catch return AnsiError.WriteFailed;
    }

    pub fn bgDefaultOutput(writer: anytype) AnsiError!void {
        writer.writeAll("\x1b[49m") catch return AnsiError.WriteFailed;
    }

    // Text attribute constants
    pub const bold = "\x1b[1m";
    pub const dim = "\x1b[2m";
    pub const italic = "\x1b[3m";
    pub const underline = "\x1b[4m";
    pub const blink = "\x1b[5m";
    pub const inverse = "\x1b[7m";
    pub const hidden = "\x1b[8m";
    pub const strikethrough = "\x1b[9m";

    // Cursor styles
    pub const cursorBlock = "\x1b[2 q";
    pub const cursorBlockBlink = "\x1b[1 q";
    pub const cursorLine = "\x1b[6 q";
    pub const cursorLineBlink = "\x1b[5 q";
    pub const cursorUnderline = "\x1b[4 q";
    pub const cursorUnderlineBlink = "\x1b[3 q";

    pub fn cursorColorOutputWriter(writer: anytype, r: u8, g: u8, b: u8) AnsiError!void {
        writer.print("\x1b]12;#{x:0>2}{x:0>2}{x:0>2}\x07", .{ r, g, b }) catch return AnsiError.WriteFailed;
    }

    pub fn explicitWidthOutput(writer: anytype, width: u32, text: []const u8) AnsiError!void {
        writer.print("\x1b]66;w={d};{s}\x1b\\", .{ width, text }) catch return AnsiError.WriteFailed;
    }

    pub const resetCursorColor = "\x1b]112\x07";
    pub const resetCursorColorFallback = "\x1b]12;default\x07";
    pub const resetMousePointer = "\x1b]22;\x1b\\";

    // OSC 11 - Set terminal background color
    pub fn setTerminalBgColorOutput(writer: anytype, r: u8, g: u8, b: u8) AnsiError!void {
        writer.print("\x1b]11;rgb:{x:0>2}/{x:0>2}/{x:0>2}\x07", .{ r, g, b }) catch return AnsiError.WriteFailed;
    }

    // OSC 111 - Reset terminal background color to default
    pub const resetTerminalBgColor = "\x1b]111\x07";
    pub const saveCursorState = "\x1b[s";
    pub const restoreCursorState = "\x1b[u";

    pub fn setMousePointerOutput(writer: anytype, shape: []const u8) AnsiError!void {
        writer.print("\x1b]22;{s}\x1b\\", .{shape}) catch return AnsiError.WriteFailed;
    }

    pub const switchToAlternateScreen = "\x1b[?1049h";
    pub const switchToMainScreen = "\x1b[?1049l";

    pub const enableMouseTracking = "\x1b[?1000h";
    pub const disableMouseTracking = "\x1b[?1000l";
    pub const enableButtonEventTracking = "\x1b[?1002h";
    pub const disableButtonEventTracking = "\x1b[?1002l";
    pub const enableAnyEventTracking = "\x1b[?1003h";
    pub const disableAnyEventTracking = "\x1b[?1003l";
    pub const enableSGRMouseMode = "\x1b[?1006h";
    pub const disableSGRMouseMode = "\x1b[?1006l";
    pub const mouseSetPixels = "\x1b[?1002;1003;1004;1016h";

    // Terminal capability queries
    pub const primaryDeviceAttrs = "\x1b[c";
    pub const tertiaryDeviceAttrs = "\x1b[=c";
    pub const deviceStatusReport = "\x1b[5n";
    pub const xtversion = "\x1b[>0q";
    pub const decrqmFocus = "\x1b[?1004$p";
    pub const decrqmSgrPixels = "\x1b[?1016$p";
    pub const decrqmBracketedPaste = "\x1b[?2004$p";
    pub const decrqmSync = "\x1b[?2026$p";
    pub const decrqmUnicode = "\x1b[?2027$p";
    pub const decrqmColorScheme = "\x1b[?2031$p";
    pub const csiUQuery = "\x1b[?u";
    pub const xtgettcapMs = "\x1bP+q4d73\x1b\\";
    pub const kittyGraphicsQuery = "\x1b_Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\";
    pub const notificationQueries = "\x1b]99;i=opentui-notifications:p=?;\x1b\\\x1b]1337;Capabilities\x1b\\";

    pub const capabilityQueriesBase = xtgettcapMs ++
        decrqmSgrPixels ++
        decrqmUnicode ++
        decrqmColorScheme ++
        decrqmFocus ++
        decrqmBracketedPaste ++
        decrqmSync;

    pub const capabilityQueries = capabilityQueriesBase ++ csiUQuery ++ notificationQueries;
    pub const capabilityQueriesFootIsBroken = capabilityQueriesBase ++ csiUQuery;

    // tmux DCS passthrough wrapper (ESC chars doubled)
    pub const tmuxDcsStart = "\x1bPtmux;";
    pub const tmuxDcsEnd = "\x1b\\";

    // GNU Screen DCS passthrough wrapper (no tmux prefix)
    pub const screenDcsStart = "\x1bP";
    pub const screenDcsEnd = "\x1b\\";

    pub fn wrapForTmux(comptime seq: []const u8) []const u8 {
        comptime {
            var result: []const u8 = tmuxDcsStart;
            for (seq) |c| {
                if (c == '\x1b') {
                    result = result ++ "\x1b\x1b";
                } else {
                    result = result ++ &[_]u8{c};
                }
            }
            return result ++ tmuxDcsEnd;
        }
    }

    pub const kittyGraphicsQueryTmux = wrapForTmux(kittyGraphicsQuery);
    pub const primaryDeviceAttrsTmux = wrapForTmux(primaryDeviceAttrs);
    pub const capabilityQueriesTmux = wrapForTmux(capabilityQueriesBase) ++ csiUQuery ++ notificationQueries;
    pub const capabilityQueriesFootIsBrokenTmux = wrapForTmux(capabilityQueriesBase) ++ csiUQuery;
    pub const sixelGeometryQuery = "\x1b[?2;1;0S";
    pub const cursorPositionRequest = "\x1b[6n";
    pub const explicitWidthQuery = "\x1b]66;w=1; \x1b\\";
    pub const scaledTextQuery = "\x1b]66;s=2; \x1b\\";

    // Focus tracking
    pub const focusSet = "\x1b[?1004h";
    pub const focusReset = "\x1b[?1004l";

    // Sync
    pub const syncSet = "\x1b[?2026h";
    pub const syncReset = "\x1b[?2026l";

    // Unicode
    pub const unicodeSet = "\x1b[?2027h";
    pub const unicodeReset = "\x1b[?2027l";

    // Bracketed paste
    pub const bracketedPasteSet = "\x1b[?2004h";
    pub const bracketedPasteReset = "\x1b[?2004l";

    // Color scheme
    pub const colorSchemeSet = "\x1b[?2031h";
    pub const colorSchemeReset = "\x1b[?2031l";
    pub const oscThemeQueries = "\x1b]10;?\x07\x1b]11;?\x07";

    // Key encoding
    pub const csiUPush = "\x1b[>{d}u";
    pub const csiUPop = "\x1b[<u";

    // modifyOtherKeys mode
    pub const modifyOtherKeysSet = "\x1b[>4;1m";
    pub const modifyOtherKeysReset = "\x1b[>4;0m";

    // Movement and erase
    pub const reverseIndex = "\x1bM";
    pub const eraseBelowCursor = "\x1b[J";

    // OSC 0 - Set window title
    pub const setTerminalTitle = "\x1b]0;{s}\x07";

    pub fn setTerminalTitleOutput(writer: anytype, title: []const u8) AnsiError!void {
        writer.print(setTerminalTitle, .{title}) catch return AnsiError.WriteFailed;
    }

    pub fn makeRoomForRendererOutput(writer: anytype, height: u32) AnsiError!void {
        if (height > 1) {
            var i: u32 = 0;
            while (i < height - 1) : (i += 1) {
                writer.writeByte('\n') catch return AnsiError.WriteFailed;
            }
        }
    }
};

pub const TextAttributes = struct {
    pub const NONE: u8 = 0;
    pub const BOLD: u8 = 1 << 0;
    pub const DIM: u8 = 1 << 1;
    pub const ITALIC: u8 = 1 << 2;
    pub const UNDERLINE: u8 = 1 << 3;
    pub const BLINK: u8 = 1 << 4;
    pub const INVERSE: u8 = 1 << 5;
    pub const HIDDEN: u8 = 1 << 6;
    pub const STRIKETHROUGH: u8 = 1 << 7;

    // Constants for attribute bit packing
    pub const ATTRIBUTE_BASE_BITS: u5 = 8;
    pub const ATTRIBUTE_BASE_MASK: u32 = 0xFF;

    // Constants for link_id packing (bits 8-31)
    pub const LINK_ID_BITS: u8 = 24;
    pub const LINK_ID_SHIFT: u5 = ATTRIBUTE_BASE_BITS;
    pub const LINK_ID_PAYLOAD_MASK: u32 = ((@as(u32, 1) << LINK_ID_BITS) - 1);
    pub const LINK_ID_MASK: u32 = LINK_ID_PAYLOAD_MASK << LINK_ID_SHIFT;

    /// Extract the base 8 bits of attributes from a u32 attribute value
    pub fn getBaseAttributes(attr: u32) u8 {
        return @intCast(attr & ATTRIBUTE_BASE_MASK);
    }

    /// Extract the link_id from bits 8-31 of attributes
    pub fn getLinkId(attr: u32) u32 {
        return (attr & LINK_ID_MASK) >> LINK_ID_SHIFT;
    }

    /// Set the link_id in an attribute value, preserving base attributes
    pub fn setLinkId(attr: u32, link_id: u32) u32 {
        const base = attr & ATTRIBUTE_BASE_MASK;
        const link_bits = (link_id & LINK_ID_PAYLOAD_MASK) << LINK_ID_SHIFT;
        return base | link_bits;
    }

    /// Check if an attribute value has a link
    pub fn hasLink(attr: u32) bool {
        return getLinkId(attr) != 0;
    }

    pub fn applyAttributesOutputWriter(writer: anytype, attributes: u32) AnsiError!void {
        const base_attr = getBaseAttributes(attributes);
        if (base_attr & BOLD != 0) writer.writeAll(ANSI.bold) catch return AnsiError.WriteFailed;
        if (base_attr & DIM != 0) writer.writeAll(ANSI.dim) catch return AnsiError.WriteFailed;
        if (base_attr & ITALIC != 0) writer.writeAll(ANSI.italic) catch return AnsiError.WriteFailed;
        if (base_attr & UNDERLINE != 0) writer.writeAll(ANSI.underline) catch return AnsiError.WriteFailed;
        if (base_attr & BLINK != 0) writer.writeAll(ANSI.blink) catch return AnsiError.WriteFailed;
        if (base_attr & INVERSE != 0) writer.writeAll(ANSI.inverse) catch return AnsiError.WriteFailed;
        if (base_attr & HIDDEN != 0) writer.writeAll(ANSI.hidden) catch return AnsiError.WriteFailed;
        if (base_attr & STRIKETHROUGH != 0) writer.writeAll(ANSI.strikethrough) catch return AnsiError.WriteFailed;
    }
};

const HSV_SECTOR_COUNT = 6;
const HUE_SECTOR_DEGREES = 60.0;

/// Convert HSV to an opaque RGB color. Hue is in degrees (wraps at 360),
/// saturation and value are 0.0-1.0.
pub fn hsvToRgb(h: f32, s: f32, v: f32) RGBA {
    const clamped_h = @mod(h, 360.0);
    const clamped_s = std.math.clamp(s, 0.0, 1.0);
    const clamped_v = std.math.clamp(v, 0.0, 1.0);

    const sector = @as(u8, @intFromFloat(@floor(clamped_h / HUE_SECTOR_DEGREES))) % HSV_SECTOR_COUNT;
    const fractional = clamped_h / HUE_SECTOR_DEGREES - @floor(clamped_h / HUE_SECTOR_DEGREES);

    const p = clamped_v * (1.0 - clamped_s);
    const q = clamped_v * (1.0 - fractional * clamped_s);
    const t = clamped_v * (1.0 - (1.0 - fractional) * clamped_s);

    const rgb = switch (sector) {
        0 => .{ clamped_v, t, p },
        1 => .{ q, clamped_v, p },
        2 => .{ p, clamped_v, t },
        3 => .{ p, q, clamped_v },
        4 => .{ t, p, clamped_v },
        5 => .{ clamped_v, p, q },
        else => unreachable,
    };

    return rgbaFromFloats(rgb[0], rgb[1], rgb[2], 1.0);
}
