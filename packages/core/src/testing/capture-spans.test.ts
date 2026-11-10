import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer } from "./test-renderer.js"
import { TextRenderable } from "../renderables/Text.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextAttributes, type CapturedFrame } from "../types.js"
import { RGBA } from "../lib/index.js"
import { StyledText } from "../lib/styled-text.js"

describe("captureSpans", () => {
  let renderer: TestRenderer
  let renderOnce: () => Promise<void>
  let captureSpans: () => CapturedFrame

  beforeEach(async () => {
    const setup = await createTestRenderer({ width: 40, height: 10 })
    renderer = setup.renderer
    renderOnce = setup.renderOnce
    captureSpans = setup.captureSpans
  })

  afterEach(() => {
    renderer.destroy()
  })

  test("returns correct dimensions and line count", async () => {
    await renderOnce()
    const data = captureSpans()

    expect(data.cols).toBe(40)
    expect(data.rows).toBe(10)
    expect(data.lines.length).toBe(10)
  })

  test("captures text content in spans", async () => {
    const text = new TextRenderable(renderer, { content: "Hello World" })
    renderer.root.add(text)
    await renderOnce()

    const data = captureSpans()
    const firstLine = data.lines[0]
    const textContent = firstLine.spans.map((s) => s.text).join("")

    expect(textContent).toContain("Hello World")
  })

  test("groups consecutive cells with same styling into single span", async () => {
    const text = new TextRenderable(renderer, { content: "AAAA" })
    renderer.root.add(text)
    await renderOnce()

    const data = captureSpans()
    const firstLine = data.lines[0]
    const aaaSpan = firstLine.spans.find((s) => s.text.includes("AAAA"))

    expect(aaaSpan).toBeDefined()
    expect(aaaSpan!.width).toBeGreaterThanOrEqual(4)
  })

  test("captures foreground color", async () => {
    const text = new TextRenderable(renderer, {
      content: "Red Text",
      fg: RGBA.fromHex("#ff0000"),
    })
    renderer.root.add(text)
    await renderOnce()

    const data = captureSpans()
    const firstLine = data.lines[0]
    const redSpan = firstLine.spans.find((s) => s.text.includes("Red"))

    expect(redSpan).toBeDefined()
    expect(redSpan!.fg.r).toBe(1)
    expect(redSpan!.fg.g).toBe(0)
    expect(redSpan!.fg.b).toBe(0)
  })

  test("captures background color", async () => {
    const box = new BoxRenderable(renderer, {
      width: 10,
      height: 3,
      backgroundColor: RGBA.fromHex("#00ff00"),
    })
    renderer.root.add(box)
    await renderOnce()

    const data = captureSpans()
    const secondLine = data.lines[1]
    const greenSpan = secondLine.spans.find((s) => s.bg.g === 1 && s.bg.r === 0 && s.bg.b === 0)

    expect(greenSpan).toBeDefined()
  })

  test("returns alpha 0 for transparent colors", async () => {
    await renderOnce()

    const data = captureSpans()
    const firstLine = data.lines[0]
    const transparentSpan = firstLine.spans.find((s) => s.bg.a === 0)

    expect(transparentSpan).toBeDefined()
  })

  test("captures text attributes", async () => {
    const text = new TextRenderable(renderer, {
      content: "Styled",
      attributes: TextAttributes.BOLD | TextAttributes.ITALIC | TextAttributes.UNDERLINE | TextAttributes.DIM,
    })
    renderer.root.add(text)
    await renderOnce()

    const data = captureSpans()
    const firstLine = data.lines[0]
    const styledSpan = firstLine.spans.find((s) => s.text.includes("Styled"))

    expect(styledSpan).toBeDefined()
    expect(styledSpan!.attributes & TextAttributes.BOLD).toBeTruthy()
    expect(styledSpan!.attributes & TextAttributes.ITALIC).toBeTruthy()
    expect(styledSpan!.attributes & TextAttributes.UNDERLINE).toBeTruthy()
    expect(styledSpan!.attributes & TextAttributes.DIM).toBeTruthy()
  })

  test("includes cursor position", async () => {
    await renderOnce()
    const data = captureSpans()

    expect(data.cursor).toEqual([expect.any(Number), expect.any(Number)])
  })

  test("splits spans when styling changes", async () => {
    const text1 = new TextRenderable(renderer, {
      content: "AAA",
      fg: RGBA.fromHex("#ff0000"),
    })
    const text2 = new TextRenderable(renderer, {
      content: "BBB",
      fg: RGBA.fromHex("#00ff00"),
    })
    renderer.root.add(text1)
    renderer.root.add(text2)
    await renderOnce()

    const data = captureSpans()
    const allSpans = data.lines.flatMap((l) => l.spans)

    expect(allSpans.some((s) => s.fg.r === 1 && s.fg.g === 0)).toBe(true)
    expect(allSpans.some((s) => s.fg.g === 1 && s.fg.r === 0)).toBe(true)
  })

  test("preserves tag-only color intent differences in captured spans", async () => {
    const text = new TextRenderable(renderer, {
      content: new StyledText([
        { __isChunk: true, text: "A", fg: RGBA.fromHex("#aabbcc") },
        { __isChunk: true, text: "B", fg: RGBA.defaultForeground("#aabbcc") },
      ]),
    })

    renderer.root.add(text)
    await renderOnce()

    const firstLine = captureSpans().lines[0]
    const contentSpans = firstLine.spans.filter((span) => span.text.trim().length > 0)

    expect(contentSpans).toHaveLength(2)
    expect(contentSpans[0].text).toBe("A")
    expect(contentSpans[1].text).toBe("B")
    expect(contentSpans[0].fg.intent).toBe("rgb")
    expect(contentSpans[1].fg.intent).toBe("default")
  })

  test("handles box-drawing characters without crashing", async () => {
    const text = new TextRenderable(renderer, {
      content: "├── folder",
    })
    renderer.root.add(text)
    await renderOnce()

    const data = captureSpans()
    const firstLine = data.lines[0]
    const textContent = firstLine.spans.map((s) => s.text).join("")

    expect(textContent).toContain("├── folder")
  })

  test("handles box borders without crashing", async () => {
    const box = new BoxRenderable(renderer, {
      width: 10,
      height: 4,
      border: true,
      borderStyle: "single",
      borderColor: RGBA.fromHex("#ffffff"),
    })
    renderer.root.add(box)
    await renderOnce()

    const data = captureSpans()
    expect(data.lines.length).toBe(10)

    const firstLine = data.lines[0]
    const textContent = firstLine.spans.map((s) => s.text).join("")
    expect(textContent.includes("┌") || textContent.includes("─")).toBe(true)
  })

  test("handles multi-width characters correctly", async () => {
    const text = new TextRenderable(renderer, {
      content: "A🌟B",
    })
    renderer.root.add(text)
    await renderOnce()

    const data = captureSpans()
    const firstLine = data.lines[0]
    const textContent = firstLine.spans.map((s) => s.text).join("")

    expect(textContent).toContain("A🌟B")
  })
})
