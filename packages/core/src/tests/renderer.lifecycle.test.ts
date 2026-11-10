import { test, beforeEach, afterEach, describe } from "bun:test"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { TextRenderable } from "../renderables/Text.js"

let renderer: TestRenderer
let renderOnce: () => Promise<void>

beforeEach(async () => {
  ;({ renderer, renderOnce } = await createTestRenderer({}))
})

afterEach(() => {
  renderer.destroy()
})

describe("Renderer lifecycle passes", () => {
  test("lifecycle pass skips destroyed renderable", async () => {
    const text = new TextRenderable(renderer, {
      id: "text-renderable",
    })
    text.add("hello")

    renderer.root.add(text)
    await renderOnce()

    text.add(" world")

    text.destroy()
    renderer.registerLifecyclePass(text)

    // Should not crash — lifecycle pass loop should skip destroyed renderables
    await renderOnce()
  })
})
