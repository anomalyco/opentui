const std = @import("std");
const buffer_mod = @import("../buffer.zig");
const buffer_effects = @import("../buffer-methods.zig");
const ansi = @import("../ansi.zig");
const gp = @import("../grapheme.zig");

const OptimizedBuffer = buffer_mod.OptimizedBuffer;
const RGBA = buffer_mod.RGBA;
const ColorTarget = buffer_effects.ColorTarget;

fn expectRGBAApprox(expected: RGBA, actual: RGBA, epsilon: f32) !void {
    const diff_r = @abs(ansi.redF(expected) - ansi.redF(actual));
    const diff_g = @abs(ansi.greenF(expected) - ansi.greenF(actual));
    const diff_b = @abs(ansi.blueF(expected) - ansi.blueF(actual));
    const diff_a = @abs(ansi.alphaF(expected) - ansi.alphaF(actual));
    const tolerance = epsilon + (1.0 / 255.0);

    if (diff_r > tolerance or diff_g > tolerance or diff_b > tolerance or diff_a > tolerance) {
        std.debug.print("RGBA mismatch: expected {any}, got {any}\n", .{ expected, actual });
        return error.TestExpectedApprox;
    }
}

fn expectVec4fApprox(expected: @Vector(4, f32), actual: @Vector(4, f32), epsilon: f32) !void {
    const diff = @abs(expected - actual);
    if (@reduce(.Or, diff > @as(@Vector(4, f32), @splat(epsilon)))) {
        std.debug.print("Vec4 mismatch: expected {any}, got {any}\n", .{ expected, actual });
        return error.TestExpectedApprox;
    }
}

// Identity matrix (no change)
const IDENTITY_MATRIX = [16]f32{
    1.0, 0.0, 0.0, 0.0, // Red output
    0.0, 1.0, 0.0, 0.0, // Green output
    0.0, 0.0, 1.0, 0.0, // Blue output
    0.0, 0.0, 0.0, 1.0, // Alpha output
};

// Sepia matrix
const SEPIA_MATRIX = [16]f32{
    0.393, 0.769, 0.189, 0.0, // Red output
    0.349, 0.686, 0.168, 0.0, // Green output
    0.272, 0.534, 0.131, 0.0, // Blue output
    0.0, 0.0, 0.0, 1.0, // Alpha output
};

// Grayscale matrix (luminance)
const GRAYSCALE_MATRIX = [16]f32{
    0.299, 0.587, 0.114, 0.0, // Red output
    0.299, 0.587, 0.114, 0.0, // Green output
    0.299, 0.587, 0.114, 0.0, // Blue output
    0.0, 0.0, 0.0, 1.0, // Alpha output
};

// Invert matrix
const INVERT_MATRIX = [16]f32{
    -1.0, 0.0, 0.0, 0.0, // Red output
    0.0, -1.0, 0.0, 0.0, // Green output
    0.0, 0.0, -1.0, 0.0, // Blue output
    0.0, 0.0, 0.0, 1.0, // Alpha output
};

test "colorMatrix - identity matrix leaves colors unchanged" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        4,
        4,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = red; // (0, 0)
    buf.buffer.fg[5] = red; // (1, 1)

    // Apply identity to specific cells: (0, 0) and (1, 1) with strength 1.0
    // cellMask format: [x, y, strength, x, y, strength, ...]
    const cell_mask = [_]f32{ 0.0, 0.0, 1.0, 1.0, 1.0, 1.0 };
    buffer_effects.colorMatrix(buf, &IDENTITY_MATRIX, &cell_mask, 1.0, ColorTarget.FG); // target=1 (FG)

    // Colors should be unchanged
    try expectRGBAApprox(red, buf.buffer.fg[0], 0.0001);
    try expectRGBAApprox(red, buf.buffer.fg[5], 0.0001);
}

