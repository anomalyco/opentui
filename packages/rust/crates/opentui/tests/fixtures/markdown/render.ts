// Renders the shared Markdown corpus's `fixture <case>` rows that have frames here with OpenTUI Core's
// MarkdownRenderable, configured as the OpenCode TUI configures it, and writes one character frame per case to
// `<case>.<mode>.txt` beside this script.
//
// Run it from a directory where `@opentui/core` resolves, such as OpenCode's `packages/tui`:
//
//     bun --cwd /path/to/opencode/packages/tui /path/to/render.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const core = await import(Bun.resolveSync("@opentui/core", process.cwd()))
const testing = await import(Bun.resolveSync("@opentui/core/testing", process.cwd()))
const directory = import.meta.dir
const width = 60

const corpus = JSON.parse(
  readFileSync(join(directory, "../../../../../../core/src/renderables/markdown.conformance.json"), "utf8"),
) as { rows: [string, string[]][] }
const cases = corpus.rows
  .filter(([name]) => name.startsWith("fixture ") && existsSync(join(directory, `${name.slice(8)}.conceal.txt`)))
  .map(([name, chunks]) => [name.slice(8), chunks.join("")] as const)

for (const [name, content] of cases) {
  for (const conceal of [true, false]) {
    const oneShot = await render(content, conceal, [content])
    const mode = conceal ? "conceal" : "source"
    writeFileSync(join(directory, `${name}.${mode}.txt`), oneShot)
    // Streaming in chunks of 7 characters, then finishing, must end at the one-shot frame.
    const chunks = content.match(/[\s\S]{1,7}/g) ?? []
    const streamed = await render(content, conceal, chunks)
    if (streamed !== oneShot) {
      console.error(`${name} (${mode}): streamed frame differs from the one-shot frame`)
      console.error(streamed)
      process.exitCode = 1
    }
  }
}

async function render(content: string, conceal: boolean, chunks: string[]) {
  const setup = await testing.createTestRenderer({ width, height: 80 })
  const syntaxStyle = core.SyntaxStyle.fromStyles(
    {
      default: { fg: core.RGBA.fromHex("#ffffff") },
      conceal: { fg: core.RGBA.fromHex("#808080") },
      "markup.heading": { fg: core.RGBA.fromHex("#00aaff"), bold: true },
      "markup.strong": { bold: true },
      "markup.italic": { italic: true },
      "markup.raw": { fg: core.RGBA.fromHex("#ffcc00") },
      "markup.link": { fg: core.RGBA.fromHex("#808080") },
      "markup.link.label": { fg: core.RGBA.fromHex("#00ffaa"), underline: true },
      "markup.link.url": { fg: core.RGBA.fromHex("#00aaff"), underline: true },
      "markup.list": { fg: core.RGBA.fromHex("#ff8800") },
      "markup.quote": { italic: true },
    },
    setup.renderer.nativeScene,
  )
  const markdown = new core.MarkdownRenderable(setup.renderer, {
    syntaxStyle,
    content: chunks.length === 1 ? content : "",
    streaming: chunks.length > 1,
    internalBlockMode: "top-level",
    tableOptions: { style: "grid", cellPaddingX: 1 },
    conceal,
  })
  setup.renderer.root.add(markdown)
  if (chunks.length > 1) {
    let streamed = ""
    for (const chunk of chunks) {
      streamed += chunk
      markdown.content = streamed
      await setup.renderOnce()
    }
    markdown.streaming = false
  }
  await settle(setup, markdown)
  const frame = setup
    .captureCharFrame()
    .split("\n")
    .map((line: string) => line.trimEnd())
    .join("\n")
    .trimEnd()
  setup.renderer.destroy()
  syntaxStyle.destroy()
  return frame + "\n"
}

// Waits until no Markdown text block is still highlighting.
async function settle(setup: { renderOnce: () => Promise<void> }, markdown: { getChildren: () => unknown[] }) {
  for (let attempt = 0; attempt < 50; attempt++) {
    await setup.renderOnce()
    const pending: unknown[] = []
    const stack = [...markdown.getChildren()]
    while (stack.length > 0) {
      const child = stack.pop() as { isHighlighting?: boolean; getChildren: () => unknown[] }
      if (child.isHighlighting) pending.push(child)
      stack.push(...child.getChildren())
    }
    if (pending.length === 0) {
      await setup.renderOnce()
      return
    }
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for highlighting")
}
