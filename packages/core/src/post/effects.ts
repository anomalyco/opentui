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

function isGraphemeCell(char: number): boolean {
  return char >>> 30 >= 2
}

interface ActiveGlitch {
  y: number
  type: "shift" | "flip" | "color"
  amount: number
}

export class DistortionEffect {
  // --- Configurable Parameters ---
  public glitchChancePerSecond: number = 0.5
  public maxGlitchLines: number = 3
  public minGlitchDuration: number = 0.05
  public maxGlitchDuration: number = 0.2
  public maxShiftAmount: number = 10
  public shiftFlipRatio: number = 0.6
  public colorGlitchChance: number = 0.2

  // --- Internal State ---
  private lastGlitchTime: number = 0
  private glitchDuration: number = 0
  private activeGlitches: ActiveGlitch[] = []

  constructor(options?: Partial<DistortionEffect>) {
    if (options) {
      Object.assign(this, options)
    }
  }

  /**
   * Applies the animated distortion/glitch effect to the buffer.
   */
  public apply(buffer: OptimizedBuffer, deltaTime: number): void {
    const width = buffer.width
    const height = buffer.height
    const buf = buffer.buffers
    // Note: Using internal timer based on deltaTime is more reliable than Date.now()

    // Update glitch timer
    this.lastGlitchTime += deltaTime

    // End current glitch if duration is over
    if (this.activeGlitches.length > 0 && this.lastGlitchTime >= this.glitchDuration) {
      this.activeGlitches = []
      this.glitchDuration = 0
    }

    // Chance to start a new glitch
    if (this.activeGlitches.length === 0 && Math.random() < this.glitchChancePerSecond * deltaTime) {
      this.lastGlitchTime = 0
      this.glitchDuration = this.minGlitchDuration + Math.random() * (this.maxGlitchDuration - this.minGlitchDuration)
      const numGlitches = 1 + Math.floor(Math.random() * this.maxGlitchLines)

      for (let i = 0; i < numGlitches; i++) {
        const y = Math.floor(Math.random() * height)
        let type: ActiveGlitch["type"]
        let amount = 0

        const typeRoll = Math.random()
        if (typeRoll < this.colorGlitchChance) {
          type = "color"
        } else {
          // Determine shift or flip based on remaining probability
          const shiftRoll = (typeRoll - this.colorGlitchChance) / (1 - this.colorGlitchChance)
          if (shiftRoll < this.shiftFlipRatio) {
            type = "shift"
            amount = Math.floor((Math.random() - 0.5) * 2 * this.maxShiftAmount)
          } else {
            type = "flip"
          }
        }

        // Avoid glitching the same line twice in one burst
        if (!this.activeGlitches.some((g) => g.y === y)) {
          this.activeGlitches.push({ y, type, amount })
        }
      }
    }

    // Apply active glitches
    if (this.activeGlitches.length > 0) {
      // Create temporary arrays lazily if needed (minor optimization for shift/flip)
      let tempChar: Uint32Array | null = null
      let tempFg: Uint16Array | null = null
      let tempBg: Uint16Array | null = null
      let tempAttr: Uint8Array | null = null

      for (const glitch of this.activeGlitches) {
        const y = glitch.y
        // Ensure y is within bounds (safer)
        if (y < 0 || y >= height) continue
        const baseIndex = y * width

        if (glitch.type === "shift" || glitch.type === "flip") {
          // Lazily create temp buffers only when needed for shift/flip
          if (!tempChar) {
            tempChar = new Uint32Array(width)
            tempFg = new Uint16Array(width * 4)
            tempBg = new Uint16Array(width * 4)
            tempAttr = new Uint8Array(width)
          }

          // 1. Copy original row data to temp buffers
          try {
            tempChar.set(buf.char.subarray(baseIndex, baseIndex + width))
            tempFg!.set(buf.fg.subarray(baseIndex * 4, (baseIndex + width) * 4))
            tempBg!.set(buf.bg.subarray(baseIndex * 4, (baseIndex + width) * 4))
            tempAttr!.set(buf.attributes.subarray(baseIndex, baseIndex + width))
          } catch (e) {
            // Handle potential range errors if buffer size changes unexpectedly
            console.error(`Error copying row ${y} for distortion:`, e)
            continue
          }

          if (glitch.type === "shift") {
            const shift = glitch.amount
            for (let x = 0; x < width; x++) {
              const srcX = (x - shift + width) % width // Wrap around shift
              const destIndex = baseIndex + x
              const srcTempIndex = srcX

              buf.char[destIndex] = tempChar[srcTempIndex]
              buf.attributes[destIndex] = tempAttr![srcTempIndex]

              const destColorIndex = destIndex * 4
              const srcTempColorIndex = srcTempIndex * 4

              buf.fg.set(tempFg!.subarray(srcTempColorIndex, srcTempColorIndex + 4), destColorIndex)
              buf.bg.set(tempBg!.subarray(srcTempColorIndex, srcTempColorIndex + 4), destColorIndex)
            }
          } else {
            // type === 'flip'
            for (let x = 0; x < width; x++) {
              const srcX = width - 1 - x // Flipped index
              const destIndex = baseIndex + x
              const srcTempIndex = srcX

              buf.char[destIndex] = tempChar[srcTempIndex]
              buf.attributes[destIndex] = tempAttr![srcTempIndex]

              const destColorIndex = destIndex * 4
              const srcTempColorIndex = srcTempIndex * 4

              buf.fg.set(tempFg!.subarray(srcTempColorIndex, srcTempColorIndex + 4), destColorIndex)
              buf.bg.set(tempBg!.subarray(srcTempColorIndex, srcTempColorIndex + 4), destColorIndex)
            }
          }
        } else if (glitch.type === "color") {
          const glitchStart = Math.floor(Math.random() * width)
          // Make glitch length at least 1 pixel, up to the rest of the line
          const maxPossibleLength = width - glitchStart
          // Introduce more variability: sometimes short, sometimes long, but not always full width
          let glitchLength = Math.floor(Math.random() * maxPossibleLength) + 1
          if (Math.random() < 0.2) {
            // 20% chance of a shorter, more intense glitch segment
            glitchLength = Math.floor(Math.random() * (width / 4)) + 1
          }
          glitchLength = Math.min(glitchLength, maxPossibleLength)

          for (let x = glitchStart; x < glitchStart + glitchLength; x++) {
            if (x >= width) break // Boundary check

            const destIndex = baseIndex + x
            const destColorIndex = destIndex * 4

            let rFg, gFg, bFg, rBg, gBg, bBg

            // More varied and "glitchy" colors
            const colorMode = Math.random()
            if (colorMode < 0.33) {
              // Pure random
              rFg = Math.random()
              gFg = Math.random()
              bFg = Math.random()
              rBg = Math.random()
              gBg = Math.random()
              bBg = Math.random()
            } else if (colorMode < 0.66) {
              // Single channel emphasis or block color
              const emphasis = Math.random()
              if (emphasis < 0.25) {
                rFg = Math.random()
                gFg = 0
                bFg = 0
              } // Red
              else if (emphasis < 0.5) {
                rFg = 0
                gFg = Math.random()
                bFg = 0
              } // Green
              else if (emphasis < 0.75) {
                rFg = 0
                gFg = 0
                bFg = Math.random()
              } // Blue
              else {
                // Bright glitch color
                const glitchColorRoll = Math.random()
                if (glitchColorRoll < 0.33) {
                  rFg = 1
                  gFg = 0
                  bFg = 1
                } // Magenta
                else if (glitchColorRoll < 0.66) {
                  rFg = 0
                  gFg = 1
                  bFg = 1
                } // Cyan
                else {
                  rFg = 1
                  gFg = 1
                  bFg = 0
                } // Yellow
              }
              // Background can be inverted or similar to FG
              if (Math.random() < 0.5) {
                rBg = 1 - rFg
                gBg = 1 - gFg
                bBg = 1 - bFg
              } else {
                rBg = rFg * (Math.random() * 0.5 + 0.2) // Darker shade of fg
                gBg = gFg * (Math.random() * 0.5 + 0.2)
                bBg = bFg * (Math.random() * 0.5 + 0.2)
              }
            } else {
              // Inverted or high contrast
              rFg = Math.random() > 0.5 ? 1 : 0
              gFg = Math.random() > 0.5 ? 1 : 0
              bFg = Math.random() > 0.5 ? 1 : 0
              rBg = 1 - rFg
              gBg = 1 - gFg
              bBg = 1 - bFg
            }

            setRgb(buf.fg, destColorIndex, rFg, gFg, bFg)
            setRgb(buf.bg, destColorIndex, rBg, gBg, bBg)
          }
        }
      }
    }
  }
}