test "colorMatrix - applies transformation to specified cells only" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        3,
        3,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);

    // Set all FG to red
    @memset(buf.buffer.fg, red);

    // Apply sepia only to cell (1, 1) with full strength
    const cell_mask = [_]f32{ 1.0, 1.0, 1.0 };
    buffer_effects.colorMatrix(buf, &SEPIA_MATRIX, &cell_mask, 1.0, ColorTarget.FG);

    // Cell (1, 1) should be transformed (index = y * width + x = 1 * 3 + 1 = 4)
    const expected_r = 0.393;
    const expected_g = 0.349;
    const expected_b = 0.272;
    try expectRGBAApprox(ansi.rgbaFromFloats(expected_r, expected_g, expected_b, 1.0), buf.buffer.fg[4], 0.001);

    // Other cells should remain red
    try expectRGBAApprox(red, buf.buffer.fg[0], 0.0001); // (0, 0)
    try expectRGBAApprox(red, buf.buffer.fg[8], 0.0001); // (2, 2)
}

test "colorMatrix - globalStrength scales individual cell strengths" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = red;

    // Apply sepia with cell strength 1.0 but globalStrength 0.5
    const cell_mask = [_]f32{ 0.0, 0.0, 1.0 };
    buffer_effects.colorMatrix(buf, &SEPIA_MATRIX, &cell_mask, 0.5, ColorTarget.FG);

    // Expected: blend(original, sepia, 0.5)
    const sepia_r = 0.393;
    const expected_r = 1.0 + (sepia_r - 1.0) * 0.5;
    const sepia_g = 0.349;
    const expected_g = 0.0 + (sepia_g - 0.0) * 0.5;
    const sepia_b = 0.272;
    const expected_b = 0.0 + (sepia_b - 0.0) * 0.5;

    try expectRGBAApprox(ansi.rgbaFromFloats(expected_r, expected_g, expected_b, 1.0), buf.buffer.fg[0], 0.001);
}

test "colorMatrix - respects target parameter" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const blue = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = red;
    buf.buffer.bg[0] = blue;
    buf.buffer.fg[1] = red;
    buf.buffer.bg[1] = blue;

    // Apply to FG only (target = 1)
    const cell_mask = [_]f32{ 0.0, 0.0, 1.0 };
    buffer_effects.colorMatrix(buf, &GRAYSCALE_MATRIX, &cell_mask, 1.0, ColorTarget.FG);

    // FG should be grayscale, BG should remain blue
    const gray_red = 0.299 * 1.0;
    try expectRGBAApprox(ansi.rgbaFromFloats(gray_red, gray_red, gray_red, 1.0), buf.buffer.fg[0], 0.001);
    try expectRGBAApprox(blue, buf.buffer.bg[0], 0.0001);

    // Reset for BG test
    buf.buffer.fg[0] = red;
    buf.buffer.bg[0] = blue;
    buf.buffer.fg[1] = red;
    buf.buffer.bg[1] = blue;

    buffer_effects.colorMatrix(buf, &GRAYSCALE_MATRIX, &cell_mask, 1.0, ColorTarget.BG); // target=2 (BG)

    // BG should be grayscale, FG should remain red
    const gray_blue = 0.114 * 1.0;
    try expectRGBAApprox(red, buf.buffer.fg[0], 0.0001);
    try expectRGBAApprox(ansi.rgbaFromFloats(gray_blue, gray_blue, gray_blue, 1.0), buf.buffer.bg[0], 0.001);
}

test "colorMatrix - skips out-of-bounds coordinates" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        3,
        3,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[4] = red; // (1, 1)

    // Apply to out-of-bounds and valid cell
    const cell_mask = [_]f32{ 10.0, 10.0, 1.0, 1.0, 1.0, 1.0 }; // (10, 10) is OOB
    buffer_effects.colorMatrix(buf, &SEPIA_MATRIX, &cell_mask, 1.0, ColorTarget.FG);

    // Valid cell should be transformed
    const expected_r = 0.393;
    const expected_g = 0.349;
    const expected_b = 0.272;
    try expectRGBAApprox(ansi.rgbaFromFloats(expected_r, expected_g, expected_b, 1.0), buf.buffer.fg[4], 0.001);
}

