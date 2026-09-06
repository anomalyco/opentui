const std = @import("std");
const uucode = @import("uucode");

/// The method to use when calculating the width of a grapheme
pub const WidthMethod = enum(u8) {
    wcwidth = 0,
    unicode = 1,
    no_zwj = 2,
    unicode_wide = 3,
};

/// Check if a byte slice contains only printable ASCII (32..126)
/// Uses SIMD16 for fast checking
pub fn isAsciiOnly(text: []const u8) bool {
    if (text.len == 0) return false;

    const vector_len = 16;
    const Vec = @Vector(vector_len, u8);

    const min_printable: Vec = @splat(32);
    const max_printable: Vec = @splat(126);

    var pos: usize = 0;

    // Process full 16-byte vectors
    while (pos + vector_len <= text.len) {
        const chunk: Vec = text[pos..][0..vector_len].*;

        // Check if all bytes are in [32, 126]
        const too_low = chunk < min_printable;
        const too_high = chunk > max_printable;

        // Check if any byte is out of range
        if (@reduce(.Or, too_low) or @reduce(.Or, too_high)) {
            return false;
        }

        pos += vector_len;
    }

    // Handle remaining bytes with scalar code
    while (pos < text.len) : (pos += 1) {
        const b = text[pos];
        if (b < 32 or b > 126) {
            return false;
        }
    }

    return true;
}

pub const LineBreakKind = enum {
    LF, // \n (Unix/Linux)
    CR, // \r (Old Mac)
    CRLF, // \r\n (Windows)
};

pub const LineBreak = struct {
    pos: usize,
    kind: LineBreakKind,
};

pub const LineBreakResult = struct {
    breaks: std.ArrayListUnmanaged(LineBreak),
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) LineBreakResult {
        return .{
            .breaks = .empty,
            .allocator = allocator,
        };
    }

    pub fn deinit(self: *LineBreakResult) void {
        self.breaks.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn reset(self: *LineBreakResult) void {
        self.breaks.clearRetainingCapacity();
    }
};

pub const TabStopResult = struct {
    positions: std.ArrayListUnmanaged(usize),
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) TabStopResult {
        return .{
            .positions = .empty,
            .allocator = allocator,
        };
    }

    pub fn deinit(self: *TabStopResult) void {
        self.positions.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn reset(self: *TabStopResult) void {
        self.positions.clearRetainingCapacity();
    }
};

/// Classifies a layout break opportunity. Line wrapping and editor word motion
/// share the same scan, but the two boundary sets differ: every kind is a
/// line-break opportunity, while only word-ending kinds are word boundaries.
pub const LayoutWrapBreakKind = enum(u8) {
    none,
    whitespace,
    preserved_whitespace,
    punctuation,
    script_transition,
    cjk_intercharacter,

    /// True when the break also ends a word. Word motion must skip breaks
    /// that are line-break opportunities only.
    pub fn isWordBoundary(self: LayoutWrapBreakKind) bool {
        return switch (self) {
            .whitespace, .preserved_whitespace, .punctuation, .script_transition => true,
            .none, .cjk_intercharacter => false,
        };
    }
};

/// Direct byte and display-column metadata for a wrap opportunity.
/// The window identifies the grapheme that creates the break, not the position
/// after it; consumers use byteEnd()/colEnd() to cross the boundary.
/// Line wrapping may break at every entry; word motion must filter through
/// `kind.isWordBoundary()`.
pub const LayoutWrapBreak = struct {
    byte_start: u32,
    col_start: u32,
    byte_len: u32,
    width_cols: u32,
    kind: LayoutWrapBreakKind,

    pub fn colEnd(self: LayoutWrapBreak) u32 {
        return self.col_start + self.width_cols;
    }

    pub fn byteEnd(self: LayoutWrapBreak) u32 {
        return self.byte_start + self.byte_len;
    }
};

// Helper function to check if an ASCII byte is a wrap break point (CR/LF excluded)
inline fn isAsciiWrapBreak(b: u8) bool {
    return switch (b) {
        ' ', '\t' => true, // Whitespace (no CR/LF in inputs)
        '-' => true, // Dash
        '/', '\\' => true, // Slashes
        '.', ',', ';', ':', '!', '?' => true, // Punctuation
        '(', ')', '[', ']', '{', '}' => true, // Brackets
        else => false,
    };
}

inline fn asciiLayoutWrapBreakKind(b: u8) LayoutWrapBreakKind {
    return switch (b) {
        ' ', '\t' => .whitespace,
        '-', '/', '\\', '.', ',', ';', ':', '!', '?', '(', ')', '[', ']', '{', '}' => .punctuation,
        else => .none,
    };
}

// Decode a UTF-8 codepoint starting at pos. Assumes valid UTF-8 input.
// Returns (codepoint, length). If the remaining bytes are insufficient, returns length 1.
// A full-word result avoids partial-width stores when materialized in hot loops.
pub inline fn decodeUtf8Unchecked(text: []const u8, pos: usize) packed struct(u32) { cp: u21, len: u3, _padding: u8 = 0 } {
    const b0 = text[pos];
    if (b0 < 0x80) return .{ .cp = @intCast(b0), .len = 1 };

    if (pos + 1 >= text.len) return .{ .cp = 0xFFFD, .len = 1 };
    const b1 = text[pos + 1];

    if ((b0 & 0xE0) == 0xC0) {
        const cp2: u21 = @intCast((@as(u32, b0 & 0x1F) << 6) | @as(u32, b1 & 0x3F));
        return .{ .cp = cp2, .len = 2 };
    }

    if (pos + 2 >= text.len) return .{ .cp = 0xFFFD, .len = 1 };
    const b2 = text[pos + 2];

    if ((b0 & 0xF0) == 0xE0) {
        const cp3: u21 = @intCast((@as(u32, b0 & 0x0F) << 12) | (@as(u32, b1 & 0x3F) << 6) | @as(u32, b2 & 0x3F));
        return .{ .cp = cp3, .len = 3 };
    }

    if (pos + 3 >= text.len) return .{ .cp = 0xFFFD, .len = 1 };
    const b3 = text[pos + 3];
    const cp4: u21 = @intCast((@as(u32, b0 & 0x07) << 18) | (@as(u32, b1 & 0x3F) << 12) | (@as(u32, b2 & 0x3F) << 6) | @as(u32, b3 & 0x3F));
    return .{ .cp = cp4, .len = 4 };
}

// Unicode wrap-break codepoints.
inline fn unicodeLayoutWrapBreakKind(cp: u21) LayoutWrapBreakKind {
    return switch (cp) {
        0x00A0, // NBSP
        0x1680, // OGHAM SPACE MARK
        0x2000...0x200A, // En quad..Hair space
        0x202F, // NARROW NO-BREAK SPACE
        0x205F, // MEDIUM MATHEMATICAL SPACE
        0x3000, // IDEOGRAPHIC SPACE
        0x200B, // ZERO WIDTH SPACE
        => .whitespace,
        0x00AD, // SOFT HYPHEN
        0x2010, // HYPHEN
        0x3001, // IDEOGRAPHIC COMMA
        0x3002, // IDEOGRAPHIC FULL STOP
        0xFF01, // FULLWIDTH EXCLAMATION MARK
        0xFF0C, // FULLWIDTH COMMA
        0xFF1A, // FULLWIDTH COLON
        0xFF1F, // FULLWIDTH QUESTION MARK
        => .punctuation,
        else => .none,
    };
}

// WordClass keeps word-boundary behavior predictable in mixed-script text.
// We split between ASCII word runs and CJK word runs, and we keep each
// CJK run grouped as one unit.
pub const WordClass = enum {
    ascii_word,
    cjk_word,
    other,
};

inline fn isAsciiWordByte(b: u8) bool {
    return (b >= 'a' and b <= 'z') or
        (b >= 'A' and b <= 'Z') or
        (b >= '0' and b <= '9') or
        b == '_';
}

inline fn isCjkWordCodepoint(cp: u21) bool {
    return
    // Han ideographs
    (cp >= 0x3400 and cp <= 0x4DBF) or
        (cp >= 0x4E00 and cp <= 0x9FFF) or
        (cp >= 0xF900 and cp <= 0xFAFF) or
        (cp >= 0x20000 and cp <= 0x2A6DF) or
        (cp >= 0x2A700 and cp <= 0x2B73F) or
        (cp >= 0x2B740 and cp <= 0x2B81F) or
        (cp >= 0x2B820 and cp <= 0x2CEAF) or
        (cp >= 0x2CEB0 and cp <= 0x2EBEF) or
        (cp >= 0x2EBF0 and cp <= 0x2EE5D) or
        (cp >= 0x2F800 and cp <= 0x2FA1F) or
        // Hiragana + Katakana
        (cp >= 0x3040 and cp <= 0x309F) or
        (cp >= 0x30A0 and cp <= 0x30FF) or
        (cp >= 0x31F0 and cp <= 0x31FF) or
        (cp >= 0xFF66 and cp <= 0xFF9D) or
        // Hangul
        (cp >= 0x1100 and cp <= 0x11FF) or
        (cp >= 0x3130 and cp <= 0x318F) or
        (cp >= 0xA960 and cp <= 0xA97F) or
        (cp >= 0xAC00 and cp <= 0xD7AF) or
        (cp >= 0xD7B0 and cp <= 0xD7FF);
}

inline fn classifyWordClass(cp: u21) WordClass {
    if (cp <= 0x7F) {
        return if (isAsciiWordByte(@intCast(cp))) .ascii_word else .other;
    }
    if (isCjkWordCodepoint(cp)) return .cjk_word;
    return .other;
}

pub inline fn isWordCodepoint(cp: u21) bool {
    return classifyWordClass(cp) != .other;
}

/// CJK text has no spaces between words, so any two adjacent CJK characters
/// form a line-break opportunity. The run still moves as one word; see
/// LayoutWrapBreakKind.isWordBoundary.
pub inline fn isCjkIntercharacterBreak(prev_class: WordClass, curr_class: WordClass, curr_cp: u21) bool {
    // Kana punctuation and combining marks belong to editor words, not new line starts.
    return prev_class == .cjk_word and curr_class == .cjk_word and
        curr_cp != 0x3099 and curr_cp != 0x309A and curr_cp != 0x30A0 and curr_cp != 0x30FB;
}

pub inline fn isCjkAsciiTransition(prev_class: WordClass, curr_class: WordClass) bool {
    return (prev_class == .cjk_word and curr_class == .ascii_word) or
        (prev_class == .ascii_word and curr_class == .cjk_word);
}

