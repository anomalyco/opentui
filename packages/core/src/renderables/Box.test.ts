import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test"
import { BoxRenderable, type BoxOptions } from "./Box.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { BorderChars, type BorderStyle } from "../lib/border.js"
import { RGBA } from "../lib/RGBA.js"

let testRenderer: TestRenderer
let renderOnce: () => Promise<void>
let captureFrame: () => string
let warnSpy: ReturnType<typeof spyOn>

beforeEach(async () => {
  ;({ renderer: testRenderer, renderOnce, captureCharFrame: captureFrame } = await createTestRenderer({}))
  warnSpy = spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  testRenderer.destroy()
  warnSpy.mockRestore()
})

function getCellIndex(x: number, y: number): number {
  return y * testRenderer.currentRenderBuffer.width + x
}

function getCellChar(x: number, y: number): string {
  return String.fromCodePoint(testRenderer.currentRenderBuffer.buffers.char[getCellIndex(x, y)])
}

function getCellForeground(x: number, y: number): [number, number, number, number] {
  const index = getCellIndex(x, y) * 4
  return RGBA.fromArray(testRenderer.currentRenderBuffer.buffers.fg.slice(index, index + 4)).toInts()
}

describe("BoxRenderable - focusable option", () => {
  test("is not focusable by default", async () => {
    const box = new BoxRenderable(testRenderer, {
      id: "test-box",
      width: 10,
      height: 5,
    })

    expect(box.focusable).toBe(false)
    box.focus()
    expect(box.focused).toBe(false)
  })

  test("can be made focusable via option", async () => {
    const box = new BoxRenderable(testRenderer, {
      id: "test-box",
      focusable: true,
      width: 10,
      height: 5,
    })

    expect(box.focusable).toBe(true)
    box.focus()
    expect(box.focused).toBe(true)
  })
})

describe("BoxRenderable - borderStyle validation", () => {
  describe("regression: invalid borderStyle via constructor does not crash", () => {
    test("handles invalid string borderStyle in constructor", async () => {
      const box = new BoxRenderable(testRenderer, {
        id: "test-box",
        borderStyle: "invalid-style" as BorderStyle,
        border: true,
        width: 10,
        height: 5,
      })

      testRenderer.root.add(box)
      await renderOnce()

      expect(box.borderStyle).toBe("single")
      expect(box.isDestroyed).toBe(false)
    })

    test("handles undefined borderStyle in constructor", async () => {
      const box = new BoxRenderable(testRenderer, {
        id: "test-box",
        borderStyle: undefined,
        border: true,
        width: 10,
        height: 5,
      })

      testRenderer.root.add(box)
      await renderOnce()

      expect(box.borderStyle).toBe("single")
      expect(box.isDestroyed).toBe(false)
    })
  })

  describe("regression: invalid borderStyle via setter does not crash", () => {
    test("handles invalid string borderStyle via setter", async () => {
      const box = new BoxRenderable(testRenderer, {
        id: "test-box",
        borderStyle: "double",
        border: true,
        width: 10,
        height: 5,
      })

      testRenderer.root.add(box)
      await renderOnce()

      expect(box.borderStyle).toBe("double")

      box.borderStyle = "invalid-style" as BorderStyle
      await renderOnce()

      expect(box.borderStyle).toBe("single")
      expect(box.isDestroyed).toBe(false)
    })

    test("renders correctly after fallback from invalid borderStyle", async () => {
      const box = new BoxRenderable(testRenderer, {
        id: "test-box",
        borderStyle: "invalid" as BorderStyle,
        border: true,
        width: 10,
        height: 5,
      })

      testRenderer.root.add(box)

      // Should not throw during render
      await expect(renderOnce()).resolves.toBeUndefined()
      expect(box.isDestroyed).toBe(false)
    })
  })

  describe("valid borderStyle values work correctly", () => {
    test.each(["single", "double", "rounded", "heavy"] as BorderStyle[])(
      "accepts valid borderStyle '%s' in constructor",
      async (style) => {
        const box = new BoxRenderable(testRenderer, {
          id: "test-box",
          borderStyle: style,
          border: true,
          width: 10,
          height: 5,
        })

        testRenderer.root.add(box)
        await renderOnce()

        expect(box.borderStyle).toBe(style)
      },
    )

    test.each(["single", "double", "rounded", "heavy"] as BorderStyle[])(
      "accepts valid borderStyle '%s' via setter",
      async (style) => {
        const box = new BoxRenderable(testRenderer, {
          id: "test-box",
          border: true,
          width: 10,
          height: 5,
        })

        testRenderer.root.add(box)
        await renderOnce()

        box.borderStyle = style
        await renderOnce()

        expect(box.borderStyle).toBe(style)
      },
    )
  })
})