test "colorMatrix - skips NaN and Inf coordinates" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        3,
        3,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[4] = red; // (1, 1)

    // Apply with NaN and valid coordinates
    const nan = std.math.nan(f32);
    const cell_mask = [_]f32{ nan, 1.0, 1.0, 1.0, 1.0, 1.0 };
    buffer_effects.colorMatrix(buf, &SEPIA_MATRIX, &cell_mask, 1.0, ColorTarget.FG);

    // Valid cell should be transformed
    const expected_r = 0.393;
    const expected_g = 0.349;
    const expected_b = 0.272;
    try expectRGBAApprox(ansi.rgbaFromFloats(expected_r, expected_g, expected_b, 1.0), buf.buffer.fg[4], 0.001);
}

test "colorMatrix - skips zero strength cells" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = red;

    // Apply with zero strength
    const cell_mask = [_]f32{ 0.0, 0.0, 0.0 };
    buffer_effects.colorMatrix(buf, &SEPIA_MATRIX, &cell_mask, 1.0, ColorTarget.FG);

    // Color should be unchanged
    try expectRGBAApprox(red, buf.buffer.fg[0], 0.0001);
}

test "colorMatrix - handles multiple cells in mask" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        4,
        4,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const green = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);
    const blue = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0);
    const white = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);

    buf.clear(bg, null);

    // Set different colors at different positions
    buf.buffer.fg[0] = red; // (0, 0)
    buf.buffer.fg[5] = green; // (1, 1)
    buf.buffer.fg[10] = blue; // (2, 2)
    buf.buffer.fg[15] = white; // (3, 3)

    // Apply sepia to all four cells with varying strengths
    const cell_mask = [_]f32{
        0.0, 0.0, 1.0, // (0, 0) - full
        1.0, 1.0, 0.5, // (1, 1) - half
        2.0, 2.0, 0.0, // (2, 2) - none (skipped)
        3.0, 3.0, 1.0, // (3, 3) - full
    };
    buffer_effects.colorMatrix(buf, &SEPIA_MATRIX, &cell_mask, 1.0, ColorTarget.FG);

    // (0, 0) should be fully sepia
    const sepia_r = 0.393;
    const sepia_g = 0.349;
    const sepia_b = 0.272;
    try expectRGBAApprox(ansi.rgbaFromFloats(sepia_r, sepia_g, sepia_b, 1.0), buf.buffer.fg[0], 0.001);

    // (1, 1) should be half sepia
    const green_sepia_r = 0.0 + (0.769 - 0.0) * 0.5; // Matrix row 0, col 1 = 0.769
    const green_sepia_g = 1.0 + (0.686 - 1.0) * 0.5;
    const green_sepia_b = 0.0 + (0.534 - 0.0) * 0.5;
    try expectRGBAApprox(ansi.rgbaFromFloats(green_sepia_r, green_sepia_g, green_sepia_b, 1.0), buf.buffer.fg[5], 0.001);

    // (2, 2) should be unchanged (zero strength)
    try expectRGBAApprox(blue, buf.buffer.fg[10], 0.0001);

    // (3, 3) should be fully sepia of white
    // White * sepia matrix = sum of first 3 columns of each row
    const white_sepia_r = 0.393 + 0.769 + 0.189; // ~1.351
    const white_sepia_g = 0.349 + 0.686 + 0.168; // ~1.203
    const white_sepia_b = 0.272 + 0.534 + 0.131; // ~0.937
    try expectRGBAApprox(ansi.rgbaFromFloats(white_sepia_r, white_sepia_g, white_sepia_b, 1.0), buf.buffer.fg[15], 0.001);
}

