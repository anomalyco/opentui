import { afterAll, beforeAll, expect, test } from "bun:test"
import { BoxRenderable } from "../renderables/Box.js"
import { ScrollBoxRenderable, type ScrollBoxOptions } from "../renderables/ScrollBox.js"
import { TextRenderable } from "../renderables/Text.js"
import { Renderable } from "../Renderable.js"
import { createTestRenderer, type TestRenderer } from "../testing.js"

// ScrollBox scenes recorded before ScrollBox became a facade over the native scroll node. Each row pins the
// cells, the background of each cell, the hit owner of each cell (a row's index, `#` for the ScrollBox and its
// parts, `.` outside), and the geometry of the box, its parts and its rows.
type Case = {
  parent: Record<string, unknown>
  box: ScrollBoxOptions & { nowrap?: boolean }
  rows: number
  text?: (i: number) => string
  scroll?: number | { x: number; y: number }
}

const words = (i: number) => `Row ${i} ` + "lorem ipsum dolor sit amet ".repeat(i % 3)
const wide = (i: number) => `Row ${i} ` + "x".repeat(30)
const column = { flexDirection: "column" }
const fills = {
  backgroundColor: "#100000",
  wrapperOptions: { backgroundColor: "#200000" },
  viewportOptions: { backgroundColor: "#300000" },
  contentOptions: { backgroundColor: "#400000" },
}

const cases: Record<string, Case> = {
  "fixed 40x10, 30 rows": { parent: column, box: { width: 40, height: 10 }, rows: 30 },
  "fixed 40x10, 3 rows": { parent: column, box: { width: 40, height: 10 }, rows: 3 },
  "unconstrained in column, 3 rows": { parent: column, box: {}, rows: 3 },
  "unconstrained in row, 3 rows": { parent: { flexDirection: "row" }, box: {}, rows: 3 },
  "maxHeight 5, 3 rows": { parent: column, box: { maxHeight: 5 }, rows: 3 },
  "maxHeight 5, 12 rows": { parent: column, box: { maxHeight: 5 }, rows: 12 },
  "flexGrow 1, minHeight 0, 40 wrapped rows": {
    parent: { flexDirection: "column", height: 20 },
    box: { flexGrow: 1, minHeight: 0 },
    rows: 40,
    text: words,
  },
  "content centered, 3 rows": {
    parent: column,
    box: { width: 40, height: 10, contentOptions: { justifyContent: "center", alignItems: "center" } },
    rows: 3,
  },
  "content centered, 30 rows": {
    parent: column,
    box: { width: 40, height: 10, contentOptions: { justifyContent: "center" } },
    rows: 30,
  },
  "content minHeight 0, 3 rows": {
    parent: column,
    box: { width: 40, height: 10, contentOptions: { minHeight: 0 } },
    rows: 3,
  },
  "viewport padding left and right, bar gap": {
    parent: column,
    box: {
      width: 40,
      height: 10,
      viewportOptions: { paddingRight: 1, paddingLeft: 1 },
      verticalScrollbarOptions: { paddingLeft: 1 },
    },
    rows: 30,
    text: words,
  },
  "scrollX, wide rows": { parent: column, box: { width: 20, height: 6, scrollX: true }, rows: 10, text: wide },
  "scrollX, no wrap, both bars": {
    parent: column,
    box: { width: 20, height: 6, scrollX: true, nowrap: true },
    rows: 10,
    text: wide,
    scroll: { x: 7, y: 2 },
  },
  "scrollX, no wrap, 2 rows": {
    parent: column,
    box: { width: 20, height: 6, scrollX: true, nowrap: true },
    rows: 2,
    text: wide,
  },
  "border, forwarded padding": {
    parent: column,
    box: { width: 40, height: 10, border: true, padding: 1 },
    rows: 30,
    scroll: 4,
  },
  "row parent, flexGrow 1, 30 rows": {
    parent: { flexDirection: "row", height: 10 },
    box: { flexGrow: 1 },
    rows: 30,
    text: words,
  },
  "fills, arrows and track colors, scrolled": {
    parent: column,
    box: {
      width: 30,
      height: 8,
      ...fills,
      scrollbarOptions: {
        showArrows: true,
        trackOptions: { foregroundColor: "#00a000", backgroundColor: "#000050" },
      },
    },
    rows: 20,
    text: (i) => (i % 2 ? `row ${i}` : ""),
    scroll: 5,
  },
  // Arrow options without a foreground color paint the glyph in the background color.
  "custom arrows": {
    parent: column,
    box: {
      width: 30,
      height: 8,
      verticalScrollbarOptions: {
        showArrows: true,
        arrowOptions: { backgroundColor: "#a00000", attributes: 1, arrowChars: { up: "Q", down: "W" } },
      },
    },
    rows: 20,
    scroll: 3,
  },
  "fills, content fits": { parent: column, box: { width: 30, height: 8, ...fills }, rows: 3 },
  "sticky bottom": {
    parent: column,
    box: { width: 30, height: 8, stickyScroll: true, stickyStart: "bottom" },
    rows: 20,
  },
  "overlay bar, two cells wide": {
    parent: column,
    box: {
      width: 30,
      height: 8,
      verticalScrollbarOptions: { position: "absolute", right: 0, top: 0, width: 2, height: "100%" },
    },
    rows: 20,
    scroll: 12,
  },
}

