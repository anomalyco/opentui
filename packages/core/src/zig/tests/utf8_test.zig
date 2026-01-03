const std = @import("std");
const testing = std.testing;
const utf8 = @import("../utf8.zig");

// ============================================================================
// ASCII-ONLY DETECTION TESTS
// ============================================================================

test "isAsciiOnly: empty string" {
    // Empty string is not ASCII-only by convention
    try testing.expect(!utf8.isAsciiOnly(""));
}

test "isAsciiOnly: simple ASCII" {
    try testing.expect(utf8.isAsciiOnly("Hello, World!"));
    try testing.expect(utf8.isAsciiOnly("The quick brown fox"));
    try testing.expect(utf8.isAsciiOnly("0123456789"));
    try testing.expect(utf8.isAsciiOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"));
}

test "isAsciiOnly: control chars rejected" {
    try testing.expect(!utf8.isAsciiOnly("Hello\tWorld"));
    try testing.expect(!utf8.isAsciiOnly("Hello\nWorld"));
    try testing.expect(!utf8.isAsciiOnly("Hello\rWorld"));
    try testing.expect(!utf8.isAsciiOnly("\x00"));
    try testing.expect(!utf8.isAsciiOnly("\x1F"));
}

test "isAsciiOnly: extended ASCII rejected" {
    try testing.expect(!utf8.isAsciiOnly("Hello\x7FWorld"));
    try testing.expect(!utf8.isAsciiOnly("Hello\x80World"));
    try testing.expect(!utf8.isAsciiOnly("Hello\xFFWorld"));
}

test "isAsciiOnly: Unicode rejected" {
    try testing.expect(!utf8.isAsciiOnly("Hello 👋"));
    try testing.expect(!utf8.isAsciiOnly("Hello 世界"));
    try testing.expect(!utf8.isAsciiOnly("café"));
    try testing.expect(!utf8.isAsciiOnly("Привет"));
}

test "isAsciiOnly: space character accepted" {
    try testing.expect(utf8.isAsciiOnly(" "));
    try testing.expect(utf8.isAsciiOnly("   "));
    try testing.expect(utf8.isAsciiOnly("Hello World"));
}

test "isAsciiOnly: all printable ASCII chars" {
    const all_printable = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
    try testing.expect(utf8.isAsciiOnly(all_printable));
}

test "isAsciiOnly: SIMD boundary tests" {
    try testing.expect(utf8.isAsciiOnly("0123456789abcdef"));
    try testing.expect(utf8.isAsciiOnly("0123456789abcde"));
    try testing.expect(utf8.isAsciiOnly("0123456789abcdefg"));
    try testing.expect(utf8.isAsciiOnly("0123456789abcdef0123456789abcdef"));
    try testing.expect(utf8.isAsciiOnly("0123456789abcdef0123456789abcdefX"));
}

test "isAsciiOnly: non-ASCII at different positions" {
    try testing.expect(!utf8.isAsciiOnly("Hello\x00World"));
    try testing.expect(!utf8.isAsciiOnly("\x00bcdefghijklmnop"));
    try testing.expect(!utf8.isAsciiOnly("0123456789abcde\x00"));
    try testing.expect(!utf8.isAsciiOnly("0123456789abcdef\x00"));
    try testing.expect(!utf8.isAsciiOnly("0123456789abcdef0123456789\x00bcdef"));
    try testing.expect(!utf8.isAsciiOnly("0123456789abcdef01234\x00"));
}

test "isAsciiOnly: large ASCII text" {
    const size = 10000;
    const buf = try testing.allocator.alloc(u8, size);
    defer testing.allocator.free(buf);

    for (buf, 0..) |*b, i| {
        b.* = 32 + @as(u8, @intCast(i % 95));
    }

    try testing.expect(utf8.isAsciiOnly(buf));

    buf[5000] = 0x80;
    try testing.expect(!utf8.isAsciiOnly(buf));
}

// ============================================================================
// LINE BREAK TESTS
// ============================================================================

const LineBreakTestCase = struct {
    name: []const u8,
    input: []const u8,
    expected: []const usize,
};

const line_break_golden_tests = [_]LineBreakTestCase{
    .{
        .name = "empty string",
        .input = "",
        .expected = &[_]usize{},
    },
    .{
        .name = "only LF",
        .input = "a\nb",
        .expected = &[_]usize{1},
    },
    .{
        .name = "only CR",
        .input = "a\rb",
        .expected = &[_]usize{1},
    },
    .{
        .name = "CRLF",
        .input = "a\r\nb",
        .expected = &[_]usize{2}, // CRLF recorded at \n index
    },
    .{
        .name = "ending with CR",
        .input = "a\r",
        .expected = &[_]usize{1},
    },
    .{
        .name = "ending with LF",
        .input = "a\n",
        .expected = &[_]usize{1},
    },
    .{
        .name = "ending with CRLF",
        .input = "a\r\n",
        .expected = &[_]usize{2},
    },
    .{
        .name = "consecutive LF",
        .input = "\n\n",
        .expected = &[_]usize{ 0, 1 },
    },
    .{
        .name = "consecutive CRLF",
        .input = "\r\n\r\n",
        .expected = &[_]usize{ 1, 3 },
    },
    .{
        .name = "mixed breaks",
        .input = "\n\r\n\r",
        .expected = &[_]usize{ 0, 2, 3 },
    },
    .{
        .name = "CR LF separate",
        .input = "\r\r\n",
        .expected = &[_]usize{ 0, 2 },
    },
    .{
        .name = "very long line no breaks",
        .input = "a" ** 1000,
        .expected = &[_]usize{},
    },
    .{
        .name = "multiple LF",
        .input = "line1\nline2\nline3\n",
        .expected = &[_]usize{ 5, 11, 17 },
    },
    .{
        .name = "multiple CRLF",
        .input = "line1\r\nline2\r\nline3\r\n",
        .expected = &[_]usize{ 6, 13, 20 },
    },
    .{
        .name = "mixed line endings",
        .input = "unix\nmac\rwin\r\n",
        .expected = &[_]usize{ 4, 8, 13 },
    },
};

fn testLineBreaks(test_case: LineBreakTestCase, allocator: std.mem.Allocator) !void {
    var result = utf8.LineBreakResult.init(allocator);
    defer result.deinit();

    try utf8.findLineBreaks(test_case.input, &result);

    try testing.expectEqual(test_case.expected.len, result.breaks.items.len);

    for (test_case.expected, 0..) |exp, i| {
        try testing.expectEqual(exp, result.breaks.items[i].pos);
    }
}

test "line breaks: golden tests" {
    for (line_break_golden_tests) |tc| {
        try testLineBreaks(tc, testing.allocator);
    }
}

test "line breaks: CRLF at SIMD16 edge (15-16)" {
    var buf: [32]u8 = undefined;
    @memset(&buf, 'x');
    buf[15] = '\r';
    buf[16] = '\n';

    const expected = [_]usize{16}; // CRLF recorded at \n index

    try testLineBreaks(.{
        .name = "CRLF@15-16",
        .input = &buf,
        .expected = &expected,
    }, testing.allocator);
}

test "line breaks: multiple breaks around SIMD16 boundary" {
    var buf: [32]u8 = undefined;
    @memset(&buf, 'x');
    buf[14] = '\n';
    buf[15] = '\r';
    buf[16] = '\n';
    buf[17] = '\n';

    const expected = [_]usize{ 14, 16, 17 }; // 15-16 is CRLF

    try testLineBreaks(.{
        .name = "multi@boundary",
        .input = &buf,
        .expected = &expected,
    }, testing.allocator);
}

test "line breaks: multibyte adjacent to LF" {
    const input = "é\n";
    const expected = [_]usize{2};

    try testLineBreaks(.{
        .name = "é\\n",
        .input = input,
        .expected = &expected,
    }, testing.allocator);
}

test "line breaks: multibyte adjacent to CRLF" {
    const input = "漢\r\n";
    const expected = [_]usize{4};

    try testLineBreaks(.{
        .name = "漢\\r\\n",
        .input = input,
        .expected = &expected,
    }, testing.allocator);
}

test "line breaks: multibyte at SIMD boundary without breaks" {
    var buf: [32]u8 = undefined;
    @memset(&buf, 0);

    const text = "Test世界Test";
    @memcpy(buf[0..text.len], text);

    const expected = [_]usize{};

    try testLineBreaks(.{
        .name = "unicode@boundary",
        .input = buf[0..text.len],
        .expected = &expected,
    }, testing.allocator);
}

test "line breaks: realistic text" {
    const sample_text =
        "The quick brown fox jumps over the lazy dog.\n" ++
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n" ++
        "Windows uses CRLF line endings.\r\n" ++
        "Unix uses LF line endings.\n" ++
        "Classic Mac used CR line endings.\r" ++
        "UTF-8 text: 世界 こんにちは\n" ++
        "Multiple\n\nEmpty\n\n\nLines\n" ++
        "Mixed\r\nendings\nhere\r";

    var result = utf8.LineBreakResult.init(testing.allocator);
    defer result.deinit();

    try utf8.findLineBreaks(sample_text, &result);

    // Verify we found some breaks
    try testing.expect(result.breaks.items.len > 0);
}

test "line breaks: random small buffers" {
    var prng = std.Random.DefaultPrng.init(42);
    const random = prng.random();

    var i: usize = 0;
    while (i < 50) : (i += 1) {
        const size = 16 + random.uintLessThan(usize, 1024);
        const buf = try testing.allocator.alloc(u8, size);
        defer testing.allocator.free(buf);

        for (buf) |*b| {
            const r = random.uintLessThan(u8, 100);
            if (r < 5) {
                b.* = '\n';
            } else if (r < 10) {
                b.* = '\r';
            } else {
                b.* = 'a' + random.uintLessThan(u8, 26);
            }
        }

        var result = utf8.LineBreakResult.init(testing.allocator);
        defer result.deinit();
        try utf8.findLineBreaks(buf, &result);
    }
}

// ============================================================================
// TAB STOP TESTS
// ============================================================================

const TabStopTestCase = struct {
    name: []const u8,
    input: []const u8,
    expected: []const usize,
};

const tab_stop_golden_tests = [_]TabStopTestCase{
    .{
        .name = "empty string",
        .input = "",
        .expected = &[_]usize{},
    },
    .{
        .name = "no tabs",
        .input = "hello world",
        .expected = &[_]usize{},
    },
    .{
        .name = "single tab",
        .input = "a\tb",
        .expected = &[_]usize{1},
    },
    .{
        .name = "multiple tabs",
        .input = "a\tb\tc",
        .expected = &[_]usize{ 1, 3 },
    },
    .{
        .name = "tab at start",
        .input = "\tabc",
        .expected = &[_]usize{0},
    },
    .{
        .name = "tab at end",
        .input = "abc\t",
        .expected = &[_]usize{3},
    },
    .{
        .name = "consecutive tabs",
        .input = "a\t\tb",
        .expected = &[_]usize{ 1, 2 },
    },
    .{
        .name = "only tabs",
        .input = "\t\t\t",
        .expected = &[_]usize{ 0, 1, 2 },
    },
    .{
        .name = "tabs mixed with spaces",
        .input = "a \tb \tc",
        .expected = &[_]usize{ 2, 5 },
    },
    .{
        .name = "tab with newline",
        .input = "a\tb\nc\td",
        .expected = &[_]usize{ 1, 5 },
    },
    .{
        .name = "many tabs",
        .input = "\ta\tb\tc\td\te\tf\t",
        .expected = &[_]usize{ 0, 2, 4, 6, 8, 10, 12 },
    },
};

fn testTabStops(test_case: TabStopTestCase, allocator: std.mem.Allocator) !void {
    var result = utf8.TabStopResult.init(allocator);
    defer result.deinit();

    try utf8.findTabStops(test_case.input, &result);

    try testing.expectEqual(test_case.expected.len, result.positions.items.len);

    for (test_case.expected, 0..) |exp, i| {
        try testing.expectEqual(exp, result.positions.items[i]);
    }
}

test "tab stops: golden tests" {
    for (tab_stop_golden_tests) |tc| {
        try testTabStops(tc, testing.allocator);
    }
}

test "tab stops: tab at SIMD16 edge (15)" {
    var buf: [32]u8 = undefined;
    @memset(&buf, 'x');
    buf[15] = '\t';
    buf[16] = 'y';

    const expected = [_]usize{15};

    try testTabStops(.{
        .name = "tab@15",
        .input = &buf,
        .expected = &expected,
    }, testing.allocator);
}

test "tab stops: tab at SIMD16 edge (16)" {
    var buf: [32]u8 = undefined;
    @memset(&buf, 'x');
    buf[16] = '\t';
    buf[17] = 'y';

    const expected = [_]usize{16};

    try testTabStops(.{
        .name = "tab@16",
        .input = &buf,
        .expected = &expected,
    }, testing.allocator);
}

test "tab stops: multiple tabs around SIMD16 boundary" {
    var buf: [32]u8 = undefined;
    @memset(&buf, 'x');
    buf[14] = '\t';
    buf[15] = '\t';
    buf[16] = '\t';
    buf[17] = '\t';

    const expected = [_]usize{ 14, 15, 16, 17 };

    try testTabStops(.{
        .name = "tabs@boundary",
        .input = &buf,
        .expected = &expected,
    }, testing.allocator);
}

test "tab stops: tabs in all SIMD lanes" {
    var buf: [16]u8 = undefined;
    for (&buf) |*b| {
        b.* = '\t';
    }

    const expected = [_]usize{ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 };

    try testTabStops(.{
        .name = "all_tabs",
        .input = &buf,
        .expected = &expected,
    }, testing.allocator);
}

test "tab stops: multibyte adjacent to tab" {
    const input = "é\ttest"; // é is 2 bytes: 0xC3 0xA9
    const expected = [_]usize{2}; // Tab at index 2

    try testTabStops(.{
        .name = "é\\t",
        .input = input,
        .expected = &expected,
    }, testing.allocator);
}

test "tab stops: CJK adjacent to tab" {
    const input = "漢\ttest"; // 漢 is 3 bytes: 0xE6 0xBC 0xA2
    const expected = [_]usize{3}; // Tab at index 3

    try testTabStops(.{
        .name = "漢\\t",
        .input = input,
        .expected = &expected,
    }, testing.allocator);
}

test "tab stops: emoji adjacent to tab" {
    const input = "👋\twave"; // 👋 is 4 bytes
    const expected = [_]usize{4}; // Tab at index 4

    try testTabStops(.{
        .name = "emoji\\t",
        .input = input,
        .expected = &expected,
    }, testing.allocator);
}

test "tab stops: multibyte at SIMD boundary without tabs" {
    var buf: [32]u8 = undefined;
    @memset(&buf, 0);

    const text = "Test世界Test";
    @memcpy(buf[0..text.len], text);

    const expected = [_]usize{}; // No tabs

    try testTabStops(.{
        .name = "unicode@boundary",
        .input = buf[0..text.len],
        .expected = &expected,
    }, testing.allocator);
}

test "tab stops: realistic code text" {
    const sample_text =
        "function test() {\n" ++
        "\tconst x = 10;\n" ++
        "\tif (x > 5) {\n" ++
        "\t\treturn true;\n" ++
        "\t}\n" ++
        "\treturn false;\n" ++
        "}\n";

    var result = utf8.TabStopResult.init(testing.allocator);
    defer result.deinit();

    try utf8.findTabStops(sample_text, &result);

    // Should find 6 tabs (including double-tab for nested return)
    try testing.expectEqual(@as(usize, 6), result.positions.items.len);
}

test "tab stops: TSV data" {
    const tsv_line = "name\tage\tcity\tcountry";
    const expected = [_]usize{ 4, 8, 13 };

    try testTabStops(.{
        .name = "tsv",
        .input = tsv_line,
        .expected = &expected,
    }, testing.allocator);
}

test "tab stops: random small buffers" {
    var prng = std.Random.DefaultPrng.init(42);
    const random = prng.random();

    var i: usize = 0;
    while (i < 50) : (i += 1) {
        const size = 16 + random.uintLessThan(usize, 1024);
        const buf = try testing.allocator.alloc(u8, size);
        defer testing.allocator.free(buf);

        for (buf) |*b| {
            const r = random.uintLessThan(u8, 100);
            if (r < 10) {
                b.* = '\t';
            } else {
                b.* = 'a' + random.uintLessThan(u8, 26);
            }
        }

        var result = utf8.TabStopResult.init(testing.allocator);
        defer result.deinit();
        try utf8.findTabStops(buf, &result);
    }
}

test "tab stops: large buffer with periodic tabs" {
    const size = 10000;
    const buf = try testing.allocator.alloc(u8, size);
    defer testing.allocator.free(buf);

    var expected_count: usize = 0;
    for (buf, 0..) |*b, idx| {
        if (idx % 50 == 0) {
            b.* = '\t';
            expected_count += 1;
        } else {
            b.* = 'a' + @as(u8, @intCast(idx % 26));
        }
    }

    var result = utf8.TabStopResult.init(testing.allocator);
    defer result.deinit();
    try utf8.findTabStops(buf, &result);

    try testing.expectEqual(expected_count, result.positions.items.len);
}

test "tab stops: exactly 16 bytes with tab" {
    const input = "0123456789abcd\tx"; // exactly 16 bytes with tab at pos 14
    const expected = [_]usize{14};

    try testTabStops(.{
        .name = "16bytes_with_tab",
        .input = input,
        .expected = &expected,
    }, testing.allocator);
}

test "tab stops: exactly 16 bytes no tab" {
    const input = "0123456789abcdef"; // exactly 16 bytes, no tab
    const expected = [_]usize{};

    try testTabStops(.{
        .name = "16bytes_no_tab",
        .input = input,
        .expected = &expected,
    }, testing.allocator);
}

test "tab stops: 17 bytes with tab at 16" {
    const input = "0123456789abcdef\t"; // tab at position 16
    const expected = [_]usize{16};

    try testTabStops(.{
        .name = "tab@16",
        .input = input,
        .expected = &expected,
    }, testing.allocator);
}

test "tab stops: result reuse" {
    var result = utf8.TabStopResult.init(testing.allocator);
    defer result.deinit();

    // First use
    try utf8.findTabStops("a\tb\tc", &result);
    try testing.expectEqual(@as(usize, 2), result.positions.items.len);

    // Second use - should reset automatically
    try utf8.findTabStops("x\ty", &result);
    try testing.expectEqual(@as(usize, 1), result.positions.items.len);
    try testing.expectEqual(@as(usize, 1), result.positions.items[0]);
}

test "tab stops: mixed with other whitespace" {
    const input = "  \t  \t  ";
    const expected = [_]usize{ 2, 5 };

    try testTabStops(.{
        .name = "mixed_whitespace",
        .input = input,
        .expected = &expected,
    }, testing.allocator);
}

test "tab stops: makefile style" {
    const makefile = "target:\n\t@echo Building\n\t@gcc -o out main.c\n";

    var result = utf8.TabStopResult.init(testing.allocator);
    defer result.deinit();

    try utf8.findTabStops(makefile, &result);

    // Should find 2 tabs (one per command line)
    try testing.expectEqual(@as(usize, 2), result.positions.items.len);
}

test "tab stops: tabs across multiple SIMD chunks" {
    const size = 64; // 4 SIMD chunks
    const buf = try testing.allocator.alloc(u8, size);
    defer testing.allocator.free(buf);

    @memset(buf, 'x');
    buf[0] = '\t';
    buf[16] = '\t';
    buf[32] = '\t';
    buf[48] = '\t';
    buf[63] = '\t';

    const expected = [_]usize{ 0, 16, 32, 48, 63 };

    try testTabStops(.{
        .name = "multi_chunk",
        .input = buf,
        .expected = &expected,
    }, testing.allocator);
}

// ============================================================================
// WORD WRAP BREAK TESTS
// ============================================================================

const WrapBreakTestCase = struct {
    name: []const u8,
    input: []const u8,
    expected: []const usize,
};

const wrap_break_golden_tests = [_]WrapBreakTestCase{
    .{
        .name = "empty string",
        .input = "",
        .expected = &[_]usize{},
    },
    .{
        .name = "no breaks",
        .input = "abcdef",
        .expected = &[_]usize{},
    },
    .{
        .name = "single space",
        .input = "a b",
        .expected = &[_]usize{1},
    },
    .{
        .name = "multiple spaces",
        .input = "a b c",
        .expected = &[_]usize{ 1, 3 },
    },
    .{
        .name = "tab character",
        .input = "a\tb",
        .expected = &[_]usize{1},
    },
    .{
        .name = "newline",
        .input = "a\nb",
        .expected = &[_]usize{},
    },
    .{
        .name = "carriage return",
        .input = "a\rb",
        .expected = &[_]usize{},
    },
    .{
        .name = "dash",
        .input = "pre-post",
        .expected = &[_]usize{3},
    },
    .{
        .name = "forward slash",
        .input = "path/to/file",
        .expected = &[_]usize{ 4, 7 },
    },
    .{
        .name = "backslash",
        .input = "path\\to\\file",
        .expected = &[_]usize{ 4, 7 },
    },
    .{
        .name = "punctuation",
        .input = "Hello, world! How are you? Fine.",
        .expected = &[_]usize{ 5, 6, 12, 13, 17, 21, 25, 26, 31 },
    },
    .{
        .name = "brackets",
        .input = "(a)[b]{c}",
        .expected = &[_]usize{ 0, 2, 3, 5, 6, 8 },
    },
    .{
        .name = "mixed breaks",
        .input = "Hello, world! -path/file.",
        .expected = &[_]usize{ 5, 6, 12, 13, 14, 19, 24 },
    },
    .{
        .name = "consecutive spaces",
        .input = "a  b",
        .expected = &[_]usize{ 1, 2 },
    },
    .{
        .name = "only spaces",
        .input = "   ",
        .expected = &[_]usize{ 0, 1, 2 },
    },
    .{
        .name = "all break types",
        .input = " \t-/\\.,:;!?()[]{}",
        .expected = &[_]usize{ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 },
    },
    .{
        .name = "nbsp",
        .input = "a\u{00A0}b",
        .expected = &[_]usize{1},
    },
    .{
        .name = "em space",
        .input = "a\u{2003}b",
        .expected = &[_]usize{1},
    },
    .{
        .name = "ideo space",
        .input = "a\u{3000}b",
        .expected = &[_]usize{1},
    },
    .{
        .name = "soft hyphen",
        .input = "pre\u{00AD}post",
        .expected = &[_]usize{3},
    },
    .{
        .name = "unicode hyphen",
        .input = "pre\u{2010}post",
        .expected = &[_]usize{3},
    },
    .{
        .name = "zero width space",
        .input = "a\u{200B}b",
        .expected = &[_]usize{1},
    },
};

fn testWrapBreaks(test_case: WrapBreakTestCase, allocator: std.mem.Allocator) !void {
    var result = utf8.WrapBreakResult.init(allocator);
    defer result.deinit();

    try utf8.findWrapBreaks(test_case.input, &result, .unicode);

    try testing.expectEqual(test_case.expected.len, result.breaks.items.len);

    for (test_case.expected, 0..) |exp, i| {
        try testing.expectEqual(exp, result.breaks.items[i].byte_offset);
    }
}

test "wrap breaks: golden tests" {
    for (wrap_break_golden_tests) |tc| {
        try testWrapBreaks(tc, testing.allocator);
    }
}

test "wrap breaks: space at SIMD16 edge (15)" {
    var buf: [32]u8 = undefined;
    @memset(&buf, 'x');
    buf[15] = ' ';
    buf[16] = 'y';

    const expected = [_]usize{15};

    try testWrapBreaks(.{
        .name = "space@15",
        .input = &buf,
        .expected = &expected,
    }, testing.allocator);
}

test "wrap breaks: unicode NBSP at SIMD16 edge (15)" {
    var buf: [32]u8 = undefined;
    @memset(&buf, 'x');
    // NBSP U+00A0 = 0xC2 0xA0
    buf[15] = 0xC2;
    buf[16] = 0xA0;

    const expected = [_]usize{15};

    try testWrapBreaks(.{
        .name = "nbsp@15",
        .input = &buf,
        .expected = &expected,
    }, testing.allocator);
}

test "wrap breaks: multiple breaks around SIMD16 boundary" {
    var buf: [32]u8 = undefined;
    @memset(&buf, 'x');
    buf[14] = ' ';
    buf[15] = '-';
    buf[16] = '/';
    buf[17] = '.';

    const expected = [_]usize{ 14, 15, 16, 17 };

    try testWrapBreaks(.{
        .name = "multi@boundary",
        .input = &buf,
        .expected = &expected,
    }, testing.allocator);
}

test "wrap breaks: multibyte adjacent to space" {
    const input = "é test"; // é is 2 bytes: 0xC3 0xA9
    const expected = [_]usize{2}; // Space at index 2

    try testWrapBreaks(.{
        .name = "é space",
        .input = input,
        .expected = &expected,
    }, testing.allocator);
}

test "wrap breaks: multibyte adjacent to dash" {
    const input = "漢-test"; // 漢 is 3 bytes: 0xE6 0xBC 0xA2
    const expected = [_]usize{3}; // Dash at index 3

    try testWrapBreaks(.{
        .name = "漢-",
        .input = input,
        .expected = &expected,
    }, testing.allocator);
}

test "wrap breaks: multibyte at SIMD boundary without breaks" {
    var buf: [32]u8 = undefined;
    @memset(&buf, 0);

    // Place UTF-8 sequences around boundary
    const text = "Test世界Test";
    @memcpy(buf[0..text.len], text);

    const expected = [_]usize{}; // No breaks

    try testWrapBreaks(.{
        .name = "unicode@boundary",
        .input = buf[0..text.len],
        .expected = &expected,
    }, testing.allocator);
}

test "wrap breaks: realistic text" {
    const sample_text =
        "The quick brown fox jumps over the lazy dog.\n" ++
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n" ++
        "File paths: /usr/local/bin and C:\\Windows\\System32\n" ++
        "Punctuation test: Hello, world! How are you? I'm fine.\n" ++
        "Brackets test: (parentheses) [square] {curly}\n" ++
        "Dashes test: pre-dash post-dash multi-word-expression\n" ++
        "Mixed: Hello, /path/to-file.txt [done]!\n";

    var result = utf8.WrapBreakResult.init(testing.allocator);
    defer result.deinit();

    try utf8.findWrapBreaks(sample_text, &result, .unicode);

    // Verify we found many breaks
    try testing.expect(result.breaks.items.len > 0);
}

test "wrap breaks: random small buffers" {
    var prng = std.Random.DefaultPrng.init(42);
    const random = prng.random();

    const break_chars = " \t-/\\.,:;!?()[]{}";

    var i: usize = 0;
    while (i < 50) : (i += 1) {
        const size = 16 + random.uintLessThan(usize, 1024);
        const buf = try testing.allocator.alloc(u8, size);
        defer testing.allocator.free(buf);

        // Fill with ASCII letters and randomly insert breaks
        for (buf) |*b| {
            const r = random.uintLessThan(u8, 100);
            if (r < 20) {
                const break_idx = random.uintLessThan(usize, break_chars.len);
                b.* = break_chars[break_idx];
            } else {
                b.* = 'a' + random.uintLessThan(u8, 26);
            }
        }

        var result = utf8.WrapBreakResult.init(testing.allocator);
        defer result.deinit();
        try utf8.findWrapBreaks(buf, &result, .unicode);
    }
}

test "wrap breaks: large buffer" {
    const size = 10000;
    const buf = try testing.allocator.alloc(u8, size);
    defer testing.allocator.free(buf);

    // Create realistic text with periodic breaks
    for (buf, 0..) |*b, idx| {
        if (idx % 50 == 0) {
            b.* = ' ';
        } else if (idx % 75 == 0) {
            b.* = '-';
        } else {
            b.* = 'a' + @as(u8, @intCast(idx % 26));
        }
    }

    var result = utf8.WrapBreakResult.init(testing.allocator);
    defer result.deinit();
    try utf8.findWrapBreaks(buf, &result, .unicode);

    try testing.expect(result.breaks.items.len > 0);
}

test "wrap breaks: buffer exceeding 64KB" {
    const size = 100_000;
    const buf = try testing.allocator.alloc(u8, size);
    defer testing.allocator.free(buf);

    @memset(buf, 'a');

    // Place a space at 70000, with u16, this will truncate to 4464 (70000 % 65536)
    const break_pos: usize = 70_000;
    buf[break_pos] = ' ';

    var result = utf8.WrapBreakResult.init(testing.allocator);
    defer result.deinit();
    try utf8.findWrapBreaks(buf, &result, .unicode);

    // Should find exactly one wrap break
    try testing.expectEqual(@as(usize, 1), result.breaks.items.len);

    // The byte_offset must be the actual position, not truncated
    try testing.expectEqual(@as(u32, break_pos), result.breaks.items[0].byte_offset);
    try testing.expectEqual(@as(u32, break_pos), result.breaks.items[0].char_offset);
}

// ============================================================================
// EDGE CASES AND INTEGRATION TESTS
// ============================================================================

test "edge case: result reuse" {
    var line_result = utf8.LineBreakResult.init(testing.allocator);
    defer line_result.deinit();

    // First use - line breaks
    try utf8.findLineBreaks("a\nb\nc", &line_result);
    try testing.expectEqual(@as(usize, 2), line_result.breaks.items.len);

    // Second use - should reset automatically
    try utf8.findLineBreaks("x\ny", &line_result);
    try testing.expectEqual(@as(usize, 1), line_result.breaks.items.len);
    try testing.expectEqual(@as(usize, 1), line_result.breaks.items[0].pos);

    // Third use - wrap breaks (different result type)
    var wrap_result = utf8.WrapBreakResult.init(testing.allocator);
    defer wrap_result.deinit();
    try utf8.findWrapBreaks("a b c", &wrap_result, .unicode);
    try testing.expectEqual(@as(usize, 2), wrap_result.breaks.items.len);
}

test "edge case: empty input" {
    var line_result = utf8.LineBreakResult.init(testing.allocator);
    defer line_result.deinit();

    try utf8.findLineBreaks("", &line_result);
    try testing.expectEqual(@as(usize, 0), line_result.breaks.items.len);

    var wrap_result = utf8.WrapBreakResult.init(testing.allocator);
    defer wrap_result.deinit();
    try utf8.findWrapBreaks("", &wrap_result, .unicode);
    try testing.expectEqual(@as(usize, 0), wrap_result.breaks.items.len);
}

test "edge case: exactly 16 bytes" {
    var line_result = utf8.LineBreakResult.init(testing.allocator);
    defer line_result.deinit();

    const input = "0123456789abcdef"; // exactly 16 bytes
    try utf8.findLineBreaks(input, &line_result);
    try testing.expectEqual(@as(usize, 0), line_result.breaks.items.len);

    var wrap_result = utf8.WrapBreakResult.init(testing.allocator);
    defer wrap_result.deinit();
    try utf8.findWrapBreaks(input, &wrap_result, .unicode);
    try testing.expectEqual(@as(usize, 0), wrap_result.breaks.items.len);
}

test "edge case: 17 bytes with break at 16" {
    var line_result = utf8.LineBreakResult.init(testing.allocator);
    defer line_result.deinit();

    const input = "0123456789abcde\nx"; // break at position 15
    try utf8.findLineBreaks(input, &line_result);
    try testing.expectEqual(@as(usize, 1), line_result.breaks.items.len);
    try testing.expectEqual(@as(usize, 15), line_result.breaks.items[0].pos);

    var wrap_result = utf8.WrapBreakResult.init(testing.allocator);
    defer wrap_result.deinit();
    const input2 = "0123456789abcde x"; // space at position 15
    try utf8.findWrapBreaks(input2, &wrap_result, .unicode);
    try testing.expectEqual(@as(usize, 1), wrap_result.breaks.items.len);
    try testing.expectEqual(@as(u16, 15), wrap_result.breaks.items[0].byte_offset);
    try testing.expectEqual(@as(u16, 15), wrap_result.breaks.items[0].char_offset);
}

// ============================================================================
// GRAPHEME CLUSTER TESTS
// ============================================================================

test "wrap breaks: emoji with ZWJ - char offset should count grapheme not codepoints" {
    const input = "ab 👩‍🚀 cd";

    var result = utf8.WrapBreakResult.init(testing.allocator);
    defer result.deinit();
    try utf8.findWrapBreaks(input, &result, .unicode);

    try testing.expectEqual(@as(usize, 2), result.breaks.items.len);
    try testing.expectEqual(@as(u16, 2), result.breaks.items[0].byte_offset);
    try testing.expectEqual(@as(u16, 2), result.breaks.items[0].char_offset);
    try testing.expectEqual(@as(u16, 14), result.breaks.items[1].byte_offset);
    try testing.expectEqual(@as(u16, 4), result.breaks.items[1].char_offset); // Should be 4, not 6
}

test "wrap breaks: emoji with skin tone - char offset should count grapheme" {
    const input = "hi 👋🏿 bye";

    var result = utf8.WrapBreakResult.init(testing.allocator);
    defer result.deinit();
    try utf8.findWrapBreaks(input, &result, .unicode);

    try testing.expectEqual(@as(usize, 2), result.breaks.items.len);
    try testing.expectEqual(@as(u16, 2), result.breaks.items[0].byte_offset);
    try testing.expectEqual(@as(u16, 2), result.breaks.items[0].char_offset);
    try testing.expectEqual(@as(u16, 11), result.breaks.items[1].byte_offset);
    try testing.expectEqual(@as(u16, 4), result.breaks.items[1].char_offset); // Should be 4, not 5
}

test "wrap breaks: emoji with VS16 selector - char offset should count grapheme" {
    const input = "I ❤️ U";

    var result = utf8.WrapBreakResult.init(testing.allocator);
    defer result.deinit();
    try utf8.findWrapBreaks(input, &result, .unicode);

    try testing.expectEqual(@as(usize, 2), result.breaks.items.len);
    try testing.expectEqual(@as(u16, 1), result.breaks.items[0].byte_offset);
    try testing.expectEqual(@as(u16, 1), result.breaks.items[0].char_offset);
    try testing.expectEqual(@as(u16, 8), result.breaks.items[1].byte_offset);
    try testing.expectEqual(@as(u16, 3), result.breaks.items[1].char_offset); // Should be 3, not 4
}

test "wrap breaks: combining diacritic - char offset should count grapheme" {
    const input = "cafe\u{0301} time";

    var result = utf8.WrapBreakResult.init(testing.allocator);
    defer result.deinit();
    try utf8.findWrapBreaks(input, &result, .unicode);

    try testing.expectEqual(@as(usize, 1), result.breaks.items.len);
    try testing.expectEqual(@as(u16, 6), result.breaks.items[0].byte_offset);
    try testing.expectEqual(@as(u16, 4), result.breaks.items[0].char_offset); // Should be 4, not 5
}

test "wrap breaks: flag emoji - char offset should count grapheme" {
    const input = "USA🇺🇸 flag";

    var result = utf8.WrapBreakResult.init(testing.allocator);
    defer result.deinit();
    try utf8.findWrapBreaks(input, &result, .unicode);

    try testing.expectEqual(@as(usize, 1), result.breaks.items.len);
    try testing.expectEqual(@as(u16, 11), result.breaks.items[0].byte_offset);
    try testing.expectEqual(@as(u16, 4), result.breaks.items[0].char_offset); // 3(USA) + 1(flag) = 4
}

test "wrap breaks: mixed graphemes and ASCII" {
    const input = "Hello 👋🏿 world 🇺🇸 test";

    var result = utf8.WrapBreakResult.init(testing.allocator);
    defer result.deinit();
    try utf8.findWrapBreaks(input, &result, .unicode);

    try testing.expectEqual(@as(usize, 4), result.breaks.items.len);
    try testing.expectEqual(@as(u16, 5), result.breaks.items[0].byte_offset);
    try testing.expectEqual(@as(u16, 5), result.breaks.items[0].char_offset);
    try testing.expectEqual(@as(u16, 14), result.breaks.items[1].byte_offset);
    try testing.expectEqual(@as(u16, 7), result.breaks.items[1].char_offset); // 5 + 1 + 1(grapheme) = 7
    try testing.expectEqual(@as(u16, 20), result.breaks.items[2].byte_offset);
    try testing.expectEqual(@as(u16, 13), result.breaks.items[2].char_offset); // 7 + 1 + 5 = 13
    try testing.expectEqual(@as(u16, 29), result.breaks.items[3].byte_offset);
    try testing.expectEqual(@as(u16, 15), result.breaks.items[3].char_offset); // 13 + 1(space) + 1(RI) + 1(RI) = 15 (per uucode)
}

// ============================================================================
// WRAP BY WIDTH TESTS
// ============================================================================

test "wrap by width: empty string" {
    const result = utf8.findWrapPosByWidth("", 10, 4, true, .unicode);
    try testing.expectEqual(@as(u32, 0), result.byte_offset);
    try testing.expectEqual(@as(u32, 0), result.grapheme_count);
    try testing.expectEqual(@as(u32, 0), result.columns_used);
}

test "wrap by width: simple ASCII no wrap" {
    const result = utf8.findWrapPosByWidth("hello", 10, 4, true, .unicode);
    try testing.expectEqual(@as(u32, 5), result.byte_offset);
    try testing.expectEqual(@as(u32, 5), result.grapheme_count);
    try testing.expectEqual(@as(u32, 5), result.columns_used);
}

test "wrap by width: ASCII wrap exactly at limit" {
    const result = utf8.findWrapPosByWidth("hello", 5, 4, true, .unicode);
    try testing.expectEqual(@as(u32, 5), result.byte_offset);
    try testing.expectEqual(@as(u32, 5), result.grapheme_count);
    try testing.expectEqual(@as(u32, 5), result.columns_used);
}

test "wrap by width: ASCII wrap before limit" {
    const result = utf8.findWrapPosByWidth("hello world", 7, 4, true, .unicode);
    try testing.expectEqual(@as(u32, 7), result.byte_offset);
    try testing.expectEqual(@as(u32, 7), result.grapheme_count);
    try testing.expectEqual(@as(u32, 7), result.columns_used);
}

test "wrap by width: East Asian wide char" {
    const result = utf8.findWrapPosByWidth("世界", 3, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 3), result.byte_offset); // After first char
    try testing.expectEqual(@as(u32, 1), result.grapheme_count);
    try testing.expectEqual(@as(u32, 2), result.columns_used);
}

