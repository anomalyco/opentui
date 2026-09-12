const std = @import("std");
const testing = std.testing;
const utf8 = @import("../utf8.zig");

test "findRenderClusterInfo wcwidth: empty string" {
    var result: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
    defer result.deinit(testing.allocator);

    try utf8.findRenderClusterInfo(testing.allocator, "", 4, false, .wcwidth, &result);
    try testing.expectEqual(@as(usize, 0), result.items.len);
}

test "findRenderClusterInfo wcwidth: ASCII-only returns empty" {
    var result: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
    defer result.deinit(testing.allocator);

    try utf8.findRenderClusterInfo(testing.allocator, "hello world", 4, true, .wcwidth, &result);
    try testing.expectEqual(@as(usize, 0), result.items.len);
}

test "findRenderClusterInfo wcwidth: ASCII with tab" {
    var result: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
    defer result.deinit(testing.allocator);

    try utf8.findRenderClusterInfo(testing.allocator, "hello\tworld", 4, false, .wcwidth, &result);

    // Should have one entry for the tab
    try testing.expectEqual(@as(usize, 1), result.items.len);
    try testing.expectEqual(@as(u32, 5), result.items[0].byte_start);
    try testing.expectEqual(@as(u32, 1), result.items[0].byte_len);
    try testing.expectEqual(@as(u32, 4), result.items[0].width_cols);
    try testing.expectEqual(@as(u32, 5), result.items[0].col_start);
}

test "findRenderClusterInfo wcwidth: CJK characters" {
    var result: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
    defer result.deinit(testing.allocator);

    const text = "hello世界";
    try utf8.findRenderClusterInfo(testing.allocator, text, 4, false, .wcwidth, &result);

    // Should have two entries for the CJK characters (each codepoint separately)
    try testing.expectEqual(@as(usize, 2), result.items.len);

    // First CJK char '世' at byte 5
    try testing.expectEqual(@as(u32, 5), result.items[0].byte_start);
    try testing.expectEqual(@as(u32, 3), result.items[0].byte_len);
    try testing.expectEqual(@as(u32, 2), result.items[0].width_cols);
    try testing.expectEqual(@as(u32, 5), result.items[0].col_start);

    // Second CJK char '界' at byte 8
    try testing.expectEqual(@as(u32, 8), result.items[1].byte_start);
    try testing.expectEqual(@as(u32, 3), result.items[1].byte_len);
    try testing.expectEqual(@as(u32, 2), result.items[1].width_cols);
    try testing.expectEqual(@as(u32, 7), result.items[1].col_start);
}

test "findRenderClusterInfo wcwidth: emoji with skin tone - single grapheme cluster" {
    var result: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
    defer result.deinit(testing.allocator);

    const text = "👋🏿"; // Wave + skin tone modifier
    try utf8.findRenderClusterInfo(testing.allocator, text, 4, false, .wcwidth, &result);

    try testing.expectEqual(@as(usize, 1), result.items.len);

    try testing.expectEqual(@as(u32, 0), result.items[0].byte_start);
    try testing.expectEqual(@as(u32, 8), result.items[0].byte_len);
    try testing.expectEqual(@as(u32, 4), result.items[0].width_cols);
}

test "findRenderClusterInfo wcwidth: emoji with ZWJ - single grapheme cluster" {
    var result: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
    defer result.deinit(testing.allocator);

    const text = "👩‍🚀"; // Woman + ZWJ + Rocket (11 bytes total)
    try utf8.findRenderClusterInfo(testing.allocator, text, 4, false, .wcwidth, &result);

    try testing.expectEqual(@as(usize, 1), result.items.len);

    try testing.expectEqual(@as(u32, 11), result.items[0].byte_len);
    try testing.expectEqual(@as(u32, 4), result.items[0].width_cols);
}

test "findRenderClusterInfo wcwidth: combining mark - part of base grapheme" {
    var result: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
    defer result.deinit(testing.allocator);

    const text = "e\u{0301}test"; // e + combining acute accent + test
    try utf8.findRenderClusterInfo(testing.allocator, text, 4, false, .wcwidth, &result);

    try testing.expectEqual(@as(usize, 1), result.items.len);
    try testing.expectEqual(@as(u32, 0), result.items[0].byte_start);
    try testing.expectEqual(@as(u32, 3), result.items[0].byte_len);
    try testing.expectEqual(@as(u32, 1), result.items[0].width_cols);
}