/**
 * Applies a vignette effect by darkening the corners, optimized with precomputation.
 * Uses native colorMatrix with a zero matrix for attenuation.
 */
export class VignetteEffect {
  private _strength: number
  // Stores packed cell masks [x, y, attenuation] per pixel
  private precomputedAttenuationCellMask: Float32Array | null = null
  private precomputedAttenuation: Float32Array | null = null
  private cachedWidth: number = -1
  private cachedHeight: number = -1
  // Zero matrix for attenuation (maps everything toward black based on strength)
  private static zeroMatrix = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])

  constructor(strength: number = 0.5) {
    this._strength = strength
  }

  public set strength(newStrength: number) {
    this._strength = Math.max(0, newStrength) // Ensure strength is non-negative
    // Invalidate cached cell masks when strength changes
    this.cachedWidth = -1
    this.cachedHeight = -1
    this.precomputedAttenuationCellMask = null
    this.precomputedAttenuation = null
  }

  public get strength(): number {
    return this._strength
  }

  private _computeFactors(width: number, height: number): void {
    this.precomputedAttenuationCellMask = new Float32Array(width * height * 3)
    this.precomputedAttenuation = new Float32Array(width * height)
    const centerX = width / 2
    const centerY = height / 2
    const maxDistSq = centerX * centerX + centerY * centerY
    const safeMaxDistSq = maxDistSq === 0 ? 1 : maxDistSq // Avoid division by zero
    const strength = this._strength
    let i = 0

    for (let y = 0; y < height; y++) {
      const dy = y - centerY
      const dySq = dy * dy
      for (let x = 0; x < width; x++) {
        const dx = x - centerX
        const distSq = dx * dx + dySq
        // Calculate base attenuation (0 to 1 based on distance)
        const baseAttenuation = Math.min(1, distSq / safeMaxDistSq)
        // Precompute final attenuation value including strength
        const attenuation = baseAttenuation * strength
        this.precomputedAttenuationCellMask[i++] = x
        this.precomputedAttenuationCellMask[i++] = y
        this.precomputedAttenuationCellMask[i++] = attenuation
        this.precomputedAttenuation[y * width + x] = attenuation
      }
    }
    this.cachedWidth = width
    this.cachedHeight = height
  }

  private _preserveGraphemeRuns(buffer: OptimizedBuffer): void {
    const baseAttenuation = this.precomputedAttenuation!
    const cellMask = this.precomputedAttenuationCellMask!
    const chars = buffer.buffers.char
    const width = buffer.width

    for (let y = 0; y < buffer.height; y++) {
      let x = 0
      while (x < width) {
        const cell = y * width + x
        if (!isGraphemeCell(chars[cell])) {
          cellMask[cell * 3 + 2] = baseAttenuation[cell]
          x++
          continue
        }

        const start = x
        while (x < width && isGraphemeCell(chars[y * width + x])) x++
        const attenuation = baseAttenuation[y * width + start + Math.floor((x - start) / 2)]
        for (let runX = start; runX < x; runX++) cellMask[(y * width + runX) * 3 + 2] = attenuation
      }
    }
  }

  /**
   * Applies the vignette effect using native colorMatrix with a zero matrix.
   * The zero matrix maps all colors to black, and the attenuation cell masks
   * control how much of the effect is applied (strength-based blending).
   */
  public apply(buffer: OptimizedBuffer): void {
    const width = buffer.width
    const height = buffer.height

    // Recompute attenuation cell masks if dimensions changed, strength changed,
    // or factors haven't been computed yet
    if (width !== this.cachedWidth || height !== this.cachedHeight || !this.precomputedAttenuationCellMask) {
      this._computeFactors(width, height)
    }

    // Style boundaries can change complex-script shaping in terminals. Keep
    // contiguous graphemes at one attenuation while other cells retain the gradient.
    this._preserveGraphemeRuns(buffer)

    // Use colorMatrix with zero matrix to apply attenuation
    // colorMatrix blends: result = original + (transformed - original) × strength
    // With zero matrix: transformed = 0
    // Result = original + (0 - original) × attenuation = original × (1 - attenuation)
    buffer.colorMatrix(VignetteEffect.zeroMatrix, this.precomputedAttenuationCellMask!, 1.0, 3)
  }
}