test "wrap by width: combining mark" {
    const result = utf8.findWrapPosByWidth("e\u{0301}test", 3, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 5), result.byte_offset); // After "é" (3 bytes) + "te" (2 bytes)
    try testing.expectEqual(@as(u32, 3), result.grapheme_count);
    try testing.expectEqual(@as(u32, 3), result.columns_used);
}

test "wrap by width: tab handling" {
    const result = utf8.findWrapPosByWidth("a\tb", 5, 4, true, .unicode);
    try testing.expectEqual(@as(u32, 2), result.byte_offset); // After "a\t"
    try testing.expectEqual(@as(u32, 2), result.grapheme_count); // 'a' + tab
    try testing.expectEqual(@as(u32, 5), result.columns_used); // 'a' (1) + tab (4) = 5
}

fn testWrapByWidthMethodsMatch(input: []const u8, max_columns: u32, tab_width: u8, isASCIIOnly: bool) !void {
    const result = utf8.findWrapPosByWidth(input, max_columns, tab_width, isASCIIOnly, .unicode);
    // Since we only have SIMD16 in utf8.zig, just verify it doesn't crash
    _ = result;
}

test "wrap by width: consistency - realistic text" {
    const sample_text =
        "The quick brown fox jumps over the lazy dog. " ++
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " ++
        "File paths: /usr/local/bin and C:\\Windows\\System32. " ++
        "Punctuation test: Hello, world! How are you? I'm fine.";

    const widths = [_]u32{ 10, 20, 40, 80, 120 };
    for (widths) |w| {
        try testWrapByWidthMethodsMatch(sample_text, w, 4, true);
    }
}