test "findRenderClusterInfo wcwidth vs unicode: emoji with skin tone" {
    var result_wcwidth: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
    defer result_wcwidth.deinit(testing.allocator);
    var result_unicode: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
    defer result_unicode.deinit(testing.allocator);

    const text = "Hi👋🏿Bye";

    try utf8.findRenderClusterInfo(testing.allocator, text, 4, false, .wcwidth, &result_wcwidth);
    try utf8.findRenderClusterInfo(testing.allocator, text, 4, false, .unicode, &result_unicode);

    try testing.expectEqual(@as(usize, 1), result_wcwidth.items.len);
    try testing.expectEqual(@as(usize, 1), result_unicode.items.len);

    try testing.expectEqual(@as(u32, 2), result_wcwidth.items[0].byte_start);
    try testing.expectEqual(@as(u32, 8), result_wcwidth.items[0].byte_len);

    try testing.expectEqual(@as(u32, 2), result_unicode.items[0].byte_start);
    try testing.expectEqual(@as(u32, 8), result_unicode.items[0].byte_len);

    try testing.expectEqual(@as(u32, 4), result_wcwidth.items[0].width_cols);
    try testing.expectEqual(@as(u32, 2), result_unicode.items[0].width_cols);
}

test "findRenderClusterInfo wcwidth vs unicode: flag emoji" {
    var result_wcwidth: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
    defer result_wcwidth.deinit(testing.allocator);
    var result_unicode: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
    defer result_unicode.deinit(testing.allocator);

    const text = "🇺🇸"; // US flag (two regional indicators)

    try utf8.findRenderClusterInfo(testing.allocator, text, 4, false, .wcwidth, &result_wcwidth);
    try utf8.findRenderClusterInfo(testing.allocator, text, 4, false, .unicode, &result_unicode);

    try testing.expectEqual(@as(usize, 1), result_wcwidth.items.len);
    try testing.expectEqual(@as(usize, 1), result_unicode.items.len);

    try testing.expectEqual(@as(u32, 2), result_wcwidth.items[0].width_cols);
    try testing.expectEqual(@as(u32, 2), result_unicode.items[0].width_cols);
}

// ============================================================================
// WIDTH CALCULATION TESTS - WCWIDTH MODE
// ============================================================================

test "getWidthAt wcwidth: combining mark has zero width" {
    const text = "e\u{0301}"; // e + combining acute accent

    // In wcwidth mode, combining mark is a separate codepoint
    const width_e = utf8.getWidthAt(text, 0, 8, .wcwidth);
    try testing.expectEqual(@as(u32, 1), width_e); // Just 'e'

    const width_combining = utf8.getWidthAt(text, 1, 8, .wcwidth);
    try testing.expectEqual(@as(u32, 0), width_combining); // Combining mark has width 0
}

test "calculateTextWidth wcwidth: emoji with skin tone counts both codepoints" {
    const text = "👋🏿"; // Wave + dark skin tone

    const width_wcwidth = utf8.calculateTextWidth(text, 4, false, .wcwidth);
    const width_unicode = utf8.calculateTextWidth(text, 4, false, .unicode);

    // wcwidth: counts both codepoints (2 + 2 = 4)
    try testing.expectEqual(@as(u32, 4), width_wcwidth);

    // unicode: single grapheme cluster (width 2)
    try testing.expectEqual(@as(u32, 2), width_unicode);
}

test "calculateTextWidth wcwidth: flag emoji counts both RIs" {
    const text = "🇺🇸"; // US flag

    const width_wcwidth = utf8.calculateTextWidth(text, 4, false, .wcwidth);
    const width_unicode = utf8.calculateTextWidth(text, 4, false, .unicode);

    // wcwidth: counts both regional indicators (1 + 1 = 2)
    try testing.expectEqual(@as(u32, 2), width_wcwidth);

    // unicode: single flag grapheme (width 2)
    try testing.expectEqual(@as(u32, 2), width_unicode);
}

// ============================================================================
// FIND WRAP POS BY WIDTH TESTS - WCWIDTH MODE
// ============================================================================

