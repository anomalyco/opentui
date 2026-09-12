const std = @import("std");
const math = std.math;
const ansi = @import("ansi.zig");

const RGBA = ansi.RGBA;
const Vec4 = @Vector(4, f32);
const MatrixColor = struct { r: f32, g: f32, b: f32, a: f32 };

/// Target buffer(s) for color matrix operations
/// Uses bitwise flags: FG=1, BG=2, Both=1|2=3
pub const ColorTarget = enum(u8) {
    FG = 1,
    BG = 2,
    Both = 3,
};

/// Apply 4x4 RGBA matrix to 4 pixels using SIMD
/// matrix: 16 floats in row-major order (4x4 matrix)
/// pixels: array of 4 RGBA values
/// strength: blend factor
/// result: output array of 4 RGBA values
fn applyMatrix4x4SIMD(matrix: *const [16]f32, r_vec: Vec4, g_vec: Vec4, b_vec: Vec4, a_vec: Vec4, strength_vec: Vec4) struct { r: Vec4, g: Vec4, b: Vec4, a: Vec4 } {
    // Matrix multiply: new_color = M * color
    // Each row of matrix defines the coefficients for one output channel
    // Row 0 -> Red output, Row 1 -> Green output, Row 2 -> Blue output, Row 3 -> Alpha output
    const new_r = r_vec * @as(Vec4, @splat(matrix[0])) + g_vec * @as(Vec4, @splat(matrix[1])) + b_vec * @as(Vec4, @splat(matrix[2])) + a_vec * @as(Vec4, @splat(matrix[3]));
    const new_g = r_vec * @as(Vec4, @splat(matrix[4])) + g_vec * @as(Vec4, @splat(matrix[5])) + b_vec * @as(Vec4, @splat(matrix[6])) + a_vec * @as(Vec4, @splat(matrix[7]));
    const new_b = r_vec * @as(Vec4, @splat(matrix[8])) + g_vec * @as(Vec4, @splat(matrix[9])) + b_vec * @as(Vec4, @splat(matrix[10])) + a_vec * @as(Vec4, @splat(matrix[11]));
    const new_a = r_vec * @as(Vec4, @splat(matrix[12])) + g_vec * @as(Vec4, @splat(matrix[13])) + b_vec * @as(Vec4, @splat(matrix[14])) + a_vec * @as(Vec4, @splat(matrix[15]));

    // Blend: original + (new - original) * strength
    const out_r = r_vec + (new_r - r_vec) * strength_vec;
    const out_g = g_vec + (new_g - g_vec) * strength_vec;
    const out_b = b_vec + (new_b - b_vec) * strength_vec;
    const out_a = a_vec + (new_a - a_vec) * strength_vec;

    return .{ .r = out_r, .g = out_g, .b = out_b, .a = out_a };
}

/// Apply 4x4 RGBA matrix to single pixel (scalar fallback)
/// matrix is in row-major order (4x4 matrix), where each row defines coefficients for one output channel
fn applyMatrix4x4Scalar(matrix: *const [16]f32, r: f32, g: f32, b: f32, a: f32, strength: f32) MatrixColor {
    // Row 0 -> Red output, Row 1 -> Green output, Row 2 -> Blue output, Row 3 -> Alpha output
    const new_r = matrix[0] * r + matrix[1] * g + matrix[2] * b + matrix[3] * a;
    const new_g = matrix[4] * r + matrix[5] * g + matrix[6] * b + matrix[7] * a;
    const new_b = matrix[8] * r + matrix[9] * g + matrix[10] * b + matrix[11] * a;
    const new_a = matrix[12] * r + matrix[13] * g + matrix[14] * b + matrix[15] * a;

    return .{
        .r = r + (new_r - r) * strength,
        .g = g + (new_g - g) * strength,
        .b = b + (new_b - b) * strength,
        .a = a + (new_a - a) * strength,
    };
}

fn floatToU8(v: f32) u8 {
    return ansi.rgbaComponentToU8(v);
}