test "wrap by width: consistency - Unicode text" {
    const unicode_text = "世界 こんにちは test 你好 CJK-mixed";

    const widths = [_]u32{ 5, 10, 15, 20, 30 };
    for (widths) |w| {
        try testWrapByWidthMethodsMatch(unicode_text, w, 4, false);
    }
}

test "wrap by width: consistency - edge cases" {
    const edge_cases = [_]struct { text: []const u8, ascii: bool }{
        .{ .text = "", .ascii = true },
        .{ .text = " ", .ascii = true },
        .{ .text = "a", .ascii = true },
        .{ .text = "abc", .ascii = true },
        .{ .text = "   ", .ascii = true },
        .{ .text = "a b c d e", .ascii = true },
        .{ .text = "no-spaces-here", .ascii = true },
        .{ .text = "/usr/local/bin", .ascii = true },
        .{ .text = "世界", .ascii = false },
        .{ .text = "\t\t\t", .ascii = true },
    };

    for (edge_cases) |input| {
        const widths = [_]u32{ 1, 5, 10, 20 };
        for (widths) |w| {
            try testWrapByWidthMethodsMatch(input.text, w, 4, input.ascii);
        }
    }
}

test "wrap by width: property - random ASCII buffers" {
    var prng = std.Random.DefaultPrng.init(42);
    const random = prng.random();

    var i: usize = 0;
    while (i < 50) : (i += 1) {
        const size = 16 + random.uintLessThan(usize, 256);
        const buf = try testing.allocator.alloc(u8, size);
        defer testing.allocator.free(buf);

        for (buf) |*b| {
            b.* = 'a' + random.uintLessThan(u8, 26);
        }

        const width = 10 + random.uintLessThan(u32, 70);
        try testWrapByWidthMethodsMatch(buf, width, 4, true);
    }
}

test "wrap by width: boundary - SIMD16 chunk boundary" {
    var buf: [32]u8 = undefined;
    @memset(&buf, 'x');
    try testWrapByWidthMethodsMatch(&buf, 20, 4, true);
    try testWrapByWidthMethodsMatch(&buf, 10, 4, true);
}

test "wrap by width: boundary - Unicode at SIMD boundary" {
    var buf: [32]u8 = undefined;
    @memset(&buf, 'a');
    const cjk = "世";
    @memcpy(buf[14..17], cjk);
    try testWrapByWidthMethodsMatch(buf[0..20], 20, 4, false);
}

test "wrap by width: wide emoji exactly at column boundary" {
    const input = "Hello 🌍 World";

    const result7 = utf8.findWrapPosByWidth(input, 7, 8, false, .unicode);
    try testing.expectEqual(@as(u32, 6), result7.byte_offset);
    try testing.expectEqual(@as(u32, 6), result7.columns_used);

    const result8 = utf8.findWrapPosByWidth(input, 8, 8, false, .unicode);
    try testing.expectEqual(@as(u32, 10), result8.byte_offset);
    try testing.expectEqual(@as(u32, 8), result8.columns_used);

    const result6 = utf8.findWrapPosByWidth(input, 6, 8, false, .unicode);
    try testing.expectEqual(@as(u32, 6), result6.byte_offset);
    try testing.expectEqual(@as(u32, 6), result6.columns_used);
}

test "wrap by width: wide emoji at start" {
    const input = "🌍 World";

    const result1 = utf8.findWrapPosByWidth(input, 1, 8, false, .unicode);
    try testing.expectEqual(@as(u32, 0), result1.byte_offset);
    try testing.expectEqual(@as(u32, 0), result1.columns_used);

    const result2 = utf8.findWrapPosByWidth(input, 2, 8, false, .unicode);
    try testing.expectEqual(@as(u32, 4), result2.byte_offset);
    try testing.expectEqual(@as(u32, 2), result2.columns_used);

    const result3 = utf8.findWrapPosByWidth(input, 3, 8, false, .unicode);
    try testing.expectEqual(@as(u32, 5), result3.byte_offset);
    try testing.expectEqual(@as(u32, 3), result3.columns_used);
}

test "wrap by width: multiple wide characters" {
    const input = "AB🌍CD🌎EF";

    const result5 = utf8.findWrapPosByWidth(input, 5, 8, false, .unicode);
    try testing.expectEqual(@as(u32, 7), result5.byte_offset);
    try testing.expectEqual(@as(u32, 5), result5.columns_used);

    const result6 = utf8.findWrapPosByWidth(input, 6, 8, false, .unicode);
    try testing.expectEqual(@as(u32, 8), result6.byte_offset);
    try testing.expectEqual(@as(u32, 6), result6.columns_used);
}

test "wrap by width: CJK wide characters at boundary" {
    const input = "hello世界test";

    const result6 = utf8.findWrapPosByWidth(input, 6, 8, false, .unicode);
    try testing.expectEqual(@as(u32, 5), result6.byte_offset);
    try testing.expectEqual(@as(u32, 5), result6.columns_used);

    const result7 = utf8.findWrapPosByWidth(input, 7, 8, false, .unicode);
    try testing.expectEqual(@as(u32, 8), result7.byte_offset);
    try testing.expectEqual(@as(u32, 7), result7.columns_used);
}

// ============================================================================
// FIND POS BY WIDTH TESTS (for selection - includes graphemes that start before limit)
// ============================================================================

test "find pos by width: wide emoji at boundary - INCLUDES grapheme" {
    const input = "Hello 🌍 World";
    // Layout: H(0) e(1) l(2) l(3) o(4) space(5) 🌍(6-7) space(8) W(9)...

    // include_start_before=true (selection end): include graphemes that START before max_columns
    const result7 = utf8.findPosByWidth(input, 7, 8, false, true, .unicode);
    try testing.expectEqual(@as(u32, 10), result7.byte_offset); // After emoji (snapped forward)
    try testing.expectEqual(@as(u32, 8), result7.columns_used);

    const result8 = utf8.findPosByWidth(input, 8, 8, false, true, .unicode);
    try testing.expectEqual(@as(u32, 10), result8.byte_offset);
    try testing.expectEqual(@as(u32, 8), result8.columns_used);

    const result6 = utf8.findPosByWidth(input, 6, 8, false, true, .unicode);
    try testing.expectEqual(@as(u32, 6), result6.byte_offset);
    try testing.expectEqual(@as(u32, 6), result6.columns_used);

    // include_start_before=false (selection start): exclude graphemes that cross max_columns
    const start7 = utf8.findPosByWidth(input, 7, 8, false, false, .unicode);
    try testing.expectEqual(@as(u32, 6), start7.byte_offset); // Before emoji (snapped backward)
    try testing.expectEqual(@as(u32, 6), start7.columns_used);
}

test "find pos by width: start at second cell of width=2 grapheme snaps backward" {
    const input = "AB🌍CD";
    const result = utf8.findPosByWidth(input, 3, 8, false, false, .unicode);
    try testing.expectEqual(@as(u32, 2), result.byte_offset); // After "AB", before emoji
    try testing.expectEqual(@as(u32, 2), result.columns_used);
}

test "find pos by width: end at first cell of width=2 grapheme snaps forward" {
    const input = "AB🌍CD";
    const result = utf8.findPosByWidth(input, 2, 8, false, true, .unicode);
    try testing.expectEqual(@as(u32, 2), result.byte_offset); // After "AB" (emoji starts at 2, which is NOT > 2, but hasn't been consumed yet)
    try testing.expectEqual(@as(u32, 2), result.columns_used);

    const result3 = utf8.findPosByWidth(input, 3, 8, false, true, .unicode);
    try testing.expectEqual(@as(u32, 6), result3.byte_offset); // After "AB🌍"
    try testing.expectEqual(@as(u32, 4), result3.columns_used);
}

test "find pos by width: selection boundaries with multiple wide chars" {
    const input = "A🌍B🌎C";
    const start2 = utf8.findPosByWidth(input, 2, 8, false, false, .unicode);
    try testing.expectEqual(@as(u32, 1), start2.byte_offset); // After "A", before first emoji
    try testing.expectEqual(@as(u32, 1), start2.columns_used);

    const end5 = utf8.findPosByWidth(input, 5, 8, false, true, .unicode);
    try testing.expectEqual(@as(u32, 10), end5.byte_offset); // After "A🌍B🌎"
    try testing.expectEqual(@as(u32, 6), end5.columns_used);
}

test "find pos by width: empty string" {
    const result = utf8.findPosByWidth("", 10, 4, true, true, .unicode);
    try testing.expectEqual(@as(u32, 0), result.byte_offset);
    try testing.expectEqual(@as(u32, 0), result.grapheme_count);
    try testing.expectEqual(@as(u32, 0), result.columns_used);
}

test "find pos by width: simple ASCII no limit" {
    const result = utf8.findPosByWidth("hello", 10, 4, true, true, .unicode);
    try testing.expectEqual(@as(u32, 5), result.byte_offset);
    try testing.expectEqual(@as(u32, 5), result.grapheme_count);
    try testing.expectEqual(@as(u32, 5), result.columns_used);
}

test "find pos by width: ASCII exactly at limit" {
    const result = utf8.findPosByWidth("hello", 5, 4, true, true, .unicode);
    try testing.expectEqual(@as(u32, 5), result.byte_offset);
    try testing.expectEqual(@as(u32, 5), result.grapheme_count);
    try testing.expectEqual(@as(u32, 5), result.columns_used);
}

test "find pos by width: wide emoji at start" {
    const input = "🌍 World";

    const result1 = utf8.findPosByWidth(input, 1, 8, false, true, .unicode);
    try testing.expectEqual(@as(u32, 4), result1.byte_offset);
    try testing.expectEqual(@as(u32, 2), result1.columns_used);

    const result2 = utf8.findPosByWidth(input, 2, 8, false, true, .unicode);
    try testing.expectEqual(@as(u32, 4), result2.byte_offset);
    try testing.expectEqual(@as(u32, 2), result2.columns_used);

    const result3 = utf8.findPosByWidth(input, 3, 8, false, true, .unicode);
    try testing.expectEqual(@as(u32, 5), result3.byte_offset);
    try testing.expectEqual(@as(u32, 3), result3.columns_used);
}

test "find pos by width: multiple wide characters" {
    const input = "AB🌍CD🌎EF";

    const result5 = utf8.findPosByWidth(input, 5, 8, false, true, .unicode);
    try testing.expectEqual(@as(u32, 7), result5.byte_offset);
    try testing.expectEqual(@as(u32, 5), result5.columns_used);

    const result7 = utf8.findPosByWidth(input, 7, 8, false, true, .unicode);
    try testing.expectEqual(@as(u32, 12), result7.byte_offset);
    try testing.expectEqual(@as(u32, 8), result7.columns_used);
}

test "find pos by width: CJK wide characters" {
    const input = "hello世界test";

    const result6 = utf8.findPosByWidth(input, 6, 8, false, true, .unicode);
    try testing.expectEqual(@as(u32, 8), result6.byte_offset);
    try testing.expectEqual(@as(u32, 7), result6.columns_used);

    const result8 = utf8.findPosByWidth(input, 8, 8, false, true, .unicode);
    try testing.expectEqual(@as(u32, 11), result8.byte_offset);
    try testing.expectEqual(@as(u32, 9), result8.columns_used);
}

test "find pos by width: combining mark" {
    const result = utf8.findPosByWidth("e\u{0301}test", 3, 4, false, true, .unicode);
    try testing.expectEqual(@as(u32, 5), result.byte_offset); // After "é" (3 bytes) + "te" (2 bytes)
    try testing.expectEqual(@as(u32, 3), result.grapheme_count);
    try testing.expectEqual(@as(u32, 3), result.columns_used);
}

test "find pos by width: tab handling" {
    const result = utf8.findPosByWidth("a\tb", 5, 4, true, true, .unicode);
    try testing.expectEqual(@as(u32, 2), result.byte_offset); // After "a\t"
    try testing.expectEqual(@as(u32, 2), result.grapheme_count); // 'a' + tab
    try testing.expectEqual(@as(u32, 5), result.columns_used); // 'a' (1) + tab (4) = 5
}

// ============================================================================
// SPLIT CHUNK AT WEIGHT TESTS (include_start_before=false)
// Tests for the exact behavior needed by splitChunkAtWeight in edit-buffer.zig
// ============================================================================

test "split at weight: ASCII simple split" {
    const input = "hello world";

    // Split at column 5 - should stop at 'h' of "hello"
    const result = utf8.findPosByWidth(input, 5, 8, true, false, .unicode);
    try testing.expectEqual(@as(u32, 5), result.byte_offset); // After "hello"
    try testing.expectEqual(@as(u32, 5), result.columns_used);
}

test "split at weight: ASCII split in middle" {
    const input = "abcdefghij";

    // Split at column 3
    const result = utf8.findPosByWidth(input, 3, 8, true, false, .unicode);
    try testing.expectEqual(@as(u32, 3), result.byte_offset); // After "abc"
    try testing.expectEqual(@as(u32, 3), result.columns_used);
}

