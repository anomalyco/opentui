import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OptimizedBuffer } from "../../buffer.js"
import { RGBA } from "../../lib/RGBA.js"
import { Selection } from "../../lib/selection.js"
import { TreeSitterClient } from "../../lib/tree-sitter/index.js"
import { SyntaxStyle } from "../../syntax-style.js"
import { createTestRenderer, type TestRendererSetup } from "../../testing/test-renderer.js"
import { BoxRenderable } from "../Box.js"
import { CodeRenderable } from "../Code.js"
import { DiffRenderable } from "../Diff.js"
import { LineNumberRenderable } from "../LineNumberRenderable.js"
import { ScrollBoxRenderable } from "../ScrollBox.js"
import { TextRenderable } from "../Text.js"

class ObservedText extends TextRenderable {
  lineInfoReads = 0
  sourceRows = 0

  override get lineInfo() {
    this.lineInfoReads++
    return super.lineInfo
  }

  override getLineSources(startLine: number, lineCount: number) {
    this.sourceRows += lineCount
    return super.getLineSources(startLine, lineCount)
  }
}

class CustomText extends TextRenderable {
  sourceOffset = 10

  override get lineInfo() {
    const info = super.lineInfo
    return { ...info, lineSources: info.lineSources.map((line) => line + this.sourceOffset) }
  }
}

class CustomCode extends CodeRenderable {
  override get lineInfo() {
    const info = super.lineInfo
    return { ...info, lineSources: info.lineSources.map((line) => (line === 1 ? 0 : line)) }
  }
}

let setup: TestRendererSetup

afterEach(() => setup?.renderer.destroy())

async function document(content: string, width = 32, height = 6) {
  setup = await createTestRenderer({ width, height })
  const scroll = new ScrollBoxRenderable(setup.renderer, {
    width: "100%",
    height: "100%",
    scrollbarOptions: { visible: false },
  })
  scroll.verticalScrollBar.visible = false
  scroll.horizontalScrollBar.visible = false
  const card = new BoxRenderable(setup.renderer, { flexShrink: 0 })
  const text = new ObservedText(setup.renderer, { content, wrapMode: "char", flexGrow: 1 })
  const numbers = new LineNumberRenderable(setup.renderer, { target: text, flexShrink: 0 })
  card.add(numbers)
  scroll.add(card)
  setup.renderer.root.add(scroll)
  return { scroll, card, text, numbers, gutter: numbers["gutter"]! }
}

