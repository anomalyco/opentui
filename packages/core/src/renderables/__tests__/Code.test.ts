import { describe, test, expect } from "bun:test"
import { createTestRenderer } from "../../testing/test-renderer.js"
import { CodeRenderable } from "../Code.js"
import { SyntaxStyle } from "../../syntax-style.js"
import { MockTreeSitterClient } from "../../testing/mock-tree-sitter-client.js"

describe("CodeRenderable", () => {
  test("streaming content update schedules render and starts highlighting when renderer is idle", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 30,
      height: 10,
    })

    const client = new MockTreeSitterClient()
    const syntaxStyle = SyntaxStyle.create()

    const code = new CodeRenderable(renderer, {
      content: "",
      filetype: "typescript",
      syntaxStyle,
      drawUnstyledText: false,
      streaming: true,
      width: "100%",
      height: "100%",
      treeSitterClient: client,
    })

    try {
      renderer.root.add(code)
      await renderOnce()

      // Set content in streaming mode — this should schedule a render
      code.content = 'console.log("hello")'

      // Render once — this should trigger startHighlight because highlights are dirty
      await renderOnce()

      // Highlighting should have started (mock client hasn't resolved yet)
      expect(code.isHighlighting).toBe(true)
      expect(client.isHighlighting()).toBe(true)

      client.resolveAllHighlightOnce()
      await code.highlightingDone
    } finally {
      if (client.isHighlighting()) {
        client.resolveAllHighlightOnce()
      }

      await code.highlightingDone.catch(() => undefined)
      renderer.destroy()
      await client.destroy()
      syntaxStyle.destroy()
    }
  })
})
