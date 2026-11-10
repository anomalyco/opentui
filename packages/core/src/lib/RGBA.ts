export type RGBTriplet = readonly [number, number, number]
export type ColorIntent = "rgb" | "indexed" | "default"
export type ColorInput = string | RGBA

export const DEFAULT_FOREGROUND_RGB: RGBTriplet = [255, 255, 255]
export const DEFAULT_BACKGROUND_RGB: RGBTriplet = [0, 0, 0]

const INTENT_RGB = 0
const INTENT_INDEXED = 1
const INTENT_DEFAULT = 2
const ZERO_RGBA_BUFFER = new Uint16Array(4)

const ANSI16_RGB: readonly RGBTriplet[] = [
  [0x00, 0x00, 0x00],
  [0x80, 0x00, 0x00],
  [0x00, 0x80, 0x00],
  [0x80, 0x80, 0x00],
  [0x00, 0x00, 0x80],
  [0x80, 0x00, 0x80],
  [0x00, 0x80, 0x80],
  [0xc0, 0xc0, 0xc0],
  [0x80, 0x80, 0x80],
  [0xff, 0x00, 0x00],
  [0x00, 0xff, 0x00],
  [0xff, 0xff, 0x00],
  [0x00, 0x00, 0xff],
  [0xff, 0x00, 0xff],
  [0x00, 0xff, 0xff],
  [0xff, 0xff, 0xff],
]

const ANSI_256_CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const

export interface NormalizedColorValue {
  rgba: RGBA
}

function packMeta(intent: number, slot = 0): number {
  return ((slot & 0xff) | ((intent & 0xff) << 8)) >>> 0
}

function toU8(value: number): number {
  return Math.round(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 255)
}

function toByte(value: number): number {
  return Math.round(Math.max(0, Math.min(255, Number.isFinite(value) ? value : 0)))
}

function packRGBA8(r: number, g: number, b: number, a: number, meta: number): RGBA {
  const rgba = new RGBA(ZERO_RGBA_BUFFER)
  rgba.buffer[0] = (toByte(r) & 0xff) | (((meta >>> 0) & 0xff) << 8)
  rgba.buffer[1] = (toByte(g) & 0xff) | (((meta >>> 8) & 0xff) << 8)
  rgba.buffer[2] = (toByte(b) & 0xff) | (((meta >>> 16) & 0xff) << 8)
  rgba.buffer[3] = (toByte(a) & 0xff) | (((meta >>> 24) & 0xff) << 8)
  return rgba
}

function rgbaForAnsi256Index(index: number): RGBA {
  const [r, g, b] = ansi256IndexToRgb(index)
  return RGBA.fromInts(r, g, b)
}

export function normalizeIndexedColorIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    throw new RangeError(`Indexed color must be an integer in the range 0..255, got ${index}`)
  }

  return index
}

export function ansi256IndexToRgb(index: number): RGBTriplet {
  const normalizedIndex = normalizeIndexedColorIndex(index)

  if (normalizedIndex < ANSI16_RGB.length) {
    return ANSI16_RGB[normalizedIndex]
  }

  if (normalizedIndex < 232) {
    const cubeIndex = normalizedIndex - 16
    const r = Math.floor(cubeIndex / 36)
    const g = Math.floor(cubeIndex / 6) % 6
    const b = cubeIndex % 6
    return [ANSI_256_CUBE_LEVELS[r], ANSI_256_CUBE_LEVELS[g], ANSI_256_CUBE_LEVELS[b]]
  }

  const value = 8 + (normalizedIndex - 232) * 10
  return [value, value, value]
}

export class RGBA {
  buffer: Uint16Array

  constructor(buffer: Uint16Array) {
    // Every color snapshot runs this; indexed copies avoid allocating a subarray view per instance.
    // Detached buffers report length 0 and short inputs still take the checked partial copy below.
    const copy = new Uint16Array(4)
    if (buffer.length === 4) {
      copy[0] = buffer[0]
      copy[1] = buffer[1]
      copy[2] = buffer[2]
      copy[3] = buffer[3]
    } else {
      copy.set(buffer.subarray(0, 4))
    }
    this.buffer = copy
  }

  static fromArray(array: Uint16Array): RGBA {
    return new RGBA(array)
  }

  static fromValues(r: number, g: number, b: number, a: number = 1): RGBA {
    return packRGBA8(toU8(r), toU8(g), toU8(b), toU8(a), packMeta(INTENT_RGB))
  }

  static clone(rgba: RGBA): RGBA {
    return new RGBA(rgba.buffer)
  }

  static fromInts(r: number, g: number, b: number, a: number = 255): RGBA {
    return packRGBA8(r, g, b, a, packMeta(INTENT_RGB))
  }

  static fromHex(hex: string): RGBA {
    return hexToRgb(hex)
  }

  static fromIndex(index: number, snapshot?: ColorInput): RGBA {
    const normalized = normalizeIndexedColorIndex(index)
    const rgba = snapshot ? parseColor(snapshot) : rgbaForAnsi256Index(normalized)
    const [r, g, b, a] = rgba.toInts()
    return packRGBA8(r, g, b, a, packMeta(INTENT_INDEXED, normalized))
  }

  static defaultForeground(snapshot?: ColorInput): RGBA {
    const rgba = snapshot ? parseColor(snapshot) : RGBA.fromInts(...DEFAULT_FOREGROUND_RGB)
    const [r, g, b, a] = rgba.toInts()
    return packRGBA8(r, g, b, a, packMeta(INTENT_DEFAULT))
  }