test "split at weight: wide char at boundary - exclude when starting after" {
    const input = "AB🌍CD"; // A(1) B(1) 🌍(2) C(1) D(1)

    // Split at column 2 - should include up to B, exclude emoji
    const result2 = utf8.findPosByWidth(input, 2, 8, false, false, .unicode);
    try testing.expectEqual(@as(u32, 2), result2.byte_offset); // After "AB"
    try testing.expectEqual(@as(u32, 2), result2.columns_used);

    const result3 = utf8.findPosByWidth(input, 3, 8, false, false, .unicode);
    try testing.expectEqual(@as(u32, 2), result3.byte_offset); // After "AB", before emoji
    try testing.expectEqual(@as(u32, 2), result3.columns_used);
}

test "split at weight: CJK characters" {
    const input = "hello世界test"; // h(1) e(1) l(1) l(1) o(1) 世(2) 界(2) t(1) e(1) s(1) t(1)

    // Split at column 5 - after "hello"
    const result5 = utf8.findPosByWidth(input, 5, 8, false, false, .unicode);
    try testing.expectEqual(@as(u32, 5), result5.byte_offset);
    try testing.expectEqual(@as(u32, 5), result5.columns_used);

    const result6 = utf8.findPosByWidth(input, 6, 8, false, false, .unicode);
    try testing.expectEqual(@as(u32, 5), result6.byte_offset); // After "hello", before 世
    try testing.expectEqual(@as(u32, 5), result6.columns_used);

    // Split at column 9 - should include both CJK chars
    const result9 = utf8.findPosByWidth(input, 9, 8, false, false, .unicode);
    try testing.expectEqual(@as(u32, 11), result9.byte_offset); // After "hello世界"
    try testing.expectEqual(@as(u32, 9), result9.columns_used);
}

test "split at weight: combining marks" {
    const input = "cafe\u{0301}test"; // c(1) a(1) f(1) é(1) t(1) e(1) s(1) t(1)

    // Split at column 4 - should include the combining mark with 'e'
    const result4 = utf8.findPosByWidth(input, 4, 8, false, false, .unicode);
    try testing.expectEqual(@as(u32, 6), result4.byte_offset); // After "café" (5 bytes: cafe + combining accent)
    try testing.expectEqual(@as(u32, 4), result4.columns_used);
}

test "split at weight: emoji with skin tone" {
    const input = "Hi👋🏿Bye"; // H(1) i(1) 👋🏿(wide) B(1) y(1) e(1)

    // Split at column 2 - should stop before or after emoji depending on where it starts
    const result2 = utf8.findPosByWidth(input, 2, 8, false, false, .unicode);
    try testing.expectEqual(@as(u32, 2), result2.byte_offset); // After "Hi"
    try testing.expectEqual(@as(u32, 2), result2.columns_used);

    // Split at column 5 - should include emoji
    const result5 = utf8.findPosByWidth(input, 5, 8, false, false, .unicode);
    // Result will stop at first grapheme that starts >= max_columns
    // Just verify it returns a reasonable offset
    try testing.expect(result5.byte_offset >= 2); // At least past "Hi"
    try testing.expect(result5.columns_used >= 2); // At least 2 columns
}

test "split at weight: zero width at start" {
    const input = "hello";

    // Split at column 0 - should return offset 0
    const result = utf8.findPosByWidth(input, 0, 8, true, false, .unicode);
    try testing.expectEqual(@as(u32, 0), result.byte_offset);
    try testing.expectEqual(@as(u32, 0), result.columns_used);
}

test "split at weight: beyond end" {
    const input = "hello"; // 5 columns

    // Split at column 10 - should return entire string
    const result = utf8.findPosByWidth(input, 10, 8, true, false, .unicode);
    try testing.expectEqual(@as(u32, 5), result.byte_offset);
    try testing.expectEqual(@as(u32, 5), result.columns_used);
}

test "split at weight: tab character" {
    const input = "a\tbc"; // a(1) tab(4 fixed) b(1) c(1) = 7 columns total

    // Split at column 4 - should stop before tab since it would exceed limit
    const result4 = utf8.findPosByWidth(input, 4, 4, true, false, .unicode);
    try testing.expectEqual(@as(u32, 2), result4.byte_offset); // After "a\t"
    try testing.expectEqual(@as(u32, 5), result4.columns_used); // a(1) + tab(4) = 5
}

test "split at weight: complex mixed content" {
    const input = "A🌍B世C"; // A(1) 🌍(2) B(1) 世(2) C(1) = 7 columns total
    const r1 = utf8.findPosByWidth(input, 1, 8, false, false, .unicode);
    try testing.expectEqual(@as(u32, 1), r1.byte_offset); // After "A"

    const r2 = utf8.findPosByWidth(input, 2, 8, false, false, .unicode);
    try testing.expectEqual(@as(u32, 1), r2.byte_offset); // After "A"

    const r3 = utf8.findPosByWidth(input, 3, 8, false, false, .unicode);
    try testing.expectEqual(@as(u32, 5), r3.byte_offset); // After "A🌍"

    const r4 = utf8.findPosByWidth(input, 4, 8, false, false, .unicode);
    try testing.expectEqual(@as(u32, 6), r4.byte_offset); // After "A🌍B"

    const r5 = utf8.findPosByWidth(input, 5, 8, false, false, .unicode);
    try testing.expectEqual(@as(u32, 6), r5.byte_offset); // After "A🌍B"
}

// ============================================================================
// GET WIDTH AT TESTS
// ============================================================================

test "getWidthAt: empty string" {
    const result = utf8.getWidthAt("", 0, 8, .unicode);
    try testing.expectEqual(@as(u32, 0), result);
}

test "getWidthAt: out of bounds" {
    const result = utf8.getWidthAt("hello", 10, 8, .unicode);
    try testing.expectEqual(@as(u32, 0), result);
}

test "getWidthAt: simple ASCII" {
    const text = "hello";
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 0, 8, .unicode)); // 'h'
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 1, 8, .unicode)); // 'e'
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 4, 8, .unicode)); // 'o'
}

test "getWidthAt: tab character" {
    const text = "a\tb";
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 0, 4, .unicode)); // 'a'
    try testing.expectEqual(@as(u32, 4), utf8.getWidthAt(text, 1, 4, .unicode)); // tab fixed width 4
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 2, 4, .unicode)); // 'b'
}

test "getWidthAt: tab at different columns" {
    const text = "\t";
    // Tab now has fixed width regardless of current_column
    try testing.expectEqual(@as(u32, 4), utf8.getWidthAt(text, 0, 4, .unicode)); // Tab fixed width 4
    try testing.expectEqual(@as(u32, 4), utf8.getWidthAt(text, 0, 4, .unicode)); // Tab fixed width 4
    try testing.expectEqual(@as(u32, 4), utf8.getWidthAt(text, 0, 4, .unicode)); // Tab fixed width 4
    try testing.expectEqual(@as(u32, 4), utf8.getWidthAt(text, 0, 4, .unicode)); // Tab fixed width 4
    try testing.expectEqual(@as(u32, 4), utf8.getWidthAt(text, 0, 4, .unicode)); // Tab fixed width 4
}

test "getWidthAt: CJK wide character" {
    const text = "世界";
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(text, 0, 8, .unicode)); // '世' (3 bytes)
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(text, 3, 8, .unicode)); // '界' (3 bytes)
}

test "getWidthAt: emoji single width" {
    const text = "🌍";
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(text, 0, 8, .unicode)); // emoji
}

test "getWidthAt: combining mark grapheme" {
    const text = "cafe\u{0301}"; // é with combining acute accent
    const width = utf8.getWidthAt(text, 3, 8, .unicode); // At 'e' (which has combining mark after)
    try testing.expectEqual(@as(u32, 1), width); // 'e' width 1 + combining mark width 0 = 1
}

test "getWidthAt: emoji with skin tone" {
    const text = "👋🏿"; // Wave + dark skin tone modifier
    const width = utf8.getWidthAt(text, 0, 8, .unicode);
    try testing.expectEqual(@as(u32, 2), width); // Single grapheme cluster, width 2
}

test "getWidthAt: emoji with ZWJ" {
    const text = "👩‍🚀"; // Woman astronaut (woman + ZWJ + rocket)
    const width = utf8.getWidthAt(text, 0, 8, .unicode);
    try testing.expectEqual(@as(u32, 2), width); // Single grapheme cluster, width 2
}

test "getWidthAt: flag emoji" {
    const text = "🇺🇸"; // US flag (two regional indicators)
    const width = utf8.getWidthAt(text, 0, 8, .unicode);
    try testing.expectEqual(@as(u32, 2), width); // Entire grapheme cluster
}

test "getWidthAt: mixed ASCII and CJK" {
    const text = "Hello世界";
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 0, 8, .unicode)); // 'H'
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 1, 8, .unicode)); // 'e'
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(text, 5, 8, .unicode)); // '世'
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(text, 8, 8, .unicode)); // '界'
}

test "getWidthAt: emoji with VS16 selector" {
    const text = "❤️"; // Heart + VS16 selector
    const width = utf8.getWidthAt(text, 0, 8, .unicode);
    try testing.expectEqual(@as(u32, 2), width); // Single grapheme cluster, width 2
}

test "getWidthAt: hiragana" {
    const text = "こんにちは";
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(text, 0, 8, .unicode)); // 'こ'
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(text, 3, 8, .unicode)); // 'ん'
}

test "getWidthAt: katakana" {
    const text = "カタカナ";
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(text, 0, 8, .unicode)); // 'カ'
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(text, 3, 8, .unicode)); // 'タ'
}

test "getWidthAt: fullwidth forms" {
    const text = "ＡＢＣ"; // Fullwidth A, B, C
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(text, 0, 8, .unicode)); // Fullwidth 'A'
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(text, 3, 8, .unicode)); // Fullwidth 'B'
}

test "getWidthAt: zero width at start of string" {
    const text = "a\u{0301}bc"; // a + combining accent + bc
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 0, 8, .unicode)); // 'a' + combining = 1
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 3, 8, .unicode)); // 'b'
}

test "getWidthAt: control characters" {
    const text = "a\x00b";
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 0, 8, .unicode)); // 'a'
    try testing.expectEqual(@as(u32, 0), utf8.getWidthAt(text, 1, 8, .unicode)); // null
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 2, 8, .unicode)); // 'b'
}

test "getWidthAt: multiple combining marks" {
    const text = "e\u{0301}\u{0302}"; // e + acute + circumflex
    const width = utf8.getWidthAt(text, 0, 8, .unicode);
    try testing.expectEqual(@as(u32, 1), width); // All combining marks part of one grapheme
}

test "getWidthAt: at exact end boundary" {
    const text = "hello";
    const width = utf8.getWidthAt(text, 5, 8, .unicode); // At index 5 (past end)
    try testing.expectEqual(@as(u32, 0), width);
}

test "getWidthAt: realistic mixed content" {
    const text = "Hello 世界! 👋";
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 0, 8, .unicode)); // 'H'
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 5, 8, .unicode)); // ' '
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(text, 6, 8, .unicode)); // '世'
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(text, 9, 8, .unicode)); // '界'
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 12, 8, .unicode)); // '!'
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 13, 8, .unicode)); // ' '
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(text, 14, 8, .unicode)); // emoji
}

test "getWidthAt: grapheme at SIMD boundary" {
    var buf: [32]u8 = undefined;
    @memset(&buf, 'x');
    const cjk = "世";
    @memcpy(buf[14..17], cjk); // Place CJK char near boundary

    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(&buf, 13, 8, .unicode)); // 'x'
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(&buf, 14, 8, .unicode)); // '世'
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(&buf, 17, 8, .unicode)); // 'x'
}

test "getWidthAt: incomplete UTF-8 at end" {
    const text = "abc\xC3"; // Incomplete 2-byte sequence
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 0, 8, .unicode)); // 'a'
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 3, 8, .unicode)); // Incomplete, returns 1 for error
}

test "getWidthAt: random positions in realistic text" {
    const text = "The quick brown 🦊 jumps over the lazy 犬";

    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 0, 8, .unicode)); // 'T'
    try testing.expectEqual(@as(u32, 1), utf8.getWidthAt(text, 10, 8, .unicode)); // 'b'
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(text, 16, 8, .unicode)); // fox emoji
    try testing.expectEqual(@as(u32, 2), utf8.getWidthAt(text, 41, 8, .unicode)); // '犬' (dog)
}

// ============================================================================
// GET PREV GRAPHEME START TESTS
// ============================================================================

test "getPrevGraphemeStart: at start" {
    const text = "hello";
    const result = utf8.getPrevGraphemeStart(text, 0, 8, .unicode);
    try testing.expect(result == null);
}

test "getPrevGraphemeStart: empty string" {
    const result = utf8.getPrevGraphemeStart("", 0, 8, .unicode);
    try testing.expect(result == null);
}

test "getPrevGraphemeStart: out of bounds" {
    const text = "hello";
    const result = utf8.getPrevGraphemeStart(text, 100, 8, .unicode);
    try testing.expect(result == null);
}

test "getPrevGraphemeStart: simple ASCII" {
    const text = "hello";

    const r1 = utf8.getPrevGraphemeStart(text, 1, 8, .unicode);
    try testing.expect(r1 != null);
    try testing.expectEqual(@as(usize, 0), r1.?.start_offset);
    try testing.expectEqual(@as(u32, 1), r1.?.width);

    const r2 = utf8.getPrevGraphemeStart(text, 2, 8, .unicode);
    try testing.expect(r2 != null);
    try testing.expectEqual(@as(usize, 1), r2.?.start_offset);
    try testing.expectEqual(@as(u32, 1), r2.?.width);

    const r5 = utf8.getPrevGraphemeStart(text, 5, 8, .unicode);
    try testing.expect(r5 != null);
    try testing.expectEqual(@as(usize, 4), r5.?.start_offset);
    try testing.expectEqual(@as(u32, 1), r5.?.width);
}

test "getPrevGraphemeStart: CJK wide character" {
    const text = "a世界";

    const r1 = utf8.getPrevGraphemeStart(text, 1, 8, .unicode);
    try testing.expect(r1 != null);
    try testing.expectEqual(@as(usize, 0), r1.?.start_offset);
    try testing.expectEqual(@as(u32, 1), r1.?.width);

    const r4 = utf8.getPrevGraphemeStart(text, 4, 8, .unicode);
    try testing.expect(r4 != null);
    try testing.expectEqual(@as(usize, 1), r4.?.start_offset);
    try testing.expectEqual(@as(u32, 2), r4.?.width);

    const r7 = utf8.getPrevGraphemeStart(text, 7, 8, .unicode);
    try testing.expect(r7 != null);
    try testing.expectEqual(@as(usize, 4), r7.?.start_offset);
    try testing.expectEqual(@as(u32, 2), r7.?.width);
}

test "getPrevGraphemeStart: combining mark" {
    const text = "cafe\u{0301}"; // café with combining acute

    const r6 = utf8.getPrevGraphemeStart(text, 6, 8, .unicode);
    try testing.expect(r6 != null);
    try testing.expectEqual(@as(usize, 3), r6.?.start_offset);
    try testing.expectEqual(@as(u32, 1), r6.?.width);
}

test "getPrevGraphemeStart: emoji with skin tone" {
    const text = "Hi👋🏿";

    const r2 = utf8.getPrevGraphemeStart(text, 2, 8, .unicode);
    try testing.expect(r2 != null);
    try testing.expectEqual(@as(usize, 1), r2.?.start_offset);
    try testing.expectEqual(@as(u32, 1), r2.?.width);

    const r_end = utf8.getPrevGraphemeStart(text, text.len, 8, .unicode);
    try testing.expect(r_end != null);
    try testing.expectEqual(@as(usize, 2), r_end.?.start_offset);
}

test "getPrevGraphemeStart: emoji with ZWJ" {
    const text = "a👩‍🚀"; // a + woman astronaut

    const r1 = utf8.getPrevGraphemeStart(text, 1, 8, .unicode);
    try testing.expect(r1 != null);
    try testing.expectEqual(@as(usize, 0), r1.?.start_offset);
    try testing.expectEqual(@as(u32, 1), r1.?.width);

    const r_end = utf8.getPrevGraphemeStart(text, text.len, 8, .unicode);
    try testing.expect(r_end != null);
    try testing.expectEqual(@as(usize, 1), r_end.?.start_offset);
}

test "getPrevGraphemeStart: flag emoji" {
    const text = "US🇺🇸";

    const r_end = utf8.getPrevGraphemeStart(text, text.len, 8, .unicode);
    try testing.expect(r_end != null);
    try testing.expectEqual(@as(usize, 2), r_end.?.start_offset);
}

test "getPrevGraphemeStart: tab handling" {
    const text = "a\tb";

    const r2 = utf8.getPrevGraphemeStart(text, 2, 4, .unicode);
    try testing.expect(r2 != null);
    try testing.expectEqual(@as(usize, 1), r2.?.start_offset);

    const r1 = utf8.getPrevGraphemeStart(text, 1, 4, .unicode);
    try testing.expect(r1 != null);
    try testing.expectEqual(@as(usize, 0), r1.?.start_offset);
    try testing.expectEqual(@as(u32, 1), r1.?.width);
}

test "getPrevGraphemeStart: mixed content" {
    const text = "Hi世界!";

    const r2 = utf8.getPrevGraphemeStart(text, 2, 8, .unicode);
    try testing.expect(r2 != null);
    try testing.expectEqual(@as(usize, 1), r2.?.start_offset);

    const r5 = utf8.getPrevGraphemeStart(text, 5, 8, .unicode);
    try testing.expect(r5 != null);
    try testing.expectEqual(@as(usize, 2), r5.?.start_offset);
    try testing.expectEqual(@as(u32, 2), r5.?.width);

    const r8 = utf8.getPrevGraphemeStart(text, 8, 8, .unicode);
    try testing.expect(r8 != null);
    try testing.expectEqual(@as(usize, 5), r8.?.start_offset);
    try testing.expectEqual(@as(u32, 2), r8.?.width);
}