test "colorMatrix - truncates incomplete mask triplets" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        3,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = red;
    buf.buffer.fg[1] = red;

    // Mask with 5 elements (1 complete triplet + 2 incomplete)
    const cell_mask = [_]f32{ 0.0, 0.0, 1.0, 1.0, 1.0 };
    buffer_effects.colorMatrix(buf, &SEPIA_MATRIX, &cell_mask, 1.0, ColorTarget.FG);

    // Only first cell should be transformed
    const sepia_r = 0.393;
    const sepia_g = 0.349;
    const sepia_b = 0.272;
    try expectRGBAApprox(ansi.rgbaFromFloats(sepia_r, sepia_g, sepia_b, 1.0), buf.buffer.fg[0], 0.001);

    // Second cell should be unchanged (incomplete triplet ignored)
    try expectRGBAApprox(red, buf.buffer.fg[1], 0.0001);
}

test "colorMatrix - empty mask returns early" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = red;

    // Empty mask - should return early
    const empty_mask: [0]f32 = .{};
    buffer_effects.colorMatrix(buf, &SEPIA_MATRIX, &empty_mask, 1.0, ColorTarget.FG);

    // Color should be unchanged
    try expectRGBAApprox(red, buf.buffer.fg[0], 0.0001);
}

test "colorMatrix - empty matrix returns early" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = red;

    // Empty matrix - should return early
    const empty_matrix: [0]f32 = .{};
    const cell_mask = [_]f32{ 0.0, 0.0, 1.0 };
    buffer_effects.colorMatrix(buf, &empty_matrix, &cell_mask, 1.0, ColorTarget.FG);

    // Color should be unchanged
    try expectRGBAApprox(red, buf.buffer.fg[0], 0.0001);
}

// Test matrix that modifies alpha channel
const ALPHA_MODIFY_MATRIX = [16]f32{
    1.0, 0.0, 0.0, 0.0, // Red output
    0.0, 1.0, 0.0, 0.0, // Green output
    0.0, 0.0, 1.0, 0.0, // Blue output
    0.0, 0.0, 0.0, 0.5, // Alpha output (multiply by 0.5)
};

test "colorMatrix - alpha channel transformation" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const opaque_color = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = opaque_color;

    // Apply matrix that halves alpha
    const cell_mask = [_]f32{ 0.0, 0.0, 1.0 };
    buffer_effects.colorMatrix(buf, &ALPHA_MODIFY_MATRIX, &cell_mask, 1.0, ColorTarget.FG);

    // Alpha should be halved
    try expectRGBAApprox(ansi.rgbaFromFloats(1.0, 0.0, 0.0, 0.5), buf.buffer.fg[0], 0.0001);
}

test "colorMatrix - mask with only 1 element" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = red;

    // Mask with only 1 element (incomplete triplet)
    const cell_mask = [_]f32{0.0};
    buffer_effects.colorMatrix(buf, &SEPIA_MATRIX, &cell_mask, 1.0, ColorTarget.FG);

    // Color should be unchanged (no complete triplets to process)
    try expectRGBAApprox(red, buf.buffer.fg[0], 0.0001);
}

test "colorMatrix - mask with only 2 elements" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = red;
    buf.buffer.fg[1] = red;

    // Mask with only 2 elements (incomplete triplet)
    const cell_mask = [_]f32{ 0.0, 0.0 };
    buffer_effects.colorMatrix(buf, &SEPIA_MATRIX, &cell_mask, 1.0, ColorTarget.FG);

    // Colors should be unchanged (no complete triplets to process)
    try expectRGBAApprox(red, buf.buffer.fg[0], 0.0001);
    try expectRGBAApprox(red, buf.buffer.fg[1], 0.0001);
}

