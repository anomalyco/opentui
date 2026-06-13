import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer } from "../../testing.js"
import { LineNumberRenderable } from "../LineNumberRenderable.js"
import { CodeRenderable } from "../Code.js"
import { BoxRenderable } from "../Box.js"
import { ScrollBoxRenderable } from "../ScrollBox.js"
import { SyntaxStyle } from "../../syntax-style.js"
import { RGBA } from "../../lib/RGBA.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let captureCharFrame: () => string

beforeEach(async () => {
  const testRenderer = await createTestRenderer({ width: 60, height: 20 })
  currentRenderer = testRenderer.renderer
  renderOnce = testRenderer.renderOnce
  captureCharFrame = testRenderer.captureCharFrame
})

afterEach(async () => {
  if (currentRenderer) {
    currentRenderer.destroy()
  }
})

// Helper to generate multi-line code content
function generateCode(lineCount: number): string {
  const lines: string[] = []
  for (let i = 1; i <= lineCount; i++) {
    lines.push(`function test${i}() {`)
    lines.push(`  console.log("Line ${i}");`)
    lines.push(`  return ${i};`)
    lines.push(`}`)
  }
  return lines.join("\n")
}

async function settleCodeRenderables(...codeRenderables: CodeRenderable[]): Promise<void> {
  await renderOnce()
  await Promise.all(codeRenderables.map((codeRenderable) => codeRenderable.highlightingDone))
  await renderOnce()
}