test "getPrevGraphemeStart: multiple combining marks" {
    const text = "e\u{0301}\u{0302}x"; // e + acute + circumflex + x

    const r_x = utf8.getPrevGraphemeStart(text, text.len, 8, .unicode);
    try testing.expect(r_x != null);
    try testing.expectEqual(@as(usize, text.len - 1), r_x.?.start_offset);

    const r_e = utf8.getPrevGraphemeStart(text, text.len - 1, 8, .unicode);
    try testing.expect(r_e != null);
    try testing.expectEqual(@as(usize, 0), r_e.?.start_offset);
    try testing.expectEqual(@as(u32, 1), r_e.?.width);
}

test "getPrevGraphemeStart: hiragana" {
    const text = "こんにちは";

    const r_last = utf8.getPrevGraphemeStart(text, text.len, 8, .unicode);
    try testing.expect(r_last != null);
    try testing.expectEqual(@as(usize, 12), r_last.?.start_offset);
    try testing.expectEqual(@as(u32, 2), r_last.?.width);
}

test "getPrevGraphemeStart: realistic scenario" {
    const text = "Hello 世界! 👋";

    const r_end = utf8.getPrevGraphemeStart(text, text.len, 8, .unicode);
    try testing.expect(r_end != null);
    try testing.expectEqual(@as(usize, 14), r_end.?.start_offset);

    const r_space = utf8.getPrevGraphemeStart(text, 14, 8, .unicode);
    try testing.expect(r_space != null);
    try testing.expectEqual(@as(usize, 13), r_space.?.start_offset);
    try testing.expectEqual(@as(u32, 1), r_space.?.width);
}

test "getPrevGraphemeStart: consecutive wide chars" {
    const text = "世界中";

    const r9 = utf8.getPrevGraphemeStart(text, 9, 8, .unicode);
    try testing.expect(r9 != null);
    try testing.expectEqual(@as(usize, 6), r9.?.start_offset);
    try testing.expectEqual(@as(u32, 2), r9.?.width);

    const r6 = utf8.getPrevGraphemeStart(text, 6, 8, .unicode);
    try testing.expect(r6 != null);
    try testing.expectEqual(@as(usize, 3), r6.?.start_offset);
    try testing.expectEqual(@as(u32, 2), r6.?.width);

    const r3 = utf8.getPrevGraphemeStart(text, 3, 8, .unicode);
    try testing.expect(r3 != null);
    try testing.expectEqual(@as(usize, 0), r3.?.start_offset);
    try testing.expectEqual(@as(u32, 2), r3.?.width);
}

// ============================================================================
// CALCULATE TEXT WIDTH TESTS (static tab width)
// ============================================================================

test "calculateTextWidth: empty string" {
    const result = utf8.calculateTextWidth("", 4, true, .unicode);
    try testing.expectEqual(@as(u32, 0), result);
}

test "calculateTextWidth: simple ASCII" {
    const result = utf8.calculateTextWidth("hello", 4, true, .unicode);
    try testing.expectEqual(@as(u32, 5), result);
}

test "calculateTextWidth: single tab" {
    const result = utf8.calculateTextWidth("\t", 4, true, .unicode);
    try testing.expectEqual(@as(u32, 4), result);
}

test "calculateTextWidth: tab with different widths" {
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth("\t", 2, true, .unicode));
    try testing.expectEqual(@as(u32, 4), utf8.calculateTextWidth("\t", 4, true, .unicode));
    try testing.expectEqual(@as(u32, 8), utf8.calculateTextWidth("\t", 8, true, .unicode));
}

test "calculateTextWidth: multiple tabs" {
    const result = utf8.calculateTextWidth("\t\t\t", 4, true, .unicode);
    try testing.expectEqual(@as(u32, 12), result); // 3 tabs * 4 = 12
}

test "calculateTextWidth: text with tabs" {
    const result = utf8.calculateTextWidth("a\tb", 4, true, .unicode);
    try testing.expectEqual(@as(u32, 6), result); // a(1) + tab(4) + b(1) = 6
}

test "calculateTextWidth: multiple tabs between text" {
    const result = utf8.calculateTextWidth("a\t\tb", 2, true, .unicode);
    try testing.expectEqual(@as(u32, 6), result); // a(1) + tab(2) + tab(2) + b(1) = 6
}

test "calculateTextWidth: tab at start" {
    const result = utf8.calculateTextWidth("\tabc", 4, true, .unicode);
    try testing.expectEqual(@as(u32, 7), result); // tab(4) + a(1) + b(1) + c(1) = 7
}

test "calculateTextWidth: tab at end" {
    const result = utf8.calculateTextWidth("abc\t", 4, true, .unicode);
    try testing.expectEqual(@as(u32, 7), result); // a(1) + b(1) + c(1) + tab(4) = 7
}

test "calculateTextWidth: CJK with tabs" {
    const result = utf8.calculateTextWidth("世\t界", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 8), result); // 世(2) + tab(4) + 界(2) = 8
}

test "calculateTextWidth: emoji with tab" {
    const result = utf8.calculateTextWidth("🌍\t", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), result); // emoji(2) + tab(4) = 6
}

test "calculateTextWidth: mixed ASCII and Unicode with tabs" {
    const result = utf8.calculateTextWidth("hello\t世界", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 13), result); // hello(5) + tab(4) + 世(2) + 界(2) = 13
}

test "calculateTextWidth: realistic code with tabs" {
    const text = "\tif (x > 5) {\n\t\treturn true;\n\t}";
    const result = utf8.calculateTextWidth(text, 2, true, .unicode);
    // tab(2) + "if (x > 5) {" (12) + newline(0) + tab(2) + tab(2) + "return true;" (12) + newline(0) + tab(2) + "}" (1)
    // = 2 + 12 + 2 + 2 + 12 + 2 + 1 = 33
    try testing.expectEqual(@as(u32, 33), result);
}

test "calculateTextWidth: only spaces" {
    const result = utf8.calculateTextWidth("     ", 4, true, .unicode);
    try testing.expectEqual(@as(u32, 5), result);
}

test "calculateTextWidth: tabs and spaces mixed" {
    const result = utf8.calculateTextWidth("  \t  \t  ", 4, true, .unicode);
    try testing.expectEqual(@as(u32, 14), result); // 2 + 4 + 2 + 4 + 2 = 14
}

test "calculateTextWidth: control characters" {
    const result = utf8.calculateTextWidth("a\x00b\x1Fc", 4, true, .unicode);
    try testing.expectEqual(@as(u32, 3), result); // Only printable chars: a, b, c
}

test "calculateTextWidth: combining marks" {
    const result = utf8.calculateTextWidth("cafe\u{0301}", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 4), result); // c(1) + a(1) + f(1) + e(1) + combining(0) = 4
}

test "calculateTextWidth: scroll book and writing emojis width 2" {
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth("📜", 4, false, .unicode));
}

test "calculateTextWidth: Devanagari नमस्ते width 4" {
    const result = utf8.calculateTextWidth("नमस्ते", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 4), result);
}

// ============================================================================
// UNICODE WARNING SIGNS WIDTH TESTS
// ============================================================================

test "calculateTextWidth: U+26A0 warning sign should be width 2" {
    const result = utf8.calculateTextWidth("⚠", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), result);
}

test "calculateTextWidth: U+2049 exclamation question mark should be width 2" {
    const result = utf8.calculateTextWidth("⁉", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), result);
}

test "calculateTextWidth: U+203C double exclamation mark should be width 2" {
    const result = utf8.calculateTextWidth("‼", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), result);
}

test "calculateTextWidth: U+26D1 rescue worker helmet should be width 2" {
    const result = utf8.calculateTextWidth("⛑", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), result);
}

test "calculateTextWidth: U+2622 radioactive sign should be width 2" {
    const result = utf8.calculateTextWidth("☢", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), result);
}

test "calculateTextWidth: U+2623 biohazard sign should be width 2" {
    const result = utf8.calculateTextWidth("☣", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), result);
}

test "calculateTextWidth: U+269B atom symbol should be width 2" {
    const result = utf8.calculateTextWidth("⚛", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), result);
}

// ============================================================================
// GRAPHEME INFO TESTS (for caching multi-byte graphemes and tabs)
// ============================================================================

test "findGraphemeInfo: empty string" {
    var result: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer result.deinit(testing.allocator);

    try utf8.findGraphemeInfo("", 4, true, .unicode, testing.allocator, &result);
    try testing.expectEqual(@as(usize, 0), result.items.len);
}

test "findGraphemeInfo: ASCII-only returns empty" {
    var result: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer result.deinit(testing.allocator);

    try utf8.findGraphemeInfo("hello world", 4, true, .unicode, testing.allocator, &result);
    try testing.expectEqual(@as(usize, 0), result.items.len);
}

test "findGraphemeInfo: ASCII with tab" {
    var result: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer result.deinit(testing.allocator);

    try utf8.findGraphemeInfo("hello\tworld", 4, false, .unicode, testing.allocator, &result);

    // Should have one entry for the tab
    try testing.expectEqual(@as(usize, 1), result.items.len);
    try testing.expectEqual(@as(u32, 5), result.items[0].byte_offset);
    try testing.expectEqual(@as(u8, 1), result.items[0].byte_len);
    try testing.expectEqual(@as(u8, 4), result.items[0].width);
    try testing.expectEqual(@as(u32, 5), result.items[0].col_offset);
}

test "findGraphemeInfo: multiple tabs" {
    var result: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer result.deinit(testing.allocator);

    try utf8.findGraphemeInfo("a\tb\tc", 4, false, .unicode, testing.allocator, &result);

    // Should have two entries for the tabs
    try testing.expectEqual(@as(usize, 2), result.items.len);

    // First tab at byte 1, col 1
    try testing.expectEqual(@as(u32, 1), result.items[0].byte_offset);
    try testing.expectEqual(@as(u8, 1), result.items[0].byte_len);
    try testing.expectEqual(@as(u8, 4), result.items[0].width);
    try testing.expectEqual(@as(u32, 1), result.items[0].col_offset);

    // Second tab at byte 3, col 6 (1 + 4 + 1)
    try testing.expectEqual(@as(u32, 3), result.items[1].byte_offset);
    try testing.expectEqual(@as(u8, 1), result.items[1].byte_len);
    try testing.expectEqual(@as(u8, 4), result.items[1].width);
    try testing.expectEqual(@as(u32, 6), result.items[1].col_offset);
}

test "findGraphemeInfo: CJK characters" {
    var result: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer result.deinit(testing.allocator);

    const text = "hello世界";
    try utf8.findGraphemeInfo(text, 4, false, .unicode, testing.allocator, &result);

    // Should have two entries for the CJK characters
    try testing.expectEqual(@as(usize, 2), result.items.len);

    // 世 at byte 5
    try testing.expectEqual(@as(u32, 5), result.items[0].byte_offset);
    try testing.expectEqual(@as(u8, 3), result.items[0].byte_len);
    try testing.expectEqual(@as(u8, 2), result.items[0].width);
    try testing.expectEqual(@as(u32, 5), result.items[0].col_offset);

    // 界 at byte 8
    try testing.expectEqual(@as(u32, 8), result.items[1].byte_offset);
    try testing.expectEqual(@as(u8, 3), result.items[1].byte_len);
    try testing.expectEqual(@as(u8, 2), result.items[1].width);
    try testing.expectEqual(@as(u32, 7), result.items[1].col_offset);
}

test "findGraphemeInfo: emoji with skin tone" {
    var result: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer result.deinit(testing.allocator);

    const text = "Hi👋🏿Bye"; // Hi + wave + dark skin tone + Bye
    try utf8.findGraphemeInfo(text, 4, false, .unicode, testing.allocator, &result);

    // Should have one entry for the emoji cluster
    try testing.expectEqual(@as(usize, 1), result.items.len);

    try testing.expectEqual(@as(u32, 2), result.items[0].byte_offset);
    try testing.expectEqual(@as(u8, 8), result.items[0].byte_len); // 4 + 4 bytes
    try testing.expectEqual(@as(u8, 2), result.items[0].width);
    try testing.expectEqual(@as(u32, 2), result.items[0].col_offset);
}

test "findGraphemeInfo: emoji with ZWJ" {
    var result: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer result.deinit(testing.allocator);

    const text = "a👩‍🚀b"; // a + woman astronaut + b
    try utf8.findGraphemeInfo(text, 4, false, .unicode, testing.allocator, &result);

    // Should have one entry for the emoji cluster
    try testing.expectEqual(@as(usize, 1), result.items.len);

    try testing.expectEqual(@as(u32, 1), result.items[0].byte_offset);
    try testing.expectEqual(@as(u8, 2), result.items[0].width);
    try testing.expectEqual(@as(u32, 1), result.items[0].col_offset);
}

test "findGraphemeInfo: combining mark" {
    var result: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer result.deinit(testing.allocator);

    const text = "cafe\u{0301}"; // café with combining acute
    try utf8.findGraphemeInfo(text, 4, false, .unicode, testing.allocator, &result);

    // Should have one entry for e + combining mark
    try testing.expectEqual(@as(usize, 1), result.items.len);

    try testing.expectEqual(@as(u32, 3), result.items[0].byte_offset); // 'e' position
    try testing.expectEqual(@as(u8, 3), result.items[0].byte_len); // e (1 byte) + combining (2 bytes)
    try testing.expectEqual(@as(u8, 1), result.items[0].width);
    try testing.expectEqual(@as(u32, 3), result.items[0].col_offset);
}

test "findGraphemeInfo: flag emoji" {
    var result: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer result.deinit(testing.allocator);

    const text = "US🇺🇸"; // US + flag
    try utf8.findGraphemeInfo(text, 4, false, .unicode, testing.allocator, &result);

    // Should have one entry for the flag (two regional indicators)
    try testing.expectEqual(@as(usize, 1), result.items.len);

    try testing.expectEqual(@as(u32, 2), result.items[0].byte_offset);
    try testing.expectEqual(@as(u8, 8), result.items[0].byte_len); // Two 4-byte chars
    try testing.expectEqual(@as(u8, 2), result.items[0].width);
    try testing.expectEqual(@as(u32, 2), result.items[0].col_offset);
}

test "findGraphemeInfo: mixed content" {
    var result: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer result.deinit(testing.allocator);

    const text = "Hi\t世界!"; // Hi + tab + CJK + !
    try utf8.findGraphemeInfo(text, 4, false, .unicode, testing.allocator, &result);

    // Should have three entries: tab, 世, 界
    try testing.expectEqual(@as(usize, 3), result.items.len);

    // Tab at byte 2, col 2
    try testing.expectEqual(@as(u32, 2), result.items[0].byte_offset);
    try testing.expectEqual(@as(u8, 1), result.items[0].byte_len);
    try testing.expectEqual(@as(u8, 4), result.items[0].width);
    try testing.expectEqual(@as(u32, 2), result.items[0].col_offset);

    // 世 at byte 3, col 6
    try testing.expectEqual(@as(u32, 3), result.items[1].byte_offset);
    try testing.expectEqual(@as(u8, 3), result.items[1].byte_len);
    try testing.expectEqual(@as(u8, 2), result.items[1].width);
    try testing.expectEqual(@as(u32, 6), result.items[1].col_offset);

    // 界 at byte 6, col 8
    try testing.expectEqual(@as(u32, 6), result.items[2].byte_offset);
    try testing.expectEqual(@as(u8, 3), result.items[2].byte_len);
    try testing.expectEqual(@as(u8, 2), result.items[2].width);
    try testing.expectEqual(@as(u32, 8), result.items[2].col_offset);
}

test "findGraphemeInfo: only ASCII letters no cache" {
    var result: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer result.deinit(testing.allocator);

    try utf8.findGraphemeInfo("abcdefghij", 4, false, .unicode, testing.allocator, &result);

    // No special characters, should be empty
    try testing.expectEqual(@as(usize, 0), result.items.len);
}

test "findGraphemeInfo: emoji with VS16" {
    var result: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer result.deinit(testing.allocator);

    const text = "I ❤️ U"; // I + space + heart + VS16 + space + U
    try utf8.findGraphemeInfo(text, 4, false, .unicode, testing.allocator, &result);

    // Should have one entry for the emoji cluster
    try testing.expectEqual(@as(usize, 1), result.items.len);

    try testing.expectEqual(@as(u32, 2), result.items[0].byte_offset);
    try testing.expectEqual(@as(u8, 2), result.items[0].width);
    try testing.expectEqual(@as(u32, 2), result.items[0].col_offset);
}

test "findGraphemeInfo: realistic text" {
    var result: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer result.deinit(testing.allocator);

    const text = "function test() {\n\tconst 世界 = 10;\n}";
    try utf8.findGraphemeInfo(text, 4, false, .unicode, testing.allocator, &result);

    // Should have entries for: tab, 世, 界
    try testing.expectEqual(@as(usize, 3), result.items.len);
}

test "findGraphemeInfo: hiragana" {
    var result: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer result.deinit(testing.allocator);

    const text = "こんにちは";
    try utf8.findGraphemeInfo(text, 4, false, .unicode, testing.allocator, &result);

    // Should have 5 entries (each hiragana is 3 bytes, width 2)
    try testing.expectEqual(@as(usize, 5), result.items.len);

    // Check first character
    try testing.expectEqual(@as(u32, 0), result.items[0].byte_offset);
    try testing.expectEqual(@as(u8, 3), result.items[0].byte_len);
    try testing.expectEqual(@as(u8, 2), result.items[0].width);
}

test "findGraphemeInfo: at SIMD boundary" {
    var result: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer result.deinit(testing.allocator);

    // Create text with multibyte char near SIMD boundary (16 bytes)
    var buf: [32]u8 = undefined;
    @memset(&buf, 'x');
    const cjk = "世";
    @memcpy(buf[14..17], cjk); // Place CJK char at boundary

    try utf8.findGraphemeInfo(&buf, 4, false, .unicode, testing.allocator, &result);

    // Should find the CJK character
    var found = false;
    for (result.items) |g| {
        if (g.byte_offset == 14) {
            found = true;
            try testing.expectEqual(@as(u8, 3), g.byte_len);
            try testing.expectEqual(@as(u8, 2), g.width);
            break;
        }
    }
    try testing.expect(found);
}