test "colorMatrix - infinity strength is skipped" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = red;

    // Apply with infinity strength (should be skipped)
    const inf = std.math.inf(f32);
    const cell_mask = [_]f32{ 0.0, 0.0, inf };
    buffer_effects.colorMatrix(buf, &SEPIA_MATRIX, &cell_mask, 1.0, ColorTarget.FG);

    // Color should be unchanged
    try expectRGBAApprox(red, buf.buffer.fg[0], 0.0001);
}

test "colorMatrix - non-finite global strength is skipped" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = red;

    const inf = std.math.inf(f32);
    const cell_mask = [_]f32{ 0.0, 0.0, 1.0 };
    buffer_effects.colorMatrix(buf, &SEPIA_MATRIX, &cell_mask, inf, ColorTarget.FG);

    // Color should be unchanged
    try expectRGBAApprox(red, buf.buffer.fg[0], 0.0001);
}

test "colorMatrix - large buffer with SIMD and scalar mix" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    // 100 pixels = 25 SIMD batches of 4
    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        100,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);

    // Set all to red
    @memset(buf.buffer.fg, red);

    // Apply sepia at full strength
    buffer_effects.colorMatrixUniform(buf, &SEPIA_MATRIX, 1.0, ColorTarget.FG);

    // All pixels should be transformed
    const expected_r = 0.393;
    const expected_g = 0.349;
    const expected_b = 0.272;

    for (0..100) |i| {
        try expectRGBAApprox(ansi.rgbaFromFloats(expected_r, expected_g, expected_b, 1.0), buf.buffer.fg[i], 0.001);
    }
}

test "colorMatrix - negative coordinates are skipped" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        3,
        3,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[4] = red; // (1, 1)

    // Apply with negative coordinates followed by valid
    const cell_mask = [_]f32{ -1.0, -1.0, 1.0, 1.0, 1.0, 1.0 };
    buffer_effects.colorMatrix(buf, &SEPIA_MATRIX, &cell_mask, 1.0, ColorTarget.FG);

    // Valid cell should be transformed
    const expected_r = 0.393;
    const expected_g = 0.349;
    const expected_b = 0.272;
    try expectRGBAApprox(ansi.rgbaFromFloats(expected_r, expected_g, expected_b, 1.0), buf.buffer.fg[4], 0.001);
}

test "colorMatrix - finite coordinates larger than u32 max are skipped" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        3,
        3,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[4] = red; // (1, 1)

    // First triplet uses finite but out-of-range coordinates for u32 conversion.
    // Second triplet is valid and should still be processed.
    const huge = std.math.floatMax(f32);
    const cell_mask = [_]f32{ huge, huge, 1.0, 1.0, 1.0, 1.0 };
    buffer_effects.colorMatrix(buf, &SEPIA_MATRIX, &cell_mask, 1.0, ColorTarget.FG);

    const expected_r = 0.393;
    const expected_g = 0.349;
    const expected_b = 0.272;
    try expectRGBAApprox(ansi.rgbaFromFloats(expected_r, expected_g, expected_b, 1.0), buf.buffer.fg[4], 0.001);
}

// ==================== colorMatrixUniform Tests ====================

test "colorMatrixUniform - identity matrix leaves colors unchanged" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        4,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const green = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);
    const blue = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0);
    const white = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);

    buf.clear(bg, null);

    // Set specific colors at different positions
    buf.buffer.fg[0] = red;
    buf.buffer.fg[1] = green;
    buf.buffer.fg[2] = blue;
    buf.buffer.fg[3] = white;

    // Apply identity matrix at full strength to foreground
    buffer_effects.colorMatrixUniform(buf, &IDENTITY_MATRIX, 1.0, ColorTarget.FG);

    // Colors should be unchanged
    try expectRGBAApprox(red, buf.buffer.fg[0], 0.0001);
    try expectRGBAApprox(green, buf.buffer.fg[1], 0.0001);
    try expectRGBAApprox(blue, buf.buffer.fg[2], 0.0001);
    try expectRGBAApprox(white, buf.buffer.fg[3], 0.0001);
}

