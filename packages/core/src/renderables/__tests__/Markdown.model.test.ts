import { afterAll, beforeAll, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MarkdownRenderable, type MarkdownInlineHook } from "../Markdown.js"
import { BoxRenderable } from "../Box.js"
import { CodeRenderable } from "../Code.js"
import type { Renderable } from "../../Renderable.js"
import { ScrollBoxRenderable } from "../ScrollBox.js"
import { SyntaxStyle } from "../../syntax-style.js"
import { RGBA } from "../../lib/RGBA.js"
import { TreeSitterClient } from "../../lib/tree-sitter/index.js"
import type { SimpleHighlight } from "../../lib/tree-sitter/types.js"
import { createTestRenderer, setRendererCapabilities, type TestRenderer } from "../../testing.js"
import { check, fail, rng } from "../../testing/model.js"
import { getBaseAttributes } from "../../types.js"

// A worker whose replies the model releases one by one, in any order. Only fences reach it: prose is the engine's.
class FakeWorker extends TreeSitterClient {
  pending: {
    content: string
    filetype: string
    resolve: (result: { highlights: SimpleHighlight[] }) => void
    reject: () => void
  }[] = []
  prose = 0
  // Fence highlights answered, across runs: the model must reach some.
  static replied = 0

  constructor() {
    super({ dataPath: join(tmpdir(), "tree-sitter-markdown-renderable-test-data") }, { autoStartWorker: false })
  }

  override async highlightOnce(content: string, filetype: string) {
    if (filetype === "markdown") this.prose++
    const { promise, resolve, reject } = Promise.withResolvers<{ highlights: SimpleHighlight[] }>()
    this.pending.push({ content, filetype, resolve, reject: () => reject(new Error("worker failed")) })
    return promise
  }

  // A streamed fence appends to a copy the worker keeps; the reply covers the whole copy.
  private copies = new Map<number, string>()
  override async highlightAppend(id: number, offset: number, text: string, filetype: string) {
    this.copies.set(id, (this.copies.get(id) ?? "").slice(0, offset) + text)
    return this.highlightOnce(this.copies.get(id)!, filetype)
  }

  reply(index = 0) {
    const [item] = this.pending.splice(index, 1)
    if (item) FakeWorker.replied++
    item?.resolve({ highlights: [[0, Math.min(1, item.content.length), "keyword"]] })
  }

  fail(index = 0) {
    this.pending.splice(index, 1)[0]?.reject()
  }
}

// Like OpenCode's session links: a known ID shows as `@title` with conceal, as written without it, in the link color of
// the style the hook is given.
function sessionLinks(titles: Map<string, string>): MarkdownInlineHook {
  return (spans, context) =>
    spans.flatMap((span) => {
      if (span.link || (span.code && !/^ses_\w+$/.test(span.text))) return [span]
      const fg = context.syntaxStyle.getStyle("markup.link.url")?.fg
      return span.text
        .split(/(ses_[ab])/)
        .filter(Boolean)
        .map((text) => {
          const title = titles.get(text)
          if (!title) return { ...span, text }
          return { ...span, text: context.conceal ? `@${title}` : text, target: text, fg: fg ?? span.fg }
        })
    })
}

type Command =
  | { k: "append"; piece: string }
  | { k: "replace"; head: boolean }
  | { k: "frame" | "rename" | "finish" | "resume" | "style" | "conceal" | "links" | "filter" | "scroll" | "remount" }
  | { k: "reply" | "fail"; at: number }

const pieces = ["see ", "ses_a ", "ses_b\n", "word ", "\n\n", "# ", "> ", "- ", "1. ", "*x* ", "`ses_a` ", "`run x` "]
// Three columns: a line holds at most one table piece, so only a delimiter's "--" cells can fall beyond the header.
pieces.push("~~y~~ ", "[l](https://e.x) ", "\n", "| ses_a | | |\n", "|--|--|--|\n", "| x ses_b |\n", "```\n", "z = 1\n")
// A fence the worker highlights, and an item's continuation.
pieces.push("```ts\n", "  ")
const others: Command["k"][] = [
  "rename",
  "finish",
  "resume",
  "style",
  "conceal",
  "links",
  "filter",
  "scroll",
  "remount",
]

function generate(seed: number): Command[] {
  const random = rng(seed)
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
  return Array.from({ length: 60 }, (): Command => {
    const roll = random()
    if (roll < 0.45) return { k: "append", piece: pick(pieces) }
    if (roll < 0.65) return { k: "frame" }
    if (roll < 0.75) return { k: random() < 0.8 ? "reply" : "fail", at: Math.floor(random() * 4) }
    if (roll < 0.78) return { k: "replace", head: random() < 0.5 }
    return { k: pick(others) } as Command
  })
}