pub fn findTabStops(text: []const u8, result: *TabStopResult) !void {
    result.reset();
    const vector_len = 16;
    const Vec = @Vector(vector_len, u8);

    const vTab: Vec = @splat('\t');

    var pos: usize = 0;

    while (pos + vector_len <= text.len) {
        const chunk: Vec = text[pos..][0..vector_len].*;
        const cmp_tab = chunk == vTab;

        if (@reduce(.Or, cmp_tab)) {
            var i: usize = 0;
            while (i < vector_len) : (i += 1) {
                if (text[pos + i] == '\t') {
                    try result.positions.append(result.allocator, pos + i);
                }
            }
        }
        pos += vector_len;
    }

    while (pos < text.len) : (pos += 1) {
        if (text[pos] == '\t') {
            try result.positions.append(result.allocator, pos);
        }
    }
}

pub fn findLineBreaks(text: []const u8, result: *LineBreakResult) !void {
    result.reset();
    const vector_len = 16; // Use 16-byte vectors (SSE2/NEON compatible)
    const Vec = @Vector(vector_len, u8);

    // Prepare vector constants for '\n' and '\r'
    const vNL: Vec = @splat('\n');
    const vCR: Vec = @splat('\r');

    var pos: usize = 0;
    var prev_was_cr = false; // Track if previous chunk ended with \r

    // Process full vector chunks
    while (pos + vector_len <= text.len) {
        const chunk: Vec = text[pos..][0..vector_len].*;
        const cmp_nl = chunk == vNL;
        const cmp_cr = chunk == vCR;

        // Check if any newline or CR found
        if (@reduce(.Or, cmp_nl) or @reduce(.Or, cmp_cr)) {
            // Found a match, process this chunk
            var i: usize = 0;
            while (i < vector_len) : (i += 1) {
                const absolute_index = pos + i;
                const b = text[absolute_index];
                if (b == '\n') {
                    // Skip if this is the \n part of a CRLF split across chunks
                    if (i == 0 and prev_was_cr) {
                        prev_was_cr = false;
                        continue;
                    }
                    // Check if this is part of CRLF
                    const kind: LineBreakKind = if (absolute_index > 0 and text[absolute_index - 1] == '\r') .CRLF else .LF;
                    try result.breaks.append(result.allocator, .{ .pos = absolute_index, .kind = kind });
                } else if (b == '\r') {
                    // Check for CRLF
                    if (absolute_index + 1 < text.len and text[absolute_index + 1] == '\n') {
                        try result.breaks.append(result.allocator, .{ .pos = absolute_index + 1, .kind = .CRLF });
                        i += 1; // Skip the \n in next iteration
                    } else {
                        try result.breaks.append(result.allocator, .{ .pos = absolute_index, .kind = .CR });
                    }
                }
            }
            // Update prev_was_cr for next chunk
            prev_was_cr = (text[pos + vector_len - 1] == '\r');
        } else {
            prev_was_cr = false;
        }
        pos += vector_len;
    }

    // Handle remaining bytes with scalar code
    while (pos < text.len) : (pos += 1) {
        const b = text[pos];
        if (b == '\n') {
            // Handle CRLF split at chunk boundary
            if (pos > 0 and text[pos - 1] == '\r') {
                // Already recorded at pos - 1 or will be skipped
                if (prev_was_cr) {
                    prev_was_cr = false;
                    continue;
                }
            }
            const kind: LineBreakKind = if (pos > 0 and text[pos - 1] == '\r') .CRLF else .LF;
            try result.breaks.append(result.allocator, .{ .pos = pos, .kind = kind });
        } else if (b == '\r') {
            if (pos + 1 < text.len and text[pos + 1] == '\n') {
                try result.breaks.append(result.allocator, .{ .pos = pos + 1, .kind = .CRLF });
                pos += 1;
            } else {
                try result.breaks.append(result.allocator, .{ .pos = pos, .kind = .CR });
            }
        }
        prev_was_cr = false;
    }
}

pub const WrapByWidthResult = struct {
    byte_offset: u32,
    grapheme_count: u32,
    columns_used: u32,
};

pub const PosByWidthResult = struct {
    byte_offset: u32,
    grapheme_count: u32,
    columns_used: u32,
};

pub inline fn eastAsianWidth(cp: u21) u32 {
    if (cp > 0x10FFFF) return 0;
    const eaw = uucode.get(.east_asian_width, cp);
    const width = eawToWidth(cp, eaw);
    return if (width > 0) @intCast(width) else 0;
}

pub inline fn isCombiningMark(bytes: []const u8) bool {
    if (bytes.len == 0) return false;
    return switch (uucode.get(.general_category, decodeUtf8Unchecked(bytes, 0).cp)) {
        .mark_nonspacing, .mark_spacing_combining, .mark_enclosing => true,
        else => false,
    };
}

/// Calculate width from east asian width property and Unicode properties
/// Returns -1 for control characters (they don't contribute to width)
inline fn eawToWidth(cp: u21, eaw: uucode.types.EastAsianWidth) i16 {
    if (cp == 0) return 0;
    if (cp < 32 or (cp >= 0x7F and cp < 0xA0)) return -1;

    const gc = uucode.get(.general_category, cp);
    switch (gc) {
        .mark_nonspacing, .mark_spacing_combining, .mark_enclosing => return 0,
        else => {},
    }

    if (cp == 0x200B) return 0;
    if (cp == 0x200C) return 0;
    if (cp == 0x200D) return 0;
    if (cp == 0x2060) return 0;
    if (cp == 0x034F) return 0;
    if (cp == 0xFEFF) return 0;
    if (cp >= 0x180B and cp <= 0x180D) return 0;
    if (cp >= 0xFE00 and cp <= 0xFE0F) return 0;
    if (cp >= 0xE0100 and cp <= 0xE01EF) return 0;

    if (eaw == .fullwidth or eaw == .wide) return 2;

    if (cp >= 0x1F000 and cp <= 0x1F02B) return 2;
    if (cp >= 0x1F030 and cp <= 0x1F093) return 2;
    if (cp >= 0x1F0A0 and cp <= 0x1F0AE) return 2;
    if (cp >= 0x1F0B1 and cp <= 0x1F0BF) return 2;
    if (cp >= 0x1F0C1 and cp <= 0x1F0CF) return 2;
    if (cp >= 0x1F0D1 and cp <= 0x1F0F5) return 2;

    if (cp == 0x231A or cp == 0x231B) return 2;
    if (cp == 0x2329 or cp == 0x232A) return 2;
    if (cp >= 0x23E9 and cp <= 0x23EC) return 2;
    if (cp == 0x23F0 or cp == 0x23F3) return 2;
    if (cp >= 0x25FD and cp <= 0x25FE) return 2;

    if (cp >= 0x2614 and cp <= 0x2615) return 2;
    if (cp == 0x2622 or cp == 0x2623) return 2;
    if (cp >= 0x2630 and cp <= 0x2637) return 2;
    if (cp >= 0x2648 and cp <= 0x2653) return 2;
    if (cp == 0x267F or cp == 0x2693 or cp == 0x269B) return 2;
    if (cp >= 0x26AA and cp <= 0x26AB) return 2;
    if (cp >= 0x26BD and cp <= 0x26BE) return 2;
    if (cp >= 0x26C4 and cp <= 0x26C5) return 2;
    if (cp == 0x26CE or cp == 0x26D1 or cp == 0x26D4) return 2;
    if (cp == 0x26EA or cp == 0x26F2 or cp == 0x26F3) return 2;
    if (cp == 0x26F5 or cp == 0x26FA or cp == 0x26FD) return 2;

    if (cp == 0x203C or cp == 0x2049) return 2;
    if (cp == 0x2705 or cp >= 0x270A and cp <= 0x270B) return 2;
    if (cp == 0x2728 or cp == 0x274C or cp == 0x274E) return 2;
    if (cp >= 0x2753 and cp <= 0x2755) return 2;
    if (cp == 0x2757) return 2;
    if (cp >= 0x2760 and cp <= 0x2767) return 2;
    if (cp >= 0x2795 and cp <= 0x2797) return 2;
    if (cp == 0x27B0 or cp == 0x27BF) return 2;
    if (cp >= 0x2B1B and cp <= 0x2B1C) return 2;
    if (cp >= 0x2B50 and cp <= 0x2B50) return 2;
    if (cp >= 0x2B55 and cp <= 0x2B55) return 2;

    if (cp >= 0x1F300 and cp <= 0x1F320) return 2;
    if (cp >= 0x1F32D and cp <= 0x1F335) return 2;
    if (cp >= 0x1F337 and cp <= 0x1F37C) return 2;
    if (cp >= 0x1F37E and cp <= 0x1F393) return 2;
    if (cp >= 0x1F3A0 and cp <= 0x1F3CA) return 2;
    if (cp >= 0x1F3CF and cp <= 0x1F3D3) return 2;
    if (cp >= 0x1F3E0 and cp <= 0x1F3F0) return 2;
    if (cp == 0x1F3F4) return 2;
    if (cp >= 0x1F3F8 and cp <= 0x1F3FF) return 2;
    if (cp >= 0x1F400 and cp <= 0x1F43E) return 2;
    if (cp == 0x1F440) return 2;
    if (cp >= 0x1F442 and cp <= 0x1F4FC) return 2;
    if (cp >= 0x1F4FF and cp <= 0x1F6C5) return 2;
    if (cp == 0x1F6CC) return 2;
    if (cp >= 0x1F6D0 and cp <= 0x1F6D2) return 2;
    if (cp >= 0x1F6D5 and cp <= 0x1F6D7) return 2;
    if (cp >= 0x1F6DC and cp <= 0x1F6DF) return 2;
    if (cp >= 0x1F6EB and cp <= 0x1F6EC) return 2;
    if (cp >= 0x1F6F4 and cp <= 0x1F6FC) return 2;
    if (cp >= 0x1F700 and cp <= 0x1F773) return 2;
    if (cp >= 0x1F780 and cp <= 0x1F7D8) return 2;
    if (cp >= 0x1F7E0 and cp <= 0x1F7EB) return 2;
    if (cp >= 0x1F800 and cp <= 0x1F80B) return 2;
    if (cp >= 0x1F810 and cp <= 0x1F847) return 2;
    if (cp >= 0x1F850 and cp <= 0x1F859) return 2;
    if (cp >= 0x1F860 and cp <= 0x1F887) return 2;
    if (cp >= 0x1F890 and cp <= 0x1F8AD) return 2;
    if (cp >= 0x1F8B0 and cp <= 0x1F8B1) return 2;
    if (cp >= 0x1F90C and cp <= 0x1F93A) return 2;
    if (cp >= 0x1F93C and cp <= 0x1F945) return 2;
    if (cp >= 0x1F947 and cp <= 0x1FA53) return 2;
    if (cp >= 0x1FA60 and cp <= 0x1FA6D) return 2;
    if (cp >= 0x1FA70 and cp <= 0x1FA74) return 2;
    if (cp >= 0x1FA78 and cp <= 0x1FA7C) return 2;
    if (cp >= 0x1FA80 and cp <= 0x1FA86) return 2;
    if (cp >= 0x1FA90 and cp <= 0x1FAAC) return 2;
    if (cp >= 0x1FAB0 and cp <= 0x1FABA) return 2;
    if (cp >= 0x1FAC0 and cp <= 0x1FAC5) return 2;
    if (cp >= 0x1FAD0 and cp <= 0x1FAD9) return 2;
    if (cp >= 0x1FAE0 and cp <= 0x1FAE7) return 2;
    if (cp >= 0x1FAF0 and cp <= 0x1FAF8) return 2;

    return 1;
}

