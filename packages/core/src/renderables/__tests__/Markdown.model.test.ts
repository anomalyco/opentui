import { afterAll, beforeAll, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MarkdownRenderable, type MarkdownInlineHook } from "../Markdown.js"
import { BoxRenderable } from "../Box.js"
import { ScrollBoxRenderable } from "../ScrollBox.js"
import { SyntaxStyle } from "../../syntax-style.js"
import { RGBA } from "../../lib/RGBA.js"
import { TreeSitterClient } from "../../lib/tree-sitter/index.js"
import type { SimpleHighlight } from "../../lib/tree-sitter/types.js"
import { createTestRenderer, setRendererCapabilities, type TestRenderer } from "../../testing.js"
import { check, fail, rng } from "../../testing/model.js"

// A worker whose replies the model releases one by one, in any order. Only fences reach it: prose is the engine's.
class FakeWorker extends TreeSitterClient {
  pending: {
    content: string
    filetype: string
    resolve: (result: { highlights: SimpleHighlight[] }) => void
    reject: () => void
  }[] = []
  prose = 0

  constructor() {
    super({ dataPath: join(tmpdir(), "tree-sitter-markdown-renderable-test-data") }, { autoStartWorker: false })
  }

  override async highlightOnce(content: string, filetype: string) {
    if (filetype === "markdown") this.prose++
    const { promise, resolve, reject } = Promise.withResolvers<{ highlights: SimpleHighlight[] }>()
    this.pending.push({ content, filetype, resolve, reject: () => reject(new Error("worker failed")) })
    return promise
  }

  reply(index = 0) {
    const [item] = this.pending.splice(index, 1)
    item?.resolve({ highlights: [[0, Math.min(1, item.content.length), "keyword"]] })
  }

  fail(index = 0) {
    this.pending.splice(index, 1)[0]?.reject()
  }
}