describe("LineNumberRenderable in ScrollBox", () => {
  test("single Code renderable with line numbers in ScrollBox - correct dimensions", async () => {
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
    })

    const code = generateCode(20) // 80 lines of code
    const codeRenderable = new CodeRenderable(currentRenderer, {
      id: "code-1",
      content: code,
      filetype: "javascript",
      syntaxStyle,
      width: "100%",
      height: "auto",
    })

    const lineNumberRenderable = new LineNumberRenderable(currentRenderer, {
      id: "line-number-1",
      target: codeRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#888888",
      bg: "transparent",
      width: "100%",
      height: "100%",
    })

    const box = new BoxRenderable(currentRenderer, {
      id: "box-1",
      border: true,
      borderStyle: "single",
      borderColor: "#ffffff",
      width: 30,
      height: 10,
    })

    box.add(lineNumberRenderable)

    const scrollBox = new ScrollBoxRenderable(currentRenderer, {
      id: "scroll-1",
      width: "100%",
      height: "100%",
      scrollY: true,
      scrollX: false,
    })

    scrollBox.add(box)
    currentRenderer.root.add(scrollBox)

    await settleCodeRenderables(codeRenderable)

    // Check initial dimensions
    const gutter = lineNumberRenderable["gutter"]
    expect(gutter).toBeDefined()
    expect(gutter!.width).toBeGreaterThan(0)
    expect(gutter!.height).toBeGreaterThan(0)

    // Box should have correct dimensions (minus borders)
    expect(box.width).toBe(30)
    expect(box.height).toBe(10)

    // LineNumberRenderable should fill the box (minus borders)
    expect(lineNumberRenderable.width).toBe(28) // 30 - 2 for borders
    expect(lineNumberRenderable.height).toBe(8) // 10 - 2 for borders

    const frame = captureCharFrame()
    expect(frame).toMatchSnapshot()
  })

  test("single Code renderable in ScrollBox - scroll and verify dimensions", async () => {
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
    })

    const code = generateCode(30) // 120 lines of code
    const codeRenderable = new CodeRenderable(currentRenderer, {
      id: "code-scroll",
      content: code,
      filetype: "javascript",
      syntaxStyle,
      width: "100%",
      height: "auto",
    })

    const lineNumberRenderable = new LineNumberRenderable(currentRenderer, {
      id: "line-number-scroll",
      target: codeRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#888888",
      width: "100%",
      height: "100%",
    })

    const box = new BoxRenderable(currentRenderer, {
      id: "box-scroll",
      border: true,
      width: 40,
      height: 12,
    })

    box.add(lineNumberRenderable)

    const scrollBox = new ScrollBoxRenderable(currentRenderer, {
      id: "scroll-scroll",
      width: "100%",
      height: "100%",
    })

    scrollBox.add(box)
    currentRenderer.root.add(scrollBox)

    await settleCodeRenderables(codeRenderable)

    const gutterBeforeScroll = lineNumberRenderable["gutter"]!
    const widthBeforeScroll = gutterBeforeScroll.width
    const heightBeforeScroll = gutterBeforeScroll.height
    const lineNumWidthBeforeScroll = lineNumberRenderable.width
    const lineNumHeightBeforeScroll = lineNumberRenderable.height

    const frameBeforeScroll = captureCharFrame()
    expect(frameBeforeScroll).toMatchSnapshot()

    // Scroll down
    scrollBox.scrollBy(10)
    await settleCodeRenderables(codeRenderable)

    const gutterAfterScroll = lineNumberRenderable["gutter"]!
    const widthAfterScroll = gutterAfterScroll.width
    const heightAfterScroll = gutterAfterScroll.height
    const lineNumWidthAfterScroll = lineNumberRenderable.width
    const lineNumHeightAfterScroll = lineNumberRenderable.height

    // Dimensions should remain stable after scrolling
    expect(widthAfterScroll).toBe(widthBeforeScroll)
    expect(heightAfterScroll).toBe(heightBeforeScroll)
    expect(lineNumWidthAfterScroll).toBe(lineNumWidthBeforeScroll)
    expect(lineNumHeightAfterScroll).toBe(lineNumHeightBeforeScroll)

    const frameAfterScroll = captureCharFrame()
    expect(frameAfterScroll).toMatchSnapshot()

    // Scroll to bottom
    scrollBox.scrollBy(1000)
    await renderOnce()

    const widthAtBottom = lineNumberRenderable["gutter"]!.width
    const heightAtBottom = lineNumberRenderable["gutter"]!.height

    expect(widthAtBottom).toBe(widthBeforeScroll)
    expect(heightAtBottom).toBe(heightBeforeScroll)

    const frameAtBottom = captureCharFrame()
    expect(frameAtBottom).toMatchSnapshot()
  })

  test("multiple Code renderables with line numbers in ScrollBox - correct dimensions", async () => {
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
    })

    const scrollBox = new ScrollBoxRenderable(currentRenderer, {
      id: "scroll-multi",
      width: "100%",
      height: "100%",
    })

    currentRenderer.root.add(scrollBox)

    const boxes: BoxRenderable[] = []
    const lineNumberRenderables: LineNumberRenderable[] = []
    const codeRenderables: CodeRenderable[] = []

    // Create 3 code blocks with line numbers in boxes
    for (let i = 1; i <= 3; i++) {
      const code = generateCode(5 + i * 2) // Different sizes
      const codeRenderable = new CodeRenderable(currentRenderer, {
        id: `code-${i}`,
        content: code,
        filetype: "javascript",
        syntaxStyle,
        width: "100%",
        height: "auto",
      })

      const lineNumberRenderable = new LineNumberRenderable(currentRenderer, {
        id: `line-number-${i}`,
        target: codeRenderable,
        minWidth: 3,
        paddingRight: 1,
        fg: "#888888",
        width: "100%",
        height: "100%",
      })

      const box = new BoxRenderable(currentRenderer, {
        id: `box-${i}`,
        border: true,
        width: 50,
        height: 8,
        marginBottom: 2,
      })

      box.add(lineNumberRenderable)
      scrollBox.add(box)

      boxes.push(box)
      lineNumberRenderables.push(lineNumberRenderable)
      codeRenderables.push(codeRenderable)
    }

    await settleCodeRenderables(...codeRenderables)

    const frame1 = captureCharFrame()
    expect(frame1).toMatchSnapshot()

    // Verify all boxes have correct dimensions
    for (let i = 0; i < 3; i++) {
      const box = boxes[i]
      expect(box.width).toBe(50)
      expect(box.height).toBe(8)

      const lineNumberRenderable = lineNumberRenderables[i]
      expect(lineNumberRenderable.width).toBe(48) // 50 - 2 for borders
      expect(lineNumberRenderable.height).toBe(6) // 8 - 2 for borders

      const gutter = lineNumberRenderable["gutter"]
      expect(gutter).toBeDefined()
      expect(gutter!.width).toBeGreaterThan(0)
      expect(gutter!.height).toBe(6)
    }

    // Scroll down
    scrollBox.scrollBy(5)
    await renderOnce()

    const frame2 = captureCharFrame()
    expect(frame2).toMatchSnapshot()

    // Dimensions should remain stable
    for (let i = 0; i < 3; i++) {
      const lineNumberRenderable = lineNumberRenderables[i]
      expect(lineNumberRenderable.width).toBe(48)
      expect(lineNumberRenderable.height).toBe(6)

      const gutter = lineNumberRenderable["gutter"]
      expect(gutter!.width).toBeGreaterThan(0)
      expect(gutter!.height).toBe(6)
    }
  })

  test("nested boxes with different border styles - dimensions correct", async () => {
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
    })

    const code = generateCode(25)
    const codeRenderable = new CodeRenderable(currentRenderer, {
      id: "code-nested",
      content: code,
      filetype: "javascript",
      syntaxStyle,
      width: "100%",
      height: "auto",
    })

    const lineNumberRenderable = new LineNumberRenderable(currentRenderer, {
      id: "line-number-nested",
      target: codeRenderable,
      minWidth: 4,
      paddingRight: 2,
      fg: "#888888",
      width: "100%",
      height: "100%",
    })

    // Inner box with border
    const innerBox = new BoxRenderable(currentRenderer, {
      id: "inner-box",
      border: true,
      borderStyle: "rounded",
      borderColor: "#00ff00",
      padding: 1,
      width: 45,
      height: 15,
    })

    innerBox.add(lineNumberRenderable)

    // Outer box with border
    const outerBox = new BoxRenderable(currentRenderer, {
      id: "outer-box",
      border: true,
      borderStyle: "double",
      borderColor: "#ff0000",
      padding: 2,
      width: 55,
      height: 19,
    })

    outerBox.add(innerBox)

    const scrollBox = new ScrollBoxRenderable(currentRenderer, {
      id: "scroll-nested",
      width: "100%",
      height: "100%",
    })

    scrollBox.add(outerBox)
    currentRenderer.root.add(scrollBox)

    await settleCodeRenderables(codeRenderable)

    const frame1 = captureCharFrame()
    expect(frame1).toMatchSnapshot()

    // Check outer box
    expect(outerBox.width).toBe(55)
    expect(outerBox.height).toBe(19)

    // Check inner box (inside outer box padding and borders)
    expect(innerBox.width).toBe(45)
    expect(innerBox.height).toBe(15)

    // Check line number renderable (inside inner box padding and borders)
    // Inner box: 45 - 2 (borders) - 2 (padding) = 41
    expect(lineNumberRenderable.width).toBe(41)
    // Inner box: 15 - 2 (borders) - 2 (padding) = 11
    expect(lineNumberRenderable.height).toBe(11)

    const gutter = lineNumberRenderable["gutter"]!
    expect(gutter.width).toBeGreaterThan(4) // At least minWidth + padding
    expect(gutter.height).toBe(11)

    // Scroll and verify dimensions remain stable
    scrollBox.scrollBy(20)
    await settleCodeRenderables(codeRenderable)

    const frame2 = captureCharFrame()
    expect(frame2).toMatchSnapshot()

    expect(lineNumberRenderable.width).toBe(41)
    expect(lineNumberRenderable.height).toBe(11)
    expect(gutter.width).toBeGreaterThan(4)
    expect(gutter.height).toBe(11)
  })

  test("ScrollBox with horizontal and vertical scrolling - dimensions stable", async () => {
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
    })

    // Create very long lines
    const longLines: string[] = []
    for (let i = 1; i <= 50; i++) {
      longLines.push(
        `const veryLongVariableName${i} = "This is a very long line that should require horizontal scrolling to view completely";`,
      )
    }
    const code = longLines.join("\n")

    const codeRenderable = new CodeRenderable(currentRenderer, {
      id: "code-long",
      content: code,
      filetype: "javascript",
      syntaxStyle,
      width: "auto",
      height: "auto",
    })

    const lineNumberRenderable = new LineNumberRenderable(currentRenderer, {
      id: "line-number-long",
      target: codeRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#888888",
      width: "100%",
      height: "100%",
    })

    const box = new BoxRenderable(currentRenderer, {
      id: "box-long",
      border: true,
      width: 50,
      height: 15,
    })

    box.add(lineNumberRenderable)

    const scrollBox = new ScrollBoxRenderable(currentRenderer, {
      id: "scroll-long",
      width: "100%",
      height: "100%",
      scrollX: true,
      scrollY: true,
    })

    scrollBox.add(box)
    currentRenderer.root.add(scrollBox)

    await settleCodeRenderables(codeRenderable)

    const initialWidth = lineNumberRenderable.width
    const initialHeight = lineNumberRenderable.height
    const initialGutterWidth = lineNumberRenderable["gutter"]!.width
    const initialGutterHeight = lineNumberRenderable["gutter"]!.height

    const frame1 = captureCharFrame()
    expect(frame1).toMatchSnapshot()

    // Scroll vertically
    scrollBox.scrollBy({ x: 0, y: 10 })
    await settleCodeRenderables(codeRenderable)

    expect(lineNumberRenderable.width).toBe(initialWidth)
    expect(lineNumberRenderable.height).toBe(initialHeight)
    expect(lineNumberRenderable["gutter"]!.width).toBe(initialGutterWidth)
    expect(lineNumberRenderable["gutter"]!.height).toBe(initialGutterHeight)

    const frame2 = captureCharFrame()
    expect(frame2).toMatchSnapshot()

    // Scroll horizontally (shouldn't affect line numbers much)
    scrollBox.scrollBy({ x: 20, y: 0 })
    await renderOnce()

    expect(lineNumberRenderable.width).toBe(initialWidth)
    expect(lineNumberRenderable.height).toBe(initialHeight)
    expect(lineNumberRenderable["gutter"]!.width).toBe(initialGutterWidth)
    expect(lineNumberRenderable["gutter"]!.height).toBe(initialGutterHeight)

    const frame3 = captureCharFrame()
    expect(frame3).toMatchSnapshot()

    // Scroll both
    scrollBox.scrollBy({ x: 10, y: 15 })
    await renderOnce()

    expect(lineNumberRenderable.width).toBe(initialWidth)
    expect(lineNumberRenderable.height).toBe(initialHeight)
    expect(lineNumberRenderable["gutter"]!.width).toBe(initialGutterWidth)
    expect(lineNumberRenderable["gutter"]!.height).toBe(initialGutterHeight)

    const frame4 = captureCharFrame()
    expect(frame4).toMatchSnapshot()
  })

  test("gutter width changes with line count - verify remeasure", async () => {
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
    })

    // Start with 9 lines (1 digit line numbers)
    let code = generateCode(2) // 8 lines
    const codeRenderable = new CodeRenderable(currentRenderer, {
      id: "code-growing",
      content: code,
      filetype: "javascript",
      syntaxStyle,
      width: "100%",
      height: "auto",
    })

    const lineNumberRenderable = new LineNumberRenderable(currentRenderer, {
      id: "line-number-growing",
      target: codeRenderable,
      minWidth: 2,
      paddingRight: 1,
      fg: "#888888",
      width: "100%",
      height: "100%",
    })

    const box = new BoxRenderable(currentRenderer, {
      id: "box-growing",
      border: true,
      width: 40,
      height: 12,
    })

    box.add(lineNumberRenderable)

    const scrollBox = new ScrollBoxRenderable(currentRenderer, {
      id: "scroll-growing",
      width: "100%",
      height: "100%",
      scrollY: false,
    })

    scrollBox.add(box)
    currentRenderer.root.add(scrollBox)

    await renderOnce()

    const widthWith1Digit = lineNumberRenderable["gutter"]!.width
    const frame1 = captureCharFrame()
    expect(frame1).toMatchSnapshot()
    // minWidth is 2, paddingRight is 1, so minimum is 3 (2 + 1)
    // But also includes +1 for left padding and maxBeforeWidth/maxAfterWidth (0 in this case)
    // So base minimum is 4 total for 1 digit numbers

    // Now update to have more than 9 lines (2 digit line numbers)
    code = generateCode(5) // 20 lines
    codeRenderable.content = code
    await settleCodeRenderables(codeRenderable)

    const widthWith2Digits = lineNumberRenderable["gutter"]!.width
    const frame2 = captureCharFrame()
    expect(frame2).toMatchSnapshot()

    // Width stays the same because minWidth 2 is still enough for 2-digit numbers
    // The gutter width calculation is: max(minWidth, digits + paddingRight + 1)
    // For 20 lines: max(2, 2 + 1 + 1) = max(2, 4) = 4
    // But we started with at least 3 or 4
    expect(widthWith2Digits).toBeGreaterThanOrEqual(widthWith1Digit)

    // Now update to have more than 99 lines (3 digit line numbers)
    code = generateCode(30) // 120 lines
    codeRenderable.content = code
    await settleCodeRenderables(codeRenderable)

    const widthWith3Digits = lineNumberRenderable["gutter"]!.width
    const frame3 = captureCharFrame()
    expect(frame3).toMatchSnapshot()

    // Width should increase for 3-digit numbers
    // For 120 lines: max(2, 3 + 1 + 1) = max(2, 5) = 5
    expect(widthWith3Digits).toBeGreaterThan(widthWith2Digits)
  })

  test("line colors span full width in ScrollBox", async () => {
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
    })

    const code = generateCode(15)
    const codeRenderable = new CodeRenderable(currentRenderer, {
      id: "code-colors",
      content: code,
      filetype: "javascript",
      syntaxStyle,
      width: "100%",
      height: "auto",
    })

    const lineColors = new Map<number, string>()
    lineColors.set(2, "#2d4a2e") // Green for line 3
    lineColors.set(5, "#4a2d2d") // Red for line 6

    const lineNumberRenderable = new LineNumberRenderable(currentRenderer, {
      id: "line-number-colors",
      target: codeRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#ffffff",
      bg: "#000000",
      lineColors,
      width: "100%",
      height: "100%",
    })

    const box = new BoxRenderable(currentRenderer, {
      id: "box-colors",
      border: true,
      width: 50,
      height: 12,
    })

    box.add(lineNumberRenderable)

    const scrollBox = new ScrollBoxRenderable(currentRenderer, {
      id: "scroll-colors",
      width: "100%",
      height: "100%",
    })

    scrollBox.add(box)
    currentRenderer.root.add(scrollBox)

    await settleCodeRenderables(codeRenderable)

    const frame = captureCharFrame()
    expect(frame).toMatchSnapshot()

    // Scroll to make line 5 visible at top
    scrollBox.scrollBy(5)
    await renderOnce()

    const frame2 = captureCharFrame()
    expect(frame2).toMatchSnapshot()
  })

  test("viewport culling with line numbers - dimensions stable", async () => {
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
    })

    const scrollBox = new ScrollBoxRenderable(currentRenderer, {
      id: "scroll-culling",
      width: "100%",
      height: "100%",
      viewportCulling: true,
    })

    currentRenderer.root.add(scrollBox)

    const boxes: BoxRenderable[] = []
    const codeRenderables: CodeRenderable[] = []

    // Add many boxes - only visible ones should be rendered
    for (let i = 1; i <= 20; i++) {
      const code = generateCode(3)
      const codeRenderable = new CodeRenderable(currentRenderer, {
        id: `code-culling-${i}`,
        content: code,
        filetype: "javascript",
        syntaxStyle,
        width: "100%",
        height: "auto",
      })

      const lineNumberRenderable = new LineNumberRenderable(currentRenderer, {
        id: `line-number-culling-${i}`,
        target: codeRenderable,
        minWidth: 3,
        paddingRight: 1,
        fg: "#888888",
        width: "100%",
        height: "100%",
      })

      const box = new BoxRenderable(currentRenderer, {
        id: `box-culling-${i}`,
        border: true,
        width: 45,
        height: 6,
        marginBottom: 1,
      })

      box.add(lineNumberRenderable)
      scrollBox.add(box)
      boxes.push(box)
      codeRenderables.push(codeRenderable)
    }

    await settleCodeRenderables(...codeRenderables)

    const frame1 = captureCharFrame()
    expect(frame1).toMatchSnapshot()

    // Scroll through content
    for (let scroll = 0; scroll < 100; scroll += 10) {
      scrollBox.scrollBy(10)
      await renderOnce()

      // Check that first few boxes have correct dimensions
      for (let i = 0; i < 5 && i < boxes.length; i++) {
        const box = boxes[i]
        expect(box.width).toBe(45)
        expect(box.height).toBe(6)
      }
    }

    const frame2 = captureCharFrame()
    expect(frame2).toMatchSnapshot()
  })

  test("EXPECTED FAILURE: Box width changes unexpectedly on first few renders", async () => {
    // This test documents a known issue where box widths may flicker on initial renders
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
    })

    const code = generateCode(30)
    const codeRenderable = new CodeRenderable(currentRenderer, {
      id: "code-flicker",
      content: code,
      filetype: "javascript",
      syntaxStyle,
      width: "100%",
      height: "auto",
    })

    const lineNumberRenderable = new LineNumberRenderable(currentRenderer, {
      id: "line-number-flicker",
      target: codeRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#888888",
      width: "100%",
      height: "100%",
    })

    const box = new BoxRenderable(currentRenderer, {
      id: "box-flicker",
      border: true,
      width: 40,
      height: 12,
    })

    box.add(lineNumberRenderable)

    const scrollBox = new ScrollBoxRenderable(currentRenderer, {
      id: "scroll-flicker",
      width: "100%",
      height: "100%",
    })

    scrollBox.add(box)
    currentRenderer.root.add(scrollBox)

    // Capture dimensions across multiple renders
    const widths: number[] = []
    const heights: number[] = []

    for (let i = 0; i < 5; i++) {
      await renderOnce()
      widths.push(box.width)
      heights.push(box.height)
    }

    // This assertion SHOULD pass if the bug is fixed
    // If it fails, it documents the flickering issue
    const allWidthsSame = widths.every((w) => w === widths[0])
    const allHeightsSame = heights.every((h) => h === heights[0])

    expect(allWidthsSame).toBe(true)
    expect(allHeightsSame).toBe(true)
  })

  test("EXPECTED FAILURE: Gutter height may not match parent height initially", async () => {
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
    })

    const code = generateCode(50)
    const codeRenderable = new CodeRenderable(currentRenderer, {
      id: "code-height",
      content: code,
      filetype: "javascript",
      syntaxStyle,
      width: "100%",
      height: "auto",
    })

    const lineNumberRenderable = new LineNumberRenderable(currentRenderer, {
      id: "line-number-height",
      target: codeRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#888888",
      width: "100%",
      height: "100%",
    })

    const box = new BoxRenderable(currentRenderer, {
      id: "box-height",
      border: true,
      width: 40,
      height: 15,
    })

    box.add(lineNumberRenderable)

    const scrollBox = new ScrollBoxRenderable(currentRenderer, {
      id: "scroll-height",
      width: "100%",
      height: "100%",
    })

    scrollBox.add(box)
    currentRenderer.root.add(scrollBox)

    await renderOnce()

    const gutter = lineNumberRenderable["gutter"]!
    const expectedHeight = lineNumberRenderable.height

    // Gutter should have same height as its parent LineNumberRenderable
    // This may fail if there's a layout issue
    expect(gutter.height).toBe(expectedHeight)
  })
})
