import { describe, test, expect } from "bun:test"
import { measureText, getCharacterPositions, fonts } from "./ascii.font.js"

// "*" is not defined in the tiny font, so it exercises the unknown-character
// fallback path that previously diverged between measureText/render and
// getCharacterPositions.
const FONT = "tiny" as keyof typeof fonts

describe("ascii.font getCharacterPositions", () => {
  test("last position matches measured width for known-only text", () => {
    const text = "AB"
    const positions = getCharacterPositions(text, FONT)
    const { width } = measureText({ text, font: FONT })
    expect(positions[positions.length - 1]).toBe(width)
  })

  test("does not drift after an unknown character", () => {
    // Regression: unknown chars used to add letterspace in getCharacterPositions
    // but not in measureText/renderFontToFrameBuffer, offsetting every glyph
    // after the unknown char (here "*") by letterspace_size.
    const text = "A*B"
    const positions = getCharacterPositions(text, FONT)
    const { width } = measureText({ text, font: FONT })

    // The trailing position must equal the rendered/measured width.
    expect(positions[positions.length - 1]).toBe(width)
    // One position per character boundary, plus the leading 0.
    expect(positions.length).toBe(text.length + 1)
    // Positions are monotonically non-decreasing and never exceed the width.
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]!)
      expect(positions[i]).toBeLessThanOrEqual(width)
    }
  })

  test("stays aligned with multiple unknown characters", () => {
    const text = "A* B*C"
    const positions = getCharacterPositions(text, FONT)
    const { width } = measureText({ text, font: FONT })
    expect(positions[positions.length - 1]).toBe(width)
  })
})