let setup: TestRenderer
beforeAll(async () => {
  setup = await createTestRenderer({ width: 70, height: 26 })
})
afterAll(() => setup.renderer.destroy())

function rect(node: { x: number; y: number; width: number; height: number }): string {
  return `${node.x},${node.y} ${node.width}x${node.height}`
}

test.each(Object.keys(cases))("ScrollBox parity: %s", async (name) => {
  const { renderer, renderOnce } = setup
  const scene = cases[name]
  const parent = new BoxRenderable(renderer, { width: 60, height: 24, ...scene.parent })
  renderer.root.add(parent)
  try {
    await capture(scene, parent)
  } finally {
    parent.destroyRecursively()
    await renderOnce()
  }
})

async function capture(scene: Case, parent: BoxRenderable): Promise<void> {
  const { renderer, renderOnce, captureCharFrame, captureSpans } = setup
  const { nowrap, ...options } = scene.box
  const box = new ScrollBoxRenderable(renderer, options)
  parent.add(box)
  const rows: TextRenderable[] = []
  for (let i = 0; i < scene.rows; i++) {
    const row = new TextRenderable(renderer, {
      content: (scene.text ?? ((i: number) => `Row ${i}`))(i),
      ...(nowrap ? { wrapMode: "none" as const } : {}),
    })
    rows.push(row)
    box.add(row)
  }
  await renderOnce()
  await renderOnce()
  if (scene.scroll !== undefined) {
    box.scrollTo(scene.scroll)
    await renderOnce()
  }

  const labels = new Map<number, string>()
  rows.forEach((row, i) => labels.set(row.num, i.toString(36)))
  const owner = (num: number): string => {
    for (let node = Renderable.renderablesByNumber.get(num) ?? null; node; node = node.parent as Renderable | null) {
      const label = labels.get(node.num)
      if (label) return label
      if (node === box) return "#"
    }
    return "."
  }
  const hits: string[] = []
  for (let y = 0; y < 24; y++) {
    let line = ""
    for (let x = 0; x < 60; x++) line += owner(renderer.hitTest(x, y))
    hits.push(line.trimEnd())
  }
  const palette: string[] = []
  const lines = captureSpans().lines.slice(0, 24)
  // One character per cell: a palette index for a color, or the attributes in base 36.
  const cells = (code: (span: (typeof lines)[number]["spans"][number]) => string) =>
    lines.map((line) =>
      line.spans
        .flatMap((span) => Array<string>(span.width).fill(code(span)))
        .slice(0, 60)
        .join(""),
    )
  const color = (rgba: { toInts(): number[] }) => {
    const key = rgba.toInts().join(",")
    let index = palette.indexOf(key)
    if (index < 0) index = palette.push(key) - 1
    return index.toString(36)
  }
  const backgrounds = cells((span) => color(span.bg))
  const foregrounds = cells((span) => color(span.fg))
  const attributes = cells((span) => span.attributes.toString(36))
  const frame = captureCharFrame()
    .split("\n")
    .slice(0, 24)
    .map((line) => line.slice(0, 60).trimEnd())
  const geometry = [
    `box ${rect(box)} top ${box.scrollTop} left ${box.scrollLeft} height ${box.scrollHeight} width ${box.scrollWidth}`,
    `viewport ${rect(box.viewport)} content ${rect(box.content)}`,
    `bars v ${box.verticalScrollBar.visible} h ${box.horizontalScrollBar.visible}`,
    ...rows.map((row, i) => `row ${i} ${rect(row)}`),
  ]
  expect({ frame, backgrounds, foregrounds, attributes, palette, hits, geometry }).toMatchSnapshot()
}
