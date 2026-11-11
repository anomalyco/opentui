import { describe, test, expect } from "bun:test"
import { createTestRenderer } from "../../testing/test-renderer.js"
import { CodeRenderable, type CodeOptions } from "../Code.js"
import { SyntaxStyle } from "../../syntax-style.js"
import { MockTreeSitterClient } from "../../testing/mock-tree-sitter-client.js"
import { TreeSitterClient } from "../../lib/tree-sitter/client.js"
import { getParsers } from "../../lib/tree-sitter/default-parsers.js"
import type { SimpleHighlight } from "../../lib/tree-sitter/types.js"
import type { TextChunk } from "../../text-buffer.js"
import { runInNewContext } from "node:vm"
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

  // What a streaming Markdown block shows before its own text's worker reply lands, from a remembered reply when it
  // is mounted again, or from a late one, equals what the worker shows for its current text, filetype, parser, client
  // and callbacks, or nothing. Real workers; each row releases the replies itself and returns the frames it checks.
  type Rig = Awaited<ReturnType<typeof rig>>
  const lines = (count: number) => Array.from({ length: count }, (_, i) => `L${i + 1}`).join("\n")
  const rows = (frame: string) => frame.split("\n").filter((row) => row.trim()).length
  test.each<[string, (t: Rig) => Promise<(string | number)[]>, (string | number)[]]>([
    ["mounted again", async (t) => [await t.again("A **name**")], ["A name"]],
    [
      "mounted again in another filetype",
      async (t) => [await t.again("A **pair**", { filetype: "javascript" }, {})],
      [""],
    ],
    [
      "mounted again with the same text and a NUL in the filetype",
      async (t) => {
        t.client.addFiletypeParser({ ...(await t.markdown()), filetype: "review\0x" })
        t.client.addFiletypeParser({ ...(await t.markdown()), filetype: "review" })
        return [await t.again("x\0**pair**", { filetype: "review" }, { content: "**pair**", filetype: "review\0x" })]
      },
      [""],
    ],
    [
      "mounted again after its parser changed",
      async (t) => {
        t.client.addFiletypeParser({ ...(await t.markdown(false)), filetype: "review" })
        const b = t.mount("A **name**", { filetype: "review" })
        const before = await t.settle(b)
        b.destroyRecursively()
        t.client.addFiletypeParser({ ...(await t.markdown()), filetype: "review" })
        const again = t.mount("A **name**", { filetype: "review" })
        return [before, await t.frame(), await t.settle(again)]
      },
      ["A **name**", "", "A name"],
    ],
    [
      "mounted again after its worker restarted",
      async (t) => {
        t.client.addFiletypeParser({ ...(await t.markdown()), filetype: "review" })
        const b = t.mount("**restart**", { filetype: "review" })
        await t.settle(b)
        b.destroyRecursively()
        // The new worker has only the default parsers.
        await t.client.destroy()
        await t.client.initialize()
        const again = t.mount("**restart**", { filetype: "review" })
        return [await t.frame(), await t.settle(again)]
      },
      ["", "**restart**"],
    ],
    [
      "mounted on a client another block left in flight",
      async (t) => {
        const other = await t.client2()
        const b = t.mount("A **client**", { filetype: "javascript" })
        await t.frame()
        b.treeSitterClient = other
        b.destroyRecursively()
        await t.release()
        const again = t.mount("A **client**", { filetype: "javascript", treeSitterClient: other })
        return [await t.frame(), await t.settle(again)]
      },
      ["", "A **client**"],
    ],
    [
      "filetype removed in flight",
      async (t) => {
        const b = t.mount("Remove **markdown**")
        await t.frame()
        b.filetype = undefined
        const removed = await t.frame()
        await t.release()
        return [removed, await t.frame()]
      },
      ["Remove **markdown**", "Remove **markdown**"],
    ],
    [
      "filetype removed in flight after a delta",
      async (t) => {
        const b = t.mount("initial")
        await t.frame()
        b.content = "initial + more"
        b.filetype = undefined
        await t.frame()
        await t.release()
        return [await t.frame()]
      },
      ["initial + more"],
    ],
    [
      "filetype changed in flight",
      async (t) => {
        const b = t.mount("A **plain**", { filetype: "javascript" })
        await t.frame()
        b.filetype = "markdown"
        await t.frame()
        await t.release()
        return [await t.frame(), await t.settle(b)]
      },
      ["", "A plain"],
    ],
    [
      "shortened and extended in flight",
      async (t) => {
        const b = t.mount(lines(4))
        const before = rows(await t.settle(b))
        b.content = lines(1)
        const short = rows(await t.frame())
        b.content = lines(5)
        await t.frame()
        await t.release()
        return [before, short, rows(await t.frame()), rows(await t.settle(b))]
      },
      [4, 4, 4, 5],
    ],
    [
      "mounted again after a callback changed its input",
      async (t) => {
        const onHighlight = (highlights: SimpleHighlight[]) => {
          for (const highlight of highlights) if (highlight[3]?.conceal === "") highlight[3].conceal = "X"
          return highlights
        }
        const own = await t.settle(t.mount("A **fresh**", { onHighlight }))
        const again = await t.again("A **fresh**", {}, { onHighlight }, false)
        return [own, again, await t.again("A **fresh**", {}, {}, false)]
      },
      ["A XXfreshXX", "A XXfreshXX", "A fresh"],
    ],
    [
      "a callback that empties its input",
      async (t) => {
        const onHighlight = (highlights: SimpleHighlight[]) => void highlights.splice(0)
        return [await t.settle(t.mount("**owner**", { onHighlight }))]
      },
      ["**owner**"],
    ],
    [
      "mounted again with a callback that answers with another realm's promise",
      async (t) => {
        const foreign = runInNewContext("(value) => Promise.resolve(value)")
        const first = await t.again("**cross realm**", {}, { onHighlight: (highlights) => foreign(highlights) })
        return [first, await t.settle(t.last())]
      },
      ["", "cross realm"],
    ],
    [
      "mounted again with a callback that answers late",
      async (t) => {
        await t.settle(t.mount("a **name**"))
        t.clear()
        let release = () => {}
        let calls = 0
        const onChunks = (chunks: TextChunk[]) => {
          const late = chunks.map((chunk, i) => ({ ...chunk, text: i ? "" : `version${++calls}` }))
          return calls === 1 ? new Promise<TextChunk[]>((resolve) => (release = () => resolve(late))) : late
        }
        const b = t.mount("a **name**", { onChunks })
        const first = await t.frame()
        b.content = "a **name**\nL2\nL3"
        const settled = await t.settle(b)
        release()
        await t.tick()
        return [first, settled, await t.frame()]
      },
      ["", "version2", "version2"],
    ],
    [
      "mounted again after a block with the same text changed",
      async (t) => {
        const a = t.mount("shared **block**")
        await t.settle(a)
        const b = t.mount("shared **block**")
        await t.settle(b)
        b.content += " more"
        await t.settle(b)
        return [await t.again("shared **block**", {}, {}, false)]
      },
      ["shared block"],
    ],
    [
      "mounted again after a block over the bound",
      async (t) => {
        await t.settle(t.mount("bound"))
        t.clear()
        await t.settle(t.mount("x".repeat((1 << 18) + 1), { filetype: "plaintext" }))
        t.clear()
        return [await t.again("bound", {}, {}, false)]
      },
      ["bound"],
    ],
  ])(
    "a highlight shown out of order: %s",
    async (_, run, expected) => {
      const t = await rig()
      try {
        expect(await run(t)).toEqual(expected)
      } finally {
        await t.destroy()
      }
    },
    30_000,
  )

  async function rig() {
    const setup = await createTestRenderer({ width: 40, height: 8 })
    const syntaxStyle = SyntaxStyle.fromStyles({ "markup.strong": { bold: true } }, setup.renderer.nativeScene)
    const dataPath = await mkdtemp(join(tmpdir(), "code-out-of-order-"))
    const held: { open: () => void; reply: Promise<unknown> }[] = []
    const clients: TreeSitterClient[] = []
    const gated = async () => {
      const client = new TreeSitterClient({ dataPath })
      await client.initialize()
      const real = client.highlightOnce.bind(client)
      client.highlightOnce = async (content, filetype) => {
        const reply = real(content, filetype)
        await new Promise<void>((open) => held.push({ open, reply }))
        return reply
      }
      clients.push(client)
      return client
    }
    const client = await gated()
    const tick = async () => {
      for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const frame = async () => {
      await setup.renderOnce()
      return setup.captureCharFrame().trim()
    }
    const release = async () => {
      const next = held.shift()
      next?.open()
      await next?.reply.catch(() => undefined)
      await tick()
    }
    const mount = (content: string, options: Partial<CodeOptions> = {}) => {
      const block = new CodeRenderable(setup.renderer, {
        ...{ content, syntaxStyle, treeSitterClient: client, filetype: "markdown", width: "100%" },
        ...{ streaming: true, drawUnstyledText: false, ...options },
      })
      setup.renderer.root.add(block)
      return block
    }
    const settle = async (block: CodeRenderable) => {
      await frame()
      while (held.length > 0) await release()
      await block.highlightingDone
      return frame()
    }
    const clear = () => setup.renderer.root.getChildren().forEach((child) => child.destroyRecursively())
    return {
      client,
      tick,
      frame,
      release,
      mount,
      settle,
      clear,
      last: () => setup.renderer.root.getChildren().at(-1) as CodeRenderable,
      client2: gated,
      // The bundled Markdown parser, or the same without its inline injections (it then keeps `**`).
      markdown: async (inline = true) => {
        const md = (await getParsers()).find((parser) => parser.filetype === "markdown")!
        return inline ? md : { ...md, queries: { highlights: md.queries.highlights }, injectionMapping: undefined }
      },
      // Settles a block first when `fresh`, then mounts a new one and returns its first frame.
      again: async (content: string, first: Partial<CodeOptions> = {}, next?: Partial<CodeOptions>, fresh = true) => {
        if (fresh) await settle(mount(content, first))
        clear()
        mount(next?.content ?? content, next ?? first)
        return frame()
      },
      destroy: async () => {
        while (held.length > 0) await release()
        setup.renderer.destroy()
        for (const each of clients) await each.destroy()
        await rm(dataPath, { recursive: true, force: true })
      },
    }
  }
})