/// Calculate the display width of a byte in columns
/// Used for ASCII-only fast paths
inline fn asciiCharWidth(byte: u8, tab_width: u8) u32 {
    if (byte == '\t') {
        return tab_width;
    } else if (byte >= 32 and byte <= 126) {
        return 1;
    }
    return 0;
}

/// Calculate the display width of a character (byte or codepoint) in columns
inline fn charWidth(byte: u8, codepoint: u21, tab_width: u8) u32 {
    if (byte == '\t') {
        return tab_width;
    } else if (byte < 0x80 and byte >= 32 and byte <= 126) {
        return 1;
    } else if (byte >= 0x80) {
        if (codepoint > 0x10FFFF) return 0;
        const eaw = uucode.get(.east_asian_width, codepoint);
        const w = eawToWidth(codepoint, eaw);
        return if (w > 0) @intCast(w) else 0;
    }
    return 0;
}

/// Check if a codepoint is valid for grapheme break detection
inline fn isValidCodepoint(cp: u21) bool {
    return cp != 0xFFFD and cp <= 0x10FFFF;
}

/// Check if there's a grapheme break between two codepoints
/// - wcwidth mode: use Unicode grapheme clustering for proper rendering,
///   but calculate width using wcwidth (sum of codepoint widths)
/// - no_zwj mode: use grapheme breaks but treat ZWJ as a break (ignore joining)
/// - unicode mode: use standard grapheme cluster segmentation
pub inline fn isGraphemeBreak(prev_cp: ?u21, curr_cp: u21, break_state: *uucode.grapheme.BreakState, width_method: WidthMethod) bool {
    // wcwidth mode uses Unicode grapheme clustering for proper rendering
    // (ZWJ sequences, skin tone modifiers stay together), but width is
    // calculated using wcwidth semantics (sum of codepoint widths)
    if (width_method == .wcwidth) {
        if (prev_cp == null) return true;

        if (!isValidCodepoint(curr_cp)) return true;
        if (!isValidCodepoint(prev_cp.?)) return true;
        return uucode.grapheme.isBreak(prev_cp.?, curr_cp, break_state);
    }

    if (!isValidCodepoint(curr_cp)) return true;

    // In no_zwj mode, treat ZWJ (U+200D) as NOT joining characters
    // When we see ZWJ after a character, it's part of that character's grapheme
    // But when we see a character after ZWJ, it starts a new grapheme
    if (width_method == .no_zwj) {
        const ZWJ: u21 = 0x200D;
        if (prev_cp) |p| {
            // If previous was ZWJ, current starts a new grapheme
            // Don't call uucode.grapheme.isBreak because it will say no break
            if (p == ZWJ) {
                // Reset break state since we're forcing a break
                break_state.* = .default;
                return true;
            }
        }
        // If current is ZWJ, don't break yet - it's part of previous grapheme
        // (will have width 0 anyway)
    }

    if (prev_cp) |p| {
        if (!isValidCodepoint(p)) return true;
        return uucode.grapheme.isBreak(p, curr_cp, break_state);
    }
    return true;
}

/// State for accumulating grapheme cluster width
const GraphemeWidthState = struct {
    width: u32 = 0,
    has_width: bool = false,
    is_regional_indicator_pair: bool = false,
    has_vs16: bool = false,
    has_indic_virama: bool = false,
    width_method: WidthMethod,

    /// Initialize state with the first codepoint of a grapheme cluster
    inline fn init(first_cp: u21, first_width: u32, width_method: WidthMethod) GraphemeWidthState {
        return .{
            .width = first_width,
            .has_width = (first_width > 0),
            .is_regional_indicator_pair = (first_cp >= 0x1F1E6 and first_cp <= 0x1F1FF),
            .has_vs16 = false,
            .has_indic_virama = false,
            .width_method = width_method,
        };
    }

    /// Add a codepoint to the current grapheme cluster
    inline fn addCodepoint(self: *GraphemeWidthState, cp: u21, cp_width: u32) void {
        // wcwidth mode: sum all codepoint widths (tmux-style)
        if (self.width_method == .wcwidth) {
            const eaw = uucode.get(.east_asian_width, cp);
            const w = eawToWidth(cp, eaw);
            if (w > 0) {
                self.width += @intCast(w);
                self.has_width = true;
            }
            return;
        }

        // Grapheme-aware width modes.
        const is_ri = (cp >= 0x1F1E6 and cp <= 0x1F1FF);
        const is_vs16 = (cp == 0xFE0F); // Variation Selector-16 (emoji presentation)

        const gc = uucode.get(.general_category, cp);
        const is_virama = gc == .mark_nonspacing;
        const is_spacing_mark = uucode.get(.grapheme_break, cp) == .spacing_mark;

        const is_devanagari_ra = (cp == 0x0930);

        const is_devanagari_base = (cp >= 0x0915 and cp <= 0x0939) or (cp >= 0x0958 and cp <= 0x095F);

        if (is_vs16) {
            self.has_vs16 = true;
            if (self.has_width and self.width == 1) {
                self.width = 2;
            }
            return;
        }

        if (is_virama) {
            self.has_indic_virama = true;
            return;
        }

        if (self.is_regional_indicator_pair and is_ri) {
            self.width += cp_width;
            self.has_width = true;
        } else if (!self.has_width and cp_width > 0) {
            self.width = cp_width;
            self.has_width = true;
        } else if (self.width_method == .unicode_wide and self.has_width and !uucode.get(.wcwidth_zero_in_grapheme, cp)) {
            self.width = @max(self.width, 2);
        } else if (self.has_width and is_spacing_mark and cp_width > 0) {
            self.width = @max(self.width, 2);
        } else if (self.has_width and self.has_indic_virama and is_devanagari_base and cp_width > 0) {
            if (!is_devanagari_ra) {
                self.width += cp_width;
            }
            self.has_indic_virama = false;
        }
    }
};

const ClusterState = struct {
    columns_used: u32,
    grapheme_count: u32,
    cluster_width: u32,
    cluster_start: usize,
    prev_cp: ?u21,
    break_state: uucode.grapheme.BreakState,
    width_state: GraphemeWidthState,
    width_method: WidthMethod,
    cluster_started: bool,

    fn init(width_method: WidthMethod) ClusterState {
        const dummy_width_state = GraphemeWidthState.init(0, 0, width_method);
        return .{
            .columns_used = 0,
            .grapheme_count = 0,
            .cluster_width = 0,
            .cluster_start = 0,
            .prev_cp = null,
            .break_state = .default,
            .width_state = dummy_width_state,
            .width_method = width_method,
            .cluster_started = false,
        };
    }
};

/// Handle grapheme cluster boundary when wrapping by width (stops BEFORE exceeding limit)
/// Returns true if we should stop (limit exceeded)
inline fn handleClusterForWrap(
    state: *ClusterState,
    is_break: bool,
    new_cluster_start: usize,
    max_columns: u32,
) bool {
    if (is_break) {
        if (state.prev_cp != null) {
            if (state.columns_used + state.cluster_width > max_columns) {
                return true; // Signal to stop
            }
            state.columns_used += state.cluster_width;
            state.grapheme_count += 1;
        }
        state.cluster_width = 0;
        state.cluster_start = new_cluster_start;
        state.cluster_started = false;
    }
    return false;
}

/// Handle grapheme cluster boundary when finding position (snaps to grapheme boundaries)
/// Returns true if we should stop
///
/// Snapping behavior:
/// - include_start_before=true (for selection end): Include graphemes that START at or before max_columns
///   If max_columns=3 and grapheme occupies columns [2-3], include it (starts at 2 <= 3)
///   This snaps forward to include the whole grapheme even if max_columns points to its middle
/// - include_start_before=false (for selection start): Only include graphemes that END before max_columns
///   If max_columns=3 and grapheme occupies columns [2-3], exclude it (ends at 4 > 3)
///   This snaps backward to exclude wide graphemes that would cross max_columns
inline fn handleClusterForPos(
    state: *ClusterState,
    is_break: bool,
    new_cluster_start: usize,
    max_columns: u32,
    include_start_before: bool,
) bool {
    if (is_break) {
        if (state.prev_cp != null) {
            const cluster_start_col = state.columns_used;
            const cluster_end_col = state.columns_used + state.cluster_width;

            if (include_start_before) {
                if (cluster_start_col >= max_columns) {
                    return true;
                }
                state.columns_used = cluster_end_col;
                state.grapheme_count += 1;
            } else {
                if (cluster_end_col > max_columns) {
                    return true; // Signal to stop (don't include this grapheme)
                }
                state.columns_used = cluster_end_col;
            }
        }
        state.cluster_width = 0;
        state.cluster_start = new_cluster_start;
        state.cluster_started = false;
    }
    return false;
}

/// Find wrap position by width - proxy function that dispatches based on width_method
pub fn findWrapPosByWidth(
    text: []const u8,
    max_columns: u32,
    tab_width: u8,
    isASCIIOnly: bool,
    width_method: WidthMethod,
) WrapByWidthResult {
    switch (width_method) {
        .unicode, .unicode_wide, .no_zwj => return findWrapPosByWidthUnicode(text, max_columns, tab_width, isASCIIOnly, width_method),
        .wcwidth => return findWrapPosByWidthWCWidth(text, max_columns, tab_width, isASCIIOnly),
    }
}

/// Find a materialized byte window boundary without splitting a grapheme.
/// wcwidth still sums codepoint widths inside each atomic cluster.
pub fn findWrapPosByWidthGraphemeSafe(
    text: []const u8,
    max_columns: u32,
    tab_width: u8,
    isASCIIOnly: bool,
    width_method: WidthMethod,
) WrapByWidthResult {
    if (width_method == .wcwidth) {
        return findWrapPosByWidthUnicode(text, max_columns, tab_width, isASCIIOnly, .wcwidth);
    }
    return findWrapPosByWidth(text, max_columns, tab_width, isASCIIOnly, width_method);
}

