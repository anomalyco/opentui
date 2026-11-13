import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test"
import { BoxRenderable, type BoxOptions } from "./Box.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import type { BorderStyle } from "../lib/border.js"
import { RGBA } from "../lib/RGBA.js"
import { ScrollBoxRenderable } from "./ScrollBox.js"
import sideConformance from "./box-sides.conformance.json" with { type: "json" }

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
  return testRenderer.currentRenderBuffer.withBuffers(({ char }) => String.fromCodePoint(char[getCellIndex(x, y)]))
}

function getCellForeground(x: number, y: number): [number, number, number, number] {
  const index = getCellIndex(x, y) * 4
  return testRenderer.currentRenderBuffer.withBuffers(({ fg }) => RGBA.fromArray(fg.slice(index, index + 4)).toInts())
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
  test("renders top and bottom titles on their respective borders and rejects titles over the byte limit", async () => {
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
    const assign = (title: "title" | "bottomTitle", text: string) => {
      try {
        box[title] = text
      } catch (error) {
        return String(error)
      }
    }
    const limit = "RangeError: Buffer text exceeds the native byte limit"
    // A 3-byte character straddles the 65,536-byte limit.
    expect([assign("title", "a".repeat(65_537)), assign("bottomTitle", "世".repeat(21_846))]).toEqual([limit, limit])
    expect([box.title, box.bottomTitle]).toEqual(["Top", "Bot"])
    for (const [title, text] of [
      ["title", "a".repeat(65_536)],
      ["bottomTitle", "世".repeat(21_845) + "a"],
      ["title", "Top"],
      ["bottomTitle", "Bot"],
    ] as const)
      expect(assign(title, text)).toBeUndefined()

    testRenderer.root.add(box)
    await renderOnce()

    const lines = captureFrame().split("\n")

    expect(lines[0].slice(0, 16)).toBe("┌─Top──────────┐")
    expect(lines[4].slice(0, 16)).toBe("└──────────Bot─┘")
  })

  // A box left of the frame keeps its titles in place; the cells left of column 0 are not drawn.
  test.each([
    ["left", 0, "└─Bot────────────┘"],
    ["center", 0, "└──────Bot───────┘"],
    ["right", 0, "└────────────Bot─┘"],
    ["left", -4, "t────────────┘    "],
    ["center", -4, "───Bot───────┘    "],
    ["right", -4, "─────────Bot─┘    "],
  ] as const)("renders titles with %s alignment at left %d", async (alignment, left, expectedBorder) => {
    const box = new BoxRenderable(testRenderer, {
      id: `bottom-title-${alignment}`,
      position: "absolute",
      left,
      border: true,
      width: 18,
      height: 5,
      title: "Bot",
      titleAlignment: alignment,
      bottomTitle: "Bot",
      bottomTitleAlignment: alignment,
    })

    testRenderer.root.add(box)
    await renderOnce()

    const lines = captureFrame().split("\n")
    expect([lines[0].slice(0, 18), lines[4].slice(0, 18)]).toEqual([
      expectedBorder.replace("└", "┌").replace("┘", "┐"),
      expectedBorder,
    ])
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
    buffer.withBuffers(({ char, fg, bg }) => {
      expect(char[0]).toBe("┃".codePointAt(0)!)
      expect({
        fg: RGBA.fromArray(fg.slice(0, 4)).toInts(),
        bg: RGBA.fromArray(bg.slice(0, 4)).toInts(),
      }).toEqual({
        fg: panel.toInts(),
        bg: panel.toInts(),
      })
    })
  })
})