let target: TestRenderer
let renderOnce: () => Promise<void>
let captureFrame: () => string
let styles: SyntaxStyle[]

beforeAll(async () => {
  const setup = await createTestRenderer({ width: 40, height: 30 })
  target = setup.renderer
  renderOnce = setup.renderOnce
  captureFrame = setup.captureCharFrame
  styles = [
    SyntaxStyle.fromStyles(
      { default: { fg: RGBA.fromValues(1, 1, 1, 1) }, "markup.link.url": { fg: RGBA.fromValues(0, 0, 1, 1) } },
      target.nativeScene,
    ),
    SyntaxStyle.fromStyles(
      {
        default: { fg: RGBA.fromValues(0.8, 0.8, 0.6, 1) },
        conceal: { fg: RGBA.fromValues(0.3, 0.3, 0.3, 1) },
        "markup.raw": { fg: RGBA.fromValues(1, 0.5, 0, 1), bold: true },
        "markup.italic": { italic: true, fg: RGBA.fromValues(0.5, 1, 0.5, 1) },
        "markup.heading": { bold: true, fg: RGBA.fromValues(0, 0.6, 1, 1) },
        "markup.quote": { italic: true },
        "markup.list": { fg: RGBA.fromValues(1, 0, 1, 1) },
        "markup.link.url": { fg: RGBA.fromValues(1, 1, 0, 1) },
      },
      target.nativeScene,
    ),
  ]
})

afterAll(() => {
  target.destroy()
  for (const style of styles) style.destroy()
})

const rows = () => captureFrame().split("\n")
const text = (lines: string[]) => lines.join("\n").trimEnd()
const codes = (node: Renderable): CodeRenderable[] => [
  ...(node instanceof CodeRenderable ? [node] : []),
  ...node.getChildren().flatMap(codes),
]
const rowsOf = (nodes: Renderable[]) =>
  new Set(nodes.flatMap((node) => Array.from({ length: node.height }, (_, at) => node.y + at)))

// Compare cell styles directly instead of constructing spans for the whole screen. Link IDs are local: compare URLs.
function snapshot(hidden: Set<number>, plain: Set<number>, chars = rows()): string[] {
  return target.currentRenderBuffer.withBuffers(({ width, height, fg, bg, attributes }) => {
    const colors = (plane: Uint16Array) => Buffer.copyBytesFrom(plane).toString("latin1")
    const foreground = colors(fg)
    const background = colors(bg)
    const attrs = String.fromCharCode(...attributes.map(getBaseAttributes))
    return chars.slice(0, height).map((line, y) => {
      if (hidden.has(y)) return ""
      const row = line.trimEnd()
      const links = /l|https/.test(row) ? Array.from(row, (_, x) => target.getLinkAt(x, y)) : []
      const start = y * width
      const end = start + width
      const colorRow = (colors: string) => colors.slice(start * 8, end * 8) // Four u16 channels per cell.
      const style = plain.has(y) ? "" : colorRow(foreground) + colorRow(background) + attrs.slice(start, end)
      return JSON.stringify([plain.has(y) ? row : line, links]) + style
    })
  })
}

/** The first row where two snapshots differ, shown both ways, or undefined. */
function differs(a: string[], b: string[]): string | undefined {
  const at = a.findIndex((row, y) => row !== b[y])
  return at === -1 ? undefined : `row ${at}\n${JSON.stringify(a[at])}\n${JSON.stringify(b[at])}`
}