/// Find wrap position by width using Unicode grapheme cluster segmentation
fn findWrapPosByWidthUnicode(
    text: []const u8,
    max_columns: u32,
    tab_width: u8,
    isASCIIOnly: bool,
    width_method: WidthMethod,
) WrapByWidthResult {
    if (text.len == 0 or max_columns == 0) {
        return .{ .byte_offset = 0, .grapheme_count = 0, .columns_used = 0 };
    }

    // ASCII-only fast path
    if (isASCIIOnly) {
        if (max_columns >= text.len) {
            return .{ .byte_offset = @intCast(text.len), .grapheme_count = @intCast(text.len), .columns_used = @intCast(text.len) };
        } else {
            return .{ .byte_offset = max_columns, .grapheme_count = max_columns, .columns_used = max_columns };
        }
    }

    const vector_len = 16;
    var pos: usize = 0;
    var state = ClusterState.init(width_method);

    while (pos + vector_len <= text.len) {
        const chunk: @Vector(vector_len, u8) = text[pos..][0..vector_len].*;
        const ascii_threshold: @Vector(vector_len, u8) = @splat(0x80);
        const is_non_ascii = chunk >= ascii_threshold;

        if (!@reduce(.Or, is_non_ascii)) {
            // All ASCII
            var i: usize = 0;
            while (i < vector_len) : (i += 1) {
                const b = text[pos + i];
                const curr_cp: u21 = b;
                const is_break = isGraphemeBreak(state.prev_cp, curr_cp, &state.break_state, state.width_method);

                if (handleClusterForWrap(&state, is_break, pos + i, max_columns)) {
                    return .{ .byte_offset = @intCast(state.cluster_start), .grapheme_count = state.grapheme_count, .columns_used = state.columns_used };
                }

                const cp_width = asciiCharWidth(b, tab_width);
                if (!state.cluster_started) {
                    state.width_state = GraphemeWidthState.init(curr_cp, cp_width, width_method);
                    state.cluster_width = cp_width;
                    state.cluster_started = true;
                } else {
                    state.width_state.addCodepoint(curr_cp, cp_width);
                    state.cluster_width = state.width_state.width;
                }
                state.prev_cp = curr_cp;
            }
            pos += vector_len;
            continue;
        }

        // Mixed ASCII/non-ASCII - process rest of chunk
        var i: usize = 0;
        while (i < vector_len and pos + i < text.len) {
            const b0 = text[pos + i];
            const curr_cp: u21 = if (b0 < 0x80) b0 else decodeUtf8Unchecked(text, pos + i).cp;
            const cp_len: usize = if (b0 < 0x80) 1 else decodeUtf8Unchecked(text, pos + i).len;

            if (pos + i + cp_len > text.len) break;

            const is_break = isGraphemeBreak(state.prev_cp, curr_cp, &state.break_state, state.width_method);

            if (handleClusterForWrap(&state, is_break, pos + i, max_columns)) {
                return .{ .byte_offset = @intCast(state.cluster_start), .grapheme_count = state.grapheme_count, .columns_used = state.columns_used };
            }

            const cp_width = charWidth(b0, curr_cp, tab_width);
            if (!state.cluster_started) {
                state.width_state = GraphemeWidthState.init(curr_cp, cp_width, width_method);
                state.cluster_width = cp_width;
                state.cluster_started = true;
            } else {
                state.width_state.addCodepoint(curr_cp, cp_width);
                state.cluster_width = state.width_state.width;
            }
            state.prev_cp = curr_cp;
            i += cp_len;
        }
        pos += i; // Advance by how much we actually processed
    }

    // Tail
    while (pos < text.len) {
        const b0 = text[pos];
        const curr_cp: u21 = if (b0 < 0x80) b0 else decodeUtf8Unchecked(text, pos).cp;
        const cp_len: usize = if (b0 < 0x80) 1 else decodeUtf8Unchecked(text, pos).len;

        const is_break = isGraphemeBreak(state.prev_cp, curr_cp, &state.break_state, state.width_method);

        if (handleClusterForWrap(&state, is_break, pos, max_columns)) {
            return .{ .byte_offset = @intCast(state.cluster_start), .grapheme_count = state.grapheme_count, .columns_used = state.columns_used };
        }

        const cp_width = charWidth(b0, curr_cp, tab_width);
        if (!state.cluster_started) {
            state.width_state = GraphemeWidthState.init(curr_cp, cp_width, width_method);
            state.cluster_width = cp_width;
            state.cluster_started = true;
        } else {
            state.width_state.addCodepoint(curr_cp, cp_width);
            state.cluster_width = state.width_state.width;
        }
        state.prev_cp = curr_cp;
        pos += cp_len;
    }

    // Final cluster
    if (state.prev_cp != null and state.cluster_width > 0) {
        if (state.columns_used + state.cluster_width > max_columns) {
            return .{ .byte_offset = @intCast(state.cluster_start), .grapheme_count = state.grapheme_count, .columns_used = state.columns_used };
        }
        state.columns_used += state.cluster_width;
        state.grapheme_count += 1;
    }

    return .{ .byte_offset = @intCast(text.len), .grapheme_count = state.grapheme_count, .columns_used = state.columns_used };
}

/// Find wrap position by width using wcwidth-style codepoint-by-codepoint processing
fn findWrapPosByWidthWCWidth(
    text: []const u8,
    max_columns: u32,
    tab_width: u8,
    isASCIIOnly: bool,
) WrapByWidthResult {
    if (text.len == 0 or max_columns == 0) {
        return .{ .byte_offset = 0, .grapheme_count = 0, .columns_used = 0 };
    }

    // ASCII-only fast path
    if (isASCIIOnly) {
        if (max_columns >= text.len) {
            return .{ .byte_offset = @intCast(text.len), .grapheme_count = @intCast(text.len), .columns_used = @intCast(text.len) };
        } else {
            return .{ .byte_offset = max_columns, .grapheme_count = max_columns, .columns_used = max_columns };
        }
    }

    // Unicode path - process each codepoint independently
    var pos: usize = 0;
    var columns_used: u32 = 0;
    var codepoint_count: u32 = 0;

    while (pos < text.len) {
        const b0 = text[pos];
        const curr_cp: u21 = if (b0 < 0x80) b0 else blk: {
            const dec = decodeUtf8Unchecked(text, pos);
            if (pos + dec.len > text.len) break :blk 0xFFFD;
            break :blk dec.cp;
        };
        const cp_len: usize = if (b0 < 0x80) 1 else decodeUtf8Unchecked(text, pos).len;

        if (pos + cp_len > text.len) break;

        const cp_width = charWidth(b0, curr_cp, tab_width);

        // In wcwidth mode, stop if we've already used max_columns
        // (don't continue adding zero-width chars after reaching limit)
        if (columns_used >= max_columns) {
            return .{ .byte_offset = @intCast(pos), .grapheme_count = codepoint_count, .columns_used = columns_used };
        }

        // Stop if adding this codepoint would exceed max_columns
        if (columns_used + cp_width > max_columns) {
            return .{ .byte_offset = @intCast(pos), .grapheme_count = codepoint_count, .columns_used = columns_used };
        }

        columns_used += cp_width;
        codepoint_count += 1;
        pos += cp_len;
    }

    return .{ .byte_offset = @intCast(text.len), .grapheme_count = codepoint_count, .columns_used = columns_used };
}

/// Find position by column width - proxy function that dispatches based on width_method
/// - If include_start_before: include graphemes that START before max_columns (snap forward for selection end)
///   This ensures that if max_columns points to the middle of a width=2 grapheme, we include the whole grapheme
/// - If !include_start_before: exclude graphemes that START at or after max_columns (snap backward for selection start)
///   This ensures that if max_columns points to the middle of a width=2 grapheme, we snap back to exclude it
pub fn findPosByWidth(
    text: []const u8,
    max_columns: u32,
    tab_width: u8,
    isASCIIOnly: bool,
    include_start_before: bool,
    width_method: WidthMethod,
) PosByWidthResult {
    switch (width_method) {
        .unicode, .unicode_wide, .no_zwj => return findPosByWidthUnicode(text, max_columns, tab_width, isASCIIOnly, include_start_before, width_method),
        .wcwidth => return findPosByWidthWCWidth(text, max_columns, tab_width, isASCIIOnly, include_start_before),
    }
}

/// Find a display position without splitting Unicode grapheme clusters.
/// The width method still controls each cluster's display width.
pub fn findGraphemePosByWidth(
    text: []const u8,
    max_columns: u32,
    tab_width: u8,
    isASCIIOnly: bool,
    include_start_before: bool,
    width_method: WidthMethod,
) PosByWidthResult {
    return findPosByWidthUnicode(text, max_columns, tab_width, isASCIIOnly, include_start_before, width_method);
}