test "colorMatrixUniform - zero strength has no effect" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        2,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);

    @memset(buf.buffer.fg, red);

    // Apply sepia matrix with zero strength
    buffer_effects.colorMatrixUniform(buf, &SEPIA_MATRIX, 0.0, ColorTarget.FG);

    // Colors should be unchanged
    try expectRGBAApprox(red, buf.buffer.fg[0], 0.0001);
    try expectRGBAApprox(red, buf.buffer.fg[3], 0.0001);
}

test "colorMatrixUniform - non-finite strength has no effect" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = red;
    buf.buffer.fg[1] = red;

    const nan = std.math.nan(f32);
    buffer_effects.colorMatrixUniform(buf, &SEPIA_MATRIX, nan, ColorTarget.FG);

    try expectRGBAApprox(red, buf.buffer.fg[0], 0.0001);
    try expectRGBAApprox(red, buf.buffer.fg[1], 0.0001);
}

test "colorMatrixUniform - grayscale transformation" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        3,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const green = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);
    const blue = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0);

    buf.clear(bg, null);

    buf.buffer.fg[0] = red;
    buf.buffer.fg[1] = green;
    buf.buffer.fg[2] = blue;

    // Apply grayscale matrix at full strength to foreground
    buffer_effects.colorMatrixUniform(buf, &GRAYSCALE_MATRIX, 1.0, ColorTarget.FG);

    // Calculate expected grayscale values
    // Luminance = 0.299*R + 0.587*G + 0.114*B
    const gray_red = 0.299 * 1.0 + 0.587 * 0.0 + 0.114 * 0.0; // ~0.299
    const gray_green = 0.299 * 0.0 + 0.587 * 1.0 + 0.114 * 0.0; // ~0.587
    const gray_blue = 0.299 * 0.0 + 0.587 * 0.0 + 0.114 * 1.0; // ~0.114

    // All channels should equal the luminance value
    try expectRGBAApprox(ansi.rgbaFromFloats(gray_red, gray_red, gray_red, 1.0), buf.buffer.fg[0], 0.001);
    try expectRGBAApprox(ansi.rgbaFromFloats(gray_green, gray_green, gray_green, 1.0), buf.buffer.fg[1], 0.001);
    try expectRGBAApprox(ansi.rgbaFromFloats(gray_blue, gray_blue, gray_blue, 1.0), buf.buffer.fg[2], 0.001);
}

test "colorMatrixUniform - partial strength blends with original" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = red;
    buf.buffer.fg[1] = red;

    // Apply sepia at 50% strength
    buffer_effects.colorMatrixUniform(buf, &SEPIA_MATRIX, 0.5, ColorTarget.FG);

    // Expected: blend(original, sepia_result, 0.5)
    // Sepia of pure red: R=0.393, G=0.349, B=0.272
    // Blend: original + (sepia - original) * 0.5
    const expected_r = 1.0 + (0.393 - 1.0) * 0.5;
    const expected_g = 0.0 + (0.349 - 0.0) * 0.5;
    const expected_b = 0.0 + (0.272 - 0.0) * 0.5;

    try expectRGBAApprox(ansi.rgbaFromFloats(expected_r, expected_g, expected_b, 1.0), buf.buffer.fg[0], 0.001);
    try expectRGBAApprox(ansi.rgbaFromFloats(expected_r, expected_g, expected_b, 1.0), buf.buffer.fg[1], 0.001);
}