fn matrixInput(color: RGBA) MatrixColor {
    return .{
        .r = ansi.redF(color),
        .g = ansi.greenF(color),
        .b = ansi.blueF(color),
        .a = ansi.alphaF(color),
    };
}

fn matrixOutput(result: MatrixColor) RGBA {
    return ansi.rgbColor(floatToU8(result.r), floatToU8(result.g), floatToU8(result.b), floatToU8(result.a));
}

/// Apply 4x4 RGBA color matrix transformation to RGBA values at specified cell coordinates.
/// matrix: 4x4 row-major matrix (16 values) where each row corresponds to output channel:
///   Row 0: [r->r, g->r, b->r, a->r] - coefficients for Red output
///   Row 1: [r->g, g->g, b->g, a->g] - coefficients for Green output
///   Row 2: [r->b, g->b, b->b, a->b] - coefficients for Blue output
///   Row 3: [r->a, g->a, b->a, a->a] - coefficients for Alpha output (usually identity)
/// cellMask format: [x, y, strength, x, y, strength, ...]
/// strength: global multiplier applied to each cell's strength value (1.0 = no change)
/// target: which buffer(s) to apply the matrix to (FG=1, BG=2, Both=3)
/// No clamping is performed - output values may exceed [0, 1] range
pub fn colorMatrix(self: anytype, matrix: []const f32, cellMask: []const f32, strength: f32, target: ColorTarget) void {
    if (matrix.len < 16 or cellMask.len < 3) return;
    if (@intFromEnum(target) == 0) return;
    if (!math.isFinite(strength)) return;

    const width = self.width;
    const height = self.height;
    const fg = self.buffer.fg;
    const bg = self.buffer.bg;

    // Use matrix directly as 4x4
    const mat4 = matrix[0..16].*;
    const max_u32_f = @as(f32, @floatFromInt(std.math.maxInt(u32)));

    const len = cellMask.len - (cellMask.len % 3);
    var i: usize = 0;
    while (i < len) : (i += 3) {
        const x_f = cellMask[i];
        const y_f = cellMask[i + 1];

        // Skip if coordinates are negative or non-finite before conversion
        if (x_f < 0.0 or y_f < 0.0) continue;
        if (!math.isFinite(x_f) or !math.isFinite(y_f)) continue;
        if (x_f > max_u32_f or y_f > max_u32_f) continue;

        const x: u32 = @intFromFloat(x_f);
        const y: u32 = @intFromFloat(y_f);
        const cellStrength = cellMask[i + 2] * strength;

        if (x >= width or y >= height) continue;

        if (!math.isFinite(cellStrength)) continue;
        if (cellStrength == 0.0) continue;

        const index = y * width + x;

        // Apply color matrix to foreground if target includes FG
        if (@intFromEnum(target) & 1 != 0) {
            const input = matrixInput(fg[index]);
            const fg_result = applyMatrix4x4Scalar(&mat4, input.r, input.g, input.b, input.a, cellStrength);
            fg[index] = matrixOutput(fg_result);
        }

        // Apply color matrix to background if target includes BG
        if (@intFromEnum(target) & 2 != 0) {
            const input = matrixInput(bg[index]);
            const bg_result = applyMatrix4x4Scalar(&mat4, input.r, input.g, input.b, input.a, cellStrength);
            bg[index] = matrixOutput(bg_result);
        }
    }
}

