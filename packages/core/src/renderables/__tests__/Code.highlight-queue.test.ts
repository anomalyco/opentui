import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { CodeRenderable } from "../Code"
import { createTestRenderer, type TestRenderer } from "../../testing/test-renderer"
import { MockTreeSitterClient } from "../../testing/mock-tree-sitter-client"
import { SyntaxStyle } from "../../syntax-style"

describe("CodeRenderable highlight queue", () => {
  let renderer: TestRenderer
  let renderOnce: () => Promise<void>
  let syntaxStyle: SyntaxStyle
  let client: MockTreeSitterClient

  beforeEach(async () => {
    const testRenderer = await createTestRenderer({ width: 60, height: 10 })
    renderer = testRenderer.renderer
    renderOnce = testRenderer.renderOnce
    syntaxStyle = SyntaxStyle.create()
    client = new MockTreeSitterClient()
  })

  afterEach(() => {
    renderer?.destroy()
    syntaxStyle?.destroy()
  })

  it("queues highlight requests instead of running them concurrently", async () => {
    const code = new CodeRenderable(renderer, {
      width: 40,
      height: 4,
      filetype: "markdown",
      drawUnstyledText: false,
      streaming: true,
      syntaxStyle,
      treeSitterClient: client,
    })

    renderer.root.add(code)

    code.content = "first"
    await renderOnce()
    expect((client as any)._highlightPromises.length).toBe(1)

    code.content = "second"
    await renderOnce()
    expect((client as any)._highlightPromises.length).toBe(1)

    client.resolveHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect((client as any)._highlightPromises.length).toBe(1)

    code.destroy()
  })
})
