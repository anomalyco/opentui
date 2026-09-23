import type { OptimizedBuffer } from "../buffer.js"

function toU8(value: number): number {
  return Math.round(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 255)
}

function channel(buffer: Uint16Array, index: number): number {
  return (buffer[index] & 0xff) / 255
}

function setRgb(buffer: Uint16Array, base: number, r: number, g: number, b: number): void {
  const a = buffer[base + 3] & 0xff
  buffer[base] = toU8(r)
  buffer[base + 1] = toU8(g)
  buffer[base + 2] = toU8(b)
  buffer[base + 3] = a
}

/**
 * Applies a scanline effect by darkening every nth row using native color matrix.
 * Only affects the background buffer to maintain text readability.
 */
export function applyScanlines(buffer: OptimizedBuffer, strength: number = 0.8, step: number = 2): void {
  if (strength === 1.0 || step < 1) return

  buffer.withBuffers(({ width, height }) => {
    // Calculate number of affected rows
    const affectedRows = Math.ceil(height / step)
    const cellCount = width * affectedRows
    const cellMask = new Float32Array(cellCount * 3)

    let maskIdx = 0
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x++) {
        cellMask[maskIdx++] = x
        cellMask[maskIdx++] = y
        cellMask[maskIdx++] = 1.0 // full strength
      }
    }

    // Gain matrix to scale down background colors
    const s = strength
    const matrix = new Float32Array([
      s,
      0,
      0,
      0, // Row 0: Red output
      0,
      s,
      0,
      0, // Row 1: Green output
      0,
      0,
      s,
      0, // Row 2: Blue output
      0,
      0,
      0,
      1, // Row 3: Alpha output (identity)
    ])

    // Apply only to background buffer (target = 2)
    buffer.colorMatrix(matrix, cellMask, 1.0, 2)
  })
}

/**
 * Inverts the colors in the buffer using native color matrix.
 * Uses negative matrix with alpha offset: output = 1.0 - input for each RGB channel.
 */
export function applyInvert(buffer: OptimizedBuffer, strength: number = 1.0): void {
  if (strength === 0.0) return

  // Invert matrix: output = -1*input + 1*alpha = 1.0 - input (assuming alpha=1.0)
  // Row format: [R_coeff, G_coeff, B_coeff, A_coeff]
  const matrix = new Float32Array([
    -1,
    0,
    0,
    1, // Row 0: Red output = -1*R + 0*G + 0*B + 1*A = 1 - R
    0,
    -1,
    0,
    1, // Row 1: Green output = 1 - G
    0,
    0,
    -1,
    1, // Row 2: Blue output = 1 - B
    0,
    0,
    0,
    1, // Row 3: Alpha output = A
  ])

  buffer.colorMatrixUniform(matrix, strength, 3)
}

/**
 * Adds random noise to the buffer colors using colorMatrix with brightness matrix.
 * Uses per-pixel random strength values to dim/brighten each cell.
 */
export function applyNoise(buffer: OptimizedBuffer, strength: number = 0.1): void {
  // Skip if no effect
  if (strength === 0) return

  buffer.withBuffers(({ width, height }) => {
    const size = width * height

    // Generate random cellMask with per-pixel strength values
    // Each pixel gets [x, y, random_strength] where random_strength ranges from -1 to 1
    const cellMask = new Float32Array(size * 3)
    let cellMaskIndex = 0

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        cellMask[cellMaskIndex++] = x
        cellMask[cellMaskIndex++] = y
        // Random strength from -1 to 1
        cellMask[cellMaskIndex++] = (Math.random() - 0.5) * 2
      }
    }

    // Brightness matrix: scales all channels by (1 + strength)
    // With cellMask strength S, result = original * (1 + (B - 1) * S)
    // where B = 1 + strength
    // So: S=1 → original * (1 + strength), S=-1 → original * (1 - strength)
    const b = 1.0 + strength
    const matrix = new Float32Array([
      b,
      0,
      0,
      0, // Row 0 (Red output)
      0,
      b,
      0,
      0, // Row 1 (Green output)
      0,
      0,
      b,
      0, // Row 2 (Blue output)
      0,
      0,
      0,
      1, // Row 3 (Alpha output - identity)
    ])

    buffer.colorMatrix(matrix, cellMask, 1.0, 3)
  })
}

/**
 * Applies a simplified chromatic aberration effect.
 */
export function applyChromaticAberration(buffer: OptimizedBuffer, strength: number = 1): void {
  buffer.withBuffers(({ width, height, fg: destFg }) => {
    const srcFg = Uint16Array.from(destFg) // Copy original fg data
    const centerX = width / 2
    const centerY = height / 2

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - centerX
        const dy = y - centerY
        const offset = Math.round((Math.sqrt(dx * dx + dy * dy) / Math.max(centerX, centerY)) * strength)

        const rX = Math.max(0, Math.min(width - 1, x - offset))
        const bX = Math.max(0, Math.min(width - 1, x + offset))

        const rIndex = (y * width + rX) * 4
        const gIndex = (y * width + x) * 4 // Green from original position
        const bIndex = (y * width + bX) * 4
        const destIndex = (y * width + x) * 4

        setRgb(destFg, destIndex, channel(srcFg, rIndex), channel(srcFg, gIndex + 1), channel(srcFg, bIndex + 2))
      }
    }
  })
}