// One run of a command list: a hooked, streamed Markdown answer in a scroll box with 16 siblings (so the scene culls it
// when scrolled away), as OpenCode shows one.
async function run(commands: Command[]): Promise<void> {
  const titles = new Map([
    ["ses_a", "A"],
    ["ses_b", "B"],
  ])
  const options = { style: 0, conceal: true, links: true, filter: true, streaming: true }
  const worker = new FakeWorker()
  const markdown = (content: string, streaming: boolean, client: TreeSitterClient) =>
    new MarkdownRenderable(target, {
      content,
      syntaxStyle: styles[options.style]!,
      streaming,
      conceal: options.conceal,
      treeSitterClient: client,
      inlineHook: sessionLinks(titles),
      inlineHookFilter: options.filter ? ["ses_"] : undefined,
      tableOptions: { style: "columns" },
    })
  // The subject scrolls among 16 siblings, so the scene culls it when scrolled away; a twin is drawn alone.
  const mount = (content: string, streaming = options.streaming) => {
    const md = markdown(content, streaming, worker)
    const box = new ScrollBoxRenderable(target, { width: "100%", height: target.height })
    box.verticalScrollBar.visible = false
    box.add(md)
    for (let i = 0; i < 16; i++) box.add(new BoxRenderable(target, { height: 3, flexShrink: 0 }))
    target.root.add(box)
    return { box, md }
  }
  setRendererCapabilities(target, { hyperlinks: true })
  let { box, md } = mount("")
  let inView = true
  const trace: string[] = []
  // What frames drew so far: text cells (P7) and the committed blocks' rows (P4); reset where display may change.
  let drawn = { rows: 0, cells: 0 }
  let last = ""
  let committed: string[] = []
  const reset = () => {
    drawn = { rows: 0, cells: 0 }
    committed = []
  }
  const failWith = (property: string, what: string) =>
    fail(property, `${what} after ${trace.join(" | ")}\n${JSON.stringify(md.content)}\n${captureFrame()}`)

  // A fence whose highlight failed draws its code without colors, which a twin's answered highlight has.
  let failed = false
  let compared = ""
  let expected: string[] = []
  // A fresh document of the same source and options, drawn alone, with every fence highlight answered.
  const twin = async (streaming: boolean, hidden: Set<number>, plain: Set<number>) => {
    box.visible = false
    const own = new FakeWorker()
    const fresh = markdown(md.content, streaming, own)
    target.root.add(fresh)
    await renderOnce()
    for (let pass = 0; pass < 4 && own.pending.length > 0; pass++) {
      while (own.pending.length > 0) own.reply()
      await new Promise<void>((resolve) => setImmediate(resolve))
      await renderOnce()
    }
    const shot = snapshot(hidden, plain)
    fresh.destroyRecursively()
    box.visible = true
    return shot
  }

  const frame = async () => {
    await renderOnce()
    if (!inView) return
    const lines = rows()
    const now = lines.map((line) => line.trimEnd())
    // A fence's code is never hooked, and draws again once its highlight lands.
    const fences = codes(md)
    const code = rowsOf(fences)
    // A fence waiting for its highlight keeps its old size, so the rows from it down may differ from a twin's.
    const first = Math.min(
      ...fences
        .filter((fence) => fence.isHighlighting || Reflect.get(fence, "_highlightsDirty"))
        .map((fence) => fence.y),
    )
    const waiting = new Set(Array.from({ length: target.height }, (_, y) => y).filter((y) => y >= first))
    const prose = now.map((row, y) => (code.has(y) ? "" : row))
    // P9: a fence whose highlight landed draws its code, as the engine reads it; a twin shares any bug of the subject.
    const doc = Reflect.get(md, "_doc")
    md.blocks.forEach((block, index) => {
      const fence = block.renderable
      if (block.kind !== "code" || !(fence instanceof CodeRenderable) || fence.y >= first) return
      const code = doc
        .readLeaf(index)
        .chunks.map((chunk: { text: string }) => chunk.text)
        .join("")
      const drawn = now
        .slice(fence.y, fence.y + fence.height)
        .map((row) => row.slice(fence.x, fence.x + fence.width))
        .join("")
      // Long lines wrap, so only the characters count.
      if (drawn.replace(/\s/g, "") !== code.replace(/\s/g, "")) failWith("P9", `fence draws ${JSON.stringify(drawn)}`)
    })
    // A code span that holds more than an ID is not hooked: it shows its inner backticks, or, while a "```" run inside a
    // line may still close one, its text as code.
    const span = /[^\n]```/.test(md.content)
    if (options.conceal && !span && /(?<!`)ses_[ab](?!`)/.test(prose.join("\n"))) failWith("P8", "unhooked ID")
    // Committed rows never change; text never leaves the frame while streaming.
    const blocks = md.getChildren()
    const end = md.committedBlockCount > 0 ? blocks[md.committedBlockCount - 1] : undefined
    const rowsEnd = end ? end.y + end.height - md.y : 0
    if (committed.some((row, at) => row !== now[at])) failWith("P4", "committed rows changed")
    // Scrollback writes committed rows once highlights land (OpenCode settles first), so a waiting fence's are not yet.
    committed = now.slice(0, Math.min(rowsEnd, first))
    // Markers and IDs may show as written until decided, so only the rest counts, and not while a code span may close.
    const shown = {
      rows: prose.filter((row) => /[^│\s#]/.test(row)).length,
      cells: prose
        .join("")
        .replace(/ses_[ab]/g, "@")
        .replace(/[\s│#─|`~*-]/g, "").length,
    }
    const lost = shown.rows < drawn.rows || shown.cells < drawn.cells - 2
    if (md.streaming && !span && lost) failWith("P7", `drawn text lost\n--- before\n${last}`)
    drawn = shown
    last = text(now)
    if (md.height > target.height) return
    // P6 per frame: characters, colors and links equal a fresh twin's, except from a fence whose highlight is in flight
    // down, and a fence's colors after a failed highlight.
    const plain = failed ? code : new Set<number>()
    const subject = snapshot(waiting, plain, lines)
    const key = JSON.stringify([md.content, options, [...titles], [...waiting], [...plain]])
    if (key !== compared) expected = await twin(md.streaming, waiting, plain)
    compared = key
    const difference = differs(subject, expected)
    if (difference) failWith("P6", `frame differs from a fresh twin on ${difference}`)
  }

  try {
    for (const command of commands) {
      trace.push(JSON.stringify(command))
      switch (command.k) {
        case "append":
          if (md.streaming) md.content += command.piece
          break
        case "replace":
          // OpenCode's trim(), or text before the old content: both parse again.
          md.content = command.head ? `x ${md.content}` : md.content.trim()
          reset()
          break
        case "frame":
          await frame()
          break
        case "reply":
          worker.reply(command.at % Math.max(1, worker.pending.length))
          await new Promise<void>((resolve) => setImmediate(resolve))
          break
        case "fail":
          failed ||= worker.pending.length > 0
          worker.fail(command.at % Math.max(1, worker.pending.length))
          await new Promise<void>((resolve) => setImmediate(resolve))
          break
        case "rename":
          // Titles keep their width, so a rename moves no row.
          titles.set("ses_a", titles.get("ses_a") === "A" ? "B" : "A")
          md.rerunInlineHook((source) => source.includes("ses_a"))
          committed = []
          break
        case "finish":
        case "resume":
          options.streaming = command.k === "resume"
          md.streaming = options.streaming
          reset()
          break
        case "style":
          options.style = 1 - options.style
          md.syntaxStyle = styles[options.style]!
          break
        case "conceal":
          options.conceal = !options.conceal
          md.conceal = options.conceal
          reset()
          break
        case "links":
          options.links = !options.links
          target.emit("capabilities", setRendererCapabilities(target, { hyperlinks: options.links }))
          reset()
          break
        case "filter":
          options.filter = !options.filter
          md.inlineHookFilter = options.filter ? ["ses_"] : undefined
          break
        case "scroll":
          inView = !inView
          box.scrollTo(inView ? 0 : target.height * 2)
          break
        case "remount": {
          const content = md.content
          box.destroyRecursively()
          ;({ box, md } = mount(content))
          inView = true
          reset()
          break
        }
      }
      // N3: the host's content is the engine's source after every call.
      if (md.content !== Reflect.get(md, "_doc").source()) failWith("N3", "content differs from the engine's source")
      if (worker.prose > 0) failWith("P11", "prose went to the highlighter")
    }
    // Settled: the frame equals a fresh finished render, colors included.
    inView = true
    box.scrollTo(0)
    md.streaming = false
    for (let pass = 0; pass < 6; pass++) {
      await renderOnce()
      if (!worker.pending.length) break
      while (worker.pending.length > 0) worker.reply()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await renderOnce()
    if (md.height <= target.height) {
      const plain = failed ? rowsOf(codes(md)) : new Set<number>()
      const settled = snapshot(new Set(), plain)
      const difference = differs(settled, await twin(false, new Set(), plain))
      if (difference) failWith("P6-settled", `settled frame differs from a fresh render on ${difference}`)
    }
  } finally {
    box.destroyRecursively()
  }
}

// CI runs 1,000 seeds of 60 commands; MODEL_SEEDS=10000 is the deep run.
test("streamed, hooked Markdown matches a fresh document in every frame", async () => {
  FakeWorker.replied = 0
  await check(1000, generate, run)
  if (!process.env.MODEL_SEED) expect(FakeWorker.replied).toBeGreaterThan(0)
}, 600_000)

test("the model's shrinker keeps a failing trace", async () => {
  const shrunk: Command[][] = []
  await expect(
    check(
      1,
      (): Command[] => [{ k: "frame" }, { k: "append", piece: "x" }, { k: "frame" }],
      async (commands) => {
        shrunk.push(commands)
        if (commands.some((command) => command.k === "append")) fail("demo", "append")
      },
    ),
  ).rejects.toThrow(/^seed \d+: demo: append\n\{"k":"append","piece":"x"\}$/)
  expect(shrunk.length).toBeGreaterThan(1)
})