// Like OpenCode's session links: a known ID shows as `@title` with conceal, as written without it.
function sessionLinks(titles: Map<string, string>): MarkdownInlineHook {
  return (spans, context) =>
    spans.flatMap((span) => {
      if (span.link || (span.code && !/^ses_\w+$/.test(span.text))) return [span]
      return span.text
        .split(/(ses_[ab])/)
        .filter(Boolean)
        .map((text) => {
          const title = titles.get(text)
          return title ? { ...span, text: context.conceal ? `@${title}` : text, target: text } : { ...span, text }
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
let captureSpans: () => { lines: { spans: { text: string; fg: RGBA; bg: RGBA; attributes: number }[] }[] }
let styles: SyntaxStyle[]

beforeAll(async () => {
  const setup = await createTestRenderer({ width: 40, height: 30 })
  target = setup.renderer
  renderOnce = setup.renderOnce
  captureFrame = setup.captureCharFrame
  captureSpans = setup.captureSpans
  styles = [
    SyntaxStyle.fromStyles({ default: { fg: RGBA.fromValues(1, 1, 1, 1) } }, target.nativeScene),
    SyntaxStyle.fromStyles(
      {
        default: { fg: RGBA.fromValues(0.8, 0.8, 0.6, 1) },
        conceal: { fg: RGBA.fromValues(0.3, 0.3, 0.3, 1) },
        "markup.raw": { fg: RGBA.fromValues(1, 0.5, 0, 1), bold: true },
        "markup.italic": { italic: true, fg: RGBA.fromValues(0.5, 1, 0.5, 1) },
        "markup.heading": { bold: true, fg: RGBA.fromValues(0, 0.6, 1, 1) },
        "markup.quote": { italic: true },
        "markup.list": { fg: RGBA.fromValues(1, 0, 1, 1) },
      },
      target.nativeScene,
    ),
  ]
})

afterAll(() => {
  target.destroy()
  for (const style of styles) style.destroy()
})

const rows = () =>
  captureFrame()
    .split("\n")
    .map((row) => row.trimEnd())
const text = (lines: string[]) => lines.join("\n").trimEnd()

// One run of a command list: a hooked, streamed Markdown answer in a scroll box with 16 siblings (so the scene culls it
// when scrolled away), as OpenCode shows one.
async function run(commands: Command[]): Promise<void> {
  const titles = new Map([
    ["ses_a", "A"],
    ["ses_b", "B"],
  ])
  const options = { style: 0, conceal: true, links: true, filter: true, streaming: true }
  const worker = new FakeWorker()
  const mount = (content: string, streaming = options.streaming) => {
    const box = new ScrollBoxRenderable(target, { width: "100%", height: target.height })
    box.verticalScrollBar.visible = false
    const md = new MarkdownRenderable(target, {
      content,
      syntaxStyle: styles[options.style]!,
      streaming,
      conceal: options.conceal,
      treeSitterClient: worker,
      inlineHook: sessionLinks(titles),
      inlineHookFilter: options.filter ? ["ses_"] : undefined,
      tableOptions: { style: "columns" },
    })
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

  // A fresh streaming document of the same source and options, drawn alone.
  const twin = async (streaming: boolean) => {
    box.visible = false
    const fresh = mount(md.content, streaming)
    await renderOnce()
    const frame = text(rows())
    const spans = JSON.stringify(
      captureSpans().lines.map((line) =>
        line.spans.map((span) => [span.text, span.fg.toInts(), span.bg.toInts(), span.attributes]),
      ),
    )
    fresh.box.destroyRecursively()
    box.visible = true
    return { frame, spans }
  }

  const frame = async () => {
    await renderOnce()
    if (!inView) return
    const now = rows()
    // A fence's code is never hooked, nor a code span that holds more than an ID (it shows its inner backticks).
    const fenced = md.content.includes("```")
    if (options.conceal && !fenced && /(?<!`)ses_[ab](?!`)/.test(now.join("\n"))) failWith("P8", "unhooked ID")
    // Committed rows never change; text never leaves the frame while streaming.
    const blocks = md.getChildren()
    const end = md.committedBlockCount > 0 ? blocks[md.committedBlockCount - 1] : undefined
    const rowsEnd = end ? end.y + end.height - md.y : 0
    if (committed.some((row, at) => row !== now[at])) failWith("P4", "committed rows changed")
    committed = now.slice(0, rowsEnd)
    // Markers and IDs may show as written until decided, so only the rest counts. A "```" run that may still open a
    // fence or close a code span draws its text as code until then, so those documents are not counted.
    const shown = {
      rows: now.filter((row) => /[^│\s#]/.test(row)).length,
      cells: now
        .join("")
        .replace(/ses_[ab]/g, "@")
        .replace(/[\s│#─|`~*-]/g, "").length,
    }
    const lost = shown.rows < drawn.rows || shown.cells < drawn.cells - 2
    if (md.streaming && !fenced && lost) failWith("P7", `drawn text lost\n--- before\n${last}`)
    drawn = shown
    last = text(now)
    // Fences show after their highlight, so the twin is compared while none is in flight.
    if (fenced || md.height > target.height) return
    const fresh = await twin(md.streaming)
    if (fresh.frame !== text(now))
      failWith("P6", `frame differs from a fresh twin\n--- frame\n${text(now)}\n--- twin\n${fresh.frame}`)
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
          await Promise.resolve()
          break
        case "fail":
          worker.fail(command.at % Math.max(1, worker.pending.length))
          await Promise.resolve()
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
      while (worker.pending.length > 0) worker.reply()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await renderOnce()
    if (md.height <= target.height) {
      const settled = text(rows())
      const spans = JSON.stringify(
        captureSpans().lines.map((line) =>
          line.spans.map((span) => [span.text, span.fg.toInts(), span.bg.toInts(), span.attributes]),
        ),
      )
      box.visible = false
      const fresh = mount(md.content, false)
      for (let pass = 0; pass < 4; pass++) {
        await renderOnce()
        while (worker.pending.length > 0) worker.reply()
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      await renderOnce()
      const twinFrame = text(rows())
      const twinSpans = JSON.stringify(
        captureSpans().lines.map((line) =>
          line.spans.map((span) => [span.text, span.fg.toInts(), span.bg.toInts(), span.attributes]),
        ),
      )
      fresh.box.destroyRecursively()
      box.visible = true
      if (twinFrame !== settled)
        failWith("P6", `settled frame differs from a fresh render\n--- settled\n${settled}\n--- fresh\n${twinFrame}`)
      if (twinSpans !== spans) {
        const [a, b] = [JSON.parse(spans) as unknown[], JSON.parse(twinSpans) as unknown[]]
        const at = a.findIndex((line, index) => JSON.stringify(line) !== JSON.stringify(b[index]))
        failWith(
          "P6-spans",
          `settled colors differ from a fresh render on row ${at}\n${JSON.stringify(a[at])}\n${JSON.stringify(b[at])}`,
        )
      }
    }
  } finally {
    box.destroyRecursively()
  }
}

// CI runs 1,000 seeds of 60 commands (about 5 s); MODEL_SEEDS=10000 is the deep run.
test("streamed, hooked Markdown matches a fresh document in every frame", async () => {
  await check(1000, generate, run)
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
