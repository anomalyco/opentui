import { afterEach, describe, expect, test } from "bun:test"
import { rgbToHex } from "../lib/RGBA.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CodeRenderable } from "../renderables/Code.js"
import { MarkdownRenderable } from "../renderables/Markdown.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { TextRenderable } from "../renderables/Text.js"
import { TextNodeRenderable } from "../renderables/TextNode.js"
import { SyntaxStyle } from "../syntax-style.js"
import { MockTreeSitterClient } from "../testing/mock-tree-sitter-client.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import type { NativeFrameWork, NativeRenderStats } from "../zig.js"

function expectInitialStats(stats: NativeRenderStats): void {
  expect(stats.nativeLastFrameTime).toBe(0)
  expect(stats.nativeAverageFrameTime).toBe(0)
  expect(stats.nativeFrameCount).toBe(0)
  expect(stats.cellsUpdated).toBe(0)
  expect(stats.averageCellsUpdated).toBe(0)
  expect(stats.nativeRenderTime).toBeUndefined()
  expect(stats.nativeStdoutWriteTime).toBeUndefined()
  expect(Object.values(stats.frameWork).every((value) => value === 0)).toBe(true)
}

function expectRenderedStats(stats: NativeRenderStats, expectedFrameCount: number, expectedCellsUpdated: number): void {
  expect(stats.nativeFrameCount).toBe(expectedFrameCount)
  expect(stats.cellsUpdated).toBe(expectedCellsUpdated)
  expect(stats.nativeRenderTime).toBeGreaterThanOrEqual(0)
  expect(stats.nativeStdoutWriteTime).toBeGreaterThanOrEqual(0)
}