/// Find position by column width using Unicode grapheme cluster segmentation
fn findPosByWidthUnicode(
    text: []const u8,
    max_columns: u32,
    tab_width: u8,
    isASCIIOnly: bool,
    include_start_before: bool,
    width_method: WidthMethod,
) PosByWidthResult {
    if (text.len == 0 or max_columns == 0) {
        return .{ .byte_offset = 0, .grapheme_count = 0, .columns_used = 0 };
    }

    // ASCII-only fast path
    if (isASCIIOnly) {
        if (max_columns >= text.len) {
            return .{ .byte_offset = @intCast(text.len), .grapheme_count = @intCast(text.len), .columns_used = @intCast(text.len) };
        } else {
            return .{ .byte_offset = max_columns, .grapheme_count = max_columns, .columns_used = max_columns };
        }
    }

    const vector_len = 16;
    var pos: usize = 0;
    var state = ClusterState.init(width_method);

    while (pos + vector_len <= text.len) {
        const chunk: @Vector(vector_len, u8) = text[pos..][0..vector_len].*;
        const ascii_threshold: @Vector(vector_len, u8) = @splat(0x80);
        const is_non_ascii = chunk >= ascii_threshold;

        if (!@reduce(.Or, is_non_ascii)) {
            // All ASCII
            var i: usize = 0;
            while (i < vector_len) : (i += 1) {
                const b = text[pos + i];
                const curr_cp: u21 = b;
                const is_break = isGraphemeBreak(state.prev_cp, curr_cp, &state.break_state, state.width_method);

                if (handleClusterForPos(&state, is_break, pos + i, max_columns, include_start_before)) {
                    return .{ .byte_offset = @intCast(state.cluster_start), .grapheme_count = state.grapheme_count, .columns_used = state.columns_used };
                }

                const cp_width = asciiCharWidth(b, tab_width);
                if (!state.cluster_started) {
                    state.width_state = GraphemeWidthState.init(curr_cp, cp_width, width_method);
                    state.cluster_width = cp_width;
                    state.cluster_started = true;
                } else {
                    state.width_state.addCodepoint(curr_cp, cp_width);
                    state.cluster_width = state.width_state.width;
                }
                state.prev_cp = curr_cp;
            }
            pos += vector_len;
            continue;
        }

        // Mixed ASCII/non-ASCII - process rest of chunk
        var i: usize = 0;
        while (i < vector_len and pos + i < text.len) {
            const b0 = text[pos + i];
            const curr_cp: u21 = if (b0 < 0x80) b0 else decodeUtf8Unchecked(text, pos + i).cp;
            const cp_len: usize = if (b0 < 0x80) 1 else decodeUtf8Unchecked(text, pos + i).len;

            if (pos + i + cp_len > text.len) break;

            const is_break = isGraphemeBreak(state.prev_cp, curr_cp, &state.break_state, state.width_method);

            if (handleClusterForPos(&state, is_break, pos + i, max_columns, include_start_before)) {
                return .{ .byte_offset = @intCast(state.cluster_start), .grapheme_count = state.grapheme_count, .columns_used = state.columns_used };
            }

            const cp_width = charWidth(b0, curr_cp, tab_width);
            if (!state.cluster_started) {
                state.width_state = GraphemeWidthState.init(curr_cp, cp_width, width_method);
                state.cluster_width = cp_width;
                state.cluster_started = true;
            } else {
                state.width_state.addCodepoint(curr_cp, cp_width);
                state.cluster_width = state.width_state.width;
            }
            state.prev_cp = curr_cp;
            i += cp_len;
        }
        pos += i; // Advance by how much we actually processed
    }

    // Tail
    while (pos < text.len) {
        const b0 = text[pos];
        const curr_cp: u21 = if (b0 < 0x80) b0 else decodeUtf8Unchecked(text, pos).cp;
        const cp_len: usize = if (b0 < 0x80) 1 else decodeUtf8Unchecked(text, pos).len;

        const is_break = isGraphemeBreak(state.prev_cp, curr_cp, &state.break_state, state.width_method);

        if (handleClusterForPos(&state, is_break, pos, max_columns, include_start_before)) {
            return .{ .byte_offset = @intCast(state.cluster_start), .grapheme_count = state.grapheme_count, .columns_used = state.columns_used };
        }

        const cp_width = charWidth(b0, curr_cp, tab_width);
        if (!state.cluster_started) {
            state.width_state = GraphemeWidthState.init(curr_cp, cp_width, width_method);
            state.cluster_width = cp_width;
            state.cluster_started = true;
        } else {
            state.width_state.addCodepoint(curr_cp, cp_width);
            state.cluster_width = state.width_state.width;
        }
        state.prev_cp = curr_cp;
        pos += cp_len;
    }

    // Final cluster
    if (state.prev_cp != null and state.cluster_width > 0) {
        if (state.columns_used >= max_columns) {
            return .{ .byte_offset = @intCast(state.cluster_start), .grapheme_count = state.grapheme_count, .columns_used = state.columns_used };
        }
        if (!include_start_before and state.columns_used + state.cluster_width > max_columns) {
            return .{ .byte_offset = @intCast(state.cluster_start), .grapheme_count = state.grapheme_count, .columns_used = state.columns_used };
        }
        state.columns_used += state.cluster_width;
        if (include_start_before) {
            state.grapheme_count += 1;
        }
    }

    return .{ .byte_offset = @intCast(text.len), .grapheme_count = state.grapheme_count, .columns_used = state.columns_used };
}

/// Find position by column width using wcwidth-style codepoint-by-codepoint processing
fn findPosByWidthWCWidth(
    text: []const u8,
    max_columns: u32,
    tab_width: u8,
    isASCIIOnly: bool,
    include_start_before: bool,
) PosByWidthResult {
    if (text.len == 0 or max_columns == 0) {
        return .{ .byte_offset = 0, .grapheme_count = 0, .columns_used = 0 };
    }

    // ASCII-only fast path
    if (isASCIIOnly) {
        if (max_columns >= text.len) {
            return .{ .byte_offset = @intCast(text.len), .grapheme_count = @intCast(text.len), .columns_used = @intCast(text.len) };
        } else {
            return .{ .byte_offset = max_columns, .grapheme_count = max_columns, .columns_used = max_columns };
        }
    }

    // Unicode path - process each codepoint independently
    var pos: usize = 0;
    var columns_used: u32 = 0;
    var codepoint_count: u32 = 0;

    while (pos < text.len) {
        const b0 = text[pos];
        const curr_cp: u21 = if (b0 < 0x80) b0 else blk: {
            const dec = decodeUtf8Unchecked(text, pos);
            if (pos + dec.len > text.len) break :blk 0xFFFD;
            break :blk dec.cp;
        };
        const cp_len: usize = if (b0 < 0x80) 1 else decodeUtf8Unchecked(text, pos).len;

        if (pos + cp_len > text.len) break;

        const cp_width = charWidth(b0, curr_cp, tab_width);
        const cp_start_col = columns_used;
        const cp_end_col = columns_used + cp_width;

        // Apply boundary behavior
        if (include_start_before) {
            // Selection end: include codepoints that START before max_columns
            if (cp_start_col >= max_columns) {
                return .{ .byte_offset = @intCast(pos), .grapheme_count = codepoint_count, .columns_used = columns_used };
            }
        } else {
            // Selection start: only include codepoints that END before or at max_columns
            // So exclude (stop) if end > max_columns
            if (cp_end_col > max_columns) {
                return .{ .byte_offset = @intCast(pos), .grapheme_count = codepoint_count, .columns_used = columns_used };
            }
        }

        columns_used = cp_end_col;
        codepoint_count += 1;
        pos += cp_len;
    }

    return .{ .byte_offset = @intCast(text.len), .grapheme_count = codepoint_count, .columns_used = columns_used };
}

/// Get width at byte offset - proxy function that dispatches based on width_method
pub fn getWidthAt(text: []const u8, byte_offset: usize, tab_width: u8, width_method: WidthMethod) u32 {
    switch (width_method) {
        .unicode, .unicode_wide, .no_zwj => return getWidthAtUnicode(text, byte_offset, tab_width, width_method),
        .wcwidth => return getWidthAtWCWidth(text, byte_offset, tab_width),
    }
}

pub fn getGraphemeWidthAt(text: []const u8, byte_offset: usize, tab_width: u8, width_method: WidthMethod) u32 {
    return getWidthAtUnicode(text, byte_offset, tab_width, width_method);
}

/// Get width at byte offset using Unicode grapheme cluster segmentation
fn getWidthAtUnicode(text: []const u8, byte_offset: usize, tab_width: u8, width_method: WidthMethod) u32 {
    if (byte_offset >= text.len) return 0;

    const b0 = text[byte_offset];

    const first_cp: u21 = if (b0 < 0x80) b0 else blk: {
        const dec = decodeUtf8Unchecked(text, byte_offset);
        if (byte_offset + dec.len > text.len) return 1;
        break :blk dec.cp;
    };

    const first_len: usize = if (b0 < 0x80) 1 else decodeUtf8Unchecked(text, byte_offset).len;

    var break_state: uucode.grapheme.BreakState = .default;
    var prev_cp: ?u21 = first_cp;
    const first_width = charWidth(b0, first_cp, tab_width);
    var state = GraphemeWidthState.init(first_cp, first_width, width_method);

    var pos = byte_offset + first_len;

    while (pos < text.len) {
        const b = text[pos];
        const curr_cp: u21 = if (b < 0x80) b else decodeUtf8Unchecked(text, pos).cp;
        const cp_len: usize = if (b < 0x80) 1 else decodeUtf8Unchecked(text, pos).len;

        if (pos + cp_len > text.len) break;

        const is_break = isGraphemeBreak(prev_cp, curr_cp, &break_state, width_method);
        if (is_break) break;

        const cp_width = charWidth(b, curr_cp, tab_width);
        state.addCodepoint(curr_cp, cp_width);

        prev_cp = curr_cp;
        pos += cp_len;
    }

    return state.width;
}

/// Get width at byte offset using wcwidth-style codepoint-by-codepoint processing
/// In wcwidth mode, each codepoint is treated independently - return its width directly
fn getWidthAtWCWidth(text: []const u8, byte_offset: usize, tab_width: u8) u32 {
    if (byte_offset >= text.len) return 0;

    const b0 = text[byte_offset];

    const first_cp: u21 = if (b0 < 0x80) b0 else blk: {
        const dec = decodeUtf8Unchecked(text, byte_offset);
        if (byte_offset + dec.len > text.len) return 1;
        break :blk dec.cp;
    };

    const first_width = charWidth(b0, first_cp, tab_width);
    return first_width;
}

pub const PrevGraphemeResult = struct {
    start_offset: usize,
    width: u32,
};

/// Get previous grapheme start - proxy function that dispatches based on width_method
pub fn getPrevGraphemeStart(text: []const u8, byte_offset: usize, tab_width: u8, width_method: WidthMethod) ?PrevGraphemeResult {
    switch (width_method) {
        .unicode, .unicode_wide, .no_zwj => return getPrevGraphemeStartUnicode(text, byte_offset, tab_width, width_method),
        .wcwidth => return getPrevGraphemeStartWCWidth(text, byte_offset, tab_width),
    }
}

/// Get previous grapheme start using wcwidth-style codepoint-by-codepoint processing
fn getPrevGraphemeStartWCWidth(text: []const u8, byte_offset: usize, tab_width: u8) ?PrevGraphemeResult {
    if (byte_offset == 0 or text.len == 0) return null;
    if (byte_offset > text.len) return null;

    var pos: usize = 0;
    var last_result: ?PrevGraphemeResult = null;

    while (pos < byte_offset) {
        const b = text[pos];
        const curr_cp: u21 = if (b < 0x80) b else blk: {
            const dec = decodeUtf8Unchecked(text, pos);
            if (pos + dec.len > text.len) break :blk 0xFFFD;
            break :blk dec.cp;
        };
        const cp_len: usize = if (b < 0x80) 1 else decodeUtf8Unchecked(text, pos).len;
        const cp_width = charWidth(b, curr_cp, tab_width);

        if (cp_width > 0) {
            last_result = .{
                .start_offset = pos,
                .width = cp_width,
            };
        }
        pos += cp_len;
    }

    return last_result;
}