/// Apply 4x4 RGBA color matrix transformation uniformly to all pixels using SIMD.
/// matrix: 4x4 row-major matrix (16 values) where each row corresponds to output channel:
///   Row 0: [r->r, g->r, b->r, a->r] - coefficients for Red output
///   Row 1: [r->g, g->g, b->g, a->g] - coefficients for Green output
///   Row 2: [r->b, g->b, b->b, a->b] - coefficients for Blue output
///   Row 3: [r->a, g->a, b->a, a->a] - coefficients for Alpha output (usually identity)
/// strength: multiplier applied to matrix effect (0.0 = no effect, 1.0 = full matrix)
/// target: which buffer(s) to apply the matrix to (FG=1, BG=2, Both=3)
/// This uses 4-wide SIMD to process pixels in batches for maximum throughput.
/// No clamping is performed - output values may exceed [0, 1] range
pub fn colorMatrixUniform(self: anytype, matrix: []const f32, strength: f32, target: ColorTarget) void {
    if (matrix.len < 16 or strength == 0.0) return;
    if (@intFromEnum(target) == 0) return;
    if (!math.isFinite(strength)) return;

    const width = self.width;
    const height = self.height;
    const size = width * height;
    const fg = self.buffer.fg;
    const bg = self.buffer.bg;

    // Use matrix directly as 4x4
    const mat4 = matrix[0..16].*;

    const processFG = @intFromEnum(target) & 1 != 0;
    const processBG = @intFromEnum(target) & 2 != 0;

    // Process 4 pixels at a time using SIMD
    const strength_vec: Vec4 = @splat(strength);
    var i: usize = 0;
    const simd_end = size - (size % 4);

    while (i < simd_end) : (i += 4) {
        // Process foreground if target includes FG
        if (processFG) {
            // Load 4 pixels' RGBA values into separate channel vectors
            const fg_r = Vec4{ ansi.redF(fg[i]), ansi.redF(fg[i + 1]), ansi.redF(fg[i + 2]), ansi.redF(fg[i + 3]) };
            const fg_g = Vec4{ ansi.greenF(fg[i]), ansi.greenF(fg[i + 1]), ansi.greenF(fg[i + 2]), ansi.greenF(fg[i + 3]) };
            const fg_b = Vec4{ ansi.blueF(fg[i]), ansi.blueF(fg[i + 1]), ansi.blueF(fg[i + 2]), ansi.blueF(fg[i + 3]) };
            const fg_a = Vec4{ ansi.alphaF(fg[i]), ansi.alphaF(fg[i + 1]), ansi.alphaF(fg[i + 2]), ansi.alphaF(fg[i + 3]) };

            // Apply matrix transformation
            const fg_result = applyMatrix4x4SIMD(&mat4, fg_r, fg_g, fg_b, fg_a, strength_vec);

            // Store results back
            inline for (0..4) |j| {
                fg[i + j] = ansi.rgbColor(floatToU8(fg_result.r[j]), floatToU8(fg_result.g[j]), floatToU8(fg_result.b[j]), floatToU8(fg_result.a[j]));
            }
        }

        // Process background if target includes BG
        if (processBG) {
            const bg_r = Vec4{ ansi.redF(bg[i]), ansi.redF(bg[i + 1]), ansi.redF(bg[i + 2]), ansi.redF(bg[i + 3]) };
            const bg_g = Vec4{ ansi.greenF(bg[i]), ansi.greenF(bg[i + 1]), ansi.greenF(bg[i + 2]), ansi.greenF(bg[i + 3]) };
            const bg_b = Vec4{ ansi.blueF(bg[i]), ansi.blueF(bg[i + 1]), ansi.blueF(bg[i + 2]), ansi.blueF(bg[i + 3]) };
            const bg_a = Vec4{ ansi.alphaF(bg[i]), ansi.alphaF(bg[i + 1]), ansi.alphaF(bg[i + 2]), ansi.alphaF(bg[i + 3]) };

            const bg_result = applyMatrix4x4SIMD(&mat4, bg_r, bg_g, bg_b, bg_a, strength_vec);

            inline for (0..4) |j| {
                bg[i + j] = ansi.rgbColor(floatToU8(bg_result.r[j]), floatToU8(bg_result.g[j]), floatToU8(bg_result.b[j]), floatToU8(bg_result.a[j]));
            }
        }
    }

    // Handle remaining pixels (0-3) with scalar fallback
    while (i < size) : (i += 1) {
        if (processFG) {
            const input = matrixInput(fg[i]);
            const fg_result = applyMatrix4x4Scalar(&mat4, input.r, input.g, input.b, input.a, strength);
            fg[i] = matrixOutput(fg_result);
        }

        if (processBG) {
            const input = matrixInput(bg[i]);
            const bg_result = applyMatrix4x4Scalar(&mat4, input.r, input.g, input.b, input.a, strength);
            bg[i] = matrixOutput(bg_result);
        }
    }
}
