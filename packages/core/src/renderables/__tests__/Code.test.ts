import { describe, test, expect } from "bun:test"
import { createTestRenderer } from "../../testing/test-renderer.js"
import { CodeRenderable } from "../Code.js"
import { SyntaxStyle } from "../../syntax-style.js"
import { MockTreeSitterClient } from "../../testing/mock-tree-sitter-client.js"
import { TreeSitterClient } from "../../lib/tree-sitter/client.js"
import { RGBA } from "../../lib/RGBA.js"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("CodeRenderable", () => {
  test("large JSON retains native token highlights and paints syntax colors", async () => {
    const scratch = join(tmpdir(), "tree-sitter-styled-text-test")
    await mkdir(scratch, { recursive: true })
    const dataPath = await mkdtemp(join(scratch, "json-tokens-"))
    const client = new TreeSitterClient({ dataPath })
    const setup = await createTestRenderer({ width: 80, height: 10 })
    const syntaxStyle = SyntaxStyle.fromStyles(
      {
        default: { fg: RGBA.fromHex("#ffffff") },
        property: { fg: RGBA.fromHex("#ff0000"), bold: true },
        number: { fg: RGBA.fromHex("#00ff00") },
      },
      setup.renderer.nativeScene,
    )
    try {
      // Match the production JSON grammar/query rather than falling back to plaintext.
      client.addFiletypeParser({
        filetype: "json",
        wasm: join(process.cwd(), "src/tests/fixtures/json/tree-sitter-json.wasm"),
        queries: {
          highlights: [join(process.cwd(), "src/tests/fixtures/json/highlights.scm")],
        },
      })
      await client.initialize()
      const lines = Number(process.env.OPENTUI_STYLED_PROBE_LINES ?? 1000)
      const content = JSON.stringify(
        Object.fromEntries(Array.from({ length: lines }, (_, row) => [`field${row}`, 123])),
        null,
        2,
      )
      class HighlightedCode extends CodeRenderable {
        get nativeTextBuffer() {
          return this.textBuffer
        }
      }
      const code = new HighlightedCode(setup.renderer, {
        content,
        filetype: "json",
        syntaxStyle,
        treeSitterClient: client,
        drawUnstyledText: true,
        conceal: false,
        width: "100%",
        height: "100%",
      })
      setup.renderer.root.add(code)
      const start = performance.now()
      await setup.renderOnce()
      const firstFrameMs = performance.now() - start
      await code.highlightingDone
      const highlightedMs = performance.now() - start
      expect(code.nativeTextBuffer.getHighlightCount()).toBe(lines * 8 + 1)
      expect(code.nativeTextBuffer.getPlainText()).toBe(content)
      for (const row of [1, Math.floor(lines / 2), lines]) {
        expect(code.nativeTextBuffer.getLineHighlights(row).length).toBeGreaterThan(2)
      }
      await setup.renderOnce()
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
      expect(spans.find((span) => span.text.includes("field0"))?.fg.toInts()).toEqual(RGBA.fromHex("#ff0000").toInts())
      expect(spans.find((span) => span.text.includes("123"))?.fg.toInts()).toEqual(RGBA.fromHex("#00ff00").toInts())
      const paintedMs = performance.now() - start
      code.scrollY = lines
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain(`field${lines - 1}`)
      expect(
        setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .find((span) => span.text.includes(`field${lines - 1}`))
          ?.fg.toInts(),
      ).toEqual(RGBA.fromHex("#ff0000").toInts())
      setup.resize(30, 10)
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain(`field${lines - 1}`)
      if (process.env.OPENTUI_STYLED_PROBE_LINES) {
        console.log(
          JSON.stringify({
            lines,
            firstFrameMs,
            highlightedMs,
            paintedMs,
            scrolledAndResizedMs: performance.now() - start,
            highlights: code.nativeTextBuffer.getHighlightCount(),
          }),
        )
      }
    } finally {
      setup.renderer.destroy()
      await client.destroy()
      syntaxStyle.destroy()
      await rm(dataPath, { recursive: true, force: true })
    }
  }, 60_000)

  test("streaming content update schedules render and starts highlighting when renderer is idle", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 30,
      height: 10,
    })

    const client = new MockTreeSitterClient()
    const syntaxStyle = SyntaxStyle.create(renderer.nativeScene)

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