/**
 * Simple Perlin noise implementation for procedural cloud generation.
 * Uses gradient vectors and smooth interpolation.
 */
class PerlinNoise {
  private perm: Uint8Array
  private grad3: number[][] = [
    [1, 1, 0],
    [-1, 1, 0],
    [1, -1, 0],
    [-1, -1, 0],
    [1, 0, 1],
    [-1, 0, 1],
    [1, 0, -1],
    [-1, 0, -1],
    [0, 1, 1],
    [0, -1, 1],
    [0, 1, -1],
    [0, -1, -1],
  ]

  constructor() {
    // Permutation table for pseudo-random gradient selection
    this.perm = new Uint8Array(512)
    const p = new Uint8Array(256)
    for (let i = 0; i < 256; i++) {
      p[i] = i
    }
    // Shuffle
    for (let i = 255; i > 0; i--) {
      const r = Math.floor(Math.random() * (i + 1))
      ;[p[i], p[r]] = [p[r], p[i]]
    }
    // Duplicate for overflow handling
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255]
    }
  }

  private dot(g: number[], x: number, y: number, z: number): number {
    return g[0] * x + g[1] * y + g[2] * z
  }

  private mix(a: number, b: number, t: number): number {
    return a + (b - a) * t
  }

  private fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10)
  }

  /**
   * 3D Perlin noise at coordinates (x, y, z)
   * Returns value in range [-1, 1]
   */
  noise3d(x: number, y: number, z: number): number {
    // Find unit grid cell containing point
    const X = Math.floor(x) & 255
    const Y = Math.floor(y) & 255
    const Z = Math.floor(z) & 255

    // Get relative xyz coordinates of point within that cell
    const xf = x - Math.floor(x)
    const yf = y - Math.floor(y)
    const zf = z - Math.floor(z)

    // Compute fade curves for each of x, y, z
    const u = this.fade(xf)
    const v = this.fade(yf)
    const w = this.fade(zf)

    // Hash coordinates of the 8 cube corners
    const A = this.perm[X] + Y
    const AA = this.perm[A] + Z
    const AB = this.perm[A + 1] + Z
    const B = this.perm[X + 1] + Y
    const BA = this.perm[B] + Z
    const BB = this.perm[B + 1] + Z

    // Add blended results from 8 corners of the cube
    let res = this.mix(
      this.mix(
        this.mix(
          this.dot(this.grad3[this.perm[AA] % 12], xf, yf, zf),
          this.dot(this.grad3[this.perm[BA] % 12], xf - 1, yf, zf),
          u,
        ),
        this.mix(
          this.dot(this.grad3[this.perm[AB] % 12], xf, yf - 1, zf),
          this.dot(this.grad3[this.perm[BB] % 12], xf - 1, yf - 1, zf),
          u,
        ),
        v,
      ),
      this.mix(
        this.mix(
          this.dot(this.grad3[this.perm[AA + 1] % 12], xf, yf, zf - 1),
          this.dot(this.grad3[this.perm[BA + 1] % 12], xf - 1, yf, zf - 1),
          u,
        ),
        this.mix(
          this.dot(this.grad3[this.perm[AB + 1] % 12], xf, yf - 1, zf - 1),
          this.dot(this.grad3[this.perm[BB + 1] % 12], xf - 1, yf - 1, zf - 1),
          u,
        ),
        v,
      ),
      w,
    )

    return res
  }
}

