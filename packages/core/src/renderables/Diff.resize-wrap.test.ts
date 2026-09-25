import { afterEach, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Selection } from "../lib/selection.js"
import { TreeSitterClient } from "../lib/tree-sitter/index.js"
import { SyntaxStyle } from "../syntax-style.js"
import { TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { BoxRenderable } from "./Box.js"
import { CodeRenderable } from "./Code.js"
import { DiffRenderable } from "./Diff.js"
import { LineNumberRenderable } from "./LineNumberRenderable.js"
import { ScrollBoxRenderable } from "./ScrollBox.js"
import { TextRenderable } from "./Text.js"

let setup: TestRendererSetup
let style: SyntaxStyle

afterEach(() => {
  setup?.renderer.destroy()
  style?.destroy()
})

test("DiffRenderable - long line tails survive split/unified/split resize", async () => {
  setup = await createTestRenderer({ width: 160, height: 30 })
  style = SyntaxStyle.create()
  const viewer = new BoxRenderable(setup.renderer, { width: "100%", height: "100%" })
  const body = new BoxRenderable(setup.renderer, { flexGrow: 1, minHeight: 0 })
  const row = new BoxRenderable(setup.renderer, { flexDirection: "row", flexGrow: 1, minHeight: 0 })
  const tree = new BoxRenderable(setup.renderer, { width: 40, flexShrink: 0 })
  const pane = new BoxRenderable(setup.renderer, {
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    paddingLeft: 2,
    paddingRight: 2,
  })
  const edge = new BoxRenderable(setup.renderer, { height: 1, flexShrink: 0 })
  const scroll = new ScrollBoxRenderable(setup.renderer, {
    flexGrow: 1,
    minHeight: 0,
    verticalScrollbarOptions: { visible: false },
    horizontalScrollbarOptions: { visible: false },
  })
  scroll.verticalScrollBar.visible = false
  scroll.horizontalScrollBar.visible = false
  const file = new BoxRenderable(setup.renderer, {})
  const card = new BoxRenderable(setup.renderer, {})
  const header = new BoxRenderable(setup.renderer, { height: 2, flexShrink: 0, zIndex: 1 })
  header.add(new TextRenderable(setup.renderer, { content: "snapshot.json" }))
  header.onLifecyclePass = () => {
    header.translateY = Math.max(
      0,
      Math.min(scroll.scrollTop - (card.y - scroll.content.y), card.height - header.height),
    )
  }
  setup.renderer.registerLifecyclePass(header)
  const removed = "x".repeat(20000) + "_OLD_END"
  const added = "y".repeat(20000) + "_NEW_END"
  const diff = new DiffRenderable(setup.renderer, {
    diff: `--- a/snapshot.json\n+++ b/snapshot.json\n@@ -1 +1 @@\n-${removed}\n+${added}\n`,
    view: "split",
    width: "100%",
    minHeight: 2,
    wrapMode: "char",
    showLineNumbers: true,
    syntaxStyle: style,
  })
  card.add(header)
  card.add(diff)
  file.add(card)
  scroll.add(file)
  pane.add(edge)
  pane.add(scroll)
  row.add(tree)
  row.add(pane)
  body.add(row)
  viewer.add(body)
  setup.renderer.root.add(viewer)

  await setup.renderOnce()
  diff.getChildren().forEach((side) => {
    if (side instanceof LineNumberRenderable) side.setLineSign(-1, { after: "  " })
  })
  await setup.flush()
  scroll.scrollTo(scroll.scrollHeight)
  await setup.flush()
  expect(setup.captureCharFrame()).toContain("_OLD_END")
  expect(setup.captureCharFrame()).toContain("_NEW_END")

  setup.resize(80, 24)
  tree.visible = false
  diff.view = "unified"
  await setup.flush()
  scroll.scrollTo(scroll.scrollHeight)
  await setup.flush()
  expect(diff.width).toBe(76)
  expect(setup.captureCharFrame()).toContain("_NEW_END")

  setup.resize(160, 30)
  tree.visible = true
  diff.view = "split"
  await setup.flush()
  scroll.scrollTo(scroll.scrollHeight)
  await setup.flush()
  expect(diff.width).toBe(116)
  expect(setup.captureCharFrame()).toContain("_OLD_END")
  expect(setup.captureCharFrame()).toContain("_NEW_END")
  const codes = diff
    .getChildren()
    .flatMap((side) => side.getChildren().filter((child) => child instanceof CodeRenderable))
  expect(codes.map((code) => code.content)).toEqual([removed, added])
  expect(codes.map((code) => code.plainText)).toEqual([removed, added])
  expect(codes.map((code) => code.virtualLineCount)).toEqual([393, 393])
  expect(codes.map((code) => code.height)).toEqual(codes.map((code) => code.virtualLineCount))
  expect(scroll.scrollHeight).toBe(395)
})

test("DiffRenderable - pane resize performs one alignment rebuild", async () => {
  setup = await createTestRenderer({ width: 116, height: 24 })
  style = SyntaxStyle.create()
  const diff = new DiffRenderable(setup.renderer, {
    diff: `--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-${"old ".repeat(500)}\n+${"new ".repeat(300)}\n`,
    view: "split",
    width: "100%",
    wrapMode: "word",
    syntaxStyle: style,
  })
  setup.renderer.root.add(diff)
  await setup.flush()

  const sides = diff.getChildren().filter((child) => child instanceof LineNumberRenderable)
  const updates = [0, 0]
  sides.forEach((side, index) => {
    const setLineNumbers = side.setLineNumbers.bind(side)
    side.setLineNumbers = (lineNumbers) => {
      updates[index]++
      setLineNumbers(lineNumbers)
    }
  })

  setup.resize(80, 24)
  await setup.flush()

  expect(updates).toEqual([1, 1])
})

test.each(["char", "word"] as const)(
  "DiffRenderable - %s wrapping aligns asymmetric pairs at the final pane widths",
  async (wrapMode) => {
    setup = await createTestRenderer({ width: 116, height: 24 })
    style = SyntaxStyle.fromStyles({
      keyword: { fg: "#ff0000" },
      string: { fg: "#00ff00" },
      comment: { fg: "#0000ff" },
    })
    const client = new TreeSitterClient({ dataPath: join(tmpdir(), "tree-sitter-diff-resize-test-data") })
    const removed = [`const old = "${"old words ".repeat(300)}OLD_TAIL";`, 'const before = "short";']
    const added = ['const next = "short";', `const after = "${"new words ".repeat(400)}NEW_TAIL";`]
    const raw = [removed, added].map((lines) => [...lines, "// CONTEXT", "// TAIL_CONTEXT"])
    const reference = raw.map((lines) => {
      const buffer = TextBuffer.create(setup.renderer.widthMethod)
      buffer.setText(lines.join("\n"))
      const view = TextBufferView.create(buffer)
      view.setWrapMode(wrapMode)
      return { buffer, view }
    })
    const scroll = new ScrollBoxRenderable(setup.renderer, { width: "100%", height: "100%" })
    scroll.verticalScrollBar.visible = false
    scroll.horizontalScrollBar.visible = false
    const diff = new DiffRenderable(setup.renderer, {
      diff: [
        "--- a/example.js",
        "+++ b/example.js",
        "@@ -99,3 +1000,3 @@",
        ...removed.map((line) => `-${line}`),
        ...added.map((line) => `+${line}`),
        " // CONTEXT",
        "@@ -200 +2000 @@",
        " // TAIL_CONTEXT",
        "",
      ].join("\n"),
      view: "split",
      width: "100%",
      flexShrink: 0,
      wrapMode,
      filetype: "javascript",
      treeSitterClient: client,
      syntaxStyle: style,
    })
    scroll.add(diff)
    setup.renderer.root.add(scroll)
    const sides = diff.getChildren().filter((side) => side instanceof LineNumberRenderable)
    const codes = sides.map((side) => {
      const code = side.getChildren().find((child) => child instanceof CodeRenderable)
      if (!code) throw new Error("Expected a CodeRenderable")
      return code
    })
    try {
      await setup.flush()
      // Match a viewer's post-layout shared gutter padding without changing line identity.
      sides[0].setLineSign(-1, { after: "   " })
      sides[1].setLineSign(-1, { after: "  " })
      for (const state of [
        { width: 116, view: "split", numbers: true },
        { width: 116, view: "unified", numbers: true },
        { width: 116, view: "split", numbers: true },
        { width: 80, view: "split", numbers: true },
        { width: 80, view: "unified", numbers: true },
        { width: 116, view: "split", numbers: true },
        { width: 116, view: "split", numbers: false },
        { width: 116, view: "split", numbers: true },
      ] as const) {
        setup.resize(state.width, 24)
        diff.view = state.view
        diff.showLineNumbers = state.numbers
        await setup.flush()
        expect(sides.map((side) => side.getLineSigns().get(-1)?.after)).toEqual(["   ", "  "])
        await Promise.all(
          diff.getChildren().flatMap((side) =>
            side
              .getChildren()
              .filter((child) => child instanceof CodeRenderable)
              .map((code) => code.highlightingDone),
          ),
        )
        await setup.flush()
        if (state.view === "unified") {
          expect(codes[0].content.split("\n")).toEqual([...removed, ...added, "// CONTEXT", "// TAIL_CONTEXT"])
          continue
        }

        // Native views of the unpadded source provide wrap counts independent of Diff alignment.
        const counts = reference.map((source, index) => {
          source.view.setWrapWidth(codes[index].width)
          const sources = source.view.logicalLineInfo.lineSources
          return raw[index].map((_, line) => sources.filter((source) => source === line).length)
        })
        const firstRows = Math.max(counts[0][0], counts[1][0])
        const secondRows = Math.max(counts[0][1], counts[1][1])
        const height = firstRows + secondRows + 2
        expect(codes.map((code) => code.virtualLineCount)).toEqual([height, height])
        expect(codes.map((code) => code.height)).toEqual([height, height])
        if (state.numbers) expect(sides.map((side) => side.getChildren()[0].height)).toEqual([height, height])
        expect(scroll.scrollHeight).toBe(height)
        expect(diff.getHunkRowOffsets()).toEqual([0, height - 1])
        sides.forEach((side, index) => {
          const sources = codes[index].lineInfo.lineSources
          expect([...side.getLineNumbers().keys()].map((line) => sources.indexOf(line))).toEqual([
            0,
            firstRows,
            firstRows + secondRows,
            height - 1,
          ])
          expect([...side.getLineNumbers().values()]).toEqual(
            index === 0 ? [99, 100, 101, 200] : [1000, 1001, 1002, 2000],
          )
          expect(codes[index].content.split("\n").filter(Boolean)).toEqual(raw[index])
          expect(codes[index].plainText).toBe(codes[index].content)
          expect(
            codes[index].getLineHighlights(0).some((highlight) => highlight.start === 0 && highlight.end === 5),
          ).toBe(true)
        })
        scroll.scrollTo(scroll.scrollHeight)
        await setup.flush()
        expect(setup.captureCharFrame()).toContain("TAIL_CONTEXT")
        const selection = new Selection(
          codes[1],
          { x: codes[1].x + 3, y: codes[1].y + height - 1 },
          { x: codes[1].x + 14, y: codes[1].y + height - 1 },
        )
        selection.isStart = true
        codes[1].onSelectionChanged(selection)
        expect(codes[1].getSelectedText()).toBe("TAIL_CONTEXT")
        const bounds = codes[1].getSelection()
        await setup.flush()
        expect(codes[1].getSelectedText()).toBe("TAIL_CONTEXT")
        expect(codes[1].getSelection()).toEqual(bounds)
        codes[1].onSelectionChanged(null)
      }
    } finally {
      diff.destroyRecursively()
      reference.forEach((source) => {
        source.view.destroy()
        source.buffer.destroy()
      })
      await client.destroy()
    }
  },
)
