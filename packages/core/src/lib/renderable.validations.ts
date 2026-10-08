import type { RenderableOptions, Renderable } from "../Renderable.js"
import type { PositionTypeString, OverflowString } from "./yoga.options.js"

export function validateOptions(id: string, options: RenderableOptions<Renderable>): void {
  if (typeof options.width === "number") {
    if (options.width < 0) {
      throw new TypeError(`Invalid width for Renderable ${id}: ${options.width}`)
    }
  }
  if (typeof options.height === "number") {
    if (options.height < 0) {
      throw new TypeError(`Invalid height for Renderable ${id}: ${options.height}`)
    }
  }
}

export function isValidPercentage(value: any): value is `${number}%` {
  if (typeof value === "string" && value.endsWith("%")) {
    const numPart = value.slice(0, -1)
    const num = parseFloat(numPart)
    return !Number.isNaN(num)
  }
  return false
}

export function isMarginType(value: any): value is number | "auto" | `${number}%` {
  if (typeof value === "number" && !Number.isNaN(value)) {
    return true
  }
  if (value === "auto") {
    return true
  }
  return isValidPercentage(value)
}

export function isPaddingType(value: any): value is number | `${number}%` {
  if (typeof value === "number" && !Number.isNaN(value)) {
    return true
  }
  return isValidPercentage(value)
}

export function isPositionType(value: any): value is number | "auto" | `${number}%` {
  if (typeof value === "number" && !Number.isNaN(value)) {
    return true
  }
  if (value === "auto") {
    return true
  }
  return isValidPercentage(value)
}

export function isPositionTypeType(value: any): value is PositionTypeString {
  return value === "static" || value === "relative" || value === "absolute"
}

export function isOverflowType(value: any): value is OverflowString {
  return value === "visible" || value === "hidden" || value === "scroll"
}

export function isDimensionType(value: any): value is number | "auto" | `${number}%` {
  return isPositionType(value)
}

export function isFlexBasisType(value: any): value is number | "auto" | undefined {
  if (value === undefined || value === "auto") {
    return true
  }
  if (typeof value === "number" && !Number.isNaN(value)) {
    return true
  }
  return false
}

export function isSizeType(value: any): value is number | `${number}%` | undefined {
  if (value === undefined) {
    return true
  }
  if (typeof value === "number" && !Number.isNaN(value)) {
    return true
  }
  return isValidPercentage(value)
}