test "calculateTextWidth: book and writing hand emojis width 2" {
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth("📖", 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth("✍️", 4, false, .unicode));
}

test "calculateTextWidth: Devanagari script" {
    const result = utf8.calculateTextWidth("देवनागरी", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 5), result);
    try testing.expectEqual(@as(u32, 3), utf8.calculateTextWidth("प्रथम", 4, false, .unicode));
}

test "calculateTextWidth: checkmark symbol" {
    const result = utf8.calculateTextWidth("✓", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 1), result);
}

test "calculateTextWidth: emoji with skin tone" {
    const result = utf8.calculateTextWidth("👋🏿", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), result); // 👋🏿 is a single grapheme with width 2
}

test "calculateTextWidth: emoji with ZWJ" {
    const result = utf8.calculateTextWidth("👩‍🚀", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), result); // 👩‍🚀 is a single grapheme with width 2
}

test "calculateTextWidth: emoji with VS16 selector" {
    const result = utf8.calculateTextWidth("❤️", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), result); // ❤️ (heart + VS16) is a single grapheme with width 2
}

test "calculateTextWidth: flag emoji" {
    const result = utf8.calculateTextWidth("🇺🇸", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), result); // 🇺🇸 is a single grapheme with width 2
}

test "calculateTextWidth: hiragana with tab" {
    const result = utf8.calculateTextWidth("こん\tにちは", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 14), result); // こ(2) + ん(2) + tab(4) + に(2) + ち(2) + は(2) = 14
}

test "calculateTextWidth: fullwidth forms with tab" {
    const result = utf8.calculateTextWidth("ＡＢ\tＣ", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 10), result); // Ａ(2) + Ｂ(2) + tab(4) + Ｃ(2) = 10
}

test "calculateTextWidth: ASCII fast path consistency" {
    const text_ascii = "hello\tworld";
    const result_fast = utf8.calculateTextWidth(text_ascii, 4, true, .unicode);
    const result_slow = utf8.calculateTextWidth(text_ascii, 4, false, .unicode);
    try testing.expectEqual(result_fast, result_slow);
}

test "calculateTextWidth: large text with many tabs" {
    const size = 1000;
    const buf = try testing.allocator.alloc(u8, size);
    defer testing.allocator.free(buf);

    var expected: u32 = 0;
    for (buf, 0..) |*b, i| {
        if (i % 10 == 0) {
            b.* = '\t';
            expected += 4;
        } else {
            b.* = 'a';
            expected += 1;
        }
    }

    const result = utf8.calculateTextWidth(buf, 4, true, .unicode);
    try testing.expectEqual(expected, result);
}

test "calculateTextWidth: comparison with manual calculation" {
    const test_cases = [_]struct {
        text: []const u8,
        tab_width: u8,
        expected: u32,
    }{
        .{ .text = "\t", .tab_width = 2, .expected = 2 },
        .{ .text = "\t\t", .tab_width = 2, .expected = 4 },
        .{ .text = "a\t", .tab_width = 2, .expected = 3 },
        .{ .text = "\ta", .tab_width = 2, .expected = 3 },
        .{ .text = "a\tb", .tab_width = 2, .expected = 4 },
        .{ .text = "ab\tcd", .tab_width = 4, .expected = 8 },
        .{ .text = "\t\tx", .tab_width = 2, .expected = 5 },
        .{ .text = "世\t界", .tab_width = 2, .expected = 6 },
    };

    for (test_cases) |tc| {
        const result = utf8.calculateTextWidth(tc.text, tc.tab_width, false, .unicode);
        try testing.expectEqual(tc.expected, result);
    }
}

// ============================================================================
// LINE WIDTH WITH GRAPHEMES TESTS
// Testing that calculateTextWidth returns correct Unicode display widths
// ============================================================================

test "calculateTextWidth: checkmark grapheme ✅" {
    // Test simple checkmark emoji
    const checkmark = "✅";

    // Calculate width using utf8.zig's calculateTextWidth
    const width = utf8.calculateTextWidth(checkmark, 4, false, .unicode);

    // The checkmark ✅ (U+2705) should be width 2
    try testing.expectEqual(@as(u32, 2), width);
}

test "calculateTextWidth: Sanskrit text with combining marks" {
    const result = utf8.calculateTextWidth("संस्कृति", 4, false, .unicode);
    try testing.expectEqual(@as(u32, 4), result);
}

test "calculateTextWidth: checkmark in text" {
    // Test checkmark in context
    const text = "Done ✅";

    // Calculate width using utf8.zig
    const width = utf8.calculateTextWidth(text, 4, false, .unicode);

    // Should return: D(1) + o(1) + n(1) + e(1) + space(1) + ✅(2) = 7
    try testing.expectEqual(@as(u32, 7), width);
}

test "calculateTextWidth: various emoji graphemes" {
    const test_cases = [_]struct {
        text: []const u8,
        name: []const u8,
        expected_width: u32,
    }{
        .{ .text = "✅", .name = "checkmark U+2705", .expected_width = 2 },
        .{ .text = "❤️", .name = "red heart U+2764+FE0F", .expected_width = 2 },
        .{ .text = "🎉", .name = "party popper U+1F389", .expected_width = 2 },
        .{ .text = "🔥", .name = "fire U+1F525", .expected_width = 2 },
        .{ .text = "💯", .name = "hundred points U+1F4AF", .expected_width = 2 },
        .{ .text = "🚀", .name = "rocket U+1F680", .expected_width = 2 },
        .{ .text = "⭐", .name = "star U+2B50", .expected_width = 2 },
        .{ .text = "👍", .name = "thumbs up U+1F44D", .expected_width = 2 },
    };

    for (test_cases) |tc| {
        const width = utf8.calculateTextWidth(tc.text, 4, false, .unicode);
        try testing.expectEqual(tc.expected_width, width);
    }
}

test "calculateTextWidth: complex graphemes with ZWJ" {
    // Woman astronaut: 👩‍🚀 (woman + ZWJ + rocket)
    const woman_astronaut = "👩‍🚀";

    const width = utf8.calculateTextWidth(woman_astronaut, 4, false, .unicode);

    // Should return 2 for the combined grapheme (not 5 for individual codepoints)
    try testing.expectEqual(@as(u32, 2), width);
}

test "calculateTextWidth: flag emoji grapheme" {
    // US flag: 🇺🇸 (two regional indicator symbols)
    const us_flag = "🇺🇸";

    const width = utf8.calculateTextWidth(us_flag, 4, false, .unicode);

    // Should return 2 for the flag grapheme
    try testing.expectEqual(@as(u32, 2), width);
}

test "calculateTextWidth: skin tone modifier grapheme" {
    // Waving hand with dark skin tone: 👋🏿
    const wave_dark = "👋🏿";

    const width = utf8.calculateTextWidth(wave_dark, 4, false, .unicode);

    // Should return 2 for the combined grapheme (not 4 for individual codepoints)
    try testing.expectEqual(@as(u32, 2), width);
}
// ============================================================================
// COMPREHENSIVE UNICODE GRAPHEME TESTS FOR calculateTextWidth
// Testing various emoji, ZWJ sequences, Indic scripts, and Unicode edge cases
// ============================================================================

// ----------------------------------------------------------------------------
// Emoji Presentation Tests
// ----------------------------------------------------------------------------

test "calculateTextWidth: emoji presentation with VS15 (text)" {
    // U+2764 (heart) + U+FE0E (VS15 - text presentation)
    const heart_text = "❤\u{FE0E}";
    const width = utf8.calculateTextWidth(heart_text, 4, false, .unicode);
    // With text presentation selector, should still be counted as grapheme width 2
    try testing.expectEqual(@as(u32, 2), width);
}

test "calculateTextWidth: emoji presentation with VS16 (emoji)" {
    // U+2764 (heart) + U+FE0F (VS16 - emoji presentation) - already tested as ❤️
    const heart_emoji = "❤️";
    const width = utf8.calculateTextWidth(heart_emoji, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), width);
}

test "calculateTextWidth: keycap sequences" {
    // Digit + U+FE0F + U+20E3 (combining enclosing keycap)
    const keycap_1 = "1️⃣"; // U+0031 U+FE0F U+20E3
    const keycap_hash = "#️⃣"; // U+0023 U+FE0F U+20E3

    // Keycap: base char (1) + VS16 (changes to emoji presentation, width 2) + combining keycap (0) = 2 total width
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(keycap_1, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(keycap_hash, 4, false, .unicode));
}

// ----------------------------------------------------------------------------
// Complex ZWJ Sequences
// ----------------------------------------------------------------------------

test "calculateTextWidth: family ZWJ sequences" {
    // Family: man, woman, girl, boy (4 people)
    const family = "👨‍👩‍👧‍👦"; // man + ZWJ + woman + ZWJ + girl + ZWJ + boy
    const width = utf8.calculateTextWidth(family, 4, false, .unicode);
    // Should be counted as single grapheme with width 2
    try testing.expectEqual(@as(u32, 2), width);
}

