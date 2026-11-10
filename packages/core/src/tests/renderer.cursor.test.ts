import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRenderer } from "../testing.js"

describe("renderer cursor state", () => {
  let renderer: TestRenderer

  beforeEach(async () => {
    ;({ renderer } = await createTestRenderer({ width: 20, height: 10 }))
  })

  afterEach(() => {
    renderer.destroy()
  })

  test("setCursorPosition preserves the terminal cursor style by default", () => {
    expect(renderer.getCursorState().style).toBe("default")

    renderer.setCursorPosition(4, 2)

    const cursorState = renderer.getCursorState()
    expect(cursorState.x).toBe(4)
    expect(cursorState.y).toBe(2)
    expect(cursorState.visible).toBe(true)
    expect(cursorState.style).toBe("default")
  })
})
