import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Renderable } from "../Renderable.js"
import { CliRenderEvents } from "../renderer.js"
import { BoxRenderable, type BoxOptions } from "../renderables/Box.js"
import { DiffRenderable } from "../renderables/Diff.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { TextRenderable, type TextOptions } from "../renderables/Text.js"
import { SyntaxStyle } from "../syntax-style.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import Yoga, { Edge, FlexDirection } from "../yoga.js"

let renderer: TestRenderer
let renderOnce: () => Promise<void>
let captureCharFrame: () => string

beforeEach(async () => {
  ;({ renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 30 }))
})

afterEach(async () => {
  renderer.destroy()
  await renderer.closed
})

function expectLayout(renderable: TextRenderable | TextareaRenderable, width: number, height: number): void {
  const layout = renderable.getLayout()
  expect(renderable.width).toBeCloseTo(width, 5)
  expect(renderable.height).toBeCloseTo(height, 5)
  expect(layout.width).toBeCloseTo(width, 5)
  expect(layout.height).toBeCloseTo(height, 5)
}

for (const kind of ["text", "textarea"] as const) {
  describe(`native-backed ${kind} measurement parity`, () => {
    const create = (
      content: string,
      options: Pick<TextOptions, "wrapMode" | "alignSelf" | "position" | "left" | "top"> = {},
    ) =>
      kind === "text"
        ? new TextRenderable(renderer, { content, ...options })
        : new TextareaRenderable(renderer, { initialValue: content, ...options })

    // Fixed expectations from the former TypeScript Yoga measurement functions.
    test.each([
      ["char", "ABCDEFGHIJKLMNOPQRST", 20, 1],
      ["word", "Hello wonderful world from OpenTUI", 34, 1],
      ["none", "Short\nAVeryLongLineHere\nMedium", 17, 3],
      ["char", "", 1, 1],
    ] as const)("%s wrap measures %j", async (wrapMode, content, width, height) => {
      const node = create(content, { wrapMode, alignSelf: "flex-start" })
      renderer.root.add(node)
      await renderOnce()
      expectLayout(node, width, height)
    })

    test("stretches relative content to the root width by default", async () => {
      const node = create("Short", { wrapMode: "char" })
      renderer.root.add(node)
      await renderOnce()
      expectLayout(node, 80, 1)
    })

    test("clamps to a narrower parent and removes clamping for absolute positioning", async () => {
      const parent = new BoxRenderable(renderer, { width: 10, alignItems: "flex-start" })
      const node = create("ABCDEFGHIJKLMNOPQRST", { wrapMode: "none", alignSelf: "flex-start", left: 0, top: 0 })
      parent.add(node)
      renderer.root.add(parent)
      for (const [position, width] of [
        ["relative", 10],
        ["absolute", 20],
        ["relative", 10],
      ] as const) {
        node.position = position
        await renderOnce()
        expectLayout(node, width, 1)
      }
    })

    test("measures initially absolute content without AtMost clamping", async () => {
      const node = create("ABCDEFGHIJKLMNOPQRST", { wrapMode: "none", position: "absolute", left: 0, top: 0 })
      renderer.root.add(node)
      await renderOnce()
      expectLayout(node, 20, 1)
    })

    test("recomputes measurement after content changes", async () => {
      const node = create("Short", { wrapMode: "char", alignSelf: "flex-start" })
      renderer.root.add(node)
      await renderOnce()
      expectLayout(node, 5, 1)
      if (node instanceof TextRenderable) node.content = "ABCDEFGHIJKLMNOPQRST"
      else node.setText("ABCDEFGHIJKLMNOPQRST")
      await renderOnce()
      expectLayout(node, 20, 1)
    })
  })
}

// Measured nodes outside their parent's content box, or with more wrapped lines than height.
// padding maps a box to its [left, right] padding. Scene nodes keep at least one cell, so sub-cell
// nodes and content boxes are skipped.
function escapes(root: Renderable, padding = new Map<Renderable, readonly [number, number]>()): string[] {
  const out: string[] = []
  const [left, right] = padding.get(root) ?? [0, 0]
  for (const child of root.getChildren() as Renderable[]) {
    const inside =
      root.width - left - right < 1 ||
      (child.x >= root.x + left &&
        child.x + child.width <= root.x + root.width - right &&
        child.y >= root.y &&
        child.y + child.height <= root.y + root.height)
    // A text narrower than a cell is measured unwrapped, so line counts are checked from two cells.
    const lines = child instanceof TextRenderable && child.width >= 2 ? child.virtualLineCount : 0
    const measured = renderer.nativeScene.hasMeasureFunc(child) && child.getLayout().width >= 1
    if (measured && (!inside || lines > child.height))
      out.push(`[${child.x},${child.width}] in [${root.x},${root.width}] lines ${lines}/${child.height}`)
    out.push(...escapes(child, padding))
  }
  return out
}

