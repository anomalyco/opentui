import { test, expect, beforeEach, afterEach, describe } from "bun:test"
import { createTestRenderer, type TestRenderer } from "../testing.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"

let testRenderer: TestRenderer
let renderOnce: () => Promise<void>

beforeEach(async () => {
  ;({ renderer: testRenderer, renderOnce } = await createTestRenderer({ width: 40, height: 10 }))
})

afterEach(() => {
  testRenderer.destroy()
})

/**
 * `scrollHeight` used to be read straight off `content.height`, so any content
 * node whose own height was smaller than the subtree laid out inside it left
 * the overflowing rows unreachable: `maxScrollTop` stopped short of them and
 * `stickyStart: "bottom"` pinned above the real bottom.
 *
 * A container with an explicit height that its children overflow reproduces
 * that shape directly.
 */
describe("ScrollBox content extent", () => {
  test("scrollHeight covers children that overflow their container's height", async () => {
    const scroll = new ScrollBoxRenderable(testRenderer, { id: "scroll", width: 40, height: 10 })
    testRenderer.root.add(scroll)

    // The column claims 20 rows; its 50 non-shrinking children need 50.
    const column = new BoxRenderable(testRenderer, { id: "column", flexDirection: "column", height: 20 })
    scroll.add(column)
    for (let i = 0; i < 50; i++) {
      column.add(new TextRenderable(testRenderer, { id: `row-${i}`, content: `row ${i}`, flexShrink: 0 }))
    }

    await renderOnce()
    await renderOnce()

    expect(column.height).toBe(20)
    expect(scroll.scrollHeight).toBe(50)

    scroll.scrollTop = Number.MAX_SAFE_INTEGER
    expect(scroll.scrollTop).toBe(40) // 50 rows of content in a 10-row viewport
  })

  test("a sound layout is unaffected: extent equals the content height", async () => {
    const scroll = new ScrollBoxRenderable(testRenderer, { id: "scroll", width: 40, height: 10 })
    testRenderer.root.add(scroll)

    const column = new BoxRenderable(testRenderer, { id: "column", flexDirection: "column" })
    scroll.add(column)
    for (let i = 0; i < 30; i++) {
      column.add(new TextRenderable(testRenderer, { id: `row-${i}`, content: `row ${i}`, flexShrink: 0 }))
    }

    await renderOnce()
    await renderOnce()

    expect(scroll.content.height).toBe(30)
    expect(scroll.scrollHeight).toBe(30)
  })

  test("getSubtreeExtentY reaches through nested containers", async () => {
    const outer = new BoxRenderable(testRenderer, { id: "outer", flexDirection: "column", height: 5 })
    testRenderer.root.add(outer)
    const inner = new BoxRenderable(testRenderer, { id: "inner", flexDirection: "column", height: 5 })
    outer.add(inner)
    for (let i = 0; i < 12; i++) {
      inner.add(new TextRenderable(testRenderer, { id: `deep-${i}`, content: `deep ${i}`, flexShrink: 0 }))
    }

    await renderOnce()
    await renderOnce()

    expect(outer.height).toBe(5)
    expect(outer.getSubtreeExtentY()).toBe(12)
  })
})