/**
 * Applies animated cloud shadows using Perlin noise.
 * Darkens the background buffer based on procedural cloud density.
 */
export class CloudsEffect {
  private noise: PerlinNoise
  private _scale: number
  private _speed: number
  private _density: number
  private _darkness: number
  private time: number = 0

  constructor(scale: number = 0.02, speed: number = 0.5, density: number = 0.6, darkness: number = 0.7) {
    this.noise = new PerlinNoise()
    this._scale = scale
    this._speed = speed
    this._density = density
    this._darkness = darkness
  }

  public set scale(newScale: number) {
    this._scale = Math.max(0.001, newScale)
  }
  public get scale(): number {
    return this._scale
  }

  public set speed(newSpeed: number) {
    this._speed = Math.max(0, newSpeed)
  }
  public get speed(): number {
    return this._speed
  }

  public set density(newDensity: number) {
    this._density = Math.max(0, Math.min(1, newDensity))
  }
  public get density(): number {
    return this._density
  }

  public set darkness(newDarkness: number) {
    this._darkness = Math.max(0, Math.min(1, newDarkness))
  }
  public get darkness(): number {
    return this._darkness
  }

  /**
   * Applies cloud shadow effect using Perlin noise mask with native colorMatrix.
   * Uses FBM (Fractal Brownian Motion) for detailed clouds, offloaded to native code.
   */
  public apply(buffer: OptimizedBuffer, deltaTime: number): void {
    const width = buffer.width
    const height = buffer.height

    // Update time for animation
    this.time += deltaTime * this._speed

    const scale = this._scale
    const timeOffset = this.time

    // Build cell mask with per-pixel attenuation values
    // Format: [x, y, attenuation] for each pixel
    const cellMask = new Float32Array(width * height * 3)
    let maskIdx = 0

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // FBM - combine multiple octaves for detail
        let noiseValue = 0
        let amplitude = 1
        let frequency = 1
        let maxValue = 0

        // 4 octaves of noise
        for (let i = 0; i < 4; i++) {
          const nx = (x * scale * frequency + timeOffset) * 0.5
          const ny = y * scale * frequency * 0.5
          const nz = timeOffset * 0.3 // Use time as z for evolution

          noiseValue += this.noise.noise3d(nx, ny, nz) * amplitude
          maxValue += amplitude
          amplitude *= 0.5
          frequency *= 2
        }

        // Normalize to [0, 1]
        noiseValue = (noiseValue / maxValue + 1) * 0.5

        // Apply density threshold - lower density = more clouds
        const cloudDensity = Math.max(0, noiseValue - (1 - this._density))

        // Scale to actual darkness (0 = no change, 1 = full darkness)
        const attenuation = cloudDensity * this._darkness

        // Add to cell mask
        cellMask[maskIdx++] = x
        cellMask[maskIdx++] = y
        cellMask[maskIdx++] = attenuation
      }
    }

    // Use native colorMatrix with zero matrix to apply attenuation
    // Zero matrix: transformed = 0 (black)
    // Result = original + (0 - original) × attenuation = original × (1 - attenuation)
    const zeroMatrix = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    buffer.colorMatrix(zeroMatrix, cellMask, 1.0, 2) // target = 2 (background only)
  }
}

