import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable } from "../renderables/Box.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { TextRenderable, type TextOptions } from "../renderables/Text.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"

let renderer: TestRenderer
let renderOnce: () => Promise<void>

beforeEach(async () => {
  ;({ renderer, renderOnce } = await createTestRenderer({ width: 80, height: 30 }))
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