describe("measured text stays inside its parent's rounded content box", () => {
  const box = (options: BoxOptions, children: Renderable[] = []) => {
    const node = new BoxRenderable(renderer, options)
    for (const child of children) node.add(child)
    return node
  }
  const text = (content: string, options: TextOptions = {}) =>
    new TextRenderable(renderer, { content, wrapMode: "char", ...options })
  const spans = (nodes: Renderable[]) => nodes.map((node) => `${node.x}+${node.width}`).join(" ")
  const line = (row: number) => captureCharFrame().split("\n")[row]!

  // Fractional columns: text rounding ceiled each text's right edge past its column.
  test.each([
    [{ width: 10 }, "abc", "0+3 3+4 7+3", "aaabbbbccc  "],
    [{ width: 11, paddingRight: 1 }, "abc", "0+3 3+4 7+3", "aaabbbbccc  "],
    [{ width: 11, paddingLeft: 1 }, "abc", "1+3 4+4 8+3", " aaabbbbccc "],
    [{ width: 21 }, "ab", "0+11 11+10", "aaaaaaaaaaabbbbbbbbbb  "],
  ] as const)("equal columns in %o", async (options, letters, expected, frame) => {
    const texts = [...letters].map((letter) => text(letter.repeat(33)))
    renderer.root.add(
      box(
        { flexDirection: "row", height: 4, ...options },
        texts.map((t) => box({ flexGrow: 1, flexBasis: 0 }, [t])),
      ),
    )
    await renderOnce()
    expect(spans(texts)).toBe(expected)
    expect(line(0).slice(0, frame.length)).toBe(frame)
  })

  test("shrinking sibling texts do not overlap", async () => {
    const texts = [text("aaaaaaaa"), text("bbbbbbbb")]
    renderer.root.add(box({ flexDirection: "row", width: 11 }, texts))
    await renderOnce()
    expect(spans(texts)).toBe("0+6 6+5")
  })

  // Two levels of fractional ratios: text at relative 2.5 in a parent at 7.5, on either axis.
  test.each(["row", "column"] as const)(
    "nested fractional text in a %s keeps every wrapped line",
    async (direction) => {
      const flex = { flexGrow: 1, flexBasis: 0 }
      const node = text("0123456789".repeat(4).slice(0, 38), { ...flex, flexGrow: 2 })
      const parent = box({ ...flex, flexDirection: direction, alignItems: "flex-start" }, [box(flex), node])
      const size = direction === "row" ? { width: 30 } : { height: 30 }
      const outer = box({ flexDirection: direction, alignItems: "flex-start", ...size }, [
        box(flex),
        parent,
        box({ ...flex, flexGrow: 2 }),
      ])
      renderer.root.add(outer)
      await renderOnce()
      const span = (n: Renderable) => (direction === "row" ? `${n.x}+${n.width}` : `${n.y}+${n.height}`)
      expect([span(parent), span(node), node.virtualLineCount <= node.height]).toEqual(["8+7", "10+5", true])
      expect(escapes(outer)).toEqual([])
    },
  )

  test("wrapped text fits beside a visible ScrollBox scrollbar", async () => {
    const scroll = new ScrollBoxRenderable(renderer, { height: 4 })
    const node = text("0123456789".repeat(20), { width: "100%" })
    scroll.add(node)
    renderer.root.add(box({ width: 20 }, [scroll]))
    await renderOnce()
    await renderOnce()
    expect([scroll.verticalScrollBar.visible, node.width, scroll.content.width]).toEqual([true, 19, 19])
    expect(line(1).slice(0, 4)).toBe("9012")
  })

  // OpenCode's permission prompt: a split diff in a padded ScrollBox.
  test.each([53, 59, 79, 139])("split diff code fits its side at width %d", async (width) => {
    const style = SyntaxStyle.create(renderer.nativeScene)
    const lines = Array.from({ length: 12 }, (_, i) => ` context ${i} ${"0123456789".repeat(8)}`)
    const diff = new DiffRenderable(renderer, {
      diff: `--- a/f.ts\n+++ b/f.ts\n@@ -1,12 +1,12 @@\n${lines.join("\n")}\n`,
      view: "split",
      width: "100%",
      wrapMode: "word",
      showLineNumbers: true,
      syntaxStyle: style,
    })
    const scroll = new ScrollBoxRenderable(renderer, { height: "100%" })
    scroll.add(diff)
    renderer.root.add(box({ width, border: ["left"], paddingLeft: 1, paddingRight: 3, height: 12 }, [scroll]))
    const errors: unknown[] = []
    renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
    for (let frame = 0; frame < 3; frame++) await renderOnce()
    expect([errors, escapes(diff)]).toEqual([[], []])
    style.destroy()
  })

  // Yoga's cache treats available sizes that round to the same cell as equal; the scene compares exactly.
  test.each(["row", "column"] as const)(
    "a subtree that Yoga reuses from its cache rounds like a fresh layout in a %s",
    async (direction) => {
      const size = (n: number) => (direction === "row" ? { width: n } : { height: n })
      const spacer = box({ ...size(0), flexShrink: 0 })
      const lines = Array.from({ length: 12 }, (_, i) => i % 10)
      const node = text(lines.join(direction === "row" ? "" : "\n"), { flexGrow: 1, flexBasis: 0 })
      const holder = box({ ...size(10), flexDirection: direction, flexShrink: 0 }, [spacer, node])
      const outer = box({ flexDirection: direction, alignItems: "flex-start" }, [
        box({ ...size(0.3), flexShrink: 0 }),
        holder,
        text("BELOW"),
      ])
      renderer.root.add(outer)
      const spans: string[] = []
      for (const offset of [0, 0.45, 0]) {
        Object.assign(spacer, size(offset))
        await renderOnce()
        spans.push(direction === "row" ? `${node.x}+${node.width}` : `${node.y}+${node.height}`)
        expect(escapes(outer)).toEqual([])
      }
      expect(spans).toEqual(["0+10", "1+9", "0+10"])
    },
  )

  test("fractional padding keeps whole-cell widths for a buffered renderable", async () => {
    const node = text("x".repeat(40), { flexGrow: 1, buffered: true })
    // 10% of the 35-wide containing block is 3.5 cells of padding on each side.
    renderer.root.add(box({ width: 35 }, [box({ flexDirection: "row", paddingX: "10%" }, [node])]))
    await renderOnce()
    expect(spans([node])).toBe("4+28")
  })

  // Overflow that does not come from rounding draws as on main.
  test("explicit and unshrinkable widths keep their overflow", async () => {
    const panned = text("abcdefghijklmnopqrst", { width: 20, wrapMode: "none" })
    const clip = box({ width: 10, height: 1, overflow: "hidden" }, [panned])
    const pushed = text("abcdefghijklmnopqrst", { flexShrink: 0 })
    const bordered = box({ flexDirection: "row", width: 14, height: 4, border: true }, [
      box({ width: 3, flexShrink: 0 }),
      pushed,
    ])
    renderer.root.add(box({}, [clip, bordered]))
    panned.translateX = -10
    await renderOnce()
    expect([spans([panned, pushed]), line(0).slice(0, 10), line(2).slice(0, 16)]).toEqual([
      "-10+20 4+12",
      "klmnopqrst",
      "│   abcdefghijkl",
    ])
  })

  test("random flex distributions keep every measured node inside its parent", async () => {
    let seed = 228
    const next = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
      return Math.floor((seed / 2 ** 32) * n)
    }
    const padding = new Map<Renderable, readonly [number, number]>()
    const item = (depth: number): Renderable => {
      if (depth > 1 || next(3) === 0)
        return text("x".repeat(1 + next(30)), { flexShrink: 1, flexGrow: next(3), flexBasis: next(2) ? 0 : "auto" })
      const pad = [next(2), next(2)] as const
      const children = Array.from({ length: 1 + next(3) }, () => item(depth + 1))
      const node = box(
        {
          flexGrow: 1 + next(3),
          flexBasis: 0,
          flexDirection: "row",
          alignItems: "flex-start",
          paddingLeft: pad[0],
          paddingRight: pad[1],
        },
        children,
      )
      padding.set(node, pad)
      return node
    }
    for (let trial = 0; trial < 100; trial++) {
      const row = box(
        { flexDirection: "row", alignItems: "flex-start", width: 4 + next(57) },
        Array.from({ length: 2 + next(4) }, () => item(0)),
      )
      renderer.root.add(row)
      await renderOnce()
      expect(escapes(row, padding)).toEqual([])
      row.destroyRecursively()
    }
  })
})