/// Get previous grapheme start using Unicode grapheme cluster segmentation
fn getPrevGraphemeStartUnicode(text: []const u8, byte_offset: usize, tab_width: u8, width_method: WidthMethod) ?PrevGraphemeResult {
    if (byte_offset == 0 or text.len == 0) return null;
    if (byte_offset > text.len) return null;

    // For unicode/no_zwj modes, use grapheme cluster detection
    var break_state: uucode.grapheme.BreakState = .default;
    var pos: usize = 0;
    var prev_cp: ?u21 = null;
    var prev_grapheme_start: usize = 0;
    var second_to_last_grapheme_start: usize = 0;

    while (pos < byte_offset) {
        const b = text[pos];
        const curr_cp: u21 = if (b < 0x80) b else blk: {
            const dec = decodeUtf8Unchecked(text, pos);
            if (pos + dec.len > text.len) break :blk 0xFFFD;
            break :blk dec.cp;
        };

        const cp_len: usize = if (b < 0x80) 1 else decodeUtf8Unchecked(text, pos).len;

        if (isValidCodepoint(curr_cp)) {
            const is_break = if (prev_cp) |p| blk: {
                if (!isValidCodepoint(p)) break :blk true;
                break :blk uucode.grapheme.isBreak(p, curr_cp, &break_state);
            } else true;

            if (is_break) {
                second_to_last_grapheme_start = prev_grapheme_start;
                prev_grapheme_start = pos;
            }

            prev_cp = curr_cp;
        }

        pos += cp_len;
    }

    if (prev_grapheme_start == 0 and byte_offset == 0) {
        return null;
    }

    const start_offset = if (prev_grapheme_start < byte_offset) prev_grapheme_start else second_to_last_grapheme_start;
    const width = getWidthAt(text, start_offset, tab_width, width_method);

    return .{
        .start_offset = start_offset,
        .width = width,
    };
}

/// Calculate the display width of text - proxy function that dispatches based on width_method
pub fn calculateTextWidth(text: []const u8, tab_width: u8, isASCIIOnly: bool, width_method: WidthMethod) u32 {
    switch (width_method) {
        .unicode, .unicode_wide, .no_zwj => return calculateTextWidthUnicode(text, tab_width, isASCIIOnly, width_method),
        .wcwidth => return calculateTextWidthWCWidth(text, tab_width, isASCIIOnly),
    }
}

/// Measure increasing byte boundaries in one pass over the complete text.
/// A boundary inside a grapheme includes that whole grapheme, so later fragments
/// cannot count it again or shift the styles that follow it. Newlines have width 0.
pub const TextWidthCursor = struct {
    text: []const u8,
    tab_width: u8,
    width_method: WidthMethod,
    byte_offset: usize = 0,
    columns: u32 = 0,
    break_state: uucode.grapheme.BreakState = .default,

    pub fn advanceTo(self: *TextWidthCursor, byte_end: usize) u32 {
        const end = @min(byte_end, self.text.len);
        if (end <= self.byte_offset) return self.columns;

        // Ordinary syntax tokens stay on the existing printable-ASCII fast path.
        if ((end == self.text.len or self.text[end] < 0x80) and isAsciiOnly(self.text[self.byte_offset..end])) {
            self.columns += @intCast(end - self.byte_offset);
            self.byte_offset = end;
            self.break_state = .default;
            return self.columns;
        }

        while (self.byte_offset < end) {
            const b0 = self.text[self.byte_offset];
            if (b0 < 0x80 and (self.byte_offset + 1 == self.text.len or self.text[self.byte_offset + 1] < 0x80)) {
                self.columns += asciiCharWidth(b0, self.tab_width);
                self.byte_offset += 1;
                self.break_state = .default;
                continue;
            }

            const first = decodeUtf8Unchecked(self.text, self.byte_offset);
            var previous: u21 = if (self.byte_offset + first.len <= self.text.len) first.cp else 0xFFFD;
            var state = GraphemeWidthState.init(previous, charWidth(b0, previous, self.tab_width), self.width_method);
            self.byte_offset += @min(first.len, self.text.len - self.byte_offset);
            while (self.byte_offset < self.text.len) {
                const byte = self.text[self.byte_offset];
                const decoded = decodeUtf8Unchecked(self.text, self.byte_offset);
                const cp: u21 = if (self.byte_offset + decoded.len <= self.text.len) decoded.cp else 0xFFFD;
                if (isGraphemeBreak(previous, cp, &self.break_state, self.width_method)) break;
                state.addCodepoint(cp, charWidth(byte, cp, self.tab_width));
                self.byte_offset += @min(decoded.len, self.text.len - self.byte_offset);
                previous = cp;
            }
            self.columns += state.width;
        }
        return self.columns;
    }
};

/// Calculate text width using Unicode grapheme cluster segmentation
fn calculateTextWidthUnicode(text: []const u8, tab_width: u8, isASCIIOnly: bool, width_method: WidthMethod) u32 {
    if (text.len == 0) return 0;

    // ASCII-only fast path
    if (isASCIIOnly) {
        return @intCast(text.len);
    }

    // General case with Unicode support and grapheme cluster handling
    var total_width_cols: u32 = 0;
    var pos: usize = 0;
    var prev_cp: ?u21 = null;
    var break_state: uucode.grapheme.BreakState = .default;
    var state: GraphemeWidthState = undefined;

    while (pos < text.len) {
        const b0 = text[pos];
        const curr_cp: u21 = if (b0 < 0x80) b0 else blk: {
            const dec = decodeUtf8Unchecked(text, pos);
            if (pos + dec.len > text.len) break :blk 0xFFFD;
            break :blk dec.cp;
        };
        const cp_len: usize = if (b0 < 0x80) 1 else decodeUtf8Unchecked(text, pos).len;
        const is_break = isGraphemeBreak(prev_cp, curr_cp, &break_state, width_method);

        if (is_break) {
            if (prev_cp != null) {
                total_width_cols += state.width;
            }

            const cp_width = charWidth(b0, curr_cp, tab_width);
            state = GraphemeWidthState.init(curr_cp, cp_width, width_method);
        } else {
            const cp_width = charWidth(b0, curr_cp, tab_width);
            state.addCodepoint(curr_cp, cp_width);
        }

        prev_cp = curr_cp;
        pos += cp_len;
    }

    if (prev_cp != null) {
        total_width_cols += state.width;
    }

    return total_width_cols;
}

/// Calculate text width using wcwidth-style codepoint-by-codepoint processing
fn calculateTextWidthWCWidth(text: []const u8, tab_width: u8, isASCIIOnly: bool) u32 {
    if (text.len == 0) return 0;

    // ASCII-only fast path
    if (isASCIIOnly) {
        return @intCast(text.len);
    }

    // Unicode path - sum width of all codepoints
    var total_width_cols: u32 = 0;
    var pos: usize = 0;

    while (pos < text.len) {
        const b0 = text[pos];
        const curr_cp: u21 = if (b0 < 0x80) b0 else blk: {
            const dec = decodeUtf8Unchecked(text, pos);
            if (pos + dec.len > text.len) break :blk 0xFFFD;
            break :blk dec.cp;
        };
        const cp_len: usize = if (b0 < 0x80) 1 else decodeUtf8Unchecked(text, pos).len;

        const cp_width = charWidth(b0, curr_cp, tab_width);
        total_width_cols += cp_width;

        pos += cp_len;
    }

    return total_width_cols;
}

/// Sparse render-cluster and tab metadata for caching.
/// Boundaries follow the selected mode; widths are terminal cells summed per codepoint in wcwidth mode.
pub const RenderClusterInfo = struct {
    byte_start: u32,
    byte_len: u32,
    width_cols: u32,
    col_start: u32,
};

pub const ChunkLayoutInfo = struct {
    // Individually ordered lists; wrapping merges them, word motion uses only the first.
    wrap_breaks: []const LayoutWrapBreak,
    cjk_breaks: []const LayoutWrapBreak = &.{},
    word_classes: WordClassEdges,
};

// Endpoint classes and codepoints support script transitions and chunk-edge checks.
pub const WordClassEdges = struct {
    first: WordClass,
    last: WordClass,
    last_cp: ?u21 = null,
    has_cjk_breaks: bool = false,
};

// Cheap endpoint metadata without scanning the chunk contents.
pub fn chunkWordClassEdges(text: []const u8) WordClassEdges {
    if (text.len == 0) return .{ .first = .other, .last = .other };

    const first = decodeUtf8Unchecked(text, 0).cp;
    var last_start = text.len - 1;
    var continuation_count: u2 = 0;
    while (last_start > 0 and (text[last_start] & 0xC0) == 0x80 and continuation_count < 3) {
        last_start -= 1;
        continuation_count += 1;
    }
    const last = decodeUtf8Unchecked(text, last_start).cp;
    return .{ .first = classifyWordClass(first), .last = classifyWordClass(last), .last_cp = last };
}

inline fn emitLayoutWrapBreak(
    visitor: anytype,
    byte_start: usize,
    byte_len: usize,
    col_start: u32,
    width_cols: u32,
    kind: LayoutWrapBreakKind,
) !bool {
    return visitor.emit(.{
        .byte_start = @intCast(byte_start),
        .col_start = col_start,
        .byte_len = @intCast(byte_len),
        .width_cols = width_cols,
        .kind = kind,
    });
}

inline fn commitLayoutCluster(
    visitor: anytype,
    cluster_start: usize,
    cluster_end: usize,
    cluster_col_offset: u32,
    cluster_width: u32,
    cluster_break_kind: LayoutWrapBreakKind,
    cluster_class: WordClass,
    next_class: ?WordClass,
    next_cp: u21,
    has_cjk_breaks: *bool,
) !bool {
    const kind: LayoutWrapBreakKind = blk: {
        if (cluster_break_kind != .none) break :blk cluster_break_kind;
        const next = next_class orelse break :blk .none;
        if (isCjkAsciiTransition(cluster_class, next)) break :blk .script_transition;
        if (cluster_width > 0 and isCjkIntercharacterBreak(cluster_class, next, next_cp)) {
            has_cjk_breaks.* = true;
            if (!@TypeOf(visitor).word_only) break :blk .cjk_intercharacter;
        }
        break :blk .none;
    };
    if (kind != .none) {
        return emitLayoutWrapBreak(
            visitor,
            cluster_start,
            cluster_end - cluster_start,
            cluster_col_offset,
            cluster_width,
            kind,
        );
    }
    return true;
}

inline fn findAsciiLayoutWrapBreaks(
    text: []const u8,
    visitor: anytype,
) !bool {
    const vector_len = 16;
    const Vec = @Vector(vector_len, u8);
    var pos: usize = 0;

    while (pos + vector_len <= text.len) {
        const chunk: Vec = text[pos..][0..vector_len].*;
        var matches: @Vector(vector_len, bool) = @splat(false);
        inline for ([_]u8{ ' ', '\t', '-', '/', '\\', '.', ',', ';', ':', '!', '?', '(', ')', '[', ']', '{', '}' }) |delimiter| {
            matches = matches | (chunk == @as(Vec, @splat(delimiter)));
        }

        var bitmask: u16 = 0;
        inline for (0..vector_len) |i| {
            if (matches[i]) bitmask |= @as(u16, 1) << @intCast(i);
        }
        while (bitmask != 0) {
            const bit_pos = @ctz(bitmask);
            const offset = pos + bit_pos;
            const kind: LayoutWrapBreakKind = if (text[offset] == ' ') .whitespace else asciiLayoutWrapBreakKind(text[offset]);
            if (!try emitLayoutWrapBreak(visitor, offset, 1, @intCast(offset), 1, kind)) return false;
            bitmask &= bitmask - 1;
        }
        pos += vector_len;
    }

    while (pos < text.len) : (pos += 1) {
        const b = text[pos];
        if (b == ' ') {
            if (!try emitLayoutWrapBreak(visitor, pos, 1, @intCast(pos), 1, .whitespace)) return false;
        } else if (isAsciiWrapBreak(b)) {
            if (!try emitLayoutWrapBreak(visitor, pos, 1, @intCast(pos), 1, asciiLayoutWrapBreakKind(b))) return false;
        }
    }
    return true;
}

