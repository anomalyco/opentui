import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { DiffRenderable } from "../Diff"
import { TextBufferRenderable } from "../TextBufferRenderable"
import { createTestRenderer, type TestRenderer } from "../../testing/test-renderer"

const simpleDiff = `--- a/test.js
+++ b/test.js
@@ -1,3 +1,3 @@
 function hello() {
-  console.log("Hello");
+  console.log("Hello, World!");
 }`

class TestBufferRenderable extends TextBufferRenderable {
  public getSyntaxStyle() {
    return this.textBuffer.getSyntaxStyle()
  }
}

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>

beforeEach(async () => {
  const testRenderer = await createTestRenderer({ width: 80, height: 20 })
  currentRenderer = testRenderer.renderer
  renderOnce = testRenderer.renderOnce
})

afterEach(() => {
  if (currentRenderer) {
    currentRenderer.destroy()
  }
})

describe("SyntaxStyle cleanup", () => {
  it("destroys the default syntax style for TextBufferRenderable", async () => {
    const renderable = new TestBufferRenderable(currentRenderer, { width: 10, height: 2 })
    currentRenderer.root.add(renderable)
    await renderOnce()

    const syntaxStyle = renderable.getSyntaxStyle()
    expect(syntaxStyle).not.toBeNull()

    renderable.destroy()

    expect(() => syntaxStyle!.getStyleCount()).toThrow("NativeSyntaxStyle is destroyed")
  })

  it("destroys fallback syntax styles created for DiffRenderable", async () => {
    const diffRenderable = new DiffRenderable(currentRenderer, { diff: simpleDiff })
    currentRenderer.root.add(diffRenderable)
    await renderOnce()

    const leftCodeRenderable = (diffRenderable as any).leftCodeRenderable
    expect(leftCodeRenderable).toBeTruthy()

    const syntaxStyle = leftCodeRenderable.syntaxStyle

    diffRenderable.destroyRecursively()

    expect(() => syntaxStyle.getStyleCount()).toThrow("NativeSyntaxStyle is destroyed")
  })
})