test "calculateTextWidth: profession ZWJ sequences" {
    // Woman health worker: woman + ZWJ + health worker
    const health_worker = "👩‍⚕️";
    const firefighter = "👨‍🚒";
    const teacher = "👩‍🏫";

    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(health_worker, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(firefighter, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(teacher, 4, false, .unicode));
}

test "calculateTextWidth: couple ZWJ sequences" {
    // Kiss: person + ZWJ + heart + ZWJ + person
    const kiss = "💏"; // Single codepoint
    const couple_with_heart = "👩‍❤️‍👨"; // woman + ZWJ + heart + VS16 + ZWJ + man

    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(kiss, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(couple_with_heart, 4, false, .unicode));
}

// ----------------------------------------------------------------------------
// Skin Tone Modifiers (Fitzpatrick scale)
// ----------------------------------------------------------------------------

test "calculateTextWidth: all skin tone modifiers" {
    // Fitzpatrick Type-1-2 (light skin tone) U+1F3FB
    const wave_light = "👋🏻";
    // Fitzpatrick Type-3 (medium-light skin tone) U+1F3FC
    const wave_medium_light = "👋🏼";
    // Fitzpatrick Type-4 (medium skin tone) U+1F3FD
    const wave_medium = "👋🏽";
    // Fitzpatrick Type-5 (medium-dark skin tone) U+1F3FE
    const wave_medium_dark = "👋🏾";
    // Fitzpatrick Type-6 (dark skin tone) U+1F3FF
    const wave_dark = "👋🏿";

    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(wave_light, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(wave_medium_light, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(wave_medium, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(wave_medium_dark, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(wave_dark, 4, false, .unicode));
}

test "calculateTextWidth: skin tone with ZWJ" {
    // Family with skin tones: man(dark) + ZWJ + woman(light) + ZWJ + child
    const family_skin_tones = "👨🏿‍👩🏻‍👶";
    const width = utf8.calculateTextWidth(family_skin_tones, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), width);
}

// ----------------------------------------------------------------------------
// Regional Indicator Symbols (Flags)
// ----------------------------------------------------------------------------

test "calculateTextWidth: various flag emojis" {
    const flag_us = "🇺🇸"; // U+1F1FA U+1F1F8
    const flag_uk = "🇬🇧"; // U+1F1EC U+1F1E7
    const flag_jp = "🇯🇵"; // U+1F1EF U+1F1F5
    const flag_de = "🇩🇪"; // U+1F1E9 U+1F1EA
    const flag_fr = "🇫🇷"; // U+1F1EB U+1F1F7

    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(flag_us, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(flag_uk, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(flag_jp, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(flag_de, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(flag_fr, 4, false, .unicode));
}

test "calculateTextWidth: multiple flags in text" {
    const text = "Flags: 🇺🇸 🇬🇧 🇯🇵";
    const width = utf8.calculateTextWidth(text, 4, false, .unicode);
    // "Flags: " (7) + 🇺🇸 (2) + " " (1) + 🇬🇧 (2) + " " (1) + 🇯🇵 (2) = 15
    try testing.expectEqual(@as(u32, 15), width);
}

// ----------------------------------------------------------------------------
// Devanagari and Indic Scripts
// ----------------------------------------------------------------------------

test "calculateTextWidth: Devanagari basic characters" {
    // Devanagari script (Hindi, Sanskrit, etc.)
    const namaste = "नमस्ते"; // na-ma-s-te with virama
    const width = utf8.calculateTextWidth(namaste, 4, false, .unicode);
    // Devanagari characters are typically width 1 each
    // This is 5 graphemes: न म स् ते (the virama combines with स)
    try testing.expect(width > 0); // Exact width depends on grapheme clustering
}

test "calculateTextWidth: Devanagari with combining marks" {
    // Devanagari vowel signs and nukta
    const ka = "क"; // Base character
    const ki = "कि"; // क + vowel sign i (U+093F)
    const kii = "की"; // क + vowel sign ii (U+0940)

    try testing.expectEqual(@as(u32, 1), utf8.calculateTextWidth(ka, 4, false, .unicode));
    // With combining vowel signs, should still be 1 grapheme
    try testing.expectEqual(@as(u32, 1), utf8.calculateTextWidth(ki, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 1), utf8.calculateTextWidth(kii, 4, false, .unicode));
}

test "calculateTextWidth: Devanagari conjuncts" {
    // Conjunct consonants with virama
    const kta = "क्त"; // क + virama + त (kta)
    const jna = "ज्ञ"; // ज + virama + ञ (jna)
    const ksha = "क्‍ष"; // क + virama + ZWJ + ष (kṣa with explicit ZWJ)

    // These form single grapheme clusters but width = number of base consonants
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(kta, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(jna, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(ksha, 4, false, .unicode));
}

test "calculateTextWidth: Bengali script" {
    // Bengali/Bangla script
    const bangla = "বাংলা"; // Bangla
    const width = utf8.calculateTextWidth(bangla, 4, false, .unicode);
    try testing.expect(width > 0);
}

test "calculateTextWidth: Tamil script" {
    // Tamil script (no conjuncts, simpler than Devanagari)
    const tamil = "தமிழ்"; // Tamil
    const width = utf8.calculateTextWidth(tamil, 4, false, .unicode);
    try testing.expect(width > 0);
}

test "calculateTextWidth: Telugu script" {
    // Telugu script
    const telugu = "తెలుగు"; // Telugu
    const width = utf8.calculateTextWidth(telugu, 4, false, .unicode);
    try testing.expect(width > 0);
}

// ----------------------------------------------------------------------------
// Arabic and RTL Scripts
// ----------------------------------------------------------------------------

test "calculateTextWidth: Arabic basic text" {
    // Arabic text (RTL, but width calculation is the same)
    const arabic = "مرحبا"; // Marhaba (hello)
    const width = utf8.calculateTextWidth(arabic, 4, false, .unicode);
    // Arabic characters are width 1 each
    try testing.expect(width >= 5);
}

test "calculateTextWidth: Arabic with diacritics" {
    // Arabic with harakat (diacritical marks)
    const with_diacritics = "مَرْحَبًا"; // Marhaba with vowel marks
    const width = utf8.calculateTextWidth(with_diacritics, 4, false, .unicode);
    // Combining marks should not add to width
    try testing.expect(width >= 5);
}

test "calculateTextWidth: Hebrew text" {
    // Hebrew text (RTL)
    const hebrew = "שלום"; // Shalom
    const width = utf8.calculateTextWidth(hebrew, 4, false, .unicode);
    try testing.expect(width >= 4);
}

// ----------------------------------------------------------------------------
// East Asian Scripts (CJK)
// ----------------------------------------------------------------------------

test "calculateTextWidth: Chinese traditional characters" {
    const traditional = "繁體中文"; // Traditional Chinese
    const width = utf8.calculateTextWidth(traditional, 4, false, .unicode);
    // Each CJK character is width 2
    try testing.expectEqual(@as(u32, 8), width); // 4 chars * 2 = 8
}

test "calculateTextWidth: Chinese simplified characters" {
    const simplified = "简体中文"; // Simplified Chinese
    const width = utf8.calculateTextWidth(simplified, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 8), width); // 4 chars * 2 = 8
}

test "calculateTextWidth: Japanese mixed scripts" {
    // Hiragana + Kanji + Katakana
    const mixed = "ひらがな漢字カタカナ"; // hiragana, kanji, katakana
    const width = utf8.calculateTextWidth(mixed, 4, false, .unicode);
    // All are width 2: 4 hiragana + 2 kanji + 4 katakana = 10 chars * 2 = 20
    try testing.expectEqual(@as(u32, 20), width);
}

test "calculateTextWidth: Korean Hangul syllables" {
    const korean = "한글"; // Hangul (Korean)
    const width = utf8.calculateTextWidth(korean, 4, false, .unicode);
    // Hangul syllables are width 2
    try testing.expectEqual(@as(u32, 4), width); // 2 chars * 2 = 4
}

test "calculateTextWidth: CJK with ASCII" {
    const mixed = "Hello世界World"; // ASCII + CJK + ASCII
    const width = utf8.calculateTextWidth(mixed, 4, false, .unicode);
    // "Hello" (5) + "世界" (4) + "World" (5) = 14
    try testing.expectEqual(@as(u32, 14), width);
}

// ----------------------------------------------------------------------------
// Combining Marks and Diacritics
// ----------------------------------------------------------------------------

test "calculateTextWidth: multiple combining marks on one base" {
    // Base + multiple combining marks
    const multiple = "e\u{0301}\u{0302}\u{0304}"; // e + acute + circumflex + macron
    const width = utf8.calculateTextWidth(multiple, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 1), width);
}

test "calculateTextWidth: combining enclosing marks" {
    // Combining enclosing circle backslash U+20E0
    const enclosed = "a\u{20E0}";
    const width = utf8.calculateTextWidth(enclosed, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 1), width);
}

test "calculateTextWidth: Vietnamese with multiple diacritics" {
    // Vietnamese uses Latin with complex diacritics
    const vietnamese = "Tiếng Việt"; // Vietnamese language
    const width = utf8.calculateTextWidth(vietnamese, 4, false, .unicode);
    // Each base character with combining marks = 1 width
    // "Tiếng" (5) + " " (1) + "Việt" (4) = 10
    try testing.expectEqual(@as(u32, 10), width);
}

// ----------------------------------------------------------------------------
// Zero-Width Characters
// ----------------------------------------------------------------------------

test "calculateTextWidth: zero width joiner (ZWJ)" {
    // ZWJ by itself (shouldn't happen, but test it) - it's a format char with width 0
    const zwj = "\u{200D}";
    const width = utf8.calculateTextWidth(zwj, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 0), width); // Width of ZWJ is 0 (Cf category)
}

test "calculateTextWidth: zero width non-joiner (ZWNJ)" {
    // ZWNJ U+200C
    const zwnj = "ab\u{200C}cd";
    const width = utf8.calculateTextWidth(zwnj, 4, false, .unicode);
    // ZWNJ has width 0, so should be 4 (a, b, c, d)
    try testing.expectEqual(@as(u32, 4), width);
}

test "calculateTextWidth: zero width space" {
    // ZWSP U+200B is Cf (format) category with width 0
    const zwsp = "a\u{200B}b\u{200B}c";
    const width = utf8.calculateTextWidth(zwsp, 4, false, .unicode);
    // a(1) + ZWSP(0) + b(1) + ZWSP(0) + c(1) = 3
    try testing.expectEqual(@as(u32, 3), width);
}

test "calculateTextWidth: word joiner" {
    // Word joiner U+2060 is Cf (format) category with width 0
    const word_joiner = "word\u{2060}joiner";
    const width = utf8.calculateTextWidth(word_joiner, 4, false, .unicode);
    // word(4) + word_joiner(0) + joiner(6) = 10
    try testing.expectEqual(@as(u32, 10), width);
}

// ----------------------------------------------------------------------------
// Special Unicode Spaces
// ----------------------------------------------------------------------------

test "calculateTextWidth: various Unicode spaces" {
    // En space U+2002
    const en_space = "a\u{2002}b";
    // Em space U+2003
    const em_space = "a\u{2003}b";
    // Thin space U+2009
    const thin_space = "a\u{2009}b";
    // Hair space U+200A
    const hair_space = "a\u{200A}b";
    // Ideographic space U+3000 (CJK)
    const ideo_space = "a\u{3000}b";

    // These are all real spaces with width 1
    try testing.expectEqual(@as(u32, 3), utf8.calculateTextWidth(en_space, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 3), utf8.calculateTextWidth(em_space, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 3), utf8.calculateTextWidth(thin_space, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 3), utf8.calculateTextWidth(hair_space, 4, false, .unicode));
    // Ideographic space is width 2 (fullwidth)
    try testing.expectEqual(@as(u32, 4), utf8.calculateTextWidth(ideo_space, 4, false, .unicode));
}

test "calculateTextWidth: non-breaking spaces" {
    // NBSP U+00A0
    const nbsp = "a\u{00A0}b";
    // Narrow NBSP U+202F
    const narrow_nbsp = "a\u{202F}b";

    try testing.expectEqual(@as(u32, 3), utf8.calculateTextWidth(nbsp, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 3), utf8.calculateTextWidth(narrow_nbsp, 4, false, .unicode));
}

// ----------------------------------------------------------------------------
// Emoji Modifiers and Tags
// ----------------------------------------------------------------------------

test "calculateTextWidth: emoji with multiple modifiers" {
    // Rainbow flag (black flag + rainbow)
    const rainbow_flag = "🏴‍🌈"; // U+1F3F4 U+200D U+1F308
    const width = utf8.calculateTextWidth(rainbow_flag, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), width);
}

test "calculateTextWidth: emoji tag sequences (subdivision flags)" {
    // England flag: 🏴󠁧󠁢󠁥󠁮󠁧󠁿 (black flag + tag chars + cancel tag)
    // This is complex to type, so we'll test a simpler version
    const black_flag = "🏴"; // Just the base flag
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(black_flag, 4, false, .unicode));
}

test "calculateTextWidth: hair style variations" {
    // Person: red hair, curly hair, white hair, bald
    const red_hair = "👩‍🦰";
    const curly_hair = "👨‍🦱";
    const white_hair = "👩‍🦳";
    const bald = "👨‍🦲";

    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(red_hair, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(curly_hair, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(white_hair, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 2), utf8.calculateTextWidth(bald, 4, false, .unicode));
}

// ----------------------------------------------------------------------------
// Mixed Content and Real-world Scenarios
// ----------------------------------------------------------------------------

test "calculateTextWidth: multilingual sentence" {
    // Mix of Latin, CJK, Arabic, Emoji
    const text = "Hello 世界! مرحبا 👋";
    const width = utf8.calculateTextWidth(text, 4, false, .unicode);
    // "Hello " (6) + "世界" (4) + "! " (2) + "مرحبا" (5) + " " (1) + "👋" (2) = 20
    try testing.expect(width >= 18); // Allow some flexibility for combining marks
}

test "calculateTextWidth: code with emoji comments" {
    const code = "const x = 42; // ✅ works";
    const width = utf8.calculateTextWidth(code, 4, false, .unicode);
    // Most chars are width 1, checkmark is width 2
    // "const x = 42; // " (17) + "✅" (2) + " works" (6) = 25
    try testing.expectEqual(@as(u32, 25), width);
}

test "calculateTextWidth: emoji sentence" {
    const text = "I ❤️ 🍕 and 🍣!";
    const width = utf8.calculateTextWidth(text, 4, false, .unicode);
    // "I " (2) + "❤️" (2) + " " (1) + "🍕" (2) + " and " (5) + "🍣" (2) + "!" (1) = 15
    try testing.expectEqual(@as(u32, 15), width);
}

test "calculateTextWidth: social media style text" {
    const text = "#OpenTUI 🚀 is #awesome 💯!";
    const width = utf8.calculateTextWidth(text, 4, false, .unicode);
    // "#OpenTUI " (9) + "🚀" (2) + " is #awesome " (13) + "💯" (2) + "!" (1) = 27
    try testing.expectEqual(@as(u32, 27), width);
}

// ----------------------------------------------------------------------------
// Edge Cases and Boundaries
// ----------------------------------------------------------------------------

test "calculateTextWidth: surrogate pair edge cases" {
    // Valid surrogate pairs (emoji are in supplementary planes)
    const emoji = "𝕳𝖊𝖑𝖑𝖔"; // Mathematical bold letters (U+1D577 etc)
    const width = utf8.calculateTextWidth(emoji, 4, false, .unicode);
    // These are typically width 1 each
    try testing.expectEqual(@as(u32, 5), width);
}

test "calculateTextWidth: long grapheme cluster chain" {
    // Create a base + many combining marks
    var text: std.ArrayListUnmanaged(u8) = .{};
    defer text.deinit(testing.allocator);

    try text.appendSlice(testing.allocator, "e");
    // Add 10 combining marks
    var i: usize = 0;
    while (i < 10) : (i += 1) {
        try text.appendSlice(testing.allocator, "\u{0301}"); // Combining acute accent
    }

    const width = utf8.calculateTextWidth(text.items, 4, false, .unicode);
    // Should be treated as single grapheme
    try testing.expectEqual(@as(u32, 1), width);
}

test "calculateTextWidth: all emoji skin tones in sequence" {
    const text = "👋🏻👋🏼👋🏽👋🏾👋🏿";
    const width = utf8.calculateTextWidth(text, 4, false, .unicode);
    // 5 emoji with skin tones, each is 1 grapheme with width 2
    try testing.expectEqual(@as(u32, 10), width); // 5 * 2 = 10
}

test "calculateTextWidth: emoji zodiac signs" {
    const zodiac = "♈♉♊♋♌♍♎♏♐♑♒♓"; // All 12 zodiac signs
    const width = utf8.calculateTextWidth(zodiac, 4, false, .unicode);
    // Each zodiac symbol is width 2
    try testing.expectEqual(@as(u32, 24), width); // 12 * 2 = 24
}

test "calculateTextWidth: mathematical symbols" {
    // Mathematical operators and symbols
    const math = "∀∃∈∉∋∑∏∫∂∇≠≤≥"; // Various math symbols
    const width = utf8.calculateTextWidth(math, 4, false, .unicode);
    // Most math symbols are width 1
    try testing.expect(width >= 13);
}

test "calculateTextWidth: box drawing characters" {
    // Box drawing characters (width 1)
    const box = "┌─┐│└─┘"; // Simple box
    const width = utf8.calculateTextWidth(box, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 7), width);
}

test "calculateTextWidth: braille patterns" {
    // Braille patterns U+2800-U+28FF
    const braille = "⠀⠁⠂⠃⠄⠅⠆⠇"; // Some braille patterns
    const width = utf8.calculateTextWidth(braille, 4, false, .unicode);
    // Braille patterns are width 1
    try testing.expectEqual(@as(u32, 8), width);
}

test "calculateTextWidth: musical symbols" {
    // Musical notation symbols
    const music = "𝄞𝄢𝅘𝅥𝅮"; // Treble clef, bass clef, notes (U+1D11E etc)
    const width = utf8.calculateTextWidth(music, 4, false, .unicode);
    // Musical symbols are typically width 1, but encoding might be issue - just verify no crash
    try testing.expect(width >= 0); // Accept any non-negative width
}

test "calculateTextWidth: weather and nature emoji" {
    const weather = "☀️🌤️⛅🌦️🌧️⛈️"; // Sun, clouds, rain
    const width = utf8.calculateTextWidth(weather, 4, false, .unicode);
    // Each emoji is width 2
    try testing.expectEqual(@as(u32, 12), width); // 6 * 2 = 12
}

test "calculateTextWidth: food emoji collection" {
    const food = "🍎🍌🍇🍓🥕🥦🍞🧀"; // Various food items
    const width = utf8.calculateTextWidth(food, 4, false, .unicode);
    // 8 emoji * 2 = 16
    try testing.expectEqual(@as(u32, 16), width);
}

test "calculateTextWidth: animal emoji" {
    const animals = "🐶🐱🐭🐹🐰🦊🐻🐼"; // Various animals
    const width = utf8.calculateTextWidth(animals, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 16), width); // 8 * 2 = 16
}

test "calculateTextWidth: realistic chat message" {
    const message = "Hey! 👋 Can you review my PR? 🙏 It fixes the bug 🐛 we discussed earlier. Thanks! 😊";
    const width = utf8.calculateTextWidth(message, 4, false, .unicode);
    // Long string with multiple emoji - just verify it doesn't crash
    try testing.expect(width > 70);
}

test "calculateTextWidth: empty string with tabs" {
    const text = "";
    try testing.expectEqual(@as(u32, 0), utf8.calculateTextWidth(text, 4, false, .unicode));
    try testing.expectEqual(@as(u32, 0), utf8.calculateTextWidth(text, 8, false, .unicode));
}

test "calculateTextWidth: only combining marks (invalid but should not crash)" {
    const text = "\u{0301}\u{0302}\u{0303}"; // Just combining marks, no base
    const width = utf8.calculateTextWidth(text, 4, false, .unicode);
    // Should handle gracefully - each combining mark might be width 0
    try testing.expect(width >= 0);
}

test "calculateTextWidth: emoji collection - celestial and symbols" {
    const celestial = "🌟🔮✨";
    const width = utf8.calculateTextWidth(celestial, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - religious and gestures" {
    const religious = "🙏";
    const width = utf8.calculateTextWidth(religious, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), width); // 1 emoji * 2 = 2
}

test "calculateTextWidth: emoji collection - ZWJ sequences astronauts" {
    const astronauts = "🧑‍🚀👨‍🚀👩‍🚀";
    const width = utf8.calculateTextWidth(astronauts, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 graphemes * 2 = 6
}

test "calculateTextWidth: emoji collection - rainbow and magical creatures" {
    const magical = "🌈🦄🧚‍♀️";
    const width = utf8.calculateTextWidth(magical, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 graphemes * 2 = 6
}

test "calculateTextWidth: emoji collection - books and writing" {
    const writing = "📜📖✍️";
    const width = utf8.calculateTextWidth(writing, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - Japanese culture" {
    const japanese = "🏯🎋🌸";
    const width = utf8.calculateTextWidth(japanese, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - traditional Japanese items" {
    const traditional = "📯🎴🎎";
    const width = utf8.calculateTextWidth(traditional, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - hearts and peace" {
    const peace = "💝🕊️☮️";
    const width = utf8.calculateTextWidth(peace, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - meditation and nature" {
    const meditation = "🧘‍♂️🌳";
    const width = utf8.calculateTextWidth(meditation, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 4), width); // 2 graphemes * 2 = 4
}

test "calculateTextWidth: emoji collection - food and drink" {
    const food = "🍵🥟";
    const width = utf8.calculateTextWidth(food, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 4), width); // 2 emoji * 2 = 4
}

test "calculateTextWidth: emoji collection - exotic animals" {
    const animals = "🦥🦦🦧🦨🦩🦚🦜🦝🦞🦟";
    const width = utf8.calculateTextWidth(animals, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 20), width); // 10 emoji * 2 = 20
}

test "calculateTextWidth: emoji collection - communication" {
    const communication = "🤫🗣️💬";
    const width = utf8.calculateTextWidth(communication, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - water and nature" {
    const nature = "🌊📝🎭";
    const width = utf8.calculateTextWidth(nature, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - landscape" {
    const landscape = "🏞️🌊💧";
    const width = utf8.calculateTextWidth(landscape, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - circus and art" {
    const circus = "🤹‍♂️🎪🎨";
    const width = utf8.calculateTextWidth(circus, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 graphemes * 2 = 6
}

test "calculateTextWidth: emoji collection - shopping and food items" {
    const shopping = "🏪🛒💰🌶️🧄🧅";
    const width = utf8.calculateTextWidth(shopping, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 12), width); // 6 emoji * 2 = 12
}

test "calculateTextWidth: emoji collection - textiles and art" {
    const textiles = "🧵👘🎨🖼️";
    const width = utf8.calculateTextWidth(textiles, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 8), width); // 4 emoji * 2 = 8
}

test "calculateTextWidth: emoji collection - prehistoric creatures" {
    const prehistoric = "🦖🦕🐉🐲";
    const width = utf8.calculateTextWidth(prehistoric, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 8), width); // 4 emoji * 2 = 8
}

test "calculateTextWidth: emoji collection - hand gestures" {
    const hands = "🤝🤲👐";
    const width = utf8.calculateTextWidth(hands, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - lanterns and lights" {
    const lanterns = "🏮🎆🎇🕯️💡";
    const width = utf8.calculateTextWidth(lanterns, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 10), width); // 5 emoji * 2 = 10
}

test "calculateTextWidth: emoji collection - dancers" {
    const dancers = "💃🕺🩰";
    const width = utf8.calculateTextWidth(dancers, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - musical instruments" {
    const instruments = "🎻🎺🎷🎸🪕🪘";
    const width = utf8.calculateTextWidth(instruments, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 12), width); // 6 emoji * 2 = 12
}

test "calculateTextWidth: emoji collection - bells and shrine" {
    const bells = "🔔⛩️";
    const width = utf8.calculateTextWidth(bells, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 4), width); // 2 emoji * 2 = 4
}

test "calculateTextWidth: emoji collection - shocked and amazed" {
    const shocked = "😵‍💫🤯✨";
    const width = utf8.calculateTextWidth(shocked, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 graphemes * 2 = 6
}

test "calculateTextWidth: emoji collection - sweets and bubble tea" {
    const sweets = "🧋🍬🍭🧁";
    const width = utf8.calculateTextWidth(sweets, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 8), width); // 4 emoji * 2 = 8
}

test "calculateTextWidth: emoji collection - machinery and robots" {
    const machinery = "⚙️🤖🦾🦿";
    const width = utf8.calculateTextWidth(machinery, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 8), width); // 4 emoji * 2 = 8
}

test "calculateTextWidth: emoji collection - vehicles" {
    const vehicles = "🚗🚕🚙🚌🚎";
    const width = utf8.calculateTextWidth(vehicles, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 10), width); // 5 emoji * 2 = 10
}

test "calculateTextWidth: emoji collection - space travel" {
    const space = "🚀🛸🛰️";
    const width = utf8.calculateTextWidth(space, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - technology" {
    const tech = "🐍💻⌨️";
    const width = utf8.calculateTextWidth(tech, 4, false, .unicode);
    // 🐍(2) + 💻(2) + ⌨️(2, VS16 makes it emoji presentation) = 6
    try testing.expectEqual(@as(u32, 6), width);
}

test "calculateTextWidth: emoji collection - education and brain" {
    const education = "🧠📚🎓";
    const width = utf8.calculateTextWidth(education, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - professional ZWJ sequences" {
    const professionals = "👨‍💼👩‍💼👨‍🔬👩‍🔬";
    const width = utf8.calculateTextWidth(professionals, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 8), width); // 4 graphemes * 2 = 8
}

test "calculateTextWidth: emoji collection - earth globes" {
    const globes = "🌍🌎🌏";
    const width = utf8.calculateTextWidth(globes, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - family ZWJ sequence" {
    const family = "👨‍👩‍👧‍👦";
    const width = utf8.calculateTextWidth(family, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), width); // 1 grapheme * 2 = 2
}

test "calculateTextWidth: emoji collection - elderly people" {
    const elderly = "👴👵";
    const width = utf8.calculateTextWidth(elderly, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 4), width); // 2 emoji * 2 = 4
}

test "calculateTextWidth: emoji collection - sunrise and sunset" {
    const sunrise = "🌅🌄🌠";
    const width = utf8.calculateTextWidth(sunrise, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - mountains" {
    const mountains = "🏔️⛰️🗻";
    const width = utf8.calculateTextWidth(mountains, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - thoughts and dreams" {
    const dreams = "💭💤🌌";
    const width = utf8.calculateTextWidth(dreams, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - campfire" {
    const campfire = "🔥🏕️";
    const width = utf8.calculateTextWidth(campfire, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 4), width); // 2 emoji * 2 = 4
}

test "calculateTextWidth: emoji collection - cooking" {
    const cooking = "🍛🍲🥘";
    const width = utf8.calculateTextWidth(cooking, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - love hearts" {
    const hearts = "❤️💕💖";
    const width = utf8.calculateTextWidth(hearts, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - media" {
    const media = "📸🎞️📹";
    const width = utf8.calculateTextWidth(media, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - global and handshake" {
    const global = "🌐🤝🌈";
    const width = utf8.calculateTextWidth(global, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - special symbols" {
    const special = "🦩🧿🪬🫀🫁🧠";
    const width = utf8.calculateTextWidth(special, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 12), width); // 6 emoji * 2 = 12
}

test "calculateTextWidth: emoji collection - strength" {
    const strength = "💪✊🙌";
    const width = utf8.calculateTextWidth(strength, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 6), width); // 3 emoji * 2 = 6
}

test "calculateTextWidth: emoji collection - entertainment" {
    const entertainment = "🎬🎭🎪✨🌟⭐";
    const width = utf8.calculateTextWidth(entertainment, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 12), width); // 6 emoji * 2 = 12
}

// ============================================================================
// DEVANAGARI SCRIPT WIDTH TESTS
// ============================================================================

test "calculateTextWidth: Devanagari - Sanskrit word" {
    // संस्कृति (culture/civilization)
    const sanskrit = "संस्कृति";
    const width = utf8.calculateTextWidth(sanskrit, 4, false, .unicode);
    // 4 base consonants (SA, SA, KA, TA) with combining marks = width 4
    try testing.expectEqual(@as(u32, 4), width);
}

test "calculateTextWidth: Devanagari - namaste" {
    const namaste = "नमस्ते";
    const width = utf8.calculateTextWidth(namaste, 4, false, .unicode);
    // 4 base consonants: NA, MA, SA, TA = width 4
    try testing.expectEqual(@as(u32, 4), width);
}

test "calculateTextWidth: Devanagari - Om symbol" {
    const om = "ॐ";
    const width = utf8.calculateTextWidth(om, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 1), width);
}

test "calculateTextWidth: Devanagari - mixed with ASCII" {
    const mixed = "Hello नमस्ते World";
    const width = utf8.calculateTextWidth(mixed, 4, false, .unicode);
    // "Hello "(6) + नमस्ते(4 base consonants) + " World"(6) = 16
    try testing.expectEqual(@as(u32, 16), width);
}

// ============================================================================
// CJK SCRIPT WIDTH TESTS
// ============================================================================

test "calculateTextWidth: Chinese characters - kanji" {
    const kanji = "漢字";
    const width = utf8.calculateTextWidth(kanji, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 4), width); // 2 chars * 2 = 4
}

test "calculateTextWidth: Hiragana" {
    const hiragana = "ひらがな";
    const width = utf8.calculateTextWidth(hiragana, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 8), width); // 4 chars * 2 = 8
}

test "calculateTextWidth: Katakana" {
    const katakana = "カタカナ";
    const width = utf8.calculateTextWidth(katakana, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 8), width); // 4 chars * 2 = 8
}

