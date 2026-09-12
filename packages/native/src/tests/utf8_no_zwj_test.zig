const std = @import("std");
const testing = std.testing;
const utf8 = @import("../utf8.zig");

test "no_zwj: basic emoji ZWJ sequence split" {
    const text = "👩‍🚀"; // Woman + ZWJ + Rocket

    const width_unicode = utf8.calculateTextWidth(text, 4, false, .unicode);
    const width_no_zwj = utf8.calculateTextWidth(text, 4, false, .no_zwj);
    const width_wcwidth = utf8.calculateTextWidth(text, 4, false, .wcwidth);

    // unicode: single grapheme cluster (width 2)
    try testing.expectEqual(@as(u32, 2), width_unicode);

    // no_zwj: woman (2) + ZWJ breaks + rocket (2) = 4
    try testing.expectEqual(@as(u32, 4), width_no_zwj);

    // wcwidth: woman (2) + ZWJ (0) + rocket (2) = 4
    try testing.expectEqual(@as(u32, 4), width_wcwidth);
}

test "no_zwj: family emoji split" {
    const text = "👨‍👩‍👧"; // Man + ZWJ + Woman + ZWJ + Girl

    const width_unicode = utf8.calculateTextWidth(text, 4, false, .unicode);
    const width_no_zwj = utf8.calculateTextWidth(text, 4, false, .no_zwj);

    // unicode: single grapheme (width 2)
    try testing.expectEqual(@as(u32, 2), width_unicode);

    // no_zwj: man (2) + woman (2) + girl (2) = 6 (ZWJ is ignored/width 0)
    try testing.expectEqual(@as(u32, 6), width_no_zwj);
}

test "no_zwj: combining marks still combined" {
    const text = "é"; // e + combining acute (U+0301)

    const width_unicode = utf8.calculateTextWidth(text, 4, false, .unicode);
    const width_no_zwj = utf8.calculateTextWidth(text, 4, false, .no_zwj);

    // Both should treat this as a single grapheme with width 1
    try testing.expectEqual(@as(u32, 1), width_unicode);
    try testing.expectEqual(@as(u32, 1), width_no_zwj);
}

test "no_zwj: skin tone modifiers still combined" {
    const text = "👋🏿"; // Wave + dark skin tone

    const width_unicode = utf8.calculateTextWidth(text, 4, false, .unicode);
    const width_no_zwj = utf8.calculateTextWidth(text, 4, false, .no_zwj);
    const width_wcwidth = utf8.calculateTextWidth(text, 4, false, .wcwidth);

    // unicode: single grapheme (width 2)
    try testing.expectEqual(@as(u32, 2), width_unicode);

    // no_zwj: should also be single grapheme (width 2) - skin tone is not ZWJ
    try testing.expectEqual(@as(u32, 2), width_no_zwj);

    // wcwidth: two separate codepoints (2 + 2 = 4)
    try testing.expectEqual(@as(u32, 4), width_wcwidth);
}

test "no_zwj: flag emoji stays combined" {
    const text = "🇺🇸"; // US flag (two regional indicators)

    const width_unicode = utf8.calculateTextWidth(text, 4, false, .unicode);
    const width_no_zwj = utf8.calculateTextWidth(text, 4, false, .no_zwj);
    const width_wcwidth = utf8.calculateTextWidth(text, 4, false, .wcwidth);

    // unicode: single flag grapheme (width 2)
    try testing.expectEqual(@as(u32, 2), width_unicode);

    // no_zwj: should also be single grapheme (width 2) - no ZWJ involved
    try testing.expectEqual(@as(u32, 2), width_no_zwj);

    // wcwidth: two separate RIs (1 + 1 = 2)
    try testing.expectEqual(@as(u32, 2), width_wcwidth);
}

test "no_zwj: mixed text with ZWJ emoji" {
    const text = "Hello👩‍🚀World"; // Hello + woman astronaut + World

    const width_unicode = utf8.calculateTextWidth(text, 4, false, .unicode);
    const width_no_zwj = utf8.calculateTextWidth(text, 4, false, .no_zwj);

    // unicode: Hello(5) + astronaut(2) + World(5) = 12
    try testing.expectEqual(@as(u32, 12), width_unicode);

    // no_zwj: Hello(5) + woman(2) + rocket(2) + World(5) = 14
    try testing.expectEqual(@as(u32, 14), width_no_zwj);
}