describe("BoxRenderable - no-op rendering", () => {
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

describe("BoxRenderable - per-side borders", () => {
  type Side = "Top" | "Right" | "Bottom" | "Left"
  // A cell on each side line of an 8x4 box at the origin.
  const lineCells: Record<Side, [number, number]> = { Top: [3, 0], Right: [7, 1], Bottom: [3, 3], Left: [0, 1] }
  const horizontal = (side: Side) => side === "Top" || side === "Bottom"
  const gray = [128, 128, 128, 255]
  const green = [0, 255, 0, 255]
  const red = [255, 0, 0, 255]

  function addBox(options: BoxOptions = {}): BoxRenderable {
    const box = new BoxRenderable(testRenderer, {
      width: 8,
      height: 4,
      border: true,
      borderColor: "#808080",
      ...options,
    })
    testRenderer.root.add(box)
    return box
  }

  function line(side: Side): [string, number[]] {
    const [x, y] = lineCells[side]
    return [getCellChar(x, y), getCellForeground(x, y)]
  }

  test.each(["Top", "Right", "Bottom", "Left"] as const)(
    "the %s longhands override one side over a changed base, survive mask toggles and clear to the current base",
    async (side) => {
      const box = addBox()
      const set = box as unknown as Record<string, unknown>
      set[`border${side}Style`] = "double"
      set[`border${side}Color`] = "#ff0000"
      expect(set[`border${side}Style`]).toBe("double")
      expect((set[`border${side}Color`] as RGBA).toInts()).toEqual(red)
      await renderOnce()
      expect(line(side)).toEqual([horizontal(side) ? "═" : "║", red])
      // A base write changes the other sides only; hiding and showing the side keeps its overrides.
      box.borderStyle = "rounded"
      box.borderColor = "#00ff00"
      box.border = (["top", "right", "bottom", "left"] as const).filter((name) => name !== side.toLowerCase())
      box.border = true
      await renderOnce()
      expect(line(side)).toEqual([horizontal(side) ? "═" : "║", red])
      const other: Side = horizontal(side) ? "Left" : "Top"
      expect(line(other)).toEqual([horizontal(other) ? "─" : "│", green])
      // Clearing shows the current base, not the one in place when the override was set.
      set[`border${side}Style`] = undefined
      set[`border${side}Color`] = undefined
      expect(set[`border${side}Style`]).toBeUndefined()
      expect(set[`border${side}Color`]).toBeUndefined()
      await renderOnce()
      expect(line(side)).toEqual([horizontal(side) ? "─" : "│", green])
      expect(getCellChar(0, 0)).toBe("╭")
    },
  )

  test("constructor options draw what setters draw, and a longhand alone draws no side", async () => {
    const options = { borderTopStyle: "heavy", borderLeftColor: "#ff0000", borderRightStyle: "double" } as const
    const fromOptions = addBox(options)
    await renderOnce()
    const expected = captureFrame()
    const leftColor = getCellForeground(0, 1)
    fromOptions.destroy()
    const fromSetters = addBox()
    Object.assign(fromSetters, options)
    await renderOnce()
    expect(captureFrame()).toBe(expected)
    expect(getCellForeground(0, 1)).toEqual(leftColor)
    expect(leftColor).toEqual(red)
    fromSetters.destroy()

    const plain = new BoxRenderable(testRenderer, { width: 8, height: 4, borderTopStyle: "double" })
    const child = new BoxRenderable(testRenderer, { width: 1, height: 1, backgroundColor: "#ff0000" })
    plain.add(child)
    testRenderer.root.add(plain)
    await renderOnce()
    expect(plain.border).toBe(false)
    expect(captureFrame().split("\n")[0].trim()).toBe("")
    expect([child.x, child.y]).toEqual([0, 0])
    plain.borderBottomColor = "#ff0000"
    expect(plain.border).toBe(false)
  })

  test("focus colors every side and blur restores the overrides; titles take their side's color", async () => {
    const box = addBox({
      focusable: true,
      focusedBorderColor: "#0000ff",
      borderTopColor: "#ff0000",
      borderBottomColor: "#00ff00",
      title: "ab",
      bottomTitle: "cd",
    })
    await renderOnce()
    expect([getCellForeground(2, 0), getCellForeground(2, 3), getCellForeground(0, 1)]).toEqual([red, green, gray])
    box.focus()
    await renderOnce()
    for (const [x, y] of [
      [2, 0],
      [2, 3],
      [0, 1],
      [5, 0],
    ])
      expect(getCellForeground(x, y)).toEqual([0, 0, 255, 255])
    box.blur()
    await renderOnce()
    expect([getCellForeground(2, 0), getCellForeground(2, 3), getCellForeground(5, 3)]).toEqual([red, green, green])
    box.titleColor = "#808080"
    await renderOnce()
    expect([getCellForeground(2, 0), getCellForeground(2, 3)]).toEqual([gray, gray])
  })

  test("custom glyphs win over side styles until a border style write clears them", async () => {
    const custom = {
      topLeft: "+",
      topRight: "+",
      bottomLeft: "+",
      bottomRight: "+",
      horizontal: "-",
      vertical: "|",
      topT: "+",
      bottomT: "+",
      leftT: "+",
      rightT: "+",
      cross: "+",
    }
    const box = addBox({ customBorderChars: custom, borderTopStyle: "double" })
    await renderOnce()
    expect(captureFrame().split("\n")[0].slice(0, 8)).toBe("+------+")
    // Double meets heavy: Unicode has no mixed corner, so the top side's own corner.
    box.borderStyle = "heavy"
    await renderOnce()
    expect(captureFrame().split("\n")[0].slice(0, 8)).toBe("╔══════╗")
    expect(getCellChar(0, 1)).toBe("┃")
  })

  test("a ScrollBox root takes longhands directly and through rootOptions", async () => {
    const scroll = new ScrollBoxRenderable(testRenderer, {
      width: 8,
      height: 4,
      border: true,
      borderColor: "#808080",
      borderTopStyle: "double",
      rootOptions: { borderLeftColor: "#ff0000" },
    })
    testRenderer.root.add(scroll)
    await renderOnce()
    expect(scroll.borderTopStyle).toBe("double")
    expect(line("Top")[0]).toBe("═")
    expect(line("Left")[1]).toEqual(red)
    scroll.rootOptions = { borderLeftColor: undefined }
    scroll.borderTopStyle = undefined
    await renderOnce()
    expect(line("Left")[1]).toEqual(gray)
    expect(line("Top")[0]).toBe("─")
  })

  test("existing typed reads keep their scalar types", () => {
    const box = addBox({ borderStyle: "double", borderTopStyle: "heavy", borderTopColor: "#ff0000" })
    const style: BorderStyle = box.borderStyle
    const color: RGBA = box.borderColor
    const options: BoxOptions = { borderStyle: "rounded", borderTopStyle: "single" }
    const optionStyle: BorderStyle = options.borderStyle ?? "single"
    expect([style, color.toInts(), optionStyle]).toEqual(["double", gray, "rounded"])
  })

  test("boxes without overrides make no side call and hold no override record", () => {
    const calls = spyOn(testRenderer.nativeScene, "setBoxSides")
    const box = addBox({ borderTopStyle: undefined, borderTopColor: undefined })
    box.borderLeftStyle = undefined
    box.borderLeftColor = undefined
    expect(calls).not.toHaveBeenCalled()
    expect(Object.keys(box)).not.toContain("_sideOverrides")
    box.borderLeftColor = "#ff0000"
    box.borderLeftColor = undefined
    expect(calls).toHaveBeenCalledTimes(2)
    expect(box.borderLeftColor).toBeUndefined()
    calls.mockRestore()
  })

  test("an invalid side style warns and leaves the side on borderStyle", () => {
    const box = addBox({ borderTopStyle: "dotted" as BorderStyle })
    expect(box.borderTopStyle).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
  })

  // Rust's View draws the same frames (tests/widgets.rs).
  test.each(sideConformance.rows as unknown as [string, Record<string, unknown>, string[], string[]][])(
    "conformance: %s",
    async (_name, spec, rows, foreground) => {
      const { width, height, ...options } = spec as { width: number; height: number } & BoxOptions
      const setup = await createTestRenderer({ width, height })
      const box = new BoxRenderable(setup.renderer, { width, height, ...options })
      setup.renderer.root.add(box)
      await setup.renderOnce()
      const frame = setup.captureCharFrame().split("\n").slice(0, height)
      expect(frame.map((row) => row.trimEnd())).toEqual(rows)
      const palette = sideConformance.palette as Record<string, string>
      const colors = setup.renderer.currentRenderBuffer.withBuffers(({ fg }) =>
        foreground.map((letters, y) =>
          [...letters]
            .map((letter, x) => {
              if (letter === ".") return "."
              const index = (y * width + x) * 4
              const cell = RGBA.fromArray(fg.slice(index, index + 4)).toInts()
              const expected = RGBA.fromHex(palette[letter]).toInts()
              return cell.every((channel, at) => channel === expected[at]) ? letter : "?"
            })
            .join(""),
        ),
      )
      expect(colors).toEqual(foreground)
      setup.renderer.destroy()
    },
  )
})