describe("native renderer stats", () => {
  let renderer: TestRenderer | null = null

  afterEach(async () => {
    renderer?.destroy()
    await renderer?.closed
    renderer = null
  })

  test("cellsUpdated counts changed diff cells for native scene renders", async () => {
    const result = await createTestRenderer({ width: 4, height: 2 })
    renderer = result.renderer
    await result.renderOnce()

    expectRenderedStats(renderer.getNativeStats(), 1, 8)
    expect(renderer.getNativeStats().averageCellsUpdated).toBe(8)

    const text = new TextRenderable(renderer, { content: "abc", width: 3, height: 1 })
    renderer.root.add(text)
    await result.renderOnce()

    expectRenderedStats(renderer.getNativeStats(), 2, 3)

    await result.renderOnce()

    expectRenderedStats(renderer.getNativeStats(), 3, 0)

    text.content = "axc"
    await result.renderOnce()

    expectRenderedStats(renderer.getNativeStats(), 4, 1)
  })

  test("forced native renders count the full render surface", async () => {
    const result = await createTestRenderer({ width: 5, height: 2 })
    renderer = result.renderer
    await result.renderOnce()

    renderer.root.add(new TextRenderable(renderer, { content: "xy", width: 2, height: 1 }))
    await result.renderOnce()
    expectRenderedStats(renderer.getNativeStats(), 2, 2)

    // @ts-expect-error - request the renderer-owned full repaint in this regression test
    renderer.forceFullRepaintRequested = true
    await result.renderOnce()

    expectRenderedStats(renderer.getNativeStats(), 3, 10)
  })

  test("frameWork counts the work of each presented scene frame, with and without nativeSceneFullFrame", async () => {
    for (const nativeSceneFullFrame of [false, true]) {
      const result = await createTestRenderer({ width: 4, height: 2, nativeSceneFullFrame })
      renderer = result.renderer
      renderer.root.add(new TextRenderable(renderer, { content: "abc", width: 3, height: 1 }))
      const zero = Object.fromEntries(
        Object.keys(renderer.getNativeStats().frameWork).map((key) => [key, 0]),
      ) as NativeFrameWork
      const forced = nativeSceneFullFrame ? 1 : 0
      const steady = {
        ...zero,
        viewPreparations: 2,
        membersPainted: 1,
        memberCells: 3,
        cellsCleared: 16,
        hitCellsWritten: 0,
        hitCellsCleared: 0,
        hitCellsCompared: 0,
        layoutRounds: 1,
      }
      await result.renderOnce()
      expect(renderer.getNativeStats().frameWork).toEqual({
        ...steady,
        workFrameId: 1,
        candidateVisits: 2,
        geometryReads: 2,
        yogaSolves: 1,
        rowsDiffed: 2,
        fullPathReasons: 2 | forced,
      })
      // An unchanged frame compares rows instead of diffing them, and reuses preparation unless forced.
      await result.renderOnce()
      const unchanged = { workFrameId: 2, rowsCompared: 2, candidateVisits: 2 * forced, fullPathReasons: forced }
      expect(renderer.getNativeStats().frameWork).toEqual({ ...steady, ...unchanged })
      expect(renderer.getStats().frameWork).toEqual(renderer.getNativeStats().frameWork)
      renderer.destroy()
      await renderer.closed
      renderer = null
    }
  })

  test("a culled ScrollBox refreshes its rows only on frames that change layout", async () => {
    const result = await createTestRenderer({ width: 40, height: 10 })
    renderer = result.renderer
    const scrollbox = new ScrollBoxRenderable(renderer, { width: "100%", height: "100%" })
    renderer.root.add(scrollbox)
    for (let i = 0; i < 1_000; i++) scrollbox.add(new TextRenderable(renderer, { content: `row ${i}` }))
    const refreshes = async () => {
      await result.renderOnce()
      return renderer!.getNativeStats().frameWork.viewportChildRefreshes
    }
    // The first frame lays out and refreshes every row, once per layout round.
    expect(await refreshes()).toBeGreaterThanOrEqual(1_000)
    expect(await refreshes()).toBe(0)
    scrollbox.scrollTo(500)
    expect(await refreshes()).toBe(0)
    scrollbox.add(new TextRenderable(renderer, { content: "appended" }))
    expect(await refreshes()).toBe(1_001)
  })

  test("frameWork solves Yoga only for text writes and viewports that can change the measured size", async () => {
    const result = await createTestRenderer({ width: 40, height: 20 })
    renderer = result.renderer
    // Solid builds `<text fg={...}>` content from child nodes.
    const label = new TextRenderable(renderer, { fg: "#808080" })
    const span = new TextNodeRenderable({})
    span.add("Model")
    label.add("Simulated ")
    label.add(span)
    const plain = new TextRenderable(renderer, { content: "plain" })
    const highlights = new MockTreeSitterClient()
    highlights.setMockResult({ highlights: [[0, 6, "keyword", { conceal: "" }]] })
    const syntaxStyle = SyntaxStyle.fromStyles({}, renderer.nativeScene)
    const code = new CodeRenderable(renderer, {
      content: "const pending = true",
      filetype: "typescript",
      syntaxStyle,
      treeSitterClient: highlights,
      conceal: false,
    })
    const treeSitterClient = new MockTreeSitterClient()
    // A solve that resizes these runs their resize hooks, which set the text view or editor viewport.
    const column = new BoxRenderable(renderer, { width: 20, flexDirection: "column" })
    // A hook runs mid-frame, after `scrolled` and `editor` prepared their views for this round.
    let hook: (() => void) | undefined
    column["onUpdate"] = () => (hook?.(), (hook = undefined))
    column.refreshHooks()
    const block = new CodeRenderable(renderer, { content: "const pending = true", syntaxStyle, treeSitterClient })
    column.add(block)
    column.add(new MarkdownRenderable(renderer, { content: "Some *words* here", syntaxStyle, treeSitterClient }))
    const scrolled = new CodeRenderable(renderer, { content: "s1\ns2", syntaxStyle, treeSitterClient, height: 1 })
    const editor = new TextareaRenderable(renderer, { initialValue: "e1\ne2", height: 1 })
    const tabs = new CodeRenderable(renderer, {
      content: "a\tb\nlong line",
      syntaxStyle,
      treeSitterClient,
      width: 8,
      wrapMode: "none",
    })
    const margins = new TextareaRenderable(renderer, { initialValue: "m0\tx\nm1\nm2\nm3\nm4\nm5\nm6", height: 5 })
    for (const child of [label, plain, code, scrolled, editor, column, tabs, margins]) renderer.root.add(child)
    const highlight = async () => {
      await result.renderOnce()
      highlights.resolveHighlightOnce()
      await code.highlightingDone
    }
    await highlight()
    await result.renderOnce()
    const fgOf = (text: string) =>
      rgbToHex(
        result
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .find((span) => span.text.startsWith(text))!.fg,
      )
    const drawn = (text: string) => result.captureCharFrame().includes(text)
    const rowsOf = (node: CodeRenderable | TextareaRenderable) =>
      result
        .captureCharFrame()
        .split("\n")
        .slice(node.y, node.y + 2)
        .map((line) => line.slice(node.x, node.x + node.width).trimEnd())
    const rows: [string, () => unknown, number, [() => unknown, unknown]?][] = [
      ["nothing", () => {}, 0],
      ["same fg on node text", () => (label.fg = "#808080"), 0, [() => fgOf("Simulated"), "#808080"]],
      ["new fg on node text", () => (label.fg = "#ff0000"), 0, [() => fgOf("Simulated"), "#ff0000"]],
      ["new fg on a child span", () => (span.fg = "#0000ff"), 0, [() => fgOf("Model"), "#0000ff"]],
      ["same string content", () => (plain.content = "plain"), 0],
      ["new fg on code", () => (code.fg = "#00ff00"), 0, [() => fgOf("const"), "#00ff00"]],
      ["code and markdown parent resize", () => (column.width = 30), 1, [() => block.height, 1]],
      ["parent resize that wraps code", () => (column.width = 10), 1, [() => block.height, 3]],
      ["code scroll", () => (scrolled.scrollY = 1), 0, [() => [drawn("s1"), drawn("s2")], [false, true]]],
      ["textarea scroll", () => editor.editorView.setViewport(0, 1, 40, 1, true), 0, [() => drawn("e2"), true]],
      ["textarea scroll that keeps the cursor", () => editor.editorView.setViewport(0, 0, 40, 1, false), 0],
      // Preparation puts the hook's viewport width of 1 back to the layout width before paint.
      [
        "code scroll in a hook",
        () => (hook = () => scrolled["textBufferView"].setViewport(0, 0, 1, 1)),
        0,
        [() => [drawn("s1"), drawn("s2")], [true, false]],
      ],
      [
        "textarea scroll in a hook",
        () => (hook = () => editor.editorView.setViewport(0, 0, 1, 1, true)),
        0,
        [() => drawn("e1"), true],
      ],
      ["code text align", () => (tabs.textAlign = "right"), 0, [() => rowsOf(tabs), ["    a  b", "long lin"]]],
      ["code tab indicator", () => (tabs.tabIndicator = ">"), 0, [() => rowsOf(tabs), ["    a> b", "long lin"]]],
      ["code tab indicator color", () => (tabs.tabIndicatorColor = "#ff0000"), 0, [() => fgOf(">"), "#ff0000"]],
      ["code truncate", () => (tabs.truncate = true), 0, [() => rowsOf(tabs), ["    a> b", "lo...ine"]]],
      ["textarea tab indicator", () => (margins.tabIndicator = ">"), 0, [() => rowsOf(margins), ["m0> x", "m1"]]],
      // With the cursor on m4, a margin of two rows scrolls to m2; the old margin of one row scrolls to m1.
      [
        "textarea scroll margin",
        () => (margins.editorView.setScrollMargin(0.5), margins.gotoLine(4)),
        0,
        [() => rowsOf(margins), ["m2", "m3"]],
      ],
      ["new string content", () => (plain.content = "plain!"), 1],
      ["code wrap mode", () => (code.wrapMode = "none"), 1],
      ["code first line offset", () => code["textBufferView"].setFirstLineOffset(2), 1],
      ["textarea wrap mode", () => (margins.wrapMode = "char"), 1],
      ["code tab width", () => code["textBuffer"].setTabWidth(8), 1],
      ["concealing highlight", () => ((code.conceal = true), highlight()), 1, [() => fgOf("pending"), "#00ff00"]],
    ]
    const actual = []
    for (const [name, change, , probe] of rows) {
      await change()
      await result.renderOnce()
      actual.push([name, renderer.getNativeStats().frameWork.yogaSolves, probe?.[0]()])
    }
    expect(actual).toEqual(rows.map(([name, , solves, probe]) => [name, solves, probe?.[1]]))
  })
})

