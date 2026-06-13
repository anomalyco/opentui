import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { bold, green, red, yellow } from "../lib/styled-text.js"
import { createTestRenderer, type MockMouse, type TestRenderer } from "../testing/test-renderer.js"
import type { CapturedFrame } from "../types.js"
import { BoxRenderable } from "./Box.js"
import { ScrollBoxRenderable } from "./ScrollBox.js"
import { TextRenderable } from "./Text.js"
import { TextTableRenderable, type TextTableCellContent, type TextTableContent } from "./TextTable.js"

const VERTICAL_BORDER_CP = "│".codePointAt(0)!
const BORDER_CHAR_PATTERN = /[┌┐└┘├┤┬┴┼│─]/

let renderer: TestRenderer
let renderOnce: () => Promise<void>
let captureFrame: () => string
let captureSpans: () => CapturedFrame
let resizeRenderer: (width: number, height: number) => void
let mockMouse: MockMouse

function getCharAt(buffer: TestRenderer["currentRenderBuffer"], x: number, y: number): number {
  return buffer.buffers.char[y * buffer.width + x] ?? 0
}

function getFgAt(buffer: TestRenderer["currentRenderBuffer"], x: number, y: number): RGBA {
  const index = (y * buffer.width + x) * 4
  return RGBA.fromArray(buffer.buffers.fg.slice(index, index + 4))
}

function getBgAt(buffer: TestRenderer["currentRenderBuffer"], x: number, y: number): RGBA {
  const index = (y * buffer.width + x) * 4
  return RGBA.fromArray(buffer.buffers.bg.slice(index, index + 4))
}

function findVerticalBorderXs(buffer: TestRenderer["currentRenderBuffer"], y: number): number[] {
  const xs: number[] = []

  for (let x = 0; x < buffer.width; x++) {
    if (getCharAt(buffer, x, y) === VERTICAL_BORDER_CP) {
      xs.push(x)
    }
  }

  return xs
}

function countChar(text: string, target: string): number {
  return [...text].filter((char) => char === target).length
}

function normalizeFrameBlock(lines: string[]): string {
  const trimmed = lines.map((line) => line.trimEnd())
  const nonEmpty = trimmed.filter((line) => line.length > 0)
  const minIndent = nonEmpty.reduce((min, line) => {
    const indent = line.match(/^ */)?.[0].length ?? 0
    return Math.min(min, indent)
  }, Number.POSITIVE_INFINITY)
  const indent = Number.isFinite(minIndent) ? minIndent : 0

  return trimmed.map((line) => line.slice(indent)).join("\n") + "\n"
}

function extractTableBlock(frame: string, headerMatcher: (line: string) => boolean): string {
  const lines = frame.split("\n")
  const headerY = lines.findIndex(headerMatcher)
  if (headerY < 0) {
    throw new Error("Unable to find table header line")
  }

  let topY = headerY
  while (topY >= 0 && !lines[topY]?.includes("┌")) {
    topY -= 1
  }
  if (topY < 0) {
    throw new Error("Unable to find table top border")
  }

  let bottomY = headerY
  while (bottomY < lines.length && !lines[bottomY]?.includes("└")) {
    bottomY += 1
  }
  if (bottomY >= lines.length) {
    throw new Error("Unable to find table bottom border")
  }

  return normalizeFrameBlock(lines.slice(topY, bottomY + 1))
}

async function renderStandaloneTableBlock(
  width: number,
  content: TextTableContent,
  headerMatcher: (line: string) => boolean,
): Promise<string> {
  const testRenderer = await createTestRenderer({ width, height: 120 })

  try {
    const table = new TextTableRenderable(testRenderer.renderer, {
      left: 0,
      top: 0,
      width,
      wrapMode: "word",
      content,
    })

    testRenderer.renderer.root.add(table)
    await testRenderer.renderOnce()
    return extractTableBlock(testRenderer.captureCharFrame(), headerMatcher)
  } finally {
    testRenderer.renderer.destroy()
  }
}

function findSelectablePoint(
  table: TextTableRenderable,
  direction: "top-left" | "bottom-right",
): { x: number; y: number } {
  const points: Array<{ x: number; y: number }> = []

  for (let y = table.y; y < table.y + table.height; y++) {
    for (let x = table.x; x < table.x + table.width; x++) {
      if (table.shouldStartSelection(x, y)) {
        points.push({ x, y })
      }
    }
  }

  expect(points.length).toBeGreaterThan(0)

  if (direction === "top-left") {
    points.sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x))
    return points[0]!
  }

  points.sort((a, b) => (a.y !== b.y ? b.y - a.y : b.x - a.x))
  return points[0]!
}

function findTextPoint(frame: string, text: string): { x: number; y: number } {
  const lines = frame.split("\n")

  for (let y = 0; y < lines.length; y++) {
    const x = lines[y]?.indexOf(text) ?? -1
    if (x >= 0) {
      return { x, y }
    }
  }

  throw new Error(`Unable to find '${text}' in frame`)
}

function cell(text: string): TextTableCellContent {
  return [
    {
      __isChunk: true,
      text,
    },
  ]
}