test "findWrapPosByWidth wcwidth: emoji with skin tone stops earlier" {
    const text = "Hi👋🏿Bye"; // H(1) i(1) wave(2) skin(2) B(1) y(1) e(1) = 10 cols wcwidth

    const result_wcwidth = utf8.findWrapPosByWidth(text, 4, 4, false, .wcwidth);
    const result_unicode = utf8.findWrapPosByWidth(text, 4, 4, false, .unicode);

    // wcwidth: stops after "Hi👋" = 4 columns (1+1+2)
    try testing.expectEqual(@as(u32, 6), result_wcwidth.byte_offset);
    try testing.expectEqual(@as(u32, 4), result_wcwidth.columns_used);

    // unicode: stops after "Hi👋🏿" = 4 columns (1+1+2 for whole grapheme)
    try testing.expectEqual(@as(u32, 10), result_unicode.byte_offset);
    try testing.expectEqual(@as(u32, 4), result_unicode.columns_used);
}

test "findPosByWidth wcwidth: emoji boundary behavior" {
    const text = "AB👋🏿CD"; // A(1) B(1) wave(2) skin(2) C(1) D(1)

    // With include_start_before=false (selection start)
    const start3 = utf8.findPosByWidth(text, 3, 4, false, false, .wcwidth);
    // wcwidth: stops after "AB" at 2 columns (wave would exceed)
    try testing.expectEqual(@as(u32, 2), start3.byte_offset);

    // With include_start_before=true (selection end)
    const end3 = utf8.findPosByWidth(text, 3, 4, false, true, .wcwidth);
    // wcwidth: includes wave since it starts at column 2 which is < 3
    try testing.expectEqual(@as(u32, 6), end3.byte_offset);
    try testing.expectEqual(@as(u32, 4), end3.columns_used);
}

test "getPrevGraphemeStart wcwidth: each codepoint separate" {
    const text = "Hi👋🏿";

    // From end of text (after skin tone)
    const r_end = utf8.getPrevGraphemeStart(text, text.len, 4, .wcwidth);
    try testing.expect(r_end != null);
    try testing.expectEqual(@as(usize, 6), r_end.?.start_offset); // Skin tone starts at byte 6
    try testing.expectEqual(@as(u32, 2), r_end.?.width);

    // From start of skin tone (byte 6)
    const r_wave = utf8.getPrevGraphemeStart(text, 6, 4, .wcwidth);
    try testing.expect(r_wave != null);
    try testing.expectEqual(@as(usize, 2), r_wave.?.start_offset); // Wave starts at byte 2
    try testing.expectEqual(@as(u32, 2), r_wave.?.width);
}

// ============================================================================
// ADDITIONAL COMPREHENSIVE WCWIDTH TESTS
// ============================================================================

test "wcwidth: zero-width characters are handled correctly" {
    // ZWJ (Zero Width Joiner) should have width 0
    const text_zwj = "\u{200D}";
    const width_zwj = utf8.calculateTextWidth(text_zwj, 4, false, .wcwidth);
    try testing.expectEqual(@as(u32, 0), width_zwj);

    // Combining marks should have width 0
    const text_combining = "e\u{0301}"; // e + combining acute
    const width = utf8.calculateTextWidth(text_combining, 4, false, .wcwidth);
    try testing.expectEqual(@as(u32, 1), width); // Only 'e' contributes
}

test "wcwidth: variation selectors" {
    // VS15 (text presentation) and VS16 (emoji presentation)
    const text_vs16 = "☺\u{FE0F}"; // Smiling face + VS16
    const width_vs16 = utf8.calculateTextWidth(text_vs16, 4, false, .wcwidth);
    try testing.expectEqual(@as(u32, 1), width_vs16); // Smiling face (1) + VS16 (0) = 1
}

test "wcwidth: regional indicators counted separately" {
    // Each regional indicator should contribute width 1
    const text = "🇺🇸"; // US flag = two regional indicators
    const width = utf8.calculateTextWidth(text, 4, false, .wcwidth);
    try testing.expectEqual(@as(u32, 2), width); // Each RI has width 1
}

test "wcwidth: emoji ZWJ sequences split" {
    // Woman astronaut = woman + ZWJ + rocket
    const text = "👩‍🚀";
    const width = utf8.calculateTextWidth(text, 4, false, .wcwidth);
    // Woman (2) + ZWJ (0) + Rocket (2) = 4
    try testing.expectEqual(@as(u32, 4), width);
}

