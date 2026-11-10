import type { ColorInput } from "./RGBA.js"

export interface BorderCharacters {
  topLeft: string
  topRight: string
  bottomLeft: string
  bottomRight: string
  horizontal: string
  vertical: string
  topT: string
  bottomT: string
  leftT: string
  rightT: string
  cross: string
}

export type BorderStyle = "single" | "double" | "rounded" | "heavy"
export type BorderSides = "top" | "right" | "bottom" | "left"

const VALID_BORDER_STYLES: readonly BorderStyle[] = ["single", "double", "rounded", "heavy"] as const

export function isValidBorderStyle(value: unknown): value is BorderStyle {
  return typeof value === "string" && VALID_BORDER_STYLES.includes(value as BorderStyle)
}

export function parseBorderStyle(value: unknown, fallback: BorderStyle = "single"): BorderStyle {
  if (isValidBorderStyle(value)) {
    return value
  }

  if (value !== undefined && value !== null) {
    console.warn(
      `Invalid borderStyle "${value}", falling back to "${fallback}". Valid values are: ${VALID_BORDER_STYLES.join(", ")}`,
    )
  }
  return fallback
}

export const BorderChars: Record<BorderStyle, BorderCharacters> = {
  single: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
    topT: "┬",
    bottomT: "┴",
    leftT: "├",
    rightT: "┤",
    cross: "┼",
  },
  double: {
    topLeft: "╔",
    topRight: "╗",
    bottomLeft: "╚",
    bottomRight: "╝",
    horizontal: "═",
    vertical: "║",
    topT: "╦",
    bottomT: "╩",
    leftT: "╠",
    rightT: "╣",
    cross: "╬",
  },
  rounded: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
    topT: "┬",
    bottomT: "┴",
    leftT: "├",
    rightT: "┤",
    cross: "┼",
  },
  heavy: {
    topLeft: "┏",
    topRight: "┓",
    bottomLeft: "┗",
    bottomRight: "┛",
    horizontal: "━",
    vertical: "┃",
    topT: "┳",
    bottomT: "┻",
    leftT: "┣",
    rightT: "┫",
    cross: "╋",
  },
}

export interface BorderConfig {
  borderStyle: BorderStyle
  border: boolean | BorderSides[]
  borderColor?: ColorInput
  customBorderChars?: BorderCharacters
}

export interface BoxDrawOptions {
  x: number
  y: number
  width: number
  height: number
  borderStyle: BorderStyle
  border: boolean | BorderSides[]
  borderColor: ColorInput
  customBorderChars?: BorderCharacters
  backgroundColor: ColorInput
  shouldFill?: boolean
  title?: string
  titleAlignment?: "left" | "center" | "right"
  bottomTitle?: string
  bottomTitleAlignment?: "left" | "center" | "right"
}

export interface BorderSidesConfig {
  top: boolean
  right: boolean
  bottom: boolean
  left: boolean
}

export function getBorderFromSides(sides: BorderSidesConfig): boolean | BorderSides[] {
  const result: BorderSides[] = []
  if (sides.top) result.push("top")
  if (sides.right) result.push("right")
  if (sides.bottom) result.push("bottom")
  if (sides.left) result.push("left")
  return result.length > 0 ? result : false
}

export function getBorderSides(border: boolean | BorderSides[]): BorderSidesConfig {
  return border === true
    ? { top: true, right: true, bottom: true, left: true }
    : Array.isArray(border)
      ? {
          top: border.includes("top"),
          right: border.includes("right"),
          bottom: border.includes("bottom"),
          left: border.includes("left"),
        }
      : { top: false, right: false, bottom: false, left: false }
}

// Empty border strings draw blank cells, not the NUL scalar rejected by native drawing.
export function borderCharsToArray(chars: BorderCharacters): Uint32Array {
  const array = new Uint32Array(11)
  array[0] = chars.topLeft.codePointAt(0) ?? 0x20
  array[1] = chars.topRight.codePointAt(0) ?? 0x20
  array[2] = chars.bottomLeft.codePointAt(0) ?? 0x20
  array[3] = chars.bottomRight.codePointAt(0) ?? 0x20
  array[4] = chars.horizontal.codePointAt(0) ?? 0x20
  array[5] = chars.vertical.codePointAt(0) ?? 0x20
  array[6] = chars.topT.codePointAt(0) ?? 0x20
  array[7] = chars.bottomT.codePointAt(0) ?? 0x20
  array[8] = chars.leftT.codePointAt(0) ?? 0x20
  array[9] = chars.rightT.codePointAt(0) ?? 0x20
  array[10] = chars.cross.codePointAt(0) ?? 0x20
  return array
}

// Pre-converted border character arrays for performance
export const BorderCharArrays: Record<BorderStyle, Uint32Array> = {
  single: borderCharsToArray(BorderChars.single),
  double: borderCharsToArray(BorderChars.double),
  rounded: borderCharsToArray(BorderChars.rounded),
  heavy: borderCharsToArray(BorderChars.heavy),
}