/**
 * Applies animated flames rising from the bottom using Perlin noise.
 * Creates warm fire effect that fades as it rises.
 */
export class FlamesEffect {
  private noise: PerlinNoise
  private _scale: number
  private _speed: number
  private _intensity: number
  private time: number = 0

  constructor(scale: number = 0.03, speed: number = 0.02, intensity: number = 0.8) {
    this.noise = new PerlinNoise()
    this._scale = scale
    this._speed = speed
    this._intensity = intensity
  }

  public set scale(newScale: number) {
    this._scale = Math.max(0.001, newScale)
  }
  public get scale(): number {
    return this._scale
  }

  public set speed(newSpeed: number) {
    this._speed = Math.max(0, newSpeed)
  }
  public get speed(): number {
    return this._speed
  }

  public set intensity(newIntensity: number) {
    this._intensity = Math.max(0, Math.min(1, newIntensity))
  }
  public get intensity(): number {
    return this._intensity
  }

  /**
   * Applies flame effect rising from bottom using Perlin noise.
   * Flames get cooler (redder) and fade as they rise.
   */
  public apply(buffer: OptimizedBuffer, deltaTime: number): void {
    const width = buffer.width
    const height = buffer.height
    const bg = buffer.buffers.bg

    // Update time for animation
    this.time += deltaTime * this._speed

    const scale = this._scale
    const timeOffset = this.time

    for (let y = 0; y < height; y++) {
      // Calculate height factor - stronger at bottom (1.0), fading toward top (0.0)
      const heightFactor = 1.0 - y / height

      for (let x = 0; x < width; x++) {
        // FBM - combine multiple octaves for organic flame detail
        let noiseValue = 0
        let amplitude = 1
        let frequency = 1
        let maxValue = 0

        // 3 octaves of noise for flames
        for (let i = 0; i < 3; i++) {
          // Flip y coordinate so flames rise from bottom
          const nx = (x * scale * frequency + timeOffset) * 0.5
          const ny = (height - y) * scale * frequency * 2 * 0.5
          const nz = timeOffset * 2.0 // Faster z evolution for more flicker

          noiseValue += this.noise.noise3d(nx, ny, nz) * amplitude
          maxValue += amplitude
          amplitude *= 0.5
          frequency *= 2
        }

        // Normalize to [0, 1]
        noiseValue = (noiseValue / maxValue + 1) * 0.5

        // Combine with height factor for rising fade effect
        const flameIntensity = noiseValue * heightFactor * this._intensity

        if (flameIntensity > 0) {
          const colorIndex = (y * width + x) * 4

          // Fire color gradient based on intensity
          // High intensity = white/yellow (hottest), low = red (coolest)
          let r: number, g: number, b: number

          if (flameIntensity > 0.7) {
            // White/yellow hot core
            r = 1.0
            g = 1.0
            b = 0.3 + (flameIntensity - 0.7) * 2.3 // 0.3 to 1.0
          } else if (flameIntensity > 0.4) {
            // Orange
            r = 1.0
            g = 0.5 + (flameIntensity - 0.4) * 1.67 // 0.5 to 1.0
            b = 0.0
          } else {
            // Red fading to dark
            r = 0.3 + flameIntensity * 1.75 // 0.3 to 1.0
            g = flameIntensity * 0.5 // 0.0 to 0.2
            b = 0.0
          }

          // Blend with existing background
          setRgb(
            bg,
            colorIndex,
            Math.max(channel(bg, colorIndex), r * flameIntensity),
            Math.max(channel(bg, colorIndex + 1), g * flameIntensity),
            Math.max(channel(bg, colorIndex + 2), b * flameIntensity),
          )
        }
      }
    }
  }
}