test "wcwidth: family emoji split into components" {
    // Family emoji with ZWJ
    const text = "👨‍👩‍👧"; // Man + ZWJ + Woman + ZWJ + Girl
    const width = utf8.calculateTextWidth(text, 4, false, .wcwidth);
    // Man (2) + ZWJ (0) + Woman (2) + ZWJ (0) + Girl (2) = 6
    try testing.expectEqual(@as(u32, 6), width);
}

test "wcwidth: skin tone modifiers counted separately" {
    // Emoji with skin tone modifier
    const text = "👋🏻"; // Wave + light skin tone
    const width = utf8.calculateTextWidth(text, 4, false, .wcwidth);
    // Wave (2) + Skin tone modifier (2) = 4
    try testing.expectEqual(@as(u32, 4), width);
}

test "wcwidth: CJK characters have width 2" {
    const text = "你好世界"; // 4 CJK characters
    const width = utf8.calculateTextWidth(text, 4, false, .wcwidth);
    try testing.expectEqual(@as(u32, 8), width); // 4 * 2 = 8
}

test "wcwidth: mixed ASCII and emoji" {
    const text = "Hello👋World";
    // H(1) e(1) l(1) l(1) o(1) 👋(2) W(1) o(1) r(1) l(1) d(1) = 12
    const width = utf8.calculateTextWidth(text, 4, false, .wcwidth);
    try testing.expectEqual(@as(u32, 12), width);
}

test "wcwidth: findWrapPosByWidth with ZWJ sequences" {
    const text = "AB👩‍🚀CD"; // A(1) B(1) woman(2) ZWJ(0) rocket(2) C(1) D(1) = 8

    // Should wrap after woman emoji (before ZWJ)
    const result = utf8.findWrapPosByWidth(text, 4, 4, false, .wcwidth);
    try testing.expectEqual(@as(u32, 6), result.byte_offset); // After woman emoji
    try testing.expectEqual(@as(u32, 4), result.columns_used);
}

test "wcwidth: findPosByWidth with skin tone modifier" {
    const text = "AB👋🏻CD"; // A(1) B(1) wave(2) skin(2) C(1) D(1) = 8

    // With include_start_before=false, include codepoints that end at or before max_columns
    // Wave ends at column 4, which is at max_columns=4, so it's included
    const start4 = utf8.findPosByWidth(text, 4, 4, false, false, .wcwidth);
    try testing.expectEqual(@as(u32, 6), start4.byte_offset); // After wave
    try testing.expectEqual(@as(u32, 4), start4.columns_used);

    // With include_start_before=true, include codepoints that start before max_columns
    // Wave starts at column 2 which is < 4, so it's included
    const end4 = utf8.findPosByWidth(text, 4, 4, false, true, .wcwidth);
    try testing.expectEqual(@as(u32, 6), end4.byte_offset); // After wave
    try testing.expectEqual(@as(u32, 4), end4.columns_used);
}

test "wcwidth: getWidthAt with combining marks" {
    const text = "e\u{0301}test"; // e + combining acute

    // Width at 'e' should be 1
    const width_e = utf8.getWidthAt(text, 0, 4, .wcwidth);
    try testing.expectEqual(@as(u32, 1), width_e);

    // Width at combining mark should be 0 (but next non-zero is 't')
    const width_combining = utf8.getWidthAt(text, 1, 4, .wcwidth);
    try testing.expectEqual(@as(u32, 0), width_combining);
}

test "wcwidth: getPrevGraphemeStart with ZWJ sequence" {
    const text = "AB👩‍🚀"; // A B woman ZWJ rocket

    // From end (after rocket)
    const r1 = utf8.getPrevGraphemeStart(text, text.len, 4, .wcwidth);
    try testing.expect(r1 != null);
    // Should point to rocket emoji (after ZWJ)
    try testing.expectEqual(@as(u32, 2), r1.?.width);

    // From rocket start, should go to ZWJ
    const r2 = utf8.getPrevGraphemeStart(text, r1.?.start_offset, 4, .wcwidth);
    try testing.expect(r2 != null);

    // Eventually should reach woman emoji
    var pos = text.len;
    var count: usize = 0;
    while (utf8.getPrevGraphemeStart(text, pos, 4, .wcwidth)) |prev| {
        pos = prev.start_offset;
        count += 1;
        if (count > 10) break; // Safety limit
    }
    try testing.expect(count >= 3); // At least rocket, ZWJ, woman
}