/**
 * Converts the buffer to ASCII art based on background brightness.
 * Uses native colorMatrix for efficient color corrections.
 */
export function applyAsciiArt(
  buffer: OptimizedBuffer,
  ramp: string = ' .\'`^"",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',
  fgColor: { r: number; g: number; b: number } = { r: 1.0, g: 1.0, b: 1.0 },
  bgColor: { r: number; g: number; b: number } = { r: 0.0, g: 0.0, b: 0.0 },
): void {
  buffer.withBuffers(({ width, height, char: chars, bg }) => {
    const rampLength = ramp.length

    // Set ASCII characters based on background luminance
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x
        const colorIndex = index * 4
        const bgR = channel(bg, colorIndex)
        const bgG = channel(bg, colorIndex + 1)
        const bgB = channel(bg, colorIndex + 2)
        const lum = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB // Luminance
        const rampIndex = Math.min(rampLength - 1, Math.floor(lum * rampLength))
        chars[index] = ramp[rampIndex].charCodeAt(0)
      }
    }

    // Create color matrix that sets all pixels to the target color
    // Matrix: output = target_color * input (where input is 1.0 from alpha)
    const fgMatrix = new Float32Array([
      0,
      0,
      0,
      fgColor.r, // Red output
      0,
      0,
      0,
      fgColor.g, // Green output
      0,
      0,
      0,
      fgColor.b, // Blue output
      0,
      0,
      0,
      1, // Alpha output (identity)
    ])

    const bgMatrix = new Float32Array([
      0,
      0,
      0,
      bgColor.r, // Red output
      0,
      0,
      0,
      bgColor.g, // Green output
      0,
      0,
      0,
      bgColor.b, // Blue output
      0,
      0,
      0,
      1, // Alpha output (identity)
    ])

    // Apply uniform color transformation to foreground (target = 1)
    buffer.colorMatrixUniform(fgMatrix, 1.0, 1)
    // Apply uniform color transformation to background (target = 2)
    buffer.colorMatrixUniform(bgMatrix, 1.0, 2)
  })
}

/**
 * Adjusts the brightness of the buffer using color matrix transformation.
 * Brightness adds the brightness value to all RGB channels (additive brightness).
 *                   If not provided, applies uniform brightness to entire buffer.
 */
export function applyBrightness(buffer: OptimizedBuffer, brightness: number = 0.0, cellMask?: Float32Array): void {
  // No need to process if brightness is 0 (no change)
  if (brightness === 0.0) return

  const b = brightness
  // Additive brightness matrix: adds brightness to all channels via alpha column
  const matrix = new Float32Array([
    1,
    0,
    0,
    b, // Row 0 (Red output = R + brightness*A)
    0,
    1,
    0,
    b, // Row 1 (Green output = G + brightness*A)
    0,
    0,
    1,
    b, // Row 2 (Blue output = B + brightness*A)
    0,
    0,
    0,
    1, // Row 3 (Alpha output = A)
  ])

  if (!cellMask || cellMask.length === 0) {
    buffer.colorMatrixUniform(matrix, 1.0, 3)
  } else {
    buffer.colorMatrix(matrix, cellMask, 1.0, 3)
  }
}

/**
 * Adjusts the gain of the buffer using color matrix transformation.
 * Gain multiplies all RGB channels by the gain factor (no clamping).
 *                   If not provided, applies uniform gain to entire buffer.
 */
export function applyGain(buffer: OptimizedBuffer, gain: number = 1.0, cellMask?: Float32Array): void {
  // No need to process if gain is 1 (no change)
  if (gain === 1.0) return

  const g = Math.max(0, gain)
  const matrix = new Float32Array([
    g,
    0,
    0,
    0, // Row 0 (Red output)
    0,
    g,
    0,
    0, // Row 1 (Green output)
    0,
    0,
    g,
    0, // Row 2 (Blue output)
    0,
    0,
    0,
    1, // Row 3 (Alpha output - identity)
  ])

  if (!cellMask || cellMask.length === 0) {
    buffer.colorMatrixUniform(matrix, 1.0, 3)
  } else {
    buffer.colorMatrix(matrix, cellMask, 1.0, 3)
  }
}

/**
 * Generates a saturation color matrix (4x4 RGBA with alpha identity).
 */