function getScrollContentBottom(scrollBox: ScrollBoxRenderable): number {
  const children = scrollBox.content.getChildren()
  const lastChild = children[children.length - 1]

  if (!lastChild) {
    return Math.max(0, Math.ceil(scrollBox.content.height))
  }

  const relativeBottom = lastChild.y - scrollBox.content.y + lastChild.height
  return Math.max(0, Math.ceil(relativeBottom))
}

beforeEach(async () => {
  const testRenderer = await createTestRenderer({ width: 60, height: 16 })
  renderer = testRenderer.renderer
  renderOnce = testRenderer.renderOnce
  captureFrame = testRenderer.captureCharFrame
  captureSpans = testRenderer.captureSpans
  resizeRenderer = testRenderer.resize
  mockMouse = testRenderer.mockMouse
})

afterEach(() => {
  renderer.destroy()
})

describe("TextTableRenderable", () => {
  test("renders a basic table with styled cell chunks", async () => {
    const content: TextTableContent = [
      [[bold("Name")], [bold("Status")], [bold("Notes")]],
      [cell("Alpha"), [green("OK")], cell("All systems nominal")],
      [cell("Bravo"), [red("WARN")], cell("Pending checks")],
    ]

    const table = new TextTableRenderable(renderer, {
      left: 1,
      top: 1,
      columnWidthMode: "content",
      content,
    })

    renderer.root.add(table)
    await renderOnce()

    const frame = captureFrame()
    expect(frame).toMatchSnapshot("basic table")
    expect(frame).toContain("Alpha")
    expect(frame).toContain("WARN")

    const spans = captureSpans().lines.flatMap((line) => line.spans)
    const okSpan = spans.find((span) => span.text.includes("OK"))

    expect(okSpan).toBeDefined()
    expect(okSpan?.fg.equals(RGBA.fromHex("#008000"))).toBe(true)
  })

  test("wraps content and fits columns when width is constrained", async () => {
    const content: TextTableContent = [
      [[bold("ID")], [bold("Description")]],
      [cell("1"), cell("This is a long sentence that should wrap across multiple visual lines")],
      [cell("2"), cell("Short")],
    ]

    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      width: 34,
      wrapMode: "word",
      content,
    })

    renderer.root.add(table)
    await renderOnce()

    const frame = captureFrame()
    expect(frame).toMatchSnapshot("wrapped constrained width")
    expect(frame).toContain("Description")
  })

  test("keeps intrinsic width in content mode when extra space is available", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      width: 34,
      wrapMode: "word",
      columnWidthMode: "content",
      content: [
        [cell("A"), cell("B")],
        [cell("1"), cell("2")],
      ],
    })

    renderer.root.add(table)
    await renderOnce()

    const lines = captureFrame().split("\n")
    const headerY = lines.findIndex((line) => line.includes("A") && line.includes("B"))
    expect(headerY).toBeGreaterThanOrEqual(0)

    const buffer = renderer.currentRenderBuffer
    const borderXs = findVerticalBorderXs(buffer, headerY)

    expect(borderXs.length).toBe(3)
    expect(borderXs[0]).toBe(0)
    expect(borderXs[borderXs.length - 1]).toBeLessThan(33)
  })

  test("fills available width by default in full mode", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      width: 34,
      wrapMode: "word",
      content: [
        [cell("A"), cell("B")],
        [cell("1"), cell("2")],
      ],
    })

    renderer.root.add(table)
    await renderOnce()

    const lines = captureFrame().split("\n")
    const headerY = lines.findIndex((line) => line.includes("A") && line.includes("B"))
    expect(headerY).toBeGreaterThanOrEqual(0)

    const buffer = renderer.currentRenderBuffer
    const borderXs = findVerticalBorderXs(buffer, headerY)

    expect(borderXs).toEqual([0, 17, 33])
  })

  test("fills available width in no-wrap mode when columnWidthMode is full", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      width: 24,
      wrapMode: "none",
      columnWidthMode: "full",
      content: [
        [cell("Key"), cell("Value")],
        [cell("A"), cell("B")],
      ],
    })

    renderer.root.add(table)
    await renderOnce()

    const lines = captureFrame().split("\n")
    const headerY = lines.findIndex((line) => line.includes("Key") && line.includes("Value"))
    expect(headerY).toBeGreaterThanOrEqual(0)

    const buffer = renderer.currentRenderBuffer
    const borderXs = findVerticalBorderXs(buffer, headerY)

    expect(borderXs).toEqual([0, 11, 23])
  })

  test("preserves bordered layout when border glyphs are hidden", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      border: true,
      outerBorder: true,
      showBorders: false,
      columnWidthMode: "content",
      content: [[cell("A"), cell("B")]],
    })

    renderer.root.add(table)
    await renderOnce()

    const frame = captureFrame()
    expect(BORDER_CHAR_PATTERN.test(frame)).toBe(false)

    const row = frame.split("\n").find((line) => line.includes("A") && line.includes("B"))
    expect(row).toBeDefined()
    expect(row?.indexOf("A")).toBe(1)
    expect(row?.indexOf("B")).toBe(3)
  })

  test("applies cell padding when provided", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      cellPadding: 1,
      columnWidthMode: "content",
      content: [
        [cell("A"), cell("B")],
        [cell("1"), cell("2")],
      ],
    })

    renderer.root.add(table)
    await renderOnce()

    const frame = captureFrame()
    expect(frame).toContain("│   │   │")
    expect(frame).toContain("│ A │ B │")

    const lines = frame.split("\n")
    const headerY = lines.findIndex((line) => line.includes(" A ") && line.includes(" B "))
    expect(headerY).toBeGreaterThanOrEqual(0)

    const borderXs = findVerticalBorderXs(renderer.currentRenderBuffer, headerY)
    expect(borderXs).toEqual([0, 4, 8])
  })

  test("reflows when columnWidthMode is changed after initial render", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      width: 34,
      wrapMode: "word",
      columnWidthMode: "content",
      content: [
        [cell("A"), cell("B")],
        [cell("1"), cell("2")],
      ],
    })

    renderer.root.add(table)
    await renderOnce()

    let lines = captureFrame().split("\n")
    let headerY = lines.findIndex((line) => line.includes("A") && line.includes("B"))
    expect(headerY).toBeGreaterThanOrEqual(0)

    let borderXs = findVerticalBorderXs(renderer.currentRenderBuffer, headerY)
    expect(borderXs[borderXs.length - 1]).toBeLessThan(33)

    table.columnWidthMode = "full"
    await renderOnce()

    lines = captureFrame().split("\n")
    headerY = lines.findIndex((line) => line.includes("A") && line.includes("B"))
    expect(headerY).toBeGreaterThanOrEqual(0)

    borderXs = findVerticalBorderXs(renderer.currentRenderBuffer, headerY)
    expect(borderXs).toEqual([0, 17, 33])
  })

  test("accepts columnFitter in options and setter", () => {
    const table = new TextTableRenderable(renderer, {
      columnFitter: "balanced",
      content: [[cell("A")]],
    })

    expect(table.columnFitter).toBe("balanced")

    table.columnFitter = "proportional"
    expect(table.columnFitter).toBe("proportional")
  })

  test("balanced fitter keeps constrained columns visually closer", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      width: 58,
      wrapMode: "word",
      columnWidthMode: "full",
      columnFitter: "proportional",
      content: [
        [
          cell("Provider"),
          cell("Compute Services"),
          cell("Storage Solutions"),
          cell("Pricing Model"),
          cell("Regions"),
          cell("Use Cases"),
        ],
        [
          cell("Amazon Web Services"),
          cell("EC2 instances with extensive options for general, memory, and accelerated workloads"),
          cell("S3 tiers, EBS, EFS, and archive classes for long retention"),
          cell("Pay as you go, reserved terms, and discounted spot capacity"),
          cell("Global regions and many edge locations"),
          cell("Enterprise migration, analytics, ML, and backend services"),
        ],
      ],
    })

    renderer.root.add(table)
    await renderOnce()

    const proportionalFrame = captureFrame()
    expect(proportionalFrame).toMatchSnapshot("fitter proportional constrained")

    const getRenderedWidths = (): number[] => {
      const lines = captureFrame().split("\n")
      const headerY = lines.findIndex((line) => line.includes("Compute") && line.includes("Pricing"))
      expect(headerY).toBeGreaterThanOrEqual(0)

      const borderXs = findVerticalBorderXs(renderer.currentRenderBuffer, headerY)
      expect(borderXs.length).toBeGreaterThan(2)

      return borderXs.slice(1).map((x, idx) => x - borderXs[idx] - 1)
    }

    const proportionalWidths = getRenderedWidths()
    const proportionalSpread = Math.max(...proportionalWidths) - Math.min(...proportionalWidths)

    table.columnFitter = "balanced"
    await renderOnce()

    const balancedFrame = captureFrame()
    expect(balancedFrame).toMatchSnapshot("fitter balanced constrained")

    const balancedWidths = getRenderedWidths()
    const balancedSpread = Math.max(...balancedWidths) - Math.min(...balancedWidths)

    expect(table.columnFitter).toBe("balanced")
    expect(balancedFrame).not.toBe(proportionalFrame)
    expect(balancedWidths[0]).toBeGreaterThan(proportionalWidths[0] ?? 0)
    expect(balancedSpread).toBeLessThan(proportionalSpread)
  })

  test("uses native border draw for inner-only mode", async () => {
    const originalDrawGrid = OptimizedBuffer.prototype.drawGrid
    let nativeCalls = 0

    OptimizedBuffer.prototype.drawGrid = function (...args: Parameters<OptimizedBuffer["drawGrid"]>) {
      nativeCalls += 1
      return originalDrawGrid.apply(this, args)
    }

    try {
      const table = new TextTableRenderable(renderer, {
        left: 0,
        top: 0,
        border: true,
        outerBorder: false,
        columnWidthMode: "content",
        content: [
          [cell("A"), cell("B")],
          [cell("1"), cell("2")],
        ],
      })

      renderer.root.add(table)
      await renderOnce()

      const frame = captureFrame()
      expect(frame).not.toContain("┌")
      expect(frame).not.toContain("┐")
      expect(frame).not.toContain("└")
      expect(frame).not.toContain("┘")
      expect(frame).toContain("┼")
      expect(nativeCalls).toBe(1)

      const lines = frame.split("\n")
      const rowY = lines.findIndex((line) => line.includes("A") && line.includes("B"))
      expect(rowY).toBeGreaterThanOrEqual(0)

      const borderXs = findVerticalBorderXs(renderer.currentRenderBuffer, rowY)
      expect(borderXs).toEqual([1])
    } finally {
      OptimizedBuffer.prototype.drawGrid = originalDrawGrid
    }
  })

  test("defaults outerBorder to false when border is false", async () => {
    const originalDrawGrid = OptimizedBuffer.prototype.drawGrid
    let nativeCalls = 0

    OptimizedBuffer.prototype.drawGrid = function (...args: Parameters<OptimizedBuffer["drawGrid"]>) {
      nativeCalls += 1
      return originalDrawGrid.apply(this, args)
    }

    try {
      const table = new TextTableRenderable(renderer, {
        left: 0,
        top: 0,
        border: false,
        columnWidthMode: "content",
        content: [
          [cell("A"), cell("B")],
          [cell("1"), cell("2")],
        ],
      })

      renderer.root.add(table)
      await renderOnce()

      const frame = captureFrame()
      expect(table.outerBorder).toBe(false)
      expect(BORDER_CHAR_PATTERN.test(frame)).toBe(false)
      expect(frame).toContain("AB")
      expect(nativeCalls).toBe(0)
    } finally {
      OptimizedBuffer.prototype.drawGrid = originalDrawGrid
    }
  })

  test("allows outer border even when inner border is off", async () => {
    const originalDrawGrid = OptimizedBuffer.prototype.drawGrid
    let nativeCalls = 0

    OptimizedBuffer.prototype.drawGrid = function (...args: Parameters<OptimizedBuffer["drawGrid"]>) {
      nativeCalls += 1
      return originalDrawGrid.apply(this, args)
    }

    try {
      const table = new TextTableRenderable(renderer, {
        left: 0,
        top: 0,
        border: false,
        outerBorder: true,
        content: [
          [cell("A"), cell("B")],
          [cell("1"), cell("2")],
        ],
      })

      renderer.root.add(table)
      await renderOnce()

      const frame = captureFrame()
      expect(frame).toContain("┌")
      expect(frame).toContain("┐")
      expect(frame).toContain("└")
      expect(frame).toContain("┘")
      expect(frame).not.toContain("┼")
      expect(nativeCalls).toBe(1)
    } finally {
      OptimizedBuffer.prototype.drawGrid = originalDrawGrid
    }
  })

  test("rebuilds table when content setter is used", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      columnWidthMode: "content",
      content: [[cell("A"), cell("B")]],
    })

    renderer.root.add(table)
    await renderOnce()

    const before = captureFrame()

    table.content = [
      [[bold("Col 1")], [bold("Col 2")]],
      [cell("row-1"), cell("updated")],
      [cell("row-2"), [green("active")]],
    ]

    await renderOnce()

    const after = captureFrame()
    expect(before).not.toBe(after)
    expect(after).toMatchSnapshot("content setter update")
  })

  test("renders a final bottom border", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      content: [
        [[bold("A")], [bold("B")]],
        [cell("1"), cell("2")],
      ],
    })

    renderer.root.add(table)
    await renderOnce()

    const frame = captureFrame()
    const lines = frame
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)

    const lastLine = lines[lines.length - 1] ?? ""

    expect(lastLine).toContain("└")
    expect(lastLine).toContain("┴")
    expect(lastLine).toContain("┘")
  })

  test("keeps borders aligned with CJK and emoji content", async () => {
    const content: TextTableContent = [
      [[bold("Locale")], [bold("Sample")]],
      [cell("ja-JP"), cell("東京で寿司 🍣")],
      [cell("zh-CN"), cell("你好世界 🚀")],
      [cell("ko-KR"), cell("한글 테스트 😄")],
    ]

    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      width: 36,
      wrapMode: "none",
      columnWidthMode: "content",
      content,
    })

    renderer.root.add(table)
    await renderOnce()

    const frame = captureFrame()
    expect(frame).toMatchSnapshot("unicode border alignment")
    expect(frame).toContain("東京で寿司")
    expect(frame).toContain("🚀")
    expect(frame).toContain("😄")

    const lines = frame.split("\n")
    const headerY = lines.findIndex((line) => line.includes("Locale"))
    expect(headerY).toBeGreaterThanOrEqual(0)

    const buffer = renderer.currentRenderBuffer
    const borderXs = findVerticalBorderXs(buffer, headerY)
    expect(borderXs.length).toBe(3)

    const sampleRowYs = [
      lines.findIndex((line) => line.includes("ja-JP")),
      lines.findIndex((line) => line.includes("zh-CN")),
      lines.findIndex((line) => line.includes("ko-KR")),
    ]

    for (const y of sampleRowYs) {
      expect(y).toBeGreaterThanOrEqual(0)
      for (const x of borderXs) {
        expect(getCharAt(buffer, x, y)).toBe(VERTICAL_BORDER_CP)
      }
    }
  })

  test("wraps CJK and emoji without grapheme duplication", async () => {
    const content: TextTableContent = [
      [[bold("Item")], [bold("Details")]],
      [cell("mixed"), cell("東京界 🌍 emoji wrapping continues across lines for width checks")],
      [cell("emoji"), cell("Faces 😀😃😄 should remain stable")],
    ]

    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      width: 30,
      wrapMode: "word",
      content,
    })

    renderer.root.add(table)
    await renderOnce()

    const frame = captureFrame()
    expect(frame).toMatchSnapshot("unicode wrapping")
    expect(frame).not.toContain("�")
    expect(countChar(frame, "界")).toBe(1)
    expect(countChar(frame, "🌍")).toBe(1)

    const lines = frame.split("\n")
    const wrappedRowStartY = lines.findIndex((line) => line.includes("mix") && line.includes("東京界"))
    const wrappedRowEndBorderY = lines.findIndex((line, idx) => idx > wrappedRowStartY && line.includes("├"))

    expect(wrappedRowStartY).toBeGreaterThanOrEqual(0)
    expect(wrappedRowEndBorderY).toBeGreaterThan(wrappedRowStartY)

    const wrappedRowYs: number[] = []
    for (let y = wrappedRowStartY; y < wrappedRowEndBorderY; y++) {
      wrappedRowYs.push(y)
    }

    expect(wrappedRowYs.length).toBeGreaterThan(1)

    const headerY = lines.findIndex((line) => line.includes("Ite") && line.includes("Details"))
    expect(headerY).toBeGreaterThanOrEqual(0)

    const buffer = renderer.currentRenderBuffer
    const borderXs = findVerticalBorderXs(buffer, headerY)
    expect(borderXs.length).toBe(3)

    for (const y of wrappedRowYs) {
      for (const x of borderXs) {
        expect(getCharAt(buffer, x, y)).toBe(VERTICAL_BORDER_CP)
      }
    }
  })

  test("starts selection only on table cell content", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      content: [
        [[bold("A")], [bold("B")]],
        [cell("1"), cell("2")],
      ],
    })

    renderer.root.add(table)
    await renderOnce()

    expect(table.shouldStartSelection(table.x, table.y)).toBe(false)
    expect(table.shouldStartSelection(table.x + 1, table.y)).toBe(false)
    expect(table.shouldStartSelection(table.x, table.y + 1)).toBe(false)
    expect(table.shouldStartSelection(table.x + 1, table.y + 1)).toBe(true)
  })

  test("selection text excludes border glyphs", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      columnWidthMode: "content",
      content: [
        [[bold("c1")], [bold("c2")]],
        [cell("aa"), cell("bb")],
        [cell("cc"), cell("dd")],
      ],
    })

    renderer.root.add(table)
    await renderOnce()

    await mockMouse.drag(table.x + 1, table.y + 1, table.x + 5, table.y + 3)
    await renderOnce()

    expect(table.hasSelection()).toBe(true)

    const selected = table.getSelectedText()
    expect(selected).toContain("c1\tc2")
    expect(selected).toContain("aa\tb")
    expect(selected).not.toContain("│")
    expect(selected).not.toContain("┌")
    expect(selected).not.toContain("┼")

    const rendererSelection = renderer.getSelection()
    expect(rendererSelection).not.toBeNull()
    expect(rendererSelection?.getSelectedText()).not.toContain("│")
  })

  test("keeps partial selection when focus stays in the anchor cell", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      content: [[cell("alphabet"), cell("status")]],
    })

    renderer.root.add(table)
    await renderOnce()

    const anchor = findTextPoint(captureFrame(), "alphabet")

    await mockMouse.drag(anchor.x + 3, anchor.y, anchor.x + 5, anchor.y)
    await renderOnce()

    expect(table.getSelectedText()).toBe("ha")
  })

  test("selects the full anchor cell once focus leaves that cell", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      content: [[cell("alphabet"), cell("status")]],
    })

    renderer.root.add(table)
    await renderOnce()

    const frame = captureFrame()
    const anchor = findTextPoint(frame, "alphabet")
    const focus = findTextPoint(frame, "status")

    await mockMouse.drag(anchor.x + 3, anchor.y, focus.x + 2, focus.y)
    await renderOnce()

    const [firstCell] = table.getSelectedText().split("\t")
    expect(firstCell).toBe("alphabet")
  })

  test("locks vertical drag to the anchor column while focus stays in that column", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      content: [
        [cell("colA"), cell("colB"), cell("colC")],
        [cell("a1"), cell("b1"), cell("c1")],
        [cell("a2"), cell("b2"), cell("c2")],
        [cell("a3"), cell("b3"), cell("c3")],
      ],
    })

    renderer.root.add(table)
    await renderOnce()

    const anchor = findTextPoint(captureFrame(), "colB")

    await mockMouse.drag(anchor.x, anchor.y, anchor.x, table.y + table.height + 2)
    await renderOnce()

    expect(table.getSelectedText()).toBe("colB\nb1\nb2\nb3")
  })

  test("returns to normal grid selection after focus leaves the anchor column", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      content: [
        [cell("colA"), cell("colB"), cell("colC")],
        [cell("a1"), cell("b1"), cell("c1")],
        [cell("a2"), cell("b2"), cell("c2")],
        [cell("a3"), cell("b3"), cell("c3")],
      ],
    })

    renderer.root.add(table)
    await renderOnce()

    const frame = captureFrame()
    const anchor = findTextPoint(frame, "colB")
    const focus = findTextPoint(frame, "colC")

    await mockMouse.drag(anchor.x, anchor.y, focus.x, table.y + table.height + 2)
    await renderOnce()

    expect(table.getSelectedText()).toBe("colB\tcolC\na1\tb1\tc1\na2\tb2\tc2\na3\tb3\tc3")
  })

  test("selection colors reset when drag retracts back to the anchor", async () => {
    const defaultFg = RGBA.fromHex("#111111")
    const defaultBg = RGBA.fromValues(0, 0, 0, 1)
    const selectionFg = RGBA.fromHex("#fefefe")
    const selectionBg = RGBA.fromHex("#cc5500")

    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      fg: defaultFg,
      bg: defaultBg,
      selectionFg,
      selectionBg,
      columnWidthMode: "content",
      content: [
        [cell("A"), cell("B")],
        [cell("C"), cell("D")],
      ],
    })

    renderer.root.add(table)
    await renderOnce()

    const anchorX = table.x + 1
    const anchorY = table.y + 1
    const farX = table.x + 3
    const farY = table.y + 3

    await mockMouse.pressDown(anchorX, anchorY)
    await mockMouse.moveTo(farX, farY)
    await renderOnce()

    expect(table.hasSelection()).toBe(true)

    let buffer = renderer.currentRenderBuffer
    const selectedCells: Array<{ x: number; y: number }> = []

    for (let y = table.y; y < table.y + table.height; y++) {
      for (let x = table.x; x < table.x + table.width; x++) {
        if (getBgAt(buffer, x, y).equals(selectionBg)) {
          selectedCells.push({ x, y })
        }
      }
    }

    expect(selectedCells.length).toBeGreaterThan(1)

    await mockMouse.moveTo(anchorX, anchorY)
    await renderOnce()

    const assertDeselectedCellsRestored = (frameBuffer: TestRenderer["currentRenderBuffer"]): void => {
      const mismatches: string[] = []

      for (const { x, y } of selectedCells) {
        if (x === anchorX && y === anchorY) continue

        const cp = getCharAt(frameBuffer, x, y)
        if (cp === 0 || cp === VERTICAL_BORDER_CP) continue

        if (getFgAt(frameBuffer, x, y).toInts().join(",") !== defaultFg.toInts().join(",")) {
          mismatches.push(`fg@${x},${y}`)
        }

        if (getBgAt(frameBuffer, x, y).toInts().join(",") !== defaultBg.toInts().join(",")) {
          mismatches.push(`bg@${x},${y}`)
        }
      }

      expect(mismatches).toEqual([])
    }

    buffer = renderer.currentRenderBuffer
    expect(table.getSelectedText()).toBe("")
    assertDeselectedCellsRestored(buffer)

    await mockMouse.release(anchorX, anchorY)
    await renderOnce()

    buffer = renderer.currentRenderBuffer
    assertDeselectedCellsRestored(buffer)
    expect(getCharAt(buffer, farX, farY)).toBe("D".codePointAt(0)!)
  })

  test("does not start selection when drag begins on border", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      content: [
        [[bold("A")], [bold("B")]],
        [cell("1"), cell("2")],
      ],
    })

    renderer.root.add(table)
    await renderOnce()

    await mockMouse.drag(table.x, table.y, table.x + 4, table.y + 1)
    await renderOnce()

    expect(table.hasSelection()).toBe(false)
    expect(table.getSelectedText()).toBe("")
  })

  test("clears stale per-cell local selection state between drags", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 1,
      top: 8,
      width: 44,
      content: [
        [[bold("Service")], [bold("Status")], [bold("Notes")]],
        [cell("api"), [green("OK")], cell("latency 28ms")],
        [cell("worker"), [yellow("DEGRADED")], cell("queue depth: 124")],
        [cell("billing"), [red("ERROR")], cell("retrying payment provider")],
      ],
    })

    renderer.root.add(table)
    await renderOnce()

    await mockMouse.drag(14, 9, 40, 18)
    await renderOnce()

    await mockMouse.click(27, 13)
    await renderOnce()

    await mockMouse.pressDown(13, 9)
    await renderOnce()

    await mockMouse.moveTo(13, 10)
    await renderOnce()
    await mockMouse.moveTo(13, 11)
    await renderOnce()
    await mockMouse.moveTo(13, 13)
    await renderOnce()
    await mockMouse.moveTo(13, 16)
    await renderOnce()
    await mockMouse.moveTo(13, 20)
    await renderOnce()

    await mockMouse.release(13, 20)
    await renderOnce()

    expect(table.getSelectedText()).toBe("Status\nOK\nDEGRADED\nERROR")
  })

  test("reverse drag across full table keeps left cells selected", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      content: [
        [[bold("H1")], [bold("H2")], [bold("H3")]],
        [cell("R1C1"), cell("R1C2"), cell("R1C3")],
        [cell("R2C1"), cell("R2C2"), cell("R2C3")],
        [cell("R3C1"), cell("R3C2"), cell("R3C3")],
      ],
    })

    renderer.root.add(table)
    await renderOnce()

    const start = findSelectablePoint(table, "bottom-right")
    const end = findSelectablePoint(table, "top-left")

    await mockMouse.drag(start.x, start.y, end.x, end.y)
    await renderOnce()

    const selected = table.getSelectedText()

    expect(selected).toBe("H1\tH2\tH3\nR1C1\tR1C2\tR1C3\nR2C1\tR2C2\tR2C3\nR3C1\tR3C2\tR3C3")
  })

  test("reverse drag ending on left border still includes first column", async () => {
    const table = new TextTableRenderable(renderer, {
      left: 0,
      top: 0,
      content: [
        [[bold("Name")], [bold("Status")]],
        [cell("Alice"), cell("Done")],
        [cell("Bob"), cell("In Progress")],
      ],
    })

    renderer.root.add(table)
    await renderOnce()

    const start = findSelectablePoint(table, "bottom-right")
    const endX = table.x
    const endY = findSelectablePoint(table, "top-left").y

    await mockMouse.drag(start.x, start.y, endX, endY)
    await renderOnce()

    const selected = table.getSelectedText()

    expect(selected).toContain("Name")
    expect(selected).toContain("Alice")
    expect(selected).toContain("Bob")
  })

  test("keeps full wrapped table layouts after a wide-to-narrow demo-style resize", async () => {
    resizeRenderer(108, 38)
    await renderOnce()

    const primaryContent: TextTableContent = [
      [[bold("Task")], [bold("Owner")], [bold("ETA")]],
      [
        cell(
          "Wrap regression in operational status dashboard with dynamic row heights and constrained layout validation",
        ),
        cell("core platform and runtime reliability squad"),
        cell(
          "done after validating none, word, and char wrap modes across narrow, medium, wide, and ultra-wide terminal widths",
        ),
      ],
      [
        cell(
          "Unicode layout stabilization for mixed Latin, punctuation, symbols, and long identifiers in adjacent columns",
        ),
        cell("render pipeline maintainers with fallback shaping support"),
        cell(
          "in review with follow-up checks for border style transitions, cell padding variants, and selection range consistency",
        ),
      ],
      [
        cell(
          "Snapshot pass for table rendering in content mode and full mode with heavy and double border combinations",
        ),
        cell("qa automation and visual diff triage group"),
        cell(
          "today pending final baseline updates for oversized fixtures that intentionally stress wrapping behavior on high-resolution terminals",
        ),
      ],
      [
        cell(
          "Document edge cases where long tokens without spaces force char wrapping and reveal per-cell clipping regressions",
        ),
        cell("developer experience and docs tooling"),
        cell(
          "planned for this sprint once final reproducible examples are captured and linked to regression tracking tickets",
        ),
      ],
      [
        cell(
          "Performance sweep of wrapping algorithm under large datasets to confirm stable frame times during rapid key toggling",
        ),
        cell("runtime performance task force"),
        cell("scheduled after review, with benchmark runs on laptop and desktop terminals at 200-plus column widths"),
      ],
    ]

    const unicodeContent: TextTableContent = [
      [[bold("Column")], [bold("Wrapped Text")]],
      [
        cell("mixed-languages"),
        cell(
          "CJK and emoji wrapping stress case: こんにちは世界 and 안녕하세요 세계 and 你好，世界 followed by long English prose that keeps flowing to test whether each cell wraps naturally even when the terminal is extremely wide and the row still needs multiple visual lines for readability 🌍🚀",
        ),
      ],
      [
        cell("emoji-and-symbols"),
        cell(
          "Faces 😀😃😄😁😆 plus symbols 🧪📦🛰️🔧📊 mixed with version tags like release-candidate-build-2026-02-very-long-token-without-breaks to ensure char wrapping remains stable and no glyph alignment issues appear at column boundaries",
        ),
      ],
      [
        cell("long-cjk-phrase"),
        cell(
          "長文の日本語テキストと中文段落和한국어문장을連続して配置し、その後に additional English context describing renderer behavior, border intersection handling, and selection extraction so that this single cell remains a reliable wrapping torture test.",
        ),
      ],
      [
        cell("mixed-punctuation"),
        cell(
          "Wrap behavior with punctuation-heavy content: [alpha]{beta}(gamma)<delta>|epsilon| then repeated fragments, commas, semicolons, and slashes to verify token boundaries do not break border drawing logic or spacing consistency in neighboring columns.",
        ),
      ],
    ]

    const container = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      padding: 1,
      gap: 1,
    })

    const tableAreaScrollBox = new ScrollBoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexShrink: 1,
      scrollY: true,
      scrollX: false,
      border: false,
      contentOptions: {
        flexDirection: "column",
        gap: 1,
      },
    })

    const controlsText = new TextRenderable(renderer, {
      content: "TextTable Demo",
      wrapMode: "word",
      selectable: false,
    })

    const primaryLabel = new TextRenderable(renderer, {
      content: "Operational Table",
      selectable: false,
    })

    const primaryTable = new TextTableRenderable(renderer, {
      width: "100%",
      wrapMode: "word",
      content: primaryContent,
    })

    const unicodeLabel = new TextRenderable(renderer, {
      content: "Unicode/CJK/Emoji Table",
      selectable: false,
    })

    const unicodeTable = new TextTableRenderable(renderer, {
      width: "100%",
      wrapMode: "word",
      content: unicodeContent,
    })

    const selectionBox = new BoxRenderable(renderer, {
      width: "100%",
      height: 10,
      flexGrow: 0,
      flexShrink: 0,
      border: true,
      title: "Selected Text",
      titleAlignment: "left",
      padding: 1,
    })

    tableAreaScrollBox.add(controlsText)
    tableAreaScrollBox.add(primaryLabel)
    tableAreaScrollBox.add(primaryTable)
    tableAreaScrollBox.add(unicodeLabel)
    tableAreaScrollBox.add(unicodeTable)

    container.add(tableAreaScrollBox)
    container.add(selectionBox)
    renderer.root.add(container)

    await renderOnce()

    resizeRenderer(72, 38)
    await renderOnce()
    await renderOnce()

    const expectedPrimaryFrame = await renderStandaloneTableBlock(primaryTable.width, primaryContent, (line) =>
      line.includes("Task"),
    )
    const expectedUnicodeFrame = await renderStandaloneTableBlock(unicodeTable.width, unicodeContent, (line) =>
      line.includes("Wrapped"),
    )

    expect(expectedPrimaryFrame).toMatchSnapshot("demo resize expected primary table")
    expect(expectedUnicodeFrame).toMatchSnapshot("demo resize expected unicode table")

    const resizedFrame = captureFrame()
    expect(resizedFrame).toContain("Operational Table")
    expect(resizedFrame).toContain("Task")

    const contentBottom = getScrollContentBottom(tableAreaScrollBox)
    expect(contentBottom).toBeGreaterThan(tableAreaScrollBox.viewport.height)
    expect(tableAreaScrollBox.scrollHeight).toBe(contentBottom)

    const maxScrollTop = Math.max(0, tableAreaScrollBox.scrollHeight - tableAreaScrollBox.viewport.height)
    expect(maxScrollTop).toBeGreaterThan(0)

    tableAreaScrollBox.scrollTop = maxScrollTop
    await renderOnce()

    const scrolledToBottomFrame = captureFrame()
    expect(scrolledToBottomFrame).toContain("epsilon")
  })

  test("keeps scroll height aligned with content bottom after word-wrap resize", async () => {
    resizeRenderer(104, 34)
    await renderOnce()

    const tableContent: TextTableContent = [
      [[bold("Key")], [bold("Value")]],
      [
        cell("alpha"),
        cell(
          "word wrapping should preserve intrinsic table height even when parent measure passes provide a smaller at-most height",
        ),
      ],
      [
        cell("beta"),
        cell(
          "this row is intentionally verbose and pushes the wrapped table height so that scrolling must include all visual lines",
        ),
      ],
      [cell("marker"), cell("ENDWORD")],
    ]

    const root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      padding: 1,
      gap: 1,
    })

    const scrollBox = new ScrollBoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexShrink: 1,
      scrollY: true,
      scrollX: false,
      border: false,
      contentOptions: {
        flexDirection: "column",
        gap: 1,
      },
    })

    const table = new TextTableRenderable(renderer, {
      width: "100%",
      wrapMode: "word",
      content: tableContent,
    })

    root.add(scrollBox)
    root.add(
      new BoxRenderable(renderer, {
        width: "100%",
        height: 16,
        flexGrow: 0,
        flexShrink: 0,
      }),
    )

    scrollBox.add(new TextRenderable(renderer, { content: "Word Wrap Table", selectable: false }))
    scrollBox.add(table)
    renderer.root.add(root)

    await renderOnce()

    resizeRenderer(66, 34)
    await renderOnce()
    await renderOnce()

    const contentBottom = getScrollContentBottom(scrollBox)
    expect(contentBottom).toBeGreaterThan(scrollBox.viewport.height)
    expect(scrollBox.scrollHeight).toBe(contentBottom)

    scrollBox.scrollTop = Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height)
    await renderOnce()

    expect(captureFrame()).toContain("ENDWORD")
  })

  test("keeps scroll height aligned with content bottom in char-wrap full mode", async () => {
    resizeRenderer(104, 34)
    await renderOnce()

    const tableContent: TextTableContent = [
      [[bold("Name")], [bold("Payload")]],
      [cell("row-1"), cell("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")],
      [cell("row-2"), cell("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB")],
      [cell("row-3"), cell("CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC")],
      [cell("marker"), cell("ENDCHAR")],
    ]

    const root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      padding: 1,
      gap: 1,
    })

    const scrollBox = new ScrollBoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexShrink: 1,
      scrollY: true,
      scrollX: false,
      border: false,
      contentOptions: {
        flexDirection: "column",
        gap: 1,
      },
    })

    const table = new TextTableRenderable(renderer, {
      width: "100%",
      wrapMode: "char",
      columnWidthMode: "full",
      content: tableContent,
    })

    root.add(scrollBox)
    root.add(
      new BoxRenderable(renderer, {
        width: "100%",
        height: 16,
        flexGrow: 0,
        flexShrink: 0,
      }),
    )

    scrollBox.add(new TextRenderable(renderer, { content: "Char Wrap Fill Table", selectable: false }))
    scrollBox.add(table)
    renderer.root.add(root)

    await renderOnce()

    resizeRenderer(58, 34)
    await renderOnce()
    await renderOnce()

    const contentBottom = getScrollContentBottom(scrollBox)
    expect(contentBottom).toBeGreaterThan(scrollBox.viewport.height)
    expect(scrollBox.scrollHeight).toBe(contentBottom)

    scrollBox.scrollTop = Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height)
    await renderOnce()

    expect(captureFrame()).toContain("ENDCHAR")
  })
})