describe("BoxRenderable - border titles (top and bottom)", () => {
  test("renders top and bottom titles on their respective borders", async () => {
    const box = new BoxRenderable(testRenderer, {
      id: "border-title-box",
      border: true,
      width: 16,
      height: 5,
      title: "Top",
      titleAlignment: "left",
      bottomTitle: "Bot",
      bottomTitleAlignment: "right",
    })

    testRenderer.root.add(box)
    await renderOnce()

    const lines = captureFrame().split("\n")

    expect(lines[0].slice(0, 16)).toBe("┌─Top──────────┐")
    expect(lines[4].slice(0, 16)).toBe("└──────────Bot─┘")
  })

  test.each([
    ["left", "└─Bot────────────┘"],
    ["center", "└──────Bot───────┘"],
    ["right", "└────────────Bot─┘"],
  ] as const)("renders bottom title with %s alignment", async (alignment, expectedBorder) => {
    const box = new BoxRenderable(testRenderer, {
      id: `bottom-title-${alignment}`,
      border: true,
      width: 18,
      height: 5,
      bottomTitle: "Bot",
      bottomTitleAlignment: alignment,
    })

    testRenderer.root.add(box)
    await renderOnce()

    const lines = captureFrame().split("\n")
    expect(lines[4].slice(0, 18)).toBe(expectedBorder)
  })

  test("sets titleColor and triggers render on change", () => {
    const box = new BoxRenderable(testRenderer, {
      id: "title-color-test",
      titleColor: "#ff0000",
    })

    expect(box.titleColor?.toInts()).toEqual([255, 0, 0, 255])

    const renderSpy = spyOn(box as any, "requestRender")

    box.titleColor = "#00ff00"

    expect(box.titleColor?.toInts()).toEqual([0, 255, 0, 255])
    expect(renderSpy).toHaveBeenCalledTimes(1)
  })
})

describe("BoxRenderable - transparent border blending", () => {
  test("blends transparent border foreground against the box background", async () => {
    const panel = RGBA.fromHex("#123456")
    const box = new BoxRenderable(testRenderer, {
      id: "transparent-border-box",
      width: 6,
      height: 3,
      border: ["left"],
      borderStyle: "heavy",
      borderColor: RGBA.fromInts(0, 0, 0, 0),
      backgroundColor: panel,
    })

    testRenderer.root.add(box)
    await renderOnce()

    const buffer = testRenderer.currentRenderBuffer
    expect(buffer.buffers.char[0]).toBe("┃".codePointAt(0)!)
    expect({
      fg: RGBA.fromArray(buffer.buffers.fg.slice(0, 4)).toInts(),
      bg: RGBA.fromArray(buffer.buffers.bg.slice(0, 4)).toInts(),
    }).toEqual({
      fg: panel.toInts(),
      bg: panel.toInts(),
    })
  })
})

describe("BoxRenderable - focus-within", () => {
  test("hasFocusedDescendant is false initially", async () => {
    const parent = new BoxRenderable(testRenderer, {
      id: "parent",
      focusable: true,
      border: true,
      width: 10,
      height: 5,
    })
    const child = new BoxRenderable(testRenderer, {
      id: "child",
      focusable: true,
      width: 5,
      height: 3,
    })

    parent.add(child)
    testRenderer.root.add(parent)
    await renderOnce()

    expect(parent.hasFocusedDescendant).toBe(false)
  })

  test("hasFocusedDescendant becomes true when child is focused", async () => {
    const parent = new BoxRenderable(testRenderer, {
      id: "parent",
      focusable: true,
      border: true,
      width: 10,
      height: 5,
    })
    const child = new BoxRenderable(testRenderer, {
      id: "child",
      focusable: true,
      width: 5,
      height: 3,
    })

    parent.add(child)
    testRenderer.root.add(parent)
    await renderOnce()

    child.focus()

    expect(child.focused).toBe(true)
    expect(parent.hasFocusedDescendant).toBe(true)
  })

  test("hasFocusedDescendant becomes false when child is blurred", async () => {
    const parent = new BoxRenderable(testRenderer, {
      id: "parent",
      focusable: true,
      border: true,
      width: 10,
      height: 5,
    })
    const child = new BoxRenderable(testRenderer, {
      id: "child",
      focusable: true,
      width: 5,
      height: 3,
    })

    parent.add(child)
    testRenderer.root.add(parent)
    await renderOnce()

    child.focus()
    expect(parent.hasFocusedDescendant).toBe(true)

    child.blur()
    expect(parent.hasFocusedDescendant).toBe(false)
  })

  test("propagates up the ancestor chain", async () => {
    const grandparent = new BoxRenderable(testRenderer, {
      id: "grandparent",
      focusable: true,
      border: true,
      width: 20,
      height: 10,
    })
    const parent = new BoxRenderable(testRenderer, {
      id: "parent",
      focusable: true,
      width: 15,
      height: 8,
    })
    const child = new BoxRenderable(testRenderer, {
      id: "child",
      focusable: true,
      width: 5,
      height: 3,
    })

    grandparent.add(parent)
    parent.add(child)
    testRenderer.root.add(grandparent)
    await renderOnce()

    child.focus()

    expect(parent.hasFocusedDescendant).toBe(true)
    expect(grandparent.hasFocusedDescendant).toBe(true)
  })
})