function createSaturationMatrix(saturation: number): Float32Array {
  const s = Math.max(0, saturation)
  const sr = 0.299 * (1 - s)
  const sg = 0.587 * (1 - s)
  const sb = 0.114 * (1 - s)

  // Row 0 (Red output)
  const m00 = sr + s // 0.299 + 0.701*s
  const m01 = sg // 0.587 * (1 - s)
  const m02 = sb // 0.114 * (1 - s)

  // Row 1 (Green output)
  const m10 = sr // 0.299 * (1 - s)
  const m11 = sg + s // 0.587 + 0.413*s
  const m12 = sb // 0.114 * (1 - s)

  // Row 2 (Blue output)
  const m20 = sr // 0.299 * (1 - s)
  const m21 = sg // 0.587 * (1 - s)
  const m22 = sb + s // 0.114 + 0.886*s

  // 4x4 matrix with alpha identity
  return new Float32Array([
    m00,
    m01,
    m02,
    0, // Red output row
    m10,
    m11,
    m12,
    0, // Green output row
    m20,
    m21,
    m22,
    0, // Blue output row
    0,
    0,
    0,
    1, // Alpha output row (identity)
  ])
}

/**
 * Applies a saturation adjustment to the buffer.
 */
export function applySaturation(buffer: OptimizedBuffer, cellMask?: Float32Array, strength: number = 1.0): void {
  // No need to process if saturation is 1 (no change) or strength is 0
  if (strength === 1.0 || strength === 0) {
    return
  }

  const matrix = createSaturationMatrix(strength)

  // If no cellMask provided, use uniform saturation (much faster)
  if (!cellMask || cellMask.length === 0) {
    buffer.colorMatrixUniform(matrix, 1.0, 3)
  } else {
    buffer.colorMatrix(matrix, cellMask, 1.0, 3)
  }
}

/**
 * Applies a bloom effect based on bright areas (Simplified).
 */
export class BloomEffect {
  private _threshold: number
  private _strength: number
  private _radius: number

  constructor(threshold: number = 0.8, strength: number = 0.2, radius: number = 2) {
    this._threshold = Math.max(0, Math.min(1, threshold))
    this._strength = Math.max(0, strength)
    this._radius = Math.max(0, Math.round(radius))
  }

  public set threshold(newThreshold: number) {
    this._threshold = Math.max(0, Math.min(1, newThreshold))
  }
  public get threshold(): number {
    return this._threshold
  }

  public set strength(newStrength: number) {
    this._strength = Math.max(0, newStrength)
  }
  public get strength(): number {
    return this._strength
  }

  public set radius(newRadius: number) {
    this._radius = Math.max(0, Math.round(newRadius))
  }
  public get radius(): number {
    return this._radius
  }

  public apply(buffer: OptimizedBuffer): void {
    const threshold = this._threshold
    const strength = this._strength
    const radius = this._radius

    if (strength <= 0 || radius <= 0) return // No bloom if strength or radius is non-positive

    buffer.withBuffers(({ width, height, fg: destFg, bg: destBg }) => {
      const brightPixels: { x: number; y: number; intensity: number }[] = []

      // 1. Find bright pixels based on original data
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const index = (y * width + x) * 4
          // Consider max component brightness, or luminance? Using luminance.
          const fgLum =
            0.299 * channel(destFg, index) + 0.587 * channel(destFg, index + 1) + 0.114 * channel(destFg, index + 2)
          const bgLum =
            0.299 * channel(destBg, index) + 0.587 * channel(destBg, index + 1) + 0.114 * channel(destBg, index + 2)
          const lum = Math.max(fgLum, bgLum)
          if (lum > threshold) {
            const intensity = (lum - threshold) / (1 - threshold + 1e-6) // Add epsilon to avoid div by zero
            brightPixels.push({ x, y, intensity: Math.max(0, intensity) })
          }
        }
      }

      // If no bright pixels found, exit early
      if (brightPixels.length === 0) return

      // 2. Apply bloom spread from bright pixels onto the destination buffers
      for (const bright of brightPixels) {
        for (let ky = -radius; ky <= radius; ky++) {
          for (let kx = -radius; kx <= radius; kx++) {
            if (kx === 0 && ky === 0) continue // Don't bloom self

            const sampleX = bright.x + kx
            const sampleY = bright.y + ky

            if (sampleX >= 0 && sampleX < width && sampleY >= 0 && sampleY < height) {
              const distSq = kx * kx + ky * ky // Use squared distance for falloff calculation
              const radiusSq = radius * radius
              if (distSq <= radiusSq) {
                // Simple linear falloff based on squared distance
                const falloff = 1 - distSq / radiusSq
                const bloomAmount = bright.intensity * strength * falloff
                const destIndex = (sampleY * width + sampleX) * 4

                // Add bloom to both fg and bg, clamping at 1.0
                setRgb(
                  destFg,
                  destIndex,
                  Math.min(1.0, channel(destFg, destIndex) + bloomAmount),
                  Math.min(1.0, channel(destFg, destIndex + 1) + bloomAmount),
                  Math.min(1.0, channel(destFg, destIndex + 2) + bloomAmount),
                )

                setRgb(
                  destBg,
                  destIndex,
                  Math.min(1.0, channel(destBg, destIndex) + bloomAmount),
                  Math.min(1.0, channel(destBg, destIndex + 1) + bloomAmount),
                  Math.min(1.0, channel(destBg, destIndex + 2) + bloomAmount),
                )
              }
            }
          }
        }
      }
    })
  }
}