describe("test renderer native render stats", () => {
  let renderer: TestRenderer | null = null

  afterEach(async () => {
    renderer?.destroy()
    await renderer?.closed
    renderer = null
  })

  test("createTestRenderer exposes native stats after renderOnce", async () => {
    const testRenderer = await createTestRenderer({ width: 10, height: 4 })
    renderer = testRenderer.renderer

    expectInitialStats(testRenderer.getNativeStats())

    const text = new TextRenderable(renderer, {
      content: "abc",
      width: 3,
      height: 1,
    })
    renderer.root.add(text)

    await testRenderer.renderOnce()

    const firstStats = testRenderer.getNativeStats()
    expect(firstStats.nativeFrameCount).toBe(1)
    expect(firstStats.cellsUpdated).toBeGreaterThanOrEqual(3)
    expect(firstStats.nativeRenderTime).toBeGreaterThanOrEqual(0)
    expect(firstStats.nativeStdoutWriteTime).toBeGreaterThanOrEqual(0)

    const combinedStats = renderer.getStats()
    expect(combinedStats.frameCount).toBe(1)
    expect(combinedStats.frameCallbackTime).toBeGreaterThanOrEqual(0)
    expect(combinedStats.nativeFrameCount).toBe(firstStats.nativeFrameCount)
    expect(combinedStats.cellsUpdated).toBe(firstStats.cellsUpdated)

    await testRenderer.renderOnce()

    const secondStats = renderer.getNativeStats()
    expect(secondStats.nativeFrameCount).toBe(2)
    expect(secondStats.cellsUpdated).toBe(0)

    text.content = "axc"
    await testRenderer.renderOnce()

    const changedStats = testRenderer.getNativeStats()
    expect(changedStats.nativeFrameCount).toBe(3)
    expect(changedStats.cellsUpdated).toBe(1)
  })
})