/// Find direct wrap metadata without converting grapheme counts after the scan.
pub fn findChunkLayoutInfo(
    allocator: std.mem.Allocator,
    text: []const u8,
    tab_width: u8,
    isASCIIOnly: bool,
    width_method: WidthMethod,
    wrap_breaks: *std.ArrayListUnmanaged(LayoutWrapBreak),
) !WordClassEdges {
    wrap_breaks.clearRetainingCapacity();
    const Context = struct {
        allocator: std.mem.Allocator,
        wrap_breaks: *std.ArrayListUnmanaged(LayoutWrapBreak),

        fn append(ctx_ptr: *anyopaque, wrap_break: LayoutWrapBreak) !bool {
            const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
            try ctx.wrap_breaks.append(ctx.allocator, wrap_break);
            return true;
        }
    };
    var ctx: Context = .{ .allocator = allocator, .wrap_breaks = wrap_breaks };
    return walkChunkLayoutInfoComptime(text, tab_width, isASCIIOnly, width_method, &ctx, Context.append);
}

/// Editor queries do not need to materialize line-only CJK opportunities.
pub fn findWordChunkLayoutInfo(
    allocator: std.mem.Allocator,
    text: []const u8,
    tab_width: u8,
    isASCIIOnly: bool,
    width_method: WidthMethod,
    wrap_breaks: *std.ArrayListUnmanaged(LayoutWrapBreak),
) !WordClassEdges {
    wrap_breaks.clearRetainingCapacity();
    const Visitor = struct {
        const word_only = true;
        allocator: std.mem.Allocator,
        breaks: *std.ArrayListUnmanaged(LayoutWrapBreak),

        inline fn emit(self: @This(), wrap_break: LayoutWrapBreak) !bool {
            try self.breaks.append(self.allocator, wrap_break);
            return true;
        }
    };
    return walkChunkLayoutInfoGeneric(text, tab_width, isASCIIOnly, width_method, Visitor{ .allocator = allocator, .breaks = wrap_breaks });
}

/// Retained layout stores word and line-only breaks once, in disjoint lists.
pub fn findLineAndWordChunkLayoutInfo(
    allocator: std.mem.Allocator,
    text: []const u8,
    tab_width: u8,
    isASCIIOnly: bool,
    width_method: WidthMethod,
    line_breaks: *std.ArrayListUnmanaged(LayoutWrapBreak),
    word_breaks: *std.ArrayListUnmanaged(LayoutWrapBreak),
) !WordClassEdges {
    line_breaks.clearRetainingCapacity();
    word_breaks.clearRetainingCapacity();
    const Visitor = struct {
        const word_only = false;
        allocator: std.mem.Allocator,
        lines: *std.ArrayListUnmanaged(LayoutWrapBreak),
        words: *std.ArrayListUnmanaged(LayoutWrapBreak),

        inline fn emit(self: @This(), wrap_break: LayoutWrapBreak) !bool {
            if (wrap_break.kind.isWordBoundary()) {
                try self.words.append(self.allocator, wrap_break);
            } else {
                try self.lines.append(self.allocator, wrap_break);
            }
            return true;
        }
    };
    return walkChunkLayoutInfoGeneric(text, tab_width, isASCIIOnly, width_method, Visitor{ .allocator = allocator, .lines = line_breaks, .words = word_breaks });
}

pub inline fn walkChunkLayoutInfoComptime(
    text: []const u8,
    tab_width: u8,
    isASCIIOnly: bool,
    width_method: WidthMethod,
    context: anytype,
    comptime callback: anytype,
) !WordClassEdges {
    const Visitor = struct {
        const word_only = false;
        context: @TypeOf(context),

        inline fn emit(self: @This(), wrap_break: LayoutWrapBreak) !bool {
            return callback(self.context, wrap_break);
        }
    };
    return walkChunkLayoutInfoGeneric(text, tab_width, isASCIIOnly, width_method, Visitor{ .context = context });
}

fn walkChunkLayoutInfoGeneric(
    text: []const u8,
    tab_width: u8,
    isASCIIOnly: bool,
    width_method: WidthMethod,
    visitor: anytype,
) !WordClassEdges {
    if (text.len == 0) return .{ .first = .other, .last = .other };

    if (isASCIIOnly) {
        _ = try findAsciiLayoutWrapBreaks(text, visitor);
        return chunkWordClassEdges(text);
    }

    const first_word_class = classifyWordClass(decodeUtf8Unchecked(text, 0).cp);
    var has_cjk_breaks = false;

    const vector_len = 16;
    var pos: usize = 0;
    var col: u32 = 0;
    var prev_cp: ?u21 = null;
    var break_state: uucode.grapheme.BreakState = .default;
    var cluster_started = false;
    var cluster_start: usize = 0;
    var cluster_col_offset: u32 = 0;
    var cluster_width_state: GraphemeWidthState = undefined;
    var cluster_break_kind: LayoutWrapBreakKind = .none;
    var cluster_class: WordClass = .other;

    while (pos < text.len) {
        {
            var ascii_len: usize = 0;
            if (pos + vector_len <= text.len) {
                const chunk: @Vector(vector_len, u8) = text[pos..][0..vector_len].*;
                const is_non_ascii = chunk >= @as(@Vector(vector_len, u8), @splat(0x80));
                ascii_len = if (std.simd.firstTrue(is_non_ascii)) |index| index else vector_len;
            } else {
                while (pos + ascii_len < text.len and text[pos + ascii_len] < 0x80) : (ascii_len += 1) {}
            }
            if (ascii_len > 1) {
                var can_use_ascii_fast_path = true;
                if (cluster_started) {
                    var probe_state = break_state;
                    can_use_ascii_fast_path = isGraphemeBreak(prev_cp, text[pos], &probe_state, width_method);
                }
                if (!can_use_ascii_fast_path) {
                    // The active cluster joins the first ASCII byte (for example GB9b Prepend).
                    // Process it below so the cluster's byte window remains intact.
                } else {
                    const first_class = classifyWordClass(text[pos]);
                    if (cluster_started) {
                        if (!try commitLayoutCluster(
                            visitor,
                            cluster_start,
                            pos,
                            cluster_col_offset,
                            cluster_width_state.width,
                            cluster_break_kind,
                            cluster_class,
                            first_class,
                            text[pos],
                            &has_cjk_breaks,
                        )) return chunkWordClassEdges(text);
                        col += cluster_width_state.width;
                        cluster_started = false;
                    }

                    var i: usize = 0;
                    while (i + 1 < ascii_len) : (i += 1) {
                        const b = text[pos + i];
                        const width = asciiCharWidth(b, tab_width);
                        if (isAsciiWrapBreak(b)) {
                            if (!try emitLayoutWrapBreak(visitor, pos + i, 1, col, width, asciiLayoutWrapBreakKind(b))) return chunkWordClassEdges(text);
                        }
                        col += width;
                    }

                    const last_b = text[pos + ascii_len - 1];
                    const last_cp: u21 = last_b;
                    cluster_started = true;
                    cluster_start = pos + ascii_len - 1;
                    cluster_col_offset = col;
                    cluster_width_state = GraphemeWidthState.init(last_cp, asciiCharWidth(last_b, tab_width), width_method);
                    cluster_break_kind = asciiLayoutWrapBreakKind(last_b);
                    cluster_class = classifyWordClass(last_cp);
                    prev_cp = last_cp;
                    break_state = .default;
                    pos += ascii_len;
                    continue;
                }
            }
        }

        const b0 = text[pos];
        const decoded = decodeUtf8Unchecked(text, pos);
        std.debug.assert(decoded.len > 0 and decoded.len <= text.len - pos);
        const curr_class = classifyWordClass(decoded.cp);
        const is_break = isGraphemeBreak(prev_cp, decoded.cp, &break_state, width_method);
        const cp_width = charWidth(b0, decoded.cp, tab_width);

        if (is_break) {
            if (cluster_started) {
                if (!try commitLayoutCluster(
                    visitor,
                    cluster_start,
                    pos,
                    cluster_col_offset,
                    cluster_width_state.width,
                    cluster_break_kind,
                    cluster_class,
                    curr_class,
                    decoded.cp,
                    &has_cjk_breaks,
                )) return chunkWordClassEdges(text);
                col += cluster_width_state.width;
            }

            cluster_started = true;
            cluster_start = pos;
            cluster_col_offset = col;
            cluster_width_state = GraphemeWidthState.init(decoded.cp, cp_width, width_method);
            cluster_break_kind = if (b0 < 0x80) asciiLayoutWrapBreakKind(b0) else unicodeLayoutWrapBreakKind(decoded.cp);
            cluster_class = curr_class;
        } else {
            cluster_width_state.addCodepoint(decoded.cp, cp_width);
            const next_break_kind = if (b0 < 0x80) asciiLayoutWrapBreakKind(b0) else unicodeLayoutWrapBreakKind(decoded.cp);
            // Only all-whitespace graphemes may be elided by wrapping.
            if (cluster_break_kind == .whitespace or next_break_kind == .whitespace) {
                cluster_break_kind = if (cluster_break_kind == .whitespace and next_break_kind == .whitespace)
                    .whitespace
                else
                    .preserved_whitespace;
            } else if (cluster_break_kind == .none) cluster_break_kind = next_break_kind;
        }

        prev_cp = decoded.cp;
        pos += decoded.len;
    }

    if (cluster_started) {
        _ = try commitLayoutCluster(
            visitor,
            cluster_start,
            text.len,
            cluster_col_offset,
            cluster_width_state.width,
            cluster_break_kind,
            cluster_class,
            null,
            0,
            &has_cjk_breaks,
        );
    }

    return .{ .first = first_word_class, .last = if (cluster_started) cluster_class else .other, .last_cp = prev_cp, .has_cjk_breaks = has_cjk_breaks };
}

