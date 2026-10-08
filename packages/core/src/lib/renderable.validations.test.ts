import { describe, test, expect } from "bun:test"
import {
  validateOptions,
  isPositionType,
  isDimensionType,
  isFlexBasisType,
  isSizeType,
  isMarginType,
  isPaddingType,
  isPositionTypeType,
  isOverflowType,
  isValidPercentage,
} from "./renderable.validations.js"

describe("Utility Functions", () => {
  test("validateOptions", () => {
    expect(validateOptions("test", { width: 100, height: 100 })).toBe(undefined)
    expect(() => validateOptions("test", { width: -100, height: 100 })).toThrow(TypeError)
    expect(() => validateOptions("test", { width: 100, height: -100 })).toThrow(TypeError)
  })

  test("isValidPercentage", () => {
    expect(isValidPercentage("50%")).toBe(true)
    expect(isValidPercentage("0%")).toBe(true)
    expect(isValidPercentage("100.5%")).toBe(true)
    expect(isValidPercentage("abc")).toBe(false)
    expect(isValidPercentage("50")).toBe(false)
    expect(isValidPercentage(50)).toBe(false)
  })

  test("isMarginType", () => {
    expect(isMarginType(10)).toBe(true)
    expect(isMarginType("auto")).toBe(true)
    expect(isMarginType("50%")).toBe(true)
    expect(isMarginType(NaN)).toBe(false)
    expect(isMarginType("invalid")).toBe(false)
  })

  test("isPaddingType", () => {
    expect(isPaddingType(10)).toBe(true)
    expect(isPaddingType("50%")).toBe(true)
    expect(isPaddingType("auto")).toBe(false)
    expect(isPaddingType(NaN)).toBe(false)
  })

  test("isPositionType", () => {
    expect(isPositionType(10)).toBe(true)
    expect(isPositionType("auto")).toBe(true)
    expect(isPositionType("50%")).toBe(true)
    expect(isPositionType(NaN)).toBe(false)
  })

  test("isDimensionType", () => {
    expect(isDimensionType(100)).toBe(true)
    expect(isDimensionType("auto")).toBe(true)
    expect(isDimensionType("50%")).toBe(true)
    expect(isDimensionType(NaN)).toBe(false)
  })

  test("isFlexBasisType", () => {
    expect(isFlexBasisType(100)).toBe(true)
    expect(isFlexBasisType("auto")).toBe(true)
    expect(isFlexBasisType(undefined)).toBe(true)
    expect(isFlexBasisType(NaN)).toBe(false)
  })

  test("isSizeType", () => {
    expect(isSizeType(100)).toBe(true)
    expect(isSizeType("50%")).toBe(true)
    expect(isSizeType(undefined)).toBe(true)
    expect(isSizeType(NaN)).toBe(false)
  })

  test("isPositionTypeType", () => {
    expect(isPositionTypeType("relative")).toBe(true)
    expect(isPositionTypeType("absolute")).toBe(true)
    expect(isPositionTypeType("static")).toBe(true)
    expect(isPositionTypeType("fixed")).toBe(false)
  })

  test("isOverflowType", () => {
    expect(isOverflowType("visible")).toBe(true)
    expect(isOverflowType("hidden")).toBe(true)
    expect(isOverflowType("scroll")).toBe(true)
    expect(isOverflowType("auto")).toBe(false)
  })
})