describe("LineNumber paint window", () => {
  test("unrelated text updates reuse the gutter raster while gutter changes repaint it", async () => {
    setup = await createTestRenderer({ width: 24, height: 5 })
    const ticker = new TextRenderable(setup.renderer, { content: "tick-0", height: 1, flexShrink: 0 })
    const text = new TextRenderable(setup.renderer, { content: "one\ntwo\nthree", flexGrow: 1 })
    const numbers = new LineNumberRenderable(setup.renderer, { target: text, flexShrink: 0 })
    setup.renderer.root.add(ticker)
    setup.renderer.root.add(numbers)
    await setup.flush()

    const raster = numbers["gutter"]!["frameBuffer"]!
    const clear = raster.clear.bind(raster)
    let paints = 0
    raster.clear = (...args) => {
      paints++
      clear(...args)
    }
    ticker.content = "tick-1"
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("tick-1")
    expect(setup.captureCharFrame()).toContain("3 three")
    expect(paints).toBe(0)

    numbers.setLineNumbers(new Map([[0, 9]]))
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("9 one")
    expect(paints).toBe(1)
    ticker.content = "tick-2"
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("9 one")
    expect(paints).toBe(1)
  })

  test("fractional target scrolling and ancestor translation match native cell coordinates", async () => {
    setup = await createTestRenderer({ width: 24, height: 3 })
    const card = new BoxRenderable(setup.renderer, { flexShrink: 0 })
    const text = new TextRenderable(setup.renderer, {
      content: Array.from({ length: 10 }, (_, line) => `row-${line}`).join("\n"),
      height: 6,
      flexGrow: 1,
    })
    const numbers = new LineNumberRenderable(setup.renderer, { target: text, flexShrink: 0 })
    for (let line = 0; line < 10; line++) {
      numbers.setLineSign(line, { before: String.fromCharCode(65 + line) })
      numbers.setLineColor(line, {
        gutter: RGBA.fromInts(32 + line * 10, 48, 64),
        content: RGBA.fromInts(64, 48, 32 + line * 10),
      })
    }
    card.add(numbers)
    setup.renderer.root.add(card)
    await setup.renderOnce()
    for (const [scrollY, translateY, firstSource, firstRow] of [
      [0, 0, 0, 0],
      [1, 0, 1, 0],
      [0, -1, 1, 0],
      [1, -1, 2, 0],
      [0, 1, 0, 1],
      // Node's native integer arguments reject fractions; Bun truncates them toward zero.
      ...(process.versions.bun
        ? [
            [0.5, 0, 0, 0],
            [1.5, 0, 1, 0],
            [0, -0.5, 0, 0],
            [0, -1.5, 1, 0],
            [0, -1.9, 1, 0],
            [0.5, -0.5, 0, 0],
            [1.5, -1.5, 2, 0],
            [0, 0.5, 0, 0],
            [0, 1.5, 0, 1],
          ]
        : []),
    ]) {
      text.scrollY = scrollY
      card.translateY = translateY
      await setup.renderOnce()
      expect(text.scrollY).toBe(scrollY)
      expect(card.translateY).toBe(translateY)
      const rows = setup.captureCharFrame().split("\n")
      for (let row = 0; row < 3; row++) {
        if (row < firstRow) {
          expect(rows[row].trim()).toBe("")
          continue
        }
        const source = firstSource + row - firstRow
        expect(rows[row].trim()).toBe(`${String.fromCharCode(65 + source)}  ${source + 1} row-${source}`)
        const gutterOffset = row * 24 * 4
        const contentOffset = (row * 24 + 20) * 4
        setup.renderer.currentRenderBuffer.withBuffers((cells) => {
          expect(Array.from(cells.bg.slice(gutterOffset, gutterOffset + 4))).toEqual([32 + source * 10, 48, 64, 255])
          expect(Array.from(cells.bg.slice(contentOffset, contentOffset + 4))).toEqual([64, 48, 32 + source * 10, 255])
        })
      }
    }
  })

  test("cached gutter distinguishes the first row from a wrapped continuation at the same raster size", async () => {
    setup = await createTestRenderer({ width: 14, height: 3 })
    const text = new TextRenderable(setup.renderer, {
      content: "abcdefghijklmno",
      wrapMode: "char",
      height: 1,
      flexGrow: 1,
    })
    const numbers = new LineNumberRenderable(setup.renderer, { target: text, minHeight: 3, flexShrink: 0 })
    setup.renderer.root.add(numbers)
    await setup.flush()
    const raster = numbers["gutter"]!["frameBuffer"]!
    expect(raster.height).toBe(3)
    expect(text.getLineSources(0, 4)).toEqual([0, 0])
    expect(setup.captureCharFrame().split("\n")[0]).toContain("1 abcdefghijk")
    setup.resize(14, 2)
    await setup.flush()
    expect(numbers["gutter"]!["frameBuffer"]!.height).toBe(2)
    expect(setup.captureCharFrame().split("\n")[0]).toContain("1 abcdefghijk")
    setup.resize(14, 3)
    await setup.flush()
    text.scrollY = 1
    await setup.renderOnce()
    expect(numbers["gutter"]!["frameBuffer"]!.height).toBe(3)
    expect(setup.captureCharFrame().split("\n")[0]).toBe("   o          ")
  })

  test("remapped sources refresh when the target paints before its gutter", async () => {
    setup = await createTestRenderer({ width: 24, height: 3 })
    const text = new CustomText(setup.renderer, { content: "one\ntwo\nthree", flexGrow: 1, zIndex: -1 })
    const numbers = new LineNumberRenderable(setup.renderer, { target: text, minWidth: 4, flexShrink: 0 })
    setup.renderer.root.add(numbers)
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("11 one")
    text.sourceOffset = 20
    text.requestRender()
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("21 one")
  })

  test("legacy Text lineInfo overrides retain remapped numbers, signs and wrap continuations", async () => {
    const doc = await document("", 14, 3)
    doc.numbers.visible = false
    const text = new CustomText(setup.renderer, {
      content: "abcdefghijklmno\nx\ny\nz\nend",
      wrapMode: "char",
      flexGrow: 1,
    })
    const numbers = new LineNumberRenderable(setup.renderer, { target: text, minWidth: 5, flexShrink: 0 })
    numbers.setLineSign(10, { before: "+" })
    doc.card.add(numbers)
    await setup.renderOnce()
    expect(setup.captureCharFrame().split("\n")[0]).toMatch(/^\+\s+11 abcdefgh/)
    expect(text.getLineSources(0, 3)).toEqual([10, 10, 11])
    const count = text.virtualLineCount
    doc.scroll.scrollTo(1)
    await setup.renderOnce()
    expect(setup.captureCharFrame().split("\n")[0]).toBe("      ijklmno ")
    expect(setup.captureCharFrame().split("\n")[1]).toContain("12 x")
    text.sourceOffset = 20
    text.requestRender()
    await setup.renderOnce()
    expect(text.virtualLineCount).toBe(count)
    expect(text.getLineSources(1, 2)).toEqual([20, 21])
    expect(setup.captureCharFrame().split("\n")[1]).toContain("22 x")
    expect(numbers["gutter"]!["frameBuffer"]!.height).toBe(3)
  })

  test("ordinary Text paint does not invoke the complete native lineInfo getter", async () => {
    const doc = await document("")
    doc.numbers.visible = false
    const text = new TextRenderable(setup.renderer, { content: "plain\ntext", flexGrow: 1 })
    expect(text["textBufferView"]).toBeUndefined()
    const numbers = new LineNumberRenderable(setup.renderer, { target: text, flexShrink: 0 })
    numbers.highlightLines(0, 1, "#203040")
    doc.card.add(numbers)
    await setup.renderOnce()
    expect(text.getLineSources(0, 2)).toEqual([0, 1])
    expect(text.scrollHeight).toBe(2)
    expect(setup.captureCharFrame()).toContain("1 plain")
  })

  test("bounds raster allocation and background work, not natural document geometry", async () => {
    const doc = await document(Array.from({ length: 10000 }, (_, i) => `row-${i + 1}`).join("\n"))
    doc.numbers.highlightLines(0, 9999, { gutter: "#304050", content: "#203040" })
    const colors = doc.numbers.getLineColors().content
    const get = colors.get.bind(colors)
    let lookups = 0
    colors.get = (line) => {
      lookups++
      return get(line)
    }
    const gutterColors = doc.numbers.getLineColors().gutter
    const gutterGet = gutterColors.get.bind(gutterColors)
    let gutterLookups = 0
    gutterColors.get = (line) => {
      gutterLookups++
      return gutterGet(line)
    }
    let layoutRasterHeight = 0
    doc.gutter.onSizeChange = () => {
      layoutRasterHeight = Math.max(layoutRasterHeight, doc.gutter["frameBuffer"]?.height ?? 0)
    }
    await setup.renderOnce()
    expect(doc.text.height).toBe(10000)
    expect(doc.numbers.height).toBe(10000)
    expect(doc.gutter.height).toBe(10000)
    expect(doc.scroll.scrollHeight).toBe(10000)
    expect(layoutRasterHeight).toBeLessThanOrEqual(6)
    expect(doc.gutter["frameBuffer"]!.height).toBe(6)
    expect(lookups).toBeLessThanOrEqual(6)
    expect(gutterLookups).toBeLessThanOrEqual(6)
    expect(setup.captureCharFrame()).toContain("1 row-1")

    doc.numbers.setLineSign(5000, { before: "+", after: "!" })
    doc.numbers.setLineNumbers(new Map([[5000, 12345]]))
    doc.scroll.scrollTo(5000)
    lookups = 0
    gutterLookups = 0
    await setup.renderOnce()
    expect(doc.text.scrollY).toBe(0)
    expect(doc.gutter.y).toBe(-5000)
    expect(setup.captureCharFrame().split("\n")[0]).toMatch(/\+\s+12345! row-5001/)
    expect(doc.gutter["frameBuffer"]!.height).toBe(6)
    expect(lookups).toBeLessThanOrEqual(6)
    expect(gutterLookups).toBeLessThanOrEqual(6)

    doc.scroll.scrollTo(9994)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("10000  row-10000")
    expect(doc.scroll.scrollHeight).toBe(10000)
  })

  test("offscreen hunks inside a visible card do not request row metadata or allocate rasters", async () => {
    const doc = await document("visible")
    const below = new ObservedText(setup.renderer, {
      content: Array.from({ length: 2000 }, () => "below").join("\n"),
      flexShrink: 0,
    })
    const numbers = new LineNumberRenderable(setup.renderer, { target: below, marginTop: 8, flexShrink: 0 })
    numbers.highlightLines(0, 1999, "#303030")
    doc.card.add(numbers)
    await setup.renderOnce()
    below.lineInfoReads = 0
    below.sourceRows = 0
    await setup.renderOnce()
    expect(numbers.y).toBeGreaterThanOrEqual(6)
    expect(below.lineInfoReads).toBe(0)
    expect(below.sourceRows).toBe(0)
    expect(numbers["gutter"]!["frameBuffer"]).toBeNull()
    doc.card.translateX = 1000
    doc.text.lineInfoReads = 0
    doc.text.sourceRows = 0
    await setup.renderOnce()
    expect(doc.text.lineInfoReads).toBe(0)
    expect(doc.text.sourceRows).toBe(0)
  })

  test("visible paint and vertical scroll extents avoid unpacking complete visual-row arrays", async () => {
    const doc = await document(Array.from({ length: 10000 }, (_, i) => `row-${i + 1}`).join("\n"))
    doc.numbers.highlightLines(0, 9999, "#203040")
    await setup.renderOnce()
    doc.scroll.scrollTo(5000)
    doc.text.lineInfoReads = 0
    doc.text.sourceRows = 0
    await setup.renderOnce()
    expect(doc.text.scrollHeight).toBe(10000)
    expect(doc.text.lineInfoReads).toBe(0)
    expect(doc.text.sourceRows).toBe(13) // Six backgrounds, six gutter rows and their preceding source.
  })

  test("outer scroll starts on wrapped continuations without repeating numbers or signs", async () => {
    const doc = await document("abcdefghijklmno\nx\ny\nz\nend", 14, 3)
    doc.numbers.setLineSign(0, { before: "+" })
    doc.numbers.setLineColor(0, "#304050")
    await setup.renderOnce()
    expect(setup.captureCharFrame().split("\n")[0]).toMatch(/^\+\s+1 abcdefghij/)
    doc.scroll.scrollTo(1)
    await setup.renderOnce()
    expect(setup.captureCharFrame().split("\n")[0]).toBe("    klmno     ")
    expect(setup.captureCharFrame().split("\n")[1]).toContain("2 x")
    doc.scroll.scrollTo(2)
    await setup.renderOnce()
    expect(setup.captureCharFrame().split("\n")[0]).toContain("2 x")
  })

  test("same-row-count content and wrapping mutations refresh numbers and preserve selection", async () => {
    const doc = await document("abcdefghijklmno\nx\ny\nz\nend", 14, 3)
    await setup.renderOnce()
    const count = doc.text.virtualLineCount
    doc.scroll.scrollTo(1)
    await setup.renderOnce()
    doc.text.content = "x\nabcdefghijklmno\ny\nz\nend"
    await setup.renderOnce()
    expect(doc.text.virtualLineCount).toBe(count)
    expect(setup.captureCharFrame().split("\n")[0]).toContain("2 abcdefghijk")
    const selection = new Selection(doc.text, { x: doc.text.x, y: 0 }, { x: doc.text.x + 2, y: 0 })
    selection.isStart = true
    doc.text.onSelectionChanged(selection)
    expect(doc.text.getSelectedText()).toBe("abc")
    const bounds = doc.text.getSelection()
    await setup.renderOnce()
    expect(doc.text.getSelection()).toEqual(bounds)
    expect(doc.text.getSelectedText()).toBe("abc")
    expect(doc.text.plainText).toBe("x\nabcdefghijklmno\ny\nz\nend")
  })

  test("arbitrary destination heights paint all requested rows, including beyond terminal height", async () => {
    const doc = await document(Array.from({ length: 30 }, (_, i) => `row-${i + 1}`).join("\n"))
    doc.numbers.highlightLines(0, 29, { gutter: "#304050", content: "#203040" })
    await setup.renderOnce()
    const buffer = OptimizedBuffer.create(32, 30, setup.renderer.widthMethod, {
      respectAlpha: true,
      owner: setup.renderer.nativeScene,
    })
    try {
      buffer.clear(RGBA.fromValues(0, 0, 0, 0))
      doc.numbers["renderSelf"](buffer)
      doc.gutter["renderSelf"](buffer)
      doc.text.drawToBuffer(buffer, doc.text.x, 0)
      expect(new TextDecoder().decode(buffer.getRealCharBytes(true))).toContain("30 row-30")
      const offset = (29 * buffer.width + doc.text.x) * 4
      expect(buffer.withBuffers((cells) => Array.from(cells.bg.slice(offset, offset + 4)))).toEqual([32, 48, 64, 255])
      expect(doc.gutter["frameBuffer"]!.height).toBe(30)
      await setup.renderOnce()
      expect(doc.gutter["frameBuffer"]!.height).toBe(6)
      expect(doc.gutter.height).toBe(30)
    } finally {
      buffer.destroy()
    }
  })

  test("moving window matches full-raster translucent color and ancestor opacity composition", async () => {
    const doc = await document(Array.from({ length: 40 }, (_, i) => `row-${i + 1}`).join("\n"))
    doc.numbers.bg = RGBA.fromValues(0.2, 0.3, 0.4, 0.35)
    doc.numbers.fg = RGBA.fromValues(0.9, 0.8, 0.7, 0.65)
    doc.numbers.setLineColor(20, {
      gutter: RGBA.fromValues(0.4, 0.2, 0.1, 0.55),
      content: RGBA.fromValues(0.2, 0.4, 0.1, 0.45),
    })
    doc.numbers.setLineSign(20, { before: "+", beforeColor: RGBA.fromValues(1, 0, 0, 0.5) })
    await setup.renderOnce()
    const full = OptimizedBuffer.create(32, 40, setup.renderer.widthMethod, {
      respectAlpha: true,
      owner: setup.renderer.nativeScene,
    })
    const expected = OptimizedBuffer.create(32, 6, setup.renderer.widthMethod, {
      respectAlpha: true,
      owner: setup.renderer.nativeScene,
    })
    const actual = OptimizedBuffer.create(32, 6, setup.renderer.widthMethod, {
      respectAlpha: true,
      owner: setup.renderer.nativeScene,
    })
    try {
      full.clear(RGBA.fromValues(0, 0, 0, 0))
      doc.gutter["renderSelf"](full)
      for (const buffer of [expected, actual]) {
        buffer.clear(RGBA.fromValues(0.1, 0.2, 0.3, 1))
        buffer.pushOpacity(0.6)
        buffer.pushOpacity(0.7)
      }
      expected.drawFrameBuffer(0, -20, doc.gutter["frameBuffer"]!)
      doc.scroll.scrollTo(20)
      await setup.renderOnce()
      doc.gutter["renderSelf"](actual)
      actual.withBuffers((actualCells) => {
        expected.withBuffers((expectedCells) => {
          expect(actualCells.char).toEqual(expectedCells.char)
          expect(actualCells.fg).toEqual(expectedCells.fg)
          expect(actualCells.bg).toEqual(expectedCells.bg)
          expect(actualCells.attributes).toEqual(expectedCells.attributes)
        })
      })
    } finally {
      full.destroy()
      expected.destroy()
      actual.destroy()
    }
  })

  test("split diff asymmetric wrap padding and resize match full-height rendering at deep and end rows", async () => {
    const doc = await document("", 60, 6)
    doc.numbers.visible = false
    doc.card.paddingLeft = 2
    doc.card.paddingRight = 3
    doc.card.paddingTop = 1
    doc.card.paddingBottom = 2
    const style = SyntaxStyle.create(setup.renderer.nativeScene)
    const diff = new DiffRenderable(setup.renderer, {
      diff: [
        "--- a/example.txt",
        "+++ b/example.txt",
        "@@ -100,40 +200,41 @@",
        ...Array.from({ length: 40 }, (_, i) => `-old-${i}${i === 0 ? " long".repeat(15) : ""}`),
        ...Array.from({ length: 41 }, (_, i) => `+new-${i}${i === 10 ? " wide".repeat(20) : ""}`),
      ].join("\n"),
      view: "split",
      wrapMode: "word",
      syntaxStyle: style,
      flexShrink: 0,
    })
    doc.card.add(diff)
    try {
      for (const width of [60, 36]) {
        doc.scroll.scrollTo(0)
        setup.resize(width, 160)
        await setup.flush()
        const full = setup.captureCharFrame().split("\n")
        const fullHeight = doc.card.height
        const geometry = diff.getChildren().map((side) => side.getChildren().map((child) => child.height))
        setup.resize(width, 6)
        await setup.flush()
        expect(doc.card.height).toBe(fullHeight)
        for (const row of [20, fullHeight - 6]) {
          doc.scroll.scrollTo(row)
          await setup.flush()
          expect(setup.captureCharFrame().split("\n").slice(0, 6)).toEqual(full.slice(row, row + 6))
          expect(diff.getChildren().map((side) => side.getChildren().map((child) => child.height))).toEqual(geometry)
          for (const side of diff.getChildren()) {
            expect(side).toBeInstanceOf(LineNumberRenderable)
            const gutter = side.getChildren()[0]
            const code = side.getChildren()[1]
            expect(code).toBeInstanceOf(CodeRenderable)
            if (!(code instanceof CodeRenderable)) throw new Error("Expected a CodeRenderable")
            expect(gutter.height).toBeGreaterThanOrEqual(code.virtualLineCount)
            expect(gutter["frameBuffer"]!.height).toBeLessThanOrEqual(6)
          }
        }
      }
    } finally {
      diff.destroyRecursively()
      style.destroy()
    }
  })

  test("Code bounded sources track same-row-count conceal mapping changes through real highlighting", async () => {
    setup = await createTestRenderer({ width: 20, height: 6 })
    const client = new TreeSitterClient({ dataPath: join(tmpdir(), "tree-sitter-line-number-test-data") })
    const style = SyntaxStyle.create(setup.renderer.nativeScene)
    const code = new CodeRenderable(setup.renderer, {
      content: "a\nb\nc\nd",
      filetype: "javascript",
      syntaxStyle: style,
      treeSitterClient: client,
      onHighlight: () => [[0, 1, "conceal", { conceal: "", concealLines: "" }]],
    })
    const custom = new CustomCode(setup.renderer, {
      content: code.content,
      filetype: code.filetype,
      syntaxStyle: style,
      treeSitterClient: client,
      onHighlight: code.onHighlight,
    })
    const numbers = new LineNumberRenderable(setup.renderer, { target: code })
    const customNumbers = new LineNumberRenderable(setup.renderer, { target: custom })
    setup.renderer.root.add(numbers)
    setup.renderer.root.add(customNumbers)
    try {
      await setup.renderOnce()
      await Promise.all([code.highlightingDone, custom.highlightingDone])
      await setup.flush()
      expect(code.plainText).toBe("b\nc\nd")
      expect(code.getLineSources(0, 3)).toEqual([1, 2, 3])
      expect(code["_mappedLineInfo"]).toBeUndefined()
      expect(setup.captureCharFrame().split("\n")[0]).toContain("2 b")
      expect(custom.getLineSources(0, 3)).toEqual([0, 2, 3])
      expect(setup.captureCharFrame().split("\n")[3]).toContain("1 b")
      const count = code.virtualLineCount
      code.onHighlight = () => [[2, 3, "conceal", { conceal: "", concealLines: "" }]]
      code.requestRender()
      await setup.renderOnce()
      await code.highlightingDone
      await setup.flush()
      expect(code.virtualLineCount).toBe(count)
      expect(code.plainText).toBe("a\nc\nd")
      expect(code.getLineSources(0, 3)).toEqual([0, 2, 3])
      expect(code["_mappedLineInfo"]).toBeUndefined()
      expect(code.getLineSources(1, 1)).toEqual(code.lineInfo.lineSources.slice(1, 2))
      expect(setup.captureCharFrame()).toContain("1 a")
      expect(setup.captureCharFrame()).toContain("4 d")
    } finally {
      numbers.destroyRecursively()
      customNumbers.destroyRecursively()
      await client.destroy()
      style.destroy()
    }
  })
})