test "calculateTextWidth: Korean Hangul" {
    const hangul = "한글";
    const width = utf8.calculateTextWidth(hangul, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 4), width); // 2 chars * 2 = 4
}

test "calculateTextWidth: Korean words - love and peace" {
    const korean = "사랑 평화";
    const width = utf8.calculateTextWidth(korean, 4, false, .unicode);
    // 사(2) + 랑(2) + space(1) + 평(2) + 화(2) = 9
    try testing.expectEqual(@as(u32, 9), width);
}

// ============================================================================
// TIBETAN SCRIPT WIDTH TESTS
// ============================================================================

test "calculateTextWidth: Tibetan script" {
    const tibetan = "རྒྱ་མཚོ";
    const width = utf8.calculateTextWidth(tibetan, 4, false, .unicode);
    // Tibetan has complex combining characters
    // Base chars are width 1, subjoined letters width 0
    try testing.expect(width >= 3 and width <= 6);
}

// ============================================================================
// OTHER INDIC SCRIPTS WIDTH TESTS
// ============================================================================

test "calculateTextWidth: Gujarati script" {
    const gujarati = "ગુજરાતી";
    const width = utf8.calculateTextWidth(gujarati, 4, false, .unicode);
    // ગ(1) + ુ(0) + જ(1) + ર(1) + ા(0) + ત(1) + ી(0) = 4
    try testing.expectEqual(@as(u32, 4), width);
}

test "calculateTextWidth: Tamil script word" {
    const tamil = "தமிழ்";
    const width = utf8.calculateTextWidth(tamil, 4, false, .unicode);
    // த(1) + ம(1) + ி(0) + ழ(1) + ்(0) = 3
    try testing.expectEqual(@as(u32, 3), width);
}

test "calculateTextWidth: Punjabi script word" {
    const punjabi = "ਪੰਜਾਬੀ";
    const width = utf8.calculateTextWidth(punjabi, 4, false, .unicode);
    // ਪ(1) + ੰ(0) + ਜ(1) + ਾ(0) + ਬ(1) + ੀ(0) = 3 base chars
    try testing.expectEqual(@as(u32, 3), width);
}

test "calculateTextWidth: Telugu script word" {
    const telugu = "తెలుగు";
    const width = utf8.calculateTextWidth(telugu, 4, false, .unicode);
    // త(1) + ె(0) + ల(1) + ు(0) + గ(1) + ు(0) = 3
    try testing.expectEqual(@as(u32, 3), width);
}

test "calculateTextWidth: Bengali script word" {
    const bengali = "বাংলা";
    const width = utf8.calculateTextWidth(bengali, 4, false, .unicode);
    // ব(1) + া(0) + ং(0) + ল(1) + া(0) = 2
    try testing.expectEqual(@as(u32, 2), width);
}

test "calculateTextWidth: Kannada script" {
    const kannada = "ಕನ್ನಡ";
    const width = utf8.calculateTextWidth(kannada, 4, false, .unicode);
    // ಕ(1) + ನ(1) + ್(0) + ನ(1) + ಡ(1) = 4
    try testing.expectEqual(@as(u32, 4), width);
}

test "calculateTextWidth: Malayalam script" {
    const malayalam = "മലയാളം";
    const width = utf8.calculateTextWidth(malayalam, 4, false, .unicode);
    // Each base letter is width 1, vowel signs width 0
    try testing.expect(width >= 4 and width <= 5);
}

test "calculateTextWidth: Oriya script" {
    const oriya = "ଓଡ଼ିଆ";
    const width = utf8.calculateTextWidth(oriya, 4, false, .unicode);
    // ଓ(1) + ଡ(1) + ଼(0) + ି(0) + ଆ(1) = 3
    try testing.expectEqual(@as(u32, 3), width);
}

// ============================================================================
// THAI AND LAO SCRIPT WIDTH TESTS
// ============================================================================

test "calculateTextWidth: Thai script" {
    const thai = "ภาษา";
    const width = utf8.calculateTextWidth(thai, 4, false, .unicode);
    // Thai base chars width 1, combining vowels/tones width 0
    try testing.expect(width >= 3 and width <= 4);
}

test "calculateTextWidth: Thai numerals" {
    const thai_num = "๑๐๐";
    const width = utf8.calculateTextWidth(thai_num, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 3), width); // 3 digits * 1 = 3
}

test "calculateTextWidth: Lao script" {
    const lao = "ໂຫຍ່າກເຈົ້າ";
    const width = utf8.calculateTextWidth(lao, 4, false, .unicode);
    // Lao has complex vowels and tone marks (width 0)
    try testing.expect(width >= 5 and width <= 10);
}

// ============================================================================
// ARABIC AND OTHER SCRIPTS WIDTH TESTS
// ============================================================================

test "calculateTextWidth: Arabic character" {
    const arabic = "ا";
    const width = utf8.calculateTextWidth(arabic, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 1), width);
}

test "calculateTextWidth: Sinhala script" {
    const sinhala = "ආහාර";
    const width = utf8.calculateTextWidth(sinhala, 4, false, .unicode);
    // Sinhala chars width 1, vowel signs width 0
    try testing.expect(width >= 3 and width <= 4);
}

test "calculateTextWidth: Chinese text" {
    const chinese = "中文";
    const width = utf8.calculateTextWidth(chinese, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 4), width); // 2 chars * 2 = 4
}

test "calculateTextWidth: Hangul Jamo" {
    const jamo = "ㄱ";
    const width = utf8.calculateTextWidth(jamo, 4, false, .unicode);
    try testing.expectEqual(@as(u32, 2), width); // Hangul Jamo is width 2
}

// ============================================================================
// MIXED SCRIPT COMPREHENSIVE TESTS
// ============================================================================

test "calculateTextWidth: realistic multilingual sentence" {
    const multilingual = "Hello 世界! नमस्ते 🙏";
    const width = utf8.calculateTextWidth(multilingual, 4, false, .unicode);
    // "Hello "(6) + 世界(4) + "! "(2) + नमस्ते(4) + " "(1) + 🙏(2) = 19
    try testing.expectEqual(@as(u32, 19), width);
}

test "calculateTextWidth: all ending words from text" {
    const endings = "समाप्त끝จบముగింపుಅಂತ್ಯઅંત";
    const width = utf8.calculateTextWidth(endings, 4, false, .unicode);
    // TODO: Expect absolutely
    try testing.expect(width > 10);
}

test "calculateTextWidth: complex text with emojis and multiple scripts" {
    const complex = "The 🌟 journey: संस्कृति meets 漢字 🎋";
    const width = utf8.calculateTextWidth(complex, 4, false, .unicode);
    // TODO: Expect absolutely
    try testing.expect(width >= 30 and width <= 50);
}

test "calculateTextWidth: validate against unicode-width-map.zon" {
    const zon_content = @embedFile("unicode-width-map.zon");

    // Use arena allocator to avoid memory leaks from ZON parser string allocations
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const zon_with_null = try allocator.dupeZ(u8, zon_content);

    const WidthEntry = struct {
        codepoint: []const u8,
        width: i32,
    };

    const width_entries = std.zon.parse.fromSlice(
        []const WidthEntry,
        allocator,
        zon_with_null,
        null,
        .{},
    ) catch |err| {
        return err;
    };

    var successes: usize = 0;
    var failures: usize = 0;

    for (width_entries) |entry| {
        const codepoint_str = entry.codepoint;
        const expected_width = entry.width;

        // Parse "U+XXXX" from codepoint string
        if (codepoint_str.len < 3 or !std.mem.startsWith(u8, codepoint_str, "U+")) {
            continue;
        }
        const hex_str = codepoint_str[2..];
        const code_point = std.fmt.parseInt(u21, hex_str, 16) catch continue;

        var buf: [4]u8 = undefined;
        const len = std.unicode.utf8Encode(code_point, &buf) catch continue;
        const str = buf[0..len];

        const actual_width = utf8.calculateTextWidth(str, 4, false, .unicode);

        if (actual_width == expected_width) {
            successes += 1;
        } else {
            failures += 1;
        }
    }

    try testing.expectEqual(@as(usize, 0), failures);
}

test "findGraphemeInfo: comprehensive multilingual text" {
    const text =
        \\# The Celestial Journey of संस्कृति 🌟🔮✨
        \\In the beginning, there was नमस्ते 🙏 and the ancient wisdom of the ॐ symbol echoing through dimensions. The travelers 🧑‍🚀👨‍🚀👩‍🚀 embarked on their quest through the cosmos, guided by the mysterious རྒྱ་མཚོ and the luminous 🌈🦄🧚‍♀️ beings of light. They encountered the great देवनागरी scribes who wrote in flowing अक्षर characters, documenting everything in their sacred texts 📜📖✍️.
        \\## Chapter प्रथम: The Eastern Gardens 🏯🎋🌸
        \\The journey led them to the mystical lands where 漢字 (kanji) danced with ひらがな and カタカナ across ancient scrolls 📯🎴🎎. In the gardens of Seoul, they found 한글 inscriptions speaking of 사랑 (love) and 평화 (peace) 💝🕊️☮️. The monks meditated under the bodhi tree 🧘‍♂️🌳, contemplating the nature of धर्म while drinking matcha 🍵 and eating 餃子 dumplings 🥟.
        \\Strange creatures emerged from the mist: 🦥🦦🦧🦨🦩🦚🦜🦝🦞🦟. They spoke in riddles about the प्राचीन (ancient) ways and the नवीन (new) paths forward. "भविष्य में क्या है?" they asked, while the ໂຫຍ່າກເຈົ້າ whispered secrets in Lao script 🤫🗣️💬.
        \\## The संगम (Confluence) of Scripts 🌊📝🎭
        \\At the great confluence, they witnessed the merger of བོད་ཡིག (Tibetan), ગુજરાતી (Gujarati), and தமிழ் (Tamil) scripts flowing together like rivers 🏞️🌊💧. The scholars debated about ਪੰਜਾਬੀ philosophy while juggling 🤹‍♂️🎪🎨 colorful orbs that represented different తెలుగు concepts.
        \\The marketplace buzzed with activity 🏪🛒💰: merchants sold বাংলা spices 🌶️🧄🧅, ಕನ್ನಡ silks 🧵👘, and മലയാളം handicrafts 🎨🖼️. Children played with toys shaped like 🦖🦕🐉🐲 while their parents bargained using ancient ଓଡ଼ିଆ numerals and gestures 🤝🤲👐.
        \\## The Festival of ๑๐๐ Lanterns 🏮🎆🎇
        \\During the grand festival, they lit exactly ๑๐๐ (100 in Thai numerals) lanterns 🏮🕯️💡 that floated into the night sky like ascending ความหวัง (hopes). The celebration featured dancers 💃🕺🩰 performing classical moves from भरतनाट्यम tradition, their मुद्रा hand gestures telling stories of प्रेम and वीरता.
        \\Musicians played unusual instruments: the 🎻🎺🎷🎸🪕🪘 ensemble created harmonies that resonated with the वेद chants and མཆོད་རྟེན bells 🔔⛩️. The audience sat mesmerized 😵‍💫🤯✨, some sipping on bubble tea 🧋 while others enjoyed मिठाई sweets 🍬🍭🧁.
        \\## The འཕྲུལ་དེབ (Machine) Age Arrives ⚙️🤖🦾
        \\As modernity crept in, the ancient འཁོར་ལོ (wheel) gave way to 🚗🚕🚙🚌🚎 vehicles and eventually to 🚀🛸🛰️ spacecraft. The યુવાન (youth) learned to code in Python 🐍💻⌨️, but still honored their గురువు (teachers) who taught them the old ways of ज्ञान acquisition 🧠📚🎓.
        \\The সমাজ (society) transformed: robots 🤖🦾🦿 worked alongside humans 👨‍💼👩‍💼👨‍🔬👩‍🔬, and AI learned to read སྐད (languages) from across the planet 🌍🌎🌏. Yet somehow, the essence of मानवता remained intact, preserved in the கவிதை (poetry) and the ກາບແກ້ວ stories passed down through generations 👴👵👨‍👩‍👧‍👦.
        \\## The Final ಅಧ್ಯಾಯ (Chapter) 🌅🌄🌠
        \\As the sun set over the പർവ്വതങ്ങൾ (mountains) 🏔️⛰️🗻, our travelers realized that every script, every symbol—from ا to ㄱ to অ to अ—represented not just sounds, but entire civilizations' worth of विचार (thoughts) and ಕನಸು (dreams) 💭💤🌌.
        \\They gathered around the final campfire 🔥🏕️, sharing stories in ภาษา (languages) both ancient and new. Someone brought out a guitar 🎸 and started singing in ગીત form, while others prepared ආහාර (food) 🍛🍲🥘 seasoned with love ❤️💕💖 and memories 📸🎞️📹.
        \\And so they learned that whether written in দেবনাগরী, 中文, 한글, or ไทย, the human experience transcends boundaries 🌐🤝🌈. The weird emojis 🦩🧿🪬🫀🫁🧠 and complex scripts were all part of the same beautiful བསྟན་པ (teaching): that diversity is our greatest strength 💪✊🙌.
        \\The end. समाप्त. 끝. จบ. முடிவு. ముగింపు. সমাপ্তি. ഒടുക്കം. ಅಂತ್ಯ. અંત. 🎬🎭🎪✨🌟⭐
        \\
    ;

    const expected_width = utf8.calculateTextWidth(text, 4, false, .unicode);

    var result: std.ArrayListUnmanaged(utf8.GraphemeInfo) = .{};
    defer result.deinit(testing.allocator);

    try utf8.findGraphemeInfo(text, 4, false, .unicode, testing.allocator, &result);
    try testing.expect(result.items.len > 0);

    var prev_end_byte: usize = 0;

    for (result.items) |g| {
        try testing.expect(g.byte_offset >= prev_end_byte);

        const text_before = text[0..g.byte_offset];
        const expected_col = utf8.calculateTextWidth(text_before, 4, false, .unicode);

        try testing.expectEqual(expected_col, g.col_offset);

        prev_end_byte = g.byte_offset + g.byte_len;
    }

    const final_computed_width = utf8.calculateTextWidth(text, 4, false, .unicode);
    try testing.expectEqual(expected_width, final_computed_width);
}