describe("the public yoga.ts API keeps upstream rounding", () => {
  test("measured nodes round as text and positions round relative to the parent", () => {
    const config = Yoga.Config.create()
    const root = Yoga.Node.create(config)
    const parent = Yoga.Node.create(config)
    const child = Yoga.Node.create(config)
    const measured = Yoga.Node.create(config)
    root.setFlexDirection(FlexDirection.Row)
    measured.setMargin(Edge.Left, 0.5)
    measured.setMeasureFunc(() => ({ width: 5.5, height: 1 }))
    parent.setMargin(Edge.Left, 0.5)
    parent.setWidth(20)
    child.setMargin(Edge.Left, 0.6)
    child.setWidth(5)
    parent.insertChild(child, 0)
    root.insertChild(measured, 0)
    root.insertChild(parent, 1)
    root.calculateLayout(40, 10)
    // Text rounding floors the measured node's left and keeps 6 cells; the child rounds its own 0.6.
    expect([measured.getComputedLeft(), measured.getComputedWidth(), child.getComputedLeft()]).toEqual([0, 6, 1])
    // Upstream's cache reuses a measurement whose available size rounds to the same point.
    let calls = 0
    const leaf = Yoga.Node.create(config)
    leaf.setMeasureFunc((width) => ({ width: (calls++, width), height: 1 }))
    leaf.calculateLayout(10.2)
    leaf.calculateLayout(10.4)
    expect(calls).toBe(1)
    leaf.free()
    root.freeRecursive()
    config.free()
  })
})

test("empty textarea measures its placeholder", async () => {
  const node = new TextareaRenderable(renderer, {
    initialValue: "",
    placeholder: "Placeholder text that is longer than content",
    wrapMode: "char",
    alignSelf: "flex-start",
  })
  renderer.root.add(node)
  await renderOnce()
  expectLayout(node, 44, 1)
})