test "no_zwj: findRenderClusterInfo splits ZWJ sequences" {
    var result_unicode: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
    defer result_unicode.deinit(testing.allocator);
    var result_no_zwj: std.ArrayListUnmanaged(utf8.RenderClusterInfo) = .empty;
    defer result_no_zwj.deinit(testing.allocator);

    const text = "Hi👩‍🚀Bye";

    try utf8.findRenderClusterInfo(testing.allocator, text, 4, false, .unicode, &result_unicode);
    try utf8.findRenderClusterInfo(testing.allocator, text, 4, false, .no_zwj, &result_no_zwj);

    // unicode: 1 grapheme (the whole ZWJ sequence)
    try testing.expectEqual(@as(usize, 1), result_unicode.items.len);
    try testing.expectEqual(@as(u32, 2), result_unicode.items[0].width_cols);

    // no_zwj: 2 graphemes (woman and rocket separately)
    try testing.expectEqual(@as(usize, 2), result_no_zwj.items.len);
    try testing.expectEqual(@as(u32, 2), result_no_zwj.items[0].width_cols);
    try testing.expectEqual(@as(u32, 2), result_no_zwj.items[1].width_cols);
}

test "no_zwj: findWrapPosByWidth with ZWJ sequences" {
    const text = "AB👩‍🚀CD"; // A(1) B(1) woman(2) rocket(2) C(1) D(1)

    const result_unicode = utf8.findWrapPosByWidth(text, 4, 4, false, .unicode);
    const result_no_zwj = utf8.findWrapPosByWidth(text, 4, 4, false, .no_zwj);

    // unicode: stops after "AB👩‍🚀" = 4 columns (whole sequence)
    try testing.expectEqual(@as(u32, 4), result_unicode.columns_used);

    // no_zwj: stops after "AB👩" = 4 columns (woman only)
    try testing.expectEqual(@as(u32, 4), result_no_zwj.columns_used);
}

test "no_zwj: findPosByWidth with ZWJ sequences" {
    const text = "AB👩‍🚀CD"; // A(1) B(1) woman(2) rocket(2) C(1) D(1)

    // With include_start_before=false
    const start4_unicode = utf8.findPosByWidth(text, 4, 4, false, false, .unicode);
    const start4_no_zwj = utf8.findPosByWidth(text, 4, 4, false, false, .no_zwj);

    // unicode: Woman+ZWJ+Rocket is one grapheme that ends at col 4, so it's included
    // Stops at 'C' (byte 13)
    try testing.expectEqual(@as(u32, 13), start4_unicode.byte_offset);
    try testing.expectEqual(@as(u32, 4), start4_unicode.columns_used);

    // no_zwj: Woman (col 2-4) ends at 4, included. Rocket (col 4-6) ends at 6 > 4, excluded
    // Stops after woman+ZWJ (byte 9, before rocket)
    try testing.expectEqual(@as(u32, 9), start4_no_zwj.byte_offset);
    try testing.expectEqual(@as(u32, 4), start4_no_zwj.columns_used);

    // With include_start_before=true
    const end4_unicode = utf8.findPosByWidth(text, 4, 4, false, true, .unicode);
    const end4_no_zwj = utf8.findPosByWidth(text, 4, 4, false, true, .no_zwj);

    // unicode: includes whole sequence
    try testing.expectEqual(@as(u32, 4), end4_unicode.columns_used);

    // no_zwj: includes woman only
    try testing.expectEqual(@as(u32, 4), end4_no_zwj.columns_used);
}

test "no_zwj: getWidthAt with ZWJ sequence" {
    const text = "👩‍🚀"; // Woman + ZWJ + Rocket

    // At woman emoji (byte 0)
    const width_woman_unicode = utf8.getWidthAt(text, 0, 4, .unicode);
    const width_woman_no_zwj = utf8.getWidthAt(text, 0, 4, .no_zwj);

    // unicode: whole sequence width
    try testing.expectEqual(@as(u32, 2), width_woman_unicode);

    // no_zwj: just woman
    try testing.expectEqual(@as(u32, 2), width_woman_no_zwj);

    // At ZWJ (byte 4)
    const width_zwj_no_zwj = utf8.getWidthAt(text, 4, 4, .no_zwj);
    try testing.expectEqual(@as(u32, 0), width_zwj_no_zwj); // ZWJ itself has width 0
}