describe("BoxRenderable - no-op rendering", () => {
  test("skips drawBox for transparent layout-only boxes", () => {
    const box = new BoxRenderable(testRenderer, {
      id: "layout-only",
      width: 10,
      height: 5,
    })

    let called = false
    const buffer = {
      drawBox() {
        called = true
      },
    }

    ;(box as any).renderSelf(buffer)
    expect(called).toBe(false)
  })

  test("still draws boxes with a visible fill", () => {
    const box = new BoxRenderable(testRenderer, {
      id: "filled-box",
      width: 10,
      height: 5,
      backgroundColor: "#112233",
    })

    let called = false
    const buffer = {
      drawBox() {
        called = true
      },
    }

    ;(box as any).renderSelf(buffer)
    expect(called).toBe(true)
  })

  test("still draws boxes with borders", () => {
    const box = new BoxRenderable(testRenderer, {
      id: "bordered-box",
      width: 10,
      height: 5,
      border: true,
    })

    let called = false
    const buffer = {
      drawBox() {
        called = true
      },
    }

    ;(box as any).renderSelf(buffer)
    expect(called).toBe(true)
  })

  test("renders titles with titleColor even if border is transparent", async () => {
    const box = new BoxRenderable(testRenderer, {
      id: "title-color-transparent-border",
      border: true,
      width: 10,
      height: 5,
      title: "Test",
      bottomTitle: "Bot",
      bottomTitleAlignment: "right",
      titleColor: "#ff0000",
      borderColor: "transparent",
      backgroundColor: "transparent",
    })

    testRenderer.root.add(box)
    await renderOnce()

    const lines = captureFrame().split("\n")
    expect(lines[0].slice(0, 10)).toBe("  Test    ")
    expect(lines[4].slice(0, 10)).toBe("     Bot  ")
    expect(getCellChar(0, 0)).toBe(" ")
    expect(getCellChar(2, 0)).toBe("T")
    expect(getCellForeground(2, 0)).toEqual([255, 0, 0, 255])
    expect(getCellChar(5, 4)).toBe("B")
    expect(getCellForeground(5, 4)).toEqual([255, 0, 0, 255])
  })

  test("falls back to borderColor when titleColor is unset", async () => {
    const box = new BoxRenderable(testRenderer, {
      id: "title-color-border-fallback",
      border: true,
      width: 10,
      height: 3,
      title: "Test",
      borderColor: "#0000ff",
      backgroundColor: "transparent",
    })

    testRenderer.root.add(box)
    await renderOnce()

    expect(captureFrame().split("\n")[0].slice(0, 10)).toBe("┌─Test───┐")
    expect(getCellForeground(0, 0)).toEqual([0, 0, 255, 255])
    expect(getCellForeground(2, 0)).toEqual([0, 0, 255, 255])
  })
})