/**
 * Applies a CRT rolling bar effect - a horizontal bar that slowly scans down the screen.
 * Simulates the classic CRT monitor rolling bar artifact.
 */
export class CRTRollingBarEffect {
  private _speed: number
  private _height: number
  private _intensity: number
  private _fadeDistance: number
  private position: number = 0

  constructor(speed: number = 0.5, height: number = 0.15, intensity: number = 0.3, fadeDistance: number = 0.3) {
    this._speed = speed
    this._height = Math.max(0.01, Math.min(0.5, height))
    this._intensity = Math.max(0, Math.min(1, intensity))
    this._fadeDistance = Math.max(0, Math.min(1, fadeDistance))
  }

  public set speed(newSpeed: number) {
    this._speed = newSpeed
  }
  public get speed(): number {
    return this._speed
  }

  public set height(newHeight: number) {
    this._height = Math.max(0.01, Math.min(0.5, newHeight))
  }
  public get height(): number {
    return this._height
  }

  public set intensity(newIntensity: number) {
    this._intensity = Math.max(0, Math.min(1, newIntensity))
  }
  public get intensity(): number {
    return this._intensity
  }

  public set fadeDistance(newFadeDistance: number) {
    this._fadeDistance = Math.max(0, Math.min(1, newFadeDistance))
  }
  public get fadeDistance(): number {
    return this._fadeDistance
  }

  /**
   * Applies the rolling bar effect to the buffer.
   * Creates a smooth horizontal bar that scans down the screen with a bell-curve gradient.
   * The bar has a bright center that smoothly fades to the edges.
   */
  public apply(buffer: OptimizedBuffer, deltaTime: number): void {
    const width = buffer.width
    const height = buffer.height
    const fg = buffer.buffers.fg
    const bg = buffer.buffers.bg

    // Update bar position (convert deltaTime from ms to seconds)
    this.position += (deltaTime / 1000) * this._speed
    // Wrap position to keep it rolling continuously
    const cycleHeight = height + this._height * height * 2
    this.position = this.position % cycleHeight

    const barPixelHeight = this._height * height
    const fadePixelDistance = this._fadeDistance * barPixelHeight
    const totalEffectHeight = barPixelHeight + fadePixelDistance * 2
    const effectCenter = this.position - totalEffectHeight / 2 + barPixelHeight / 2

    for (let y = 0; y < height; y++) {
      // Calculate distance from the bar center
      const distFromCenter = Math.abs(y - effectCenter)

      // Create a smooth bell-curve effect
      // Full intensity at center, smooth falloff using Gaussian-like curve
      let barFactor = 0

      if (distFromCenter <= totalEffectHeight / 2) {
        // Normalize distance to 0-1 range across the whole effect
        const normalizedDist = distFromCenter / (totalEffectHeight / 2)
        // Cosine falloff: 1 at center, 0 at edge
        // cos(0) = 1, cos(π/2) = 0
        barFactor = Math.cos((normalizedDist * Math.PI) / 2)
      }

      if (barFactor > 0.001) {
        const rowMultiplier = 1 + this._intensity * barFactor

        for (let x = 0; x < width; x++) {
          const colorIndex = (y * width + x) * 4

          // Brighten foreground
          setRgb(
            fg,
            colorIndex,
            Math.min(1, channel(fg, colorIndex) * rowMultiplier),
            Math.min(1, channel(fg, colorIndex + 1) * rowMultiplier),
            Math.min(1, channel(fg, colorIndex + 2) * rowMultiplier),
          )

          // Brighten background
          setRgb(
            bg,
            colorIndex,
            Math.min(1, channel(bg, colorIndex) * rowMultiplier),
            Math.min(1, channel(bg, colorIndex + 1) * rowMultiplier),
            Math.min(1, channel(bg, colorIndex + 2) * rowMultiplier),
          )
        }
      }
    }
  }
}