  static defaultBackground(snapshot?: ColorInput): RGBA {
    const rgba = snapshot ? parseColor(snapshot) : RGBA.fromInts(...DEFAULT_BACKGROUND_RGB)
    const [r, g, b, a] = rgba.toInts()
    return packRGBA8(r, g, b, a, packMeta(INTENT_DEFAULT))
  }

  toInts(): [number, number, number, number] {
    return [this.buffer[0] & 0xff, this.buffer[1] & 0xff, this.buffer[2] & 0xff, this.buffer[3] & 0xff]
  }

  get r(): number {
    return (this.buffer[0] & 0xff) / 255
  }

  set r(value: number) {
    this.buffer[0] = (this.buffer[0] & 0xff00) | toU8(value)
  }

  get g(): number {
    return (this.buffer[1] & 0xff) / 255
  }

  set g(value: number) {
    this.buffer[1] = (this.buffer[1] & 0xff00) | toU8(value)
  }

  get b(): number {
    return (this.buffer[2] & 0xff) / 255
  }

  set b(value: number) {
    this.buffer[2] = (this.buffer[2] & 0xff00) | toU8(value)
  }

  get a(): number {
    return (this.buffer[3] & 0xff) / 255
  }

  set a(value: number) {
    this.buffer[3] = (this.buffer[3] & 0xff00) | toU8(value)
  }

  get meta(): number {
    return (
      ((this.buffer[0] >>> 8) |
        ((this.buffer[1] >>> 8) << 8) |
        ((this.buffer[2] >>> 8) << 16) |
        ((this.buffer[3] >>> 8) << 24)) >>>
      0
    )
  }

  get intent(): ColorIntent {
    switch ((this.meta >>> 8) & 0xff) {
      case INTENT_INDEXED:
        return "indexed"
      case INTENT_DEFAULT:
        return "default"
      default:
        return "rgb"
    }
  }

  get slot(): number {
    return this.meta & 0xff
  }

  map<R>(fn: (value: number) => R): [R, R, R, R] {
    return [fn(this.r), fn(this.g), fn(this.b), fn(this.a)]
  }

  toString(): string {
    return `rgba(${this.r.toFixed(2)}, ${this.g.toFixed(2)}, ${this.b.toFixed(2)}, ${this.a.toFixed(2)})`
  }

  equals(other?: RGBA): boolean {
    if (!other) return false
    return (
      this.buffer[0] === other.buffer[0] &&
      this.buffer[1] === other.buffer[1] &&
      this.buffer[2] === other.buffer[2] &&
      this.buffer[3] === other.buffer[3]
    )
  }
}

export function normalizeColorValue(value: ColorInput | null | undefined): NormalizedColorValue | null {
  if (value == null) return null
  return { rgba: parseColor(value) }
}

export function hexToRgb(hex: string): RGBA {
  hex = hex.replace(/^#/, "")

  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
  } else if (hex.length === 4) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
  }

  if (!/^[0-9A-Fa-f]{6}$/.test(hex) && !/^[0-9A-Fa-f]{8}$/.test(hex)) {
    console.warn(`Invalid hex color: ${hex}, defaulting to magenta`)
    return RGBA.fromValues(1, 0, 1, 1)
  }

  const r = parseInt(hex.substring(0, 2), 16)
  const g = parseInt(hex.substring(2, 4), 16)
  const b = parseInt(hex.substring(4, 6), 16)
  const a = hex.length === 8 ? parseInt(hex.substring(6, 8), 16) : 255

  return RGBA.fromInts(r, g, b, a)
}

export function rgbToHex(rgb: RGBA): string {
  const [r, g, b, a] = rgb.toInts()
  const components = a === 255 ? [r, g, b] : [r, g, b, a]
  return "#" + components.map((x) => x.toString(16).padStart(2, "0")).join("")
}

export function hsvToRgb(h: number, s: number, v: number): RGBA {
  let r = 0,
    g = 0,
    b = 0

  const i = Math.floor(h / 60) % 6
  const f = h / 60 - Math.floor(h / 60)
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)

  switch (i) {
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

  return RGBA.fromValues(r, g, b, 1)
}

const CSS_COLOR_NAMES: Record<string, string> = {
  black: "#000000",
  white: "#FFFFFF",
  red: "#FF0000",
  green: "#008000",
  blue: "#0000FF",
  yellow: "#FFFF00",
  cyan: "#00FFFF",
  magenta: "#FF00FF",
  silver: "#C0C0C0",
  gray: "#808080",
  grey: "#808080",
  maroon: "#800000",
  olive: "#808000",
  lime: "#00FF00",
  aqua: "#00FFFF",
  teal: "#008080",
  navy: "#000080",
  fuchsia: "#FF00FF",
  purple: "#800080",
  orange: "#FFA500",
  brightblack: "#666666",
  brightred: "#FF6666",
  brightgreen: "#66FF66",
  brightblue: "#6666FF",
  brightyellow: "#FFFF66",
  brightcyan: "#66FFFF",
  brightmagenta: "#FF66FF",
  brightwhite: "#FFFFFF",
}

export function parseColor(color: ColorInput): RGBA {
  if (typeof color === "string") {
    const lowerColor = color.toLowerCase()

    if (lowerColor === "transparent") {
      return RGBA.fromValues(0, 0, 0, 0)
    }

    if (CSS_COLOR_NAMES[lowerColor]) {
      return hexToRgb(CSS_COLOR_NAMES[lowerColor])
    }

    return hexToRgb(color)
  }
  return color
}