test "colorMatrixUniform - target affects correct buffers" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const blue = ansi.rgbaFromFloats(0.0, 0.0, 1.0, 1.0);

    buf.clear(bg, null);

    buf.buffer.fg[0] = red;
    buf.buffer.bg[0] = blue;
    buf.buffer.fg[1] = red;
    buf.buffer.bg[1] = blue;

    // Apply to FG only (target = 1)
    buffer_effects.colorMatrixUniform(buf, &GRAYSCALE_MATRIX, 1.0, ColorTarget.FG);

    // FG should be grayscale, BG should remain blue
    const gray_red = 0.299 * 1.0;
    try expectRGBAApprox(ansi.rgbaFromFloats(gray_red, gray_red, gray_red, 1.0), buf.buffer.fg[0], 0.001);
    try expectRGBAApprox(blue, buf.buffer.bg[0], 0.0001);

    // Reset and test BG only (target = 2)
    buf.buffer.fg[0] = red;
    buf.buffer.bg[0] = blue;
    buf.buffer.fg[1] = red;
    buf.buffer.bg[1] = blue;

    buffer_effects.colorMatrixUniform(buf, &GRAYSCALE_MATRIX, 1.0, ColorTarget.BG);

    // BG should be grayscale, FG should remain red
    const gray_blue = 0.114 * 1.0;
    try expectRGBAApprox(red, buf.buffer.fg[0], 0.0001);
    try expectRGBAApprox(ansi.rgbaFromFloats(gray_blue, gray_blue, gray_blue, 1.0), buf.buffer.bg[0], 0.001);

    // Reset and test Both (target = 3)
    buf.buffer.fg[0] = red;
    buf.buffer.bg[0] = blue;
    buf.buffer.fg[1] = red;
    buf.buffer.bg[1] = blue;

    buffer_effects.colorMatrixUniform(buf, &GRAYSCALE_MATRIX, 1.0, ColorTarget.Both);

    // Both should be grayscale
    try expectRGBAApprox(ansi.rgbaFromFloats(gray_red, gray_red, gray_red, 1.0), buf.buffer.fg[0], 0.001);
    try expectRGBAApprox(ansi.rgbaFromFloats(gray_blue, gray_blue, gray_blue, 1.0), buf.buffer.bg[0], 0.001);
}

test "colorMatrixUniform - handles buffer sizes not divisible by 4" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    // Test with 5 pixels (1 SIMD batch of 4 + 1 scalar remainder)
    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        5,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);

    // Set all FG to red
    for (0..5) |i| {
        buf.buffer.fg[i] = red;
    }

    // Apply sepia at full strength
    buffer_effects.colorMatrixUniform(buf, &SEPIA_MATRIX, 1.0, ColorTarget.FG);

    // All pixels should be transformed (including the scalar fallback)
    const expected_r = 0.393;
    const expected_g = 0.349;
    const expected_b = 0.272;

    for (0..5) |i| {
        try expectRGBAApprox(ansi.rgbaFromFloats(expected_r, expected_g, expected_b, 1.0), buf.buffer.fg[i], 0.001);
    }
}

test "colorMatrixUniform - empty matrix returns early" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = red;

    // Empty matrix - should return early without changes
    const empty_matrix: [0]f32 = .{};
    buffer_effects.colorMatrixUniform(buf, &empty_matrix, 1.0, ColorTarget.FG);

    // Color should be unchanged
    try expectRGBAApprox(red, buf.buffer.fg[0], 0.0001);
}

test "colorMatrixUniform - alpha channel transformation" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const opaque_color = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const transparent_color = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 0.5);

    buf.clear(bg, null);

    buf.buffer.fg[0] = opaque_color;
    buf.buffer.fg[1] = transparent_color;

    // Apply matrix that halves alpha at full strength
    buffer_effects.colorMatrixUniform(buf, &ALPHA_MODIFY_MATRIX, 1.0, ColorTarget.FG);

    // Opaque should become semi-transparent (alpha = 1.0 * 0.5 = 0.5)
    try expectRGBAApprox(ansi.rgbaFromFloats(1.0, 0.0, 0.0, 0.5), buf.buffer.fg[0], 0.0001);
    // Semi-transparent should become more transparent (alpha = 0.5 * 0.5 = 0.25)
    try expectRGBAApprox(ansi.rgbaFromFloats(0.0, 1.0, 0.0, 0.25), buf.buffer.fg[1], 0.0001);
}