describe("BoxRenderable - default fallbacks when props are removed", () => {
  function topLine(width: number): string {
    return captureFrame().split("\n")[0].slice(0, width)
  }

  test("border-related setter implies a border on a borderless box", async () => {
    const box = new BoxRenderable(testRenderer, {
      id: "implied-border",
      width: 10,
      height: 4,
    })
    testRenderer.root.add(box)

    box.borderStyle = "double"
    await renderOnce()

    expect(box.border).toBe(true)
    expect(topLine(10)).toBe("╔════════╗")
  })

  test("removing the border-implying prop turns the border back off", async () => {
    const box = new BoxRenderable(testRenderer, {
      id: "removable-border",
      width: 10,
      height: 4,
      borderStyle: "double",
    })
    testRenderer.root.add(box)
    await renderOnce()
    expect(topLine(10)).toBe("╔════════╗")

    box.borderStyle = undefined
    await renderOnce()

    expect(box.border).toBe(false)
    expect(topLine(10)).toBe("          ")
  })

  test("explicit border: false wins over border-implying props", async () => {
    const box = new BoxRenderable(testRenderer, {
      id: "explicit-border-off",
      width: 10,
      height: 4,
      border: false,
      borderStyle: "double",
    })
    testRenderer.root.add(box)
    await renderOnce()

    expect(box.border).toBe(false)
    expect(topLine(10)).toBe("          ")
  })

  test("removing border keeps the border implied by borderStyle", async () => {
    const box = new BoxRenderable(testRenderer, {
      id: "border-removed-style-kept",
      width: 10,
      height: 4,
      border: true,
      borderStyle: "double",
    })
    testRenderer.root.add(box)

    box.border = undefined
    await renderOnce()

    expect(box.border).toBe(true)
    expect(topLine(10)).toBe("╔════════╗")
  })

  test("removing borderColor falls back to the default color but keeps an explicit border", () => {
    const box = new BoxRenderable(testRenderer, {
      id: "border-color-reset",
      width: 10,
      height: 4,
      border: true,
      borderColor: "#ff0000",
    })

    expect(box.borderColor.toInts()).toEqual([255, 0, 0, 255])

    box.borderColor = undefined

    expect(box.borderColor.toInts()).toEqual([255, 255, 255, 255])
    expect(box.border).toBe(true)
  })

  test("removing borderColor removes the border it implied", async () => {
    const box = new BoxRenderable(testRenderer, {
      id: "implied-border-color",
      width: 10,
      height: 4,
      borderColor: "#ff0000",
    })
    testRenderer.root.add(box)
    await renderOnce()
    expect(topLine(10)).toBe("┌────────┐")

    box.borderColor = undefined
    await renderOnce()

    expect(box.border).toBe(false)
    expect(topLine(10)).toBe("          ")
  })

  test("custom border chars imply a border and removal reverts", async () => {
    const box = new BoxRenderable(testRenderer, {
      id: "implied-custom-chars",
      width: 10,
      height: 4,
    })
    testRenderer.root.add(box)

    box.customBorderChars = BorderChars.double
    await renderOnce()
    expect(box.border).toBe(true)
    expect(topLine(10)).toBe("╔════════╗")

    box.customBorderChars = undefined
    await renderOnce()
    expect(box.border).toBe(false)
    expect(topLine(10)).toBe("          ")
  })

  test("removing backgroundColor falls back to transparent", () => {
    const box = new BoxRenderable(testRenderer, {
      id: "bg-reset",
      width: 4,
      height: 2,
      backgroundColor: "#123456",
    })

    expect(box.backgroundColor.toInts()).toEqual([18, 52, 86, 255])

    box.backgroundColor = undefined

    expect(box.backgroundColor.a).toBe(0)
  })

  test("removing focusedBorderColor falls back to the default", () => {
    const box = new BoxRenderable(testRenderer, {
      id: "focused-color-reset",
      focusable: true,
      border: true,
      focusedBorderColor: "#ff0000",
    })

    expect(box.focusedBorderColor.toInts()).toEqual([255, 0, 0, 255])

    box.focusedBorderColor = undefined

    expect(box.focusedBorderColor.toInts()).toEqual([0, 170, 255, 255])
  })

  test("removing title alignments falls back to left", async () => {
    const box = new BoxRenderable(testRenderer, {
      id: "alignment-reset",
      width: 18,
      height: 5,
      border: true,
      title: "Top",
      titleAlignment: "right",
      bottomTitle: "Bot",
      bottomTitleAlignment: "right",
    })
    testRenderer.root.add(box)
    await renderOnce()

    let lines = captureFrame().split("\n")
    expect(lines[0].slice(0, 18)).toBe("┌────────────Top─┐")
    expect(lines[4].slice(0, 18)).toBe("└────────────Bot─┘")

    box.titleAlignment = undefined
    box.bottomTitleAlignment = undefined
    await renderOnce()

    lines = captureFrame().split("\n")
    expect(lines[0].slice(0, 18)).toBe("┌─Top────────────┐")
    expect(lines[4].slice(0, 18)).toBe("└─Bot────────────┘")
  })
})