test "no_zwj: getPrevGraphemeStart with ZWJ sequence" {
    const text = "AB👩‍🚀CD";

    // From end of text (after 'D')
    const r1_unicode = utf8.getPrevGraphemeStart(text, text.len, 4, .unicode);
    const r1_no_zwj = utf8.getPrevGraphemeStart(text, text.len, 4, .no_zwj);

    try testing.expect(r1_unicode != null);
    try testing.expect(r1_no_zwj != null);

    // unicode: should point to 'D' (last ASCII char)
    try testing.expectEqual(@as(u32, 1), r1_unicode.?.width);

    // no_zwj: should also point to 'D'
    try testing.expectEqual(@as(u32, 1), r1_no_zwj.?.width);
}

test "no_zwj: multiple ZWJ sequences" {
    const text = "👨‍👩‍👧👨‍👩‍👦"; // Family with girl + Family with boy

    const width_unicode = utf8.calculateTextWidth(text, 4, false, .unicode);
    const width_no_zwj = utf8.calculateTextWidth(text, 4, false, .no_zwj);

    // unicode: 2 families = 4 columns
    try testing.expectEqual(@as(u32, 4), width_unicode);

    // no_zwj: 6 people = 12 columns (each person is width 2)
    try testing.expectEqual(@as(u32, 12), width_no_zwj);
}

test "no_zwj: ZWJ with skin tones" {
    const text = "👨🏿‍❤️‍👨🏻"; // Man with dark skin + ZWJ + heart + ZWJ + man with light skin

    const width_unicode = utf8.calculateTextWidth(text, 4, false, .unicode);
    const width_no_zwj = utf8.calculateTextWidth(text, 4, false, .no_zwj);

    // unicode: single couple grapheme (width 2)
    try testing.expectEqual(@as(u32, 2), width_unicode);

    // no_zwj: man+skin (2) + heart+VS16 (2) + man+skin (2) = 6
    try testing.expectEqual(@as(u32, 6), width_no_zwj);
}

test "no_zwj: keycap sequences without ZWJ" {
    const text = "1️⃣"; // 1 + VS16 + combining enclosing keycap

    const width_unicode = utf8.calculateTextWidth(text, 4, false, .unicode);
    const width_no_zwj = utf8.calculateTextWidth(text, 4, false, .no_zwj);
    const width_wcwidth = utf8.calculateTextWidth(text, 4, false, .wcwidth);

    // unicode and no_zwj should both treat this as a single grapheme
    try testing.expectEqual(@as(u32, 2), width_unicode);
    try testing.expectEqual(@as(u32, 2), width_no_zwj);

    // wcwidth counts each codepoint: 1(1) + VS16(0) + keycap combining(0) = 1
    // Keycap is a combining character that doesn't add width
    try testing.expectEqual(@as(u32, 1), width_wcwidth);
}

test "no_zwj: rainbow flag without ZWJ" {
    const text = "🏳️‍🌈"; // White flag + VS16 + ZWJ + rainbow

    const width_unicode = utf8.calculateTextWidth(text, 4, false, .unicode);
    const width_no_zwj = utf8.calculateTextWidth(text, 4, false, .no_zwj);

    // unicode: single rainbow flag grapheme (width 2)
    try testing.expectEqual(@as(u32, 2), width_unicode);

    // no_zwj: flag+VS16 (2) + rainbow (2) = 4 (ZWJ causes break)
    try testing.expectEqual(@as(u32, 4), width_no_zwj);
}

test "no_zwj: Devanagari conjuncts still work" {
    const text = "क्ष"; // Ka + virama + Sha (conjunct)

    const width_unicode = utf8.calculateTextWidth(text, 4, false, .unicode);
    const width_no_zwj = utf8.calculateTextWidth(text, 4, false, .no_zwj);
    const width_wcwidth = utf8.calculateTextWidth(text, 4, false, .wcwidth);

    // unicode: Devanagari renders as width 2 in terminals (Ka=1 + Sha=1)
    try testing.expectEqual(@as(u32, 2), width_unicode);

    // no_zwj: should behave same as unicode for non-ZWJ sequences
    try testing.expectEqual(@as(u32, 2), width_no_zwj);

    // wcwidth: counts each codepoint separately (same result)
    try testing.expectEqual(@as(u32, 2), width_wcwidth); // Ka(1) + virama(0) + Sha(1)
}