/// Find sparse render-cluster metadata for multibyte clusters and tabs.
/// Cluster boundaries follow the selected mode; wcwidth mode sums codepoint cell widths within each cluster.
pub fn findRenderClusterInfo(
    allocator: std.mem.Allocator,
    text: []const u8,
    tab_width: u8,
    isASCIIOnly: bool,
    width_method: WidthMethod,
    result: *std.ArrayListUnmanaged(RenderClusterInfo),
) !void {
    switch (width_method) {
        .unicode, .unicode_wide, .no_zwj => try findRenderClusterInfoUnicode(allocator, text, tab_width, isASCIIOnly, width_method, result),
        .wcwidth => try findRenderClusterInfoWCWidth(allocator, text, tab_width, isASCIIOnly, result),
    }
}

/// Find render clusters using the selected Unicode boundary mode.
fn findRenderClusterInfoUnicode(
    allocator: std.mem.Allocator,
    text: []const u8,
    tab_width: u8,
    isASCIIOnly: bool,
    width_method: WidthMethod,
    result: *std.ArrayListUnmanaged(RenderClusterInfo),
) !void {
    // In wcwidth mode, always process to capture combining marks on ASCII
    if (isASCIIOnly and width_method != .wcwidth) {
        return;
    }

    if (text.len == 0) {
        return;
    }

    const vector_len = 16;
    var pos: usize = 0;
    var col: u32 = 0;
    var prev_cp: ?u21 = null;
    var break_state: uucode.grapheme.BreakState = .default;

    // Track current grapheme cluster
    var cluster_start: usize = 0;
    var cluster_start_col: u32 = 0;
    var cluster_width_state: GraphemeWidthState = undefined;
    var cluster_is_multibyte: bool = false;
    var cluster_is_tab: bool = false;

    while (pos + vector_len <= text.len) {
        const chunk: @Vector(vector_len, u8) = text[pos..][0..vector_len].*;
        const ascii_threshold: @Vector(vector_len, u8) = @splat(0x80);
        const is_non_ascii = chunk >= ascii_threshold;

        // Fast path: all ASCII
        if (!@reduce(.Or, is_non_ascii)) {
            var i: usize = 0;
            while (i < vector_len) : (i += 1) {
                const b = text[pos + i];
                const curr_cp: u21 = b;
                const is_break = isGraphemeBreak(prev_cp, curr_cp, &break_state, width_method);

                if (is_break) {
                    if (prev_cp != null and (cluster_is_multibyte or cluster_is_tab)) {
                        if (cluster_width_state.width > 0 or width_method == .wcwidth) {
                            const cluster_byte_len = (pos + i) - cluster_start;
                            try result.append(allocator, .{
                                .byte_start = @intCast(cluster_start),
                                .byte_len = @intCast(cluster_byte_len),
                                .width_cols = cluster_width_state.width,
                                .col_start = cluster_start_col,
                            });
                        }
                        col += cluster_width_state.width;
                    } else if (prev_cp != null) {
                        col += cluster_width_state.width;
                    }

                    cluster_start = pos + i;
                    cluster_start_col = col;
                    cluster_is_tab = (b == '\t');
                    cluster_is_multibyte = false;

                    const cp_width = asciiCharWidth(b, tab_width);
                    cluster_width_state = GraphemeWidthState.init(curr_cp, cp_width, width_method);
                } else {
                    // Continuing cluster (shouldn't happen for ASCII, but handle it)
                    const cp_width = asciiCharWidth(b, tab_width);
                    cluster_width_state.addCodepoint(curr_cp, cp_width);
                }

                prev_cp = curr_cp;
            }
            pos += vector_len;
            continue;
        }

        // Slow path: mixed ASCII/non-ASCII
        var i: usize = 0;
        while (i < vector_len and pos + i < text.len) {
            const b0 = text[pos + i];
            const curr_cp: u21 = if (b0 < 0x80) b0 else decodeUtf8Unchecked(text, pos + i).cp;
            const cp_len: usize = if (b0 < 0x80) 1 else decodeUtf8Unchecked(text, pos + i).len;

            if (pos + i + cp_len > text.len) break;

            const is_break = isGraphemeBreak(prev_cp, curr_cp, &break_state, width_method);

            if (is_break) {
                if (prev_cp != null and (cluster_is_multibyte or cluster_is_tab)) {
                    if (cluster_width_state.width > 0 or width_method == .wcwidth) {
                        const cluster_byte_len = (pos + i) - cluster_start;
                        try result.append(allocator, .{
                            .byte_start = @intCast(cluster_start),
                            .byte_len = @intCast(cluster_byte_len),
                            .width_cols = cluster_width_state.width,
                            .col_start = cluster_start_col,
                        });
                    }
                    col += cluster_width_state.width;
                } else if (prev_cp != null) {
                    col += cluster_width_state.width;
                }

                cluster_start = pos + i;
                cluster_start_col = col;
                cluster_is_tab = (b0 == '\t');
                cluster_is_multibyte = (cp_len != 1);

                const cp_width = charWidth(b0, curr_cp, tab_width);
                cluster_width_state = GraphemeWidthState.init(curr_cp, cp_width, width_method);
            } else {
                cluster_is_multibyte = cluster_is_multibyte or (cp_len != 1);
                const cp_width = charWidth(b0, curr_cp, tab_width);
                cluster_width_state.addCodepoint(curr_cp, cp_width);
            }

            prev_cp = curr_cp;
            i += cp_len;
        }
        pos += i;
    }

    // Tail processing
    while (pos < text.len) {
        const b0 = text[pos];
        const curr_cp: u21 = if (b0 < 0x80) b0 else decodeUtf8Unchecked(text, pos).cp;
        const cp_len: usize = if (b0 < 0x80) 1 else decodeUtf8Unchecked(text, pos).len;

        if (pos + cp_len > text.len) break;

        const is_break = isGraphemeBreak(prev_cp, curr_cp, &break_state, width_method);

        if (is_break) {
            if (prev_cp != null and (cluster_is_multibyte or cluster_is_tab)) {
                if (cluster_width_state.width > 0 or width_method == .wcwidth) {
                    const cluster_byte_len = pos - cluster_start;
                    try result.append(allocator, .{
                        .byte_start = @intCast(cluster_start),
                        .byte_len = @intCast(cluster_byte_len),
                        .width_cols = cluster_width_state.width,
                        .col_start = cluster_start_col,
                    });
                }
                col += cluster_width_state.width;
            } else if (prev_cp != null) {
                col += cluster_width_state.width;
            }

            cluster_start = pos;
            cluster_start_col = col;
            cluster_is_tab = (b0 == '\t');
            cluster_is_multibyte = (cp_len != 1);

            const cp_width = charWidth(b0, curr_cp, tab_width);
            cluster_width_state = GraphemeWidthState.init(curr_cp, cp_width, width_method);
        } else {
            cluster_is_multibyte = cluster_is_multibyte or (cp_len != 1);
            const cp_width = charWidth(b0, curr_cp, tab_width);
            cluster_width_state.addCodepoint(curr_cp, cp_width);
        }

        prev_cp = curr_cp;
        pos += cp_len;
    }

    if (prev_cp != null and (cluster_is_multibyte or cluster_is_tab)) {
        if (cluster_width_state.width > 0 or width_method == .wcwidth) {
            const cluster_byte_len = text.len - cluster_start;
            try result.append(allocator, .{
                .byte_start = @intCast(cluster_start),
                .byte_len = @intCast(cluster_byte_len),
                .width_cols = cluster_width_state.width,
                .col_start = cluster_start_col,
            });
        }
    }
}

/// Find Unicode render-cluster byte boundaries with codepoint-summed wcwidth cell widths.
fn findRenderClusterInfoWCWidth(
    allocator: std.mem.Allocator,
    text: []const u8,
    tab_width: u8,
    isASCIIOnly: bool,
    result: *std.ArrayListUnmanaged(RenderClusterInfo),
) !void {
    // wcwidth mode should still produce the same grapheme cluster boundaries as Unicode
    // (so ZWJ sequences and combining marks stay together), but the width of each cluster
    // is calculated using wcwidth (sum of codepoint widths). This keeps rendering coherent
    // while preserving tmux-style widths.
    if (isASCIIOnly) {
        return;
    }

    if (text.len == 0) {
        return;
    }

    var pos: usize = 0;
    var col: u32 = 0;
    var prev_cp: ?u21 = null;
    var break_state: uucode.grapheme.BreakState = .default;

    // Track current cluster
    var cluster_start: usize = 0;
    var cluster_start_col: u32 = 0;
    var cluster_width_state: GraphemeWidthState = undefined;
    var cluster_is_multibyte: bool = false;
    var cluster_is_tab: bool = false;
    var cluster_started = false;

    while (pos < text.len) {
        const b0 = text[pos];
        const curr_cp: u21 = if (b0 < 0x80) b0 else blk: {
            const dec = decodeUtf8Unchecked(text, pos);
            if (pos + dec.len > text.len) break :blk 0xFFFD;
            break :blk dec.cp;
        };
        const cp_len: usize = if (b0 < 0x80) 1 else decodeUtf8Unchecked(text, pos).len;

        if (pos + cp_len > text.len) break;

        // Keep Unicode render-cluster boundaries while summing codepoint cell widths.
        const is_break = isGraphemeBreak(prev_cp, curr_cp, &break_state, .wcwidth);

        if (is_break) {
            if (cluster_started and (cluster_is_multibyte or cluster_is_tab)) {
                try result.append(allocator, .{
                    .byte_start = @intCast(cluster_start),
                    .byte_len = @intCast(pos - cluster_start),
                    .width_cols = cluster_width_state.width,
                    .col_start = cluster_start_col,
                });
                col += cluster_width_state.width;
            } else if (cluster_started) {
                // Still need to advance col by cluster width even if not emitted
                col += cluster_width_state.width;
            }

            // Start a new cluster
            cluster_start = pos;
            cluster_start_col = col;
            cluster_is_tab = (b0 == '\t');
            cluster_is_multibyte = (cp_len != 1);
            const cp_width = charWidth(b0, curr_cp, tab_width);
            cluster_width_state = GraphemeWidthState.init(curr_cp, cp_width, .wcwidth);
            cluster_started = true;
        } else {
            // Continuing cluster
            cluster_is_multibyte = cluster_is_multibyte or (cp_len != 1);
            const cp_width = charWidth(b0, curr_cp, tab_width);
            cluster_width_state.addCodepoint(curr_cp, cp_width);
        }

        prev_cp = curr_cp;
        pos += cp_len;
    }

    // Commit final cluster
    if (cluster_started) {
        if (cluster_is_multibyte or cluster_is_tab) {
            try result.append(allocator, .{
                .byte_start = @intCast(cluster_start),
                .byte_len = @intCast(text.len - cluster_start),
                .width_cols = cluster_width_state.width,
                .col_start = cluster_start_col,
            });
            col += cluster_width_state.width;
        } else {
            col += cluster_width_state.width;
        }
    }
}