test "colorMatrixUniform - very small buffer (less than 4 pixels)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    // Test with 2 pixels (all scalar, no SIMD)
    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);
    const green = ansi.rgbaFromFloats(0.0, 1.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = red;
    buf.buffer.fg[1] = green;

    // Apply sepia at full strength
    buffer_effects.colorMatrixUniform(buf, &SEPIA_MATRIX, 1.0, ColorTarget.FG);

    // Both pixels should be transformed correctly using scalar path
    const expected_red_r = 0.393;
    const expected_red_g = 0.349;
    const expected_red_b = 0.272;
    try expectRGBAApprox(ansi.rgbaFromFloats(expected_red_r, expected_red_g, expected_red_b, 1.0), buf.buffer.fg[0], 0.001);

    // Green transformed: R=0.769, G=0.686, B=0.534
    const expected_green_r = 0.769;
    const expected_green_g = 0.686;
    const expected_green_b = 0.534;
    try expectRGBAApprox(ansi.rgbaFromFloats(expected_green_r, expected_green_g, expected_green_b, 1.0), buf.buffer.fg[1], 0.001);
}

test "colorMatrixUniform - single pixel buffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    // Test with 1 pixel (edge case)
    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        1,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = red;

    // Apply sepia at full strength
    buffer_effects.colorMatrixUniform(buf, &SEPIA_MATRIX, 1.0, ColorTarget.FG);

    // Pixel should be transformed correctly
    const expected_r = 0.393;
    const expected_g = 0.349;
    const expected_b = 0.272;
    try expectRGBAApprox(ansi.rgbaFromFloats(expected_r, expected_g, expected_b, 1.0), buf.buffer.fg[0], 0.001);
}

test "colorMatrixUniform - values can exceed 1.0 (no clamping)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    // Matrix that amplifies colors beyond 1.0
    const amplify_matrix = [16]f32{
        2.0, 0.0, 0.0, 0.0, // Red output (2x)
        0.0, 2.0, 0.0, 0.0, // Green output (2x)
        0.0, 0.0, 2.0, 0.0, // Blue output (2x)
        0.0, 0.0, 0.0, 1.0, // Alpha output
    };

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const gray = ansi.rgbaFromFloats(0.5, 0.5, 0.5, 1.0);

    buf.clear(bg, null);
    buf.buffer.fg[0] = gray;

    // Apply amplification at full strength
    buffer_effects.colorMatrixUniform(buf, &amplify_matrix, 1.0, ColorTarget.FG);

    // Values should exceed 1.0 (no clamping)
    try expectRGBAApprox(ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0), buf.buffer.fg[0], 0.0001);
}

test "colorMatrixUniform - 3 pixel buffer (simd_end = 0, all scalar)" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    // 3 pixels - simd_end will be 0, so all processed via scalar
    var buf = try OptimizedBuffer.init(
        std.testing.allocator,
        3,
        1,
        .{ .pool = pool, .id = "test-buffer" },
    );
    defer buf.deinit();

    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    const red = ansi.rgbaFromFloats(1.0, 0.0, 0.0, 1.0);

    buf.clear(bg, null);
    for (0..3) |i| {
        buf.buffer.fg[i] = red;
    }

    // Apply sepia
    buffer_effects.colorMatrixUniform(buf, &SEPIA_MATRIX, 1.0, ColorTarget.FG);

    // All 3 should be transformed via scalar path
    const expected_r = 0.393;
    const expected_g = 0.349;
    const expected_b = 0.272;

    for (0..3) |i| {
        try expectRGBAApprox(ansi.rgbaFromFloats(expected_r, expected_g, expected_b, 1.0), buf.buffer.fg[i], 0.001);
    }
}