/**
 * Applies animated rainbow colors to cells with white foreground.
 * Cycles through HSV hue spectrum over time.
 */
export class RainbowTextEffect {
  private _speed: number
  private _saturation: number
  private _value: number
  private _repeats: number
  private time: number = 0

  constructor(speed: number = 0.01, saturation: number = 1.0, value: number = 1.0, repeats: number = 3.0) {
    this._speed = speed
    this._saturation = saturation
    this._value = value
    this._repeats = repeats
  }

  public set speed(newSpeed: number) {
    this._speed = Math.max(0, newSpeed)
  }
  public get speed(): number {
    return this._speed
  }

  public set saturation(newSaturation: number) {
    this._saturation = Math.max(0, Math.min(1, newSaturation))
  }
  public get saturation(): number {
    return this._saturation
  }

  public set value(newValue: number) {
    this._value = Math.max(0, Math.min(1, newValue))
  }
  public get value(): number {
    return this._value
  }

  public set repeats(newRepeats: number) {
    this._repeats = Math.max(0.1, newRepeats)
  }
  public get repeats(): number {
    return this._repeats
  }

  /**
   * Converts HSV color to RGB
   * @param h - Hue [0, 1]
   * @param s - Saturation [0, 1]
   * @param v - Value [0, 1]
   * @returns [r, g, b] each in [0, 1]
   */
  private hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    let r = 0,
      g = 0,
      b = 0

    const i = Math.floor(h * 6)
    const f = h * 6 - i
    const p = v * (1 - s)
    const q = v * (1 - f * s)
    const t = v * (1 - (1 - f) * s)

    switch (i % 6) {
      case 0:
        r = v
        g = t
        b = p
        break
      case 1:
        r = q
        g = v
        b = p
        break
      case 2:
        r = p
        g = v
        b = t
        break
      case 3:
        r = p
        g = q
        b = v
        break
      case 4:
        r = t
        g = p
        b = v
        break
      case 5:
        r = v
        g = p
        b = q
        break
    }

    return [r, g, b]
  }

  /**
   * Applies rainbow colors to cells with white foreground.
   * White is defined as R, G, B all >= 0.9
   */
  public apply(buffer: OptimizedBuffer, deltaTime: number): void {
    const width = buffer.width
    const height = buffer.height
    const fg = buffer.buffers.fg

    // Update time for animation
    this.time += deltaTime * this._speed

    const saturation = this._saturation
    const value = this._value
    const repeats = this._repeats

    // 25 degree angle for diagonal rainbow
    const angleRad = (25 * Math.PI) / 180
    const cosAngle = Math.cos(angleRad)
    const sinAngle = Math.sin(angleRad)

    // Define white threshold
    const whiteThreshold = 0.9

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const colorIndex = (y * width + x) * 4

        const r = channel(fg, colorIndex)
        const g = channel(fg, colorIndex + 1)
        const b = channel(fg, colorIndex + 2)

        // Check if foreground is white-ish (all components >= threshold)
        if (r >= whiteThreshold && g >= whiteThreshold && b >= whiteThreshold) {
          // Calculate hue based on position projected at 25-degree angle
          // Creates a diagonal moving rainbow wave effect
          const projection = x * cosAngle + y * sinAngle
          const maxProjection = width * cosAngle + height * sinAngle
          const hue = ((projection / maxProjection) * repeats + this.time * 0.1) % 1.0

          // Convert HSV to RGB
          const [newR, newG, newB] = this.hsvToRgb(hue, saturation, value)

          setRgb(fg, colorIndex, newR, newG, newB)
        }
      }
    }
  }
}
