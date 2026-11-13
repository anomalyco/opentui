// Model-based test of the Code highlight lifecycle (CodeRenderable + tree-sitter client + ScrollBox culling).
//
// Environment: MODEL_SEEDS=<n> (default 2000), MODEL_STEPS=<n> (default 80), MODEL_SEED=<s> replays one seed and prints
// its trace, MODEL_SHRINK=0 skips shrinking, MODEL_SKIP=a,b turns properties off, MODEL_SCRIPT='{"start":..,
// "commands":[..]}' runs one hand-written sequence, MODEL_DEBUG=1 logs the block's layout at every checked frame.
//
// A seed generates a random command sequence (content writes, appends, option changes, scrolling the block in and
// out of view, remounts, a new block in its place, worker replies in any order, worker failures, frames). The real
// CodeRenderable runs it in a test renderer; a reference model tracks every (content, options) state the block has
// been in. After each frame, the painted rows and the layout height are checked against the model; at the end every
// reply is released and the settled frame is checked against the model's render of the current state. A failing
// sequence is shrunk by removing commands, then by shortening text.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { CodeRenderable } from "../Code.js"
import { BoxRenderable } from "../Box.js"
import { ScrollBoxRenderable } from "../ScrollBox.js"
import { SyntaxStyle } from "../../syntax-style.js"
import { RGBA } from "../../lib/RGBA.js"
import { createTestRenderer } from "../../testing/test-renderer.js"
import { StyledText } from "../../lib/styled-text.js"
import {
  Failure,
  ModelClient,
  fail,
  removeChunks,
  rendered,
  rng,
  text,
  tick,
  type Filetype,
} from "./code-model-harness.js"

// ---------------------------------------------------------------------------------------------------------------
// Commands.

type Command =
  | { op: "set"; text: string }
  | { op: "append"; text: string }
  | { op: "streaming" }
  | { op: "filetype"; value: Filetype }
  | { op: "conceal" }
  | { op: "style" }
  | { op: "unstyled" }
  | { op: "preview" }
  | { op: "scroll"; into: boolean }
  | { op: "restore" }
  | { op: "push"; restore?: "scroll" | "remove" | "other" }
  | { op: "late"; inner: Command }
  | { op: "remount" }
  | { op: "replace" }
  | { op: "reply"; index: number }
  | { op: "fail"; index: number; answer: boolean }
  | { op: "frame" }
  | { op: "tick" }

function show(c: Command): string {
  switch (c.op) {
    case "set":
    case "append":
      return `${c.op} ${JSON.stringify(c.text)}`
    case "filetype":
      return `filetype ${c.value ?? "none"}`
    case "scroll":
      return `scroll ${c.into ? "in" : "out"}`
    case "push":
      return c.restore ? `push, restore by ${c.restore}` : "push"
    case "late":
      return `late ${show(c.inner)}`
    case "reply":
    case "fail":
      return `${c.op} ${c.index}`
    default:
      return c.op
  }
}

function generate(seed: number, steps: number): Command[] {
  const r = rng(seed)
  const out: Command[] = []
  for (let i = 0; i < steps; i++) {
    const k = r()
    if (k < 0.01) {
      // A change made in an afterLayout callback, after the frame's layout and before it paints.
      const inner = (["unstyled", "streaming", "conceal"] as const)[Math.floor(r() * 3)]
      out.push({ op: "late", inner: r() < 0.5 ? { op: "append", text: text(r, 2) } : { op: inner } })
    } else if (k < 0.12) out.push({ op: "set", text: text(r, 4) })
    else if (k < 0.27) out.push({ op: "append", text: text(r, 2) })
    else if (k < 0.31) out.push({ op: "streaming" })
    else if (k < 0.34) out.push({ op: "filetype", value: (["hide", "plain", undefined] as const)[Math.floor(r() * 3)] })
    else if (k < 0.37) out.push({ op: "conceal" })
    else if (k < 0.39) out.push({ op: "style" })
    else if (k < 0.42) out.push({ op: "unstyled" })
    else if (k < 0.47) out.push({ op: "scroll", into: r() < 0.6 })
    else if (k < 0.48) out.push({ op: "restore" })
    else if (k < 0.5) {
      const how = r()
      out.push({ op: "push", restore: how < 0.3 ? "scroll" : how < 0.5 ? "remove" : how < 0.7 ? "other" : undefined })
    } else if (k < 0.52) out.push({ op: r() < 0.5 ? "remount" : "replace" })
    else if (k < 0.66) out.push({ op: "reply", index: Math.floor(r() * 3) })
    else if (k < 0.69) out.push({ op: "fail", index: Math.floor(r() * 3), answer: r() < 0.5 })
    else if (k < 0.93) out.push({ op: "frame" })
    else if (k < 0.95) out.push({ op: "preview" })
    else out.push({ op: "tick" })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Reference model.

interface State {
  content: string
  filetype: Filetype
  conceal: boolean
  unstyled: boolean
  streaming: boolean
  style?: number
  preview?: number
}

interface Start {
  state: State
  scrolledIn: boolean
}

const VIEW = 6
// Spacer height above and below the block: far enough that scrolling away culls it.
const ABOVE = 30

let setup: Awaited<ReturnType<typeof createTestRenderer>>
let styles: SyntaxStyle[]
beforeAll(async () => {
  setup = await createTestRenderer({ width: 30, height: 10 })
  styles = [0.2, 0.8].map((v) =>
    SyntaxStyle.fromStyles(
      { default: { fg: RGBA.fromValues(1, 1, 1, 1) }, keyword: { fg: RGBA.fromValues(v, 0, 1, 1) } },
      setup.renderer.nativeScene,
    ),
  )
})
afterAll(async () => {
  await setup.dispose()
  for (const style of styles) style.destroy()
})

async function run(start: Start, commands: Command[], trace?: string[]): Promise<void> {
  const { renderer, renderOnce, captureCharFrame } = setup
  const client = new ModelClient()
  try {
    const box = new ScrollBoxRenderable(renderer, { width: 30, height: VIEW })
    renderer.root.add(box)
    // Another box, whose callbacks native delivers after the block's box's.
    const other = new ScrollBoxRenderable(renderer, { width: 30, height: 1 })
    renderer.root.add(other)
    // The scene culls only parents with at least 16 children, so the spacers are many small boxes.
    const spacers = () => {
      for (let i = 0; i < ABOVE / 2; i++) box.add(new BoxRenderable(renderer, { height: 2, flexShrink: 0 }))
    }
    spacers()
    let state: State = { ...start.state }
    let style = 0
    const create = () =>
      new CodeRenderable(renderer, {
        content: state.content,
        filetype: state.filetype,
        conceal: state.conceal,
        drawUnstyledText: state.unstyled,
        streaming: state.streaming,
        syntaxStyle: styles[style],
        treeSitterClient: client,
        width: "100%",
        flexShrink: 0,
      })
    let block = create()
    box.add(block)
    spacers()
    // Rows mounted above the block push it down; `top` scrolls it into view.
    let pushes = 0
    const top = () => ABOVE + pushes * 2 * VIEW
    box.scrollTo(start.scrolledIn ? ABOVE : 0)

    // Every state the block has been in, oldest first. history[i] are its rows; raw[i] its source rows.
    const history: State[] = [{ ...state }]
    let shownIndex = -1
    // The render epoch changes with every change of what a highlight renders (content, filetype, conceal, style). A
    // request is current while its block and epoch are; a current failure falls back to the raw source.
    let epoch = 0
    // The last current reply failed, or succeeded: the block then holds as current the highlight of `heldState`, its
    // state at that reply or an earlier one that a style change keeps until the next reply.
    let failed: { block: CodeRenderable; epoch: number } | undefined
    let held: { block: CodeRenderable; epoch: number } | undefined
    let heldState: State = { ...start.state }
    const isCurrent = (tag: typeof held) => tag?.block === block && tag.epoch === epoch
    const currentFailed = () => isCurrent(failed)
    const heldRows = () => rendered(heldState.content, heldState.filetype, heldState.conceal)
    client.answered = (tag) => {
      if (!isCurrent(tag as typeof held)) return
      failed = undefined
      held = tag as typeof held
      heldState = { ...state }
    }
    client.tag = () => ({ block, epoch })
    // The last frame painted a highlight, and no frame since ended with the block culled.
    let painted = false

    const preview = () =>
      new StyledText([{ __isChunk: true, text: rendered(state.content, state.filetype, state.conceal).join("\n") }])
    const push = () => {
      // Only a streaming, styled block keeps its highlight through a change; others may wait blank for the next one.
      const prev = history[history.length - 1]
      if (!prev.streaming || prev.filetype === undefined || prev.unstyled) painted = false
      if (["content", "filetype", "conceal", "style"].some((k) => prev[k as keyof State] !== state[k as keyof State])) {
        // A style change keeps the held highlight, and its height, as current until the next reply.
        const restyled =
          isCurrent(held) && ["content", "filetype"].every((k) => prev[k as keyof State] === state[k as keyof State])
        epoch++
        if (restyled) held = { block, epoch }
      }
      history.push({ ...state })
    }

    const visibleRows = (): { rows: string[]; skip: number } | undefined => {
      const top = box.viewport.y
      const y0 = block.y
      const y1 = block.y + block.height
      const v0 = Math.max(top, y0)
      const v1 = Math.min(top + VIEW, y1)
      if (v1 <= v0) return undefined
      const lines = captureCharFrame().split("\n")
      const rows: string[] = []
      for (let y = v0; y < v1; y++) rows.push((lines[y] ?? "").slice(block.x, block.x + block.width).trimEnd())
      return { rows, skip: v0 - y0 }
    }

    const matches = (rows: string[], skip: number, want: string[]) =>
      rows.every((row, i) => row === (want[i + skip] ?? "").trimEnd())

    let late: unknown
    // The previous checked frame painted the block.
    let seenBefore = false
    const check = (label: string) => {
      if (late) throw late
      // The scroll range agrees with the children's layout (520: culled descendants kept stale public layout).
      if (box.scrollHeight !== ABOVE + top() + block.height)
        fail("scroll-height", `${label}: scrollHeight ${box.scrollHeight}, children ${ABOVE + top()} + ${block.height}`)
      const seen = visibleRows()
      const wasSeen = seenBefore
      seenBefore = seen !== undefined
      if (process.env.MODEL_DEBUG)
        console.log(
          `  [${label}] y ${block.y} h ${block.height} view ${box.viewport.y} hooks ${renderer.nativeScene.reachesHooks(block)} rows ${JSON.stringify(seen?.rows)} pending ${client.pending.length}`,
        )
      if (!seen) {
        // Culled: no hook runs, so the block measures its current source, raw or highlighted (496). Culling has
        // overscan, so a block just outside the view still runs its hooks and may keep its previous paint.
        if (renderer.nativeScene.reachesHooks(block)) return
        const cur = history[history.length - 1]
        const styledHeight = rendered(cur.content, cur.filetype, cur.conceal).length
        // A block that holds its current highlight measures it.
        const ok = isCurrent(held) ? [heldRows().length] : [cur.content.split("\n").length, styledHeight]
        // Culling is decided against the last painted frame: a block that frame painted may keep its highlight, and
        // its height, for the first frame that culls it.
        if (wasSeen) ok.push(...history.map((s) => rendered(s.content, s.filetype, s.conceal).length))
        if (!ok.includes(block.height))
          fail("culled-height", `${label}: culled block measures ${block.height}, current content has ${ok} rows`)
        return
      }
      const { rows, skip } = seen
      const current = history.length - 1
      const cur = history[current]
      const blank = rows.every((row) => row === "")
      // Indexes of states whose highlighted render the rows show.
      const styledHits: number[] = []
      const rawHits: number[] = []
      history.forEach((s, i) => {
        if (matches(rows, skip, rendered(s.content, s.filetype, s.conceal))) styledHits.push(i)
        if (matches(rows, skip, s.content.split("\n"))) rawHits.push(i)
      })
      // A streaming block that painted a highlight keeps painting one until a frame culls it (520's restore). Only a
      // state it may still show (the newest shown or a later one) can render blank.
      const styled = cur.filetype !== undefined && !cur.unstyled
      const blankState = [...styledHits, ...rawHits].some((i) => i >= shownIndex)
      if (blank && !blankState && painted && cur.streaming && styled)
        fail("no-blank", `${label}: blank after it painted a highlight, and no frame culled it since`)
      // A preview kept after unstyled text turned off is not a highlight: the next change may hide it.
      painted = !blank && styled && styledHits.length > 0 && !currentFailed() && !(cur.preview && !isCurrent(held))
      if (blank) return
      if (styledHits.length === 0 && rawHits.length === 0)
        fail("foreign", `${label}: rows ${JSON.stringify(rows)} (skip ${skip}) match no state of the block`)
      // Without streaming or unstyled text, the block shows nothing until each highlight completes (code.mdx).
      const keeps = isCurrent(held) && matches(rows, skip, heldRows())
      if (!cur.streaming && !cur.unstyled && !keeps && !styledHits.includes(current) && !rawHits.includes(current))
        fail("stale", `${label}: not streaming, but rows ${JSON.stringify(rows)} show an older state`)
      // A failed highlight of the current state falls back to its raw source.
      if (cur.filetype === "hide" && !cur.unstyled && styledHits.length === 0 && !currentFailed())
        fail("raw-markup", `${label}: drawUnstyledText false, but rows ${JSON.stringify(rows)} show raw source`)
      const shown = Math.max(...styledHits, ...rawHits)
      // Distinct states can render alike; compare the newest state each paint can be.
      if (shown < shownIndex) {
        const prevRows = rendered(
          history[shownIndex].content,
          history[shownIndex].filetype,
          history[shownIndex].conceal,
        )
        if (!matches(rows, skip, prevRows))
          fail(
            "monotonic",
            `${label}: rows ${JSON.stringify(rows)} are state ${shown}, after state ${shownIndex} was shown`,
          )
      }
      shownIndex = Math.max(shownIndex, shown)
      // Measured height equals the row count of some state the painted rows can be.
      const heights = new Set([
        ...styledHits.map((i) => rendered(history[i].content, history[i].filetype, history[i].conceal).length),
        ...rawHits.map((i) => history[i].content.split("\n").length),
      ])
      if (skip === 0 && !heights.has(block.height))
        fail("height", `${label}: paints ${JSON.stringify(rows)} (${[...heights]} rows) but measures ${block.height}`)
    }

    const step = async (c: Command, i: number) => {
      switch (c.op) {
        case "set":
        case "append": {
          const next = c.op === "set" ? c.text : state.content + c.text
          if (next === state.content) return
          state.content = next
          // Markdown gives a streamed block the preview of its new text first.
          if (state.preview) block.initialStyledText = preview()
          block.content = next
          push()
          // Only a streaming block that draws no unstyled text keeps its old buffer (the deleted streaming rows).
          // With unstyled text drawn, a preview stands for the source.
          const written = state.unstyled && state.preview ? preview().chunks[0].text : next
          if ((!state.streaming || state.unstyled) && block.plainText !== written)
            fail(
              "plain-text",
              `step ${i}: plainText ${JSON.stringify(block.plainText)}, want ${JSON.stringify(written)}`,
            )
          return
        }
        case "streaming":
          state.streaming = !state.streaming
          block.streaming = state.streaming
          push()
          return
        case "filetype":
          if (state.filetype === c.value) return
          state.filetype = c.value
          if (state.preview) block.initialStyledText = preview()
          block.filetype = c.value
          push()
          return
        case "conceal":
          state.conceal = !state.conceal
          if (state.preview) block.initialStyledText = preview()
          block.conceal = state.conceal
          push()
          return
        case "style":
          style ^= 1
          state.style = style
          block.syntaxStyle = styles[style]
          push()
          return
        // A preview of the current state, as Markdown gives a streamed block.
        case "preview":
          state.preview = (state.preview ?? 0) + 1
          // While streaming, a preview replaces a highlight on its way out (one a style change keeps for a request).
          if (state.streaming && state.unstyled && client.pending.length > 0) held = undefined
          block.initialStyledText = preview()
          // After a failure, a new preview shows: the newest input wins.
          if (currentFailed() && state.unstyled && state.content && block.plainText !== preview().chunks[0].text)
            fail("preview", `step ${i}: plainText ${JSON.stringify(block.plainText)} after a failure and a new preview`)
          push()
          return
        case "unstyled":
          state.unstyled = !state.unstyled
          block.drawUnstyledText = state.unstyled
          push()
          return
        case "scroll":
          box.scrollTo(c.into ? top() : 0)
          // An explicit scroll away counts as culling: a change after it measures the plain text at once (496).
          if (!c.into) painted = false
          return
        // An app's restore, asked after a change: it scrolls the block back in after the next frame's layout.
        case "restore":
          box.afterLayout(() => box.scrollTo(top()))
          return
        // OpenCode mounting older rows: they push the block down, out of view, and usually ask a restore, which
        // scrolls back or removes the rows again after the next frame's layout, or another box's callback removes them.
        case "push": {
          const rows = new BoxRenderable(renderer, { height: 2 * VIEW, flexShrink: 0 })
          box.insertBefore(rows, box.getChildren()[0])
          pushes++
          if (c.restore === "scroll") box.afterLayout(() => box.scrollTo(top()))
          const remover = c.restore === "remove" ? box : c.restore === "other" ? other : undefined
          remover?.afterLayout(() => {
            rows.destroy()
            pushes--
          })
          return
        }
        case "late":
          // A failure in the callback shows at the next checked frame.
          box.afterLayout(() => void step(c.inner, i).catch((error) => (late ??= error)))
          return
        case "remount":
          box.remove(block)
          box.insertBefore(block, box.getChildren()[ABOVE / 2 + pushes])
          // Until its next layout the scene reaches no moved block, so a change measures the plain text (496).
          painted = false
          return
        // A new block with the same state in its place (a tab switch): it paints once its own highlight lands.
        case "replace":
          block.destroy()
          block = create()
          painted = false
          box.insertBefore(block, box.getChildren()[ABOVE / 2 + pushes])
          return
        case "reply":
          if (client.pending.length) client.reply(c.index % client.pending.length)
          await tick()
          return
        case "fail":
          if (client.pending.length) {
            const tag = client.pending[c.index % client.pending.length].tag as typeof failed
            // A current failure ends the kept highlight: its fallback is the source, which a later change hides.
            if (tag?.block === block && tag.epoch === epoch) [failed, held, painted] = [tag, undefined, false]
            client.fail(c.index % client.pending.length, c.answer)
          }
          await tick()
          return
        case "frame":
          await renderOnce()
          check(`step ${i}`)
          return
        case "tick":
          await tick()
          return
      }
    }

    const warn = console.warn
    console.warn = () => {}
    try {
      let frame = renderer.frameId
      for (let i = 0; i < commands.length; i++) {
        trace?.push(show(commands[i]))
        await step(commands[i], i)
        if (renderer.frameId === frame) continue
        frame = renderer.frameId
        if (!renderer.nativeScene.reachesHooks(block)) painted = false
      }
      // Settle: scroll in, release every reply (oldest first), and render until nothing is pending.
      for (let pass = 0; pass < 8; pass++) {
        // A pending restore may still remove rows above.
        box.scrollTo(top())
        await renderOnce()
        // An afterLayout write can start a highlight on the next frame, not this one.
        if (pass > 0 && !client.pending.length && !block.isHighlighting && box.scrollTop === top()) break
        while (client.pending.length) client.reply(0)
        await tick()
      }
      box.scrollTo(top())
      await renderOnce()
      check("settled")
    } finally {
      console.warn = warn
    }

    // Every request settles.
    if (client.pending.length) fail("settles", `${client.pending.length} requests still pending`)
    if (block.isHighlighting) fail("settles", "isHighlighting is still true after every reply landed")

    const seen = visibleRows()
    const cur = state
    const want = cur.filetype ? rendered(cur.content, cur.filetype, cur.conceal) : cur.content.split("\n")
    const rows = seen?.rows ?? []
    const raw = cur.content.split("\n")
    // I6: the last current reply decides, a failure shows the source. A preview set after the failure stands for it while
    // unstyled text is drawn.
    const previewed =
      currentFailed() && cur.unstyled && cur.preview && matches(rows, 0, preview().chunks[0].text.split("\n"))
    const wantRows = previewed ? preview().chunks[0].text.split("\n") : currentFailed() ? raw : want
    const okRows = seen && seen.skip === 0 && matches(rows, 0, wantRows)
    if (!okRows)
      fail(
        "settled",
        `settled block paints ${JSON.stringify(rows)}, want ${JSON.stringify(wantRows)} (content ${JSON.stringify(cur.content)})`,
      )
    if (block.height !== wantRows.length)
      fail("settled-height", `settled block measures ${block.height}, paints ${wantRows.length} rows`)
    // Rows below the view too.
    if (block.plainText !== wantRows.join("\n"))
      fail(
        "settled",
        `settled plainText ${JSON.stringify(block.plainText)}, want ${JSON.stringify(wantRows.join("\n"))}`,
      )
  } finally {
    for (const child of renderer.root.getChildren()) child.destroyRecursively()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Runner and shrinker.

function startFor(seed: number): Start {
  const r = rng(seed ^ 0x5bd1e995)
  return {
    state: {
      content: text(r, 3),
      filetype: (["hide", "plain", undefined, "hide"] as const)[Math.floor(r() * 4)],
      conceal: r() < 0.8,
      unstyled: r() < 0.4,
      streaming: r() < 0.6,
    },
    scrolledIn: r() < 0.6,
  }
}

async function failureOf(start: Start, commands: Command[]): Promise<Failure | undefined> {
  try {
    await run(start, commands)
  } catch (e) {
    if (e instanceof Failure) return e
    return new Failure("throws", String((e as Error)?.stack ?? e))
  }
}

async function shrink(
  start: Start,
  commands: Command[],
  property: string,
): Promise<{ start: Start; commands: Command[] }> {
  const same = async (s: Start, cs: Command[]) => (await failureOf(s, cs))?.property === property
  let best = await removeChunks(commands, (candidate) => same(start, candidate))
  // Shorten texts.
  for (let i = 0; i < best.length; i++) {
    const c = best[i]
    if (c.op !== "set" && c.op !== "append") continue
    for (let n = 1; n < c.text.length; n++) {
      const candidate = [...best]
      candidate[i] = { ...c, text: c.text.slice(0, n) }
      if (await same(start, candidate)) {
        best = candidate
        break
      }
    }
  }
  // Simplify the start state.
  let s = start
  for (const patch of [
    { scrolledIn: true },
    { state: { ...s.state, streaming: false } },
    { state: { ...s.state, unstyled: false } },
    { state: { ...s.state, conceal: true } },
  ] as Partial<Start>[]) {
    const candidate = { ...s, ...patch, state: { ...s.state, ...(patch.state ?? {}) } }
    if (await same(candidate, best)) s = candidate
  }
  return { start: s, commands: best }
}

// Short sequences that random seeds reach rarely, each a review finding or a mutation the seeds missed.
const plainStart = (content: string, streaming = true): Start => ({
  state: { content, filetype: "hide", conceal: true, unstyled: false, streaming },
  scrolledIn: true,
})
const highlighted: Command[] = [{ op: "frame" }, { op: "reply", index: 0 }, { op: "frame" }]
const SCRIPTS: [string, Start, Command[]][] = [
  // A restore that removes the rows it mounted above: the check must see the layout the frame paints.
  [
    "restore by removing rows",
    plainStart("#h\nTitle"),
    [...highlighted, { op: "set", text: "#h\nNew" }, { op: "push", restore: "remove" }, { op: "frame" }],
  ],
  [
    "restore from another box",
    plainStart("#h\nTitle"),
    [...highlighted, { op: "set", text: "#h\nNew" }, { op: "push", restore: "other" }, { op: "frame" }],
  ],
  // A blank that only a superseded state renders is not allowed.
  [
    "kept over a blank older state",
    plainStart("#hidden"),
    [
      ...highlighted,
      { op: "set", text: "*now*" },
      ...highlighted,
      { op: "set", text: "*next*" },
      { op: "push", restore: "scroll" },
      { op: "frame" },
    ],
  ],
  // A current failure ends the kept highlight; the change after it hides the fallback source.
  [
    "failure ends the kept highlight",
    plainStart("xab"),
    [
      ...highlighted,
      { op: "set", text: "a" },
      { op: "frame" },
      { op: "fail", index: 0, answer: false },
      { op: "conceal" },
      { op: "frame" },
    ],
  ],
  // A worker that answers with an error is a failure: the next change hides the source.
  [
    "error answer, then unstyled off",
    { ...plainStart("x*"), state: { ...plainStart("x*").state, unstyled: true } },
    [
      { op: "frame" },
      { op: "fail", index: 0, answer: true },
      { op: "unstyled" },
      { op: "append", text: "*" },
      { op: "frame" },
    ],
  ],
  // drawUnstyledText turned off after the frame's update hooks hides the source in that frame.
  [
    "late unstyled off",
    { ...plainStart("x*"), state: { ...plainStart("x*").state, unstyled: true } },
    [{ op: "frame" }, { op: "late", inner: { op: "unstyled" } }, { op: "frame" }],
  ],
  // The view shows six rows that the source and the highlight share; the fallback's last line is the source's.
  [
    "failure below the view",
    plainStart("a\nb\nc\nd\ne\nf\n*last*"),
    [{ op: "frame" }, { op: "fail", index: 0, answer: false }, { op: "frame" }],
  ],
  // A retry of the same input after a failure lands: the block shows the highlight again.
  [
    "failed, then retried",
    { ...plainStart("*SENTINEL*", false), state: { ...plainStart("*SENTINEL*", false).state, unstyled: true } },
    [
      { op: "frame" },
      { op: "fail", index: 0, answer: false },
      { op: "streaming" },
      { op: "frame" },
      { op: "reply", index: 0 },
      { op: "frame" },
    ],
  ],
  // A failed highlight of a block that shows a preview, without a chunk callback, falls back to its source.
  [
    "failure with a preview",
    { ...plainStart("#h\n*x*"), state: { ...plainStart("#h\n*x*").state, unstyled: true } },
    [{ op: "preview" }, { op: "frame" }, { op: "fail", index: 0, answer: true }, { op: "frame" }],
  ],
  // A painted preview stays when unstyled text turns off; a new preview that cannot show replaces it with the source,
  // which does not paint.
  [
    "a preview after unstyled text turned off",
    plainStart("\n#"),
    [
      { op: "unstyled" },
      { op: "preview" },
      { op: "frame" },
      { op: "unstyled" },
      { op: "frame" },
      { op: "preview" },
      { op: "frame" },
    ],
  ],
  // Only the last current reply's failure allows the source when settled.
  [
    "failed first, highlighted last",
    { ...plainStart("*SENTINEL*", false), state: { ...plainStart("*SENTINEL*", false).state, unstyled: true } },
    [{ op: "frame" }, { op: "fail", index: 0, answer: false }, { op: "append", text: "!" }, { op: "frame" }],
  ],
  // A change after rows mounted above and a scroll back, before any layout: only the frame's layout says it shows.
  [
    "change before the layout of a push and a scroll back",
    plainStart("#h\nTitle"),
    [...highlighted, { op: "push" }, { op: "scroll", into: true }, { op: "set", text: "#h\nNew" }, { op: "frame" }],
  ],
  // A change in a callback to a block that frame culls: the frame after it measures the new text.
  [
    "late change while culled",
    plainStart("#h\nTitle"),
    [
      ...highlighted,
      { op: "late", inner: { op: "append", text: "\n*\n*" } },
      { op: "scroll", into: false },
      { op: "frame" },
      { op: "frame" },
    ],
  ],
  // A change in a callback while rows mounted above push the block out, and another box's callback removes them: the
  // frame's layout is not settled until its checks, so the block keeps its highlight.
  [
    "late change while pushed out and brought back",
    plainStart("#h\nTitle"),
    [
      ...highlighted,
      { op: "push", restore: "other" },
      { op: "late", inner: { op: "append", text: "\nx" } },
      { op: "frame" },
    ],
  ],
  // A preview changes what shows while a highlight runs, not the highlight: a culled block that holds its current
  // highlight keeps it, and its height, through a conceal change until the next reply.
  [
    "preview, then conceal on a culled block",
    { ...plainStart("\n#"), state: { ...plainStart("\n#").state, conceal: false } },
    [
      { op: "preview" },
      { op: "append", text: "\n" },
      { op: "frame" },
      { op: "scroll", into: false },
      { op: "reply", index: 0 },
      { op: "conceal" },
      { op: "frame" },
    ],
  ],
  // A current highlight, culled before its check runs, stays (a check that rewrote it would leave it blank for good).
  [
    "current highlight culled",
    plainStart("#h\nTitle"),
    [
      ...highlighted,
      { op: "set", text: "#h\nNext" },
      { op: "frame" },
      { op: "reply", index: 0 },
      { op: "scroll", into: false },
      { op: "frame" },
      { op: "scroll", into: true },
      { op: "frame" },
    ],
  ],
]

const SEEDS = Number(process.env.MODEL_SEEDS ?? 2000)
const STEPS = Number(process.env.MODEL_STEPS ?? 80)
const ONE = process.env.MODEL_SEED

test(
  "Code highlight lifecycle follows the reference model",
  async () => {
    // MODEL_SCRIPT='{"start":{...},"commands":[...]}' runs one hand-written sequence and prints its trace.
    if (process.env.MODEL_SCRIPT) {
      const script = JSON.parse(process.env.MODEL_SCRIPT) as { start: Start; commands: Command[] }
      const trace: string[] = []
      const failure = await run(script.start, script.commands, trace).then(
        () => undefined,
        (e) => e as Error,
      )
      console.log(trace.join("\n"), "\n=>", failure?.message ?? "pass")
      expect(failure?.message ?? "pass").toBe("pass")
      return
    }
    const scripts = ONE === undefined ? SCRIPTS : []
    const failures: string[] = []
    for (const [name, start, commands] of scripts) {
      const failure = await failureOf(start, commands)
      if (failure) failures.push(`${name}: ${failure.message}`)
    }
    expect(failures).toEqual([])
    const seeds = ONE !== undefined ? [Number(ONE)] : Array.from({ length: SEEDS }, (_, i) => i)
    const found = new Map<string, { seed: number; start: Start; commands: Command[]; message: string }>()
    for (const seed of seeds) {
      const start = startFor(seed)
      const commands = generate(seed, STEPS)
      const failure = await failureOf(start, commands)
      if (ONE !== undefined) {
        const trace: string[] = []
        await run(start, commands, trace).catch(() => {})
        console.log(JSON.stringify(start), "\n" + trace.join("\n"))
      }
      if (!failure || found.has(failure.property)) continue
      const small =
        process.env.MODEL_SHRINK === "0" ? { start, commands } : await shrink(start, commands, failure.property)
      const again = await failureOf(small.start, small.commands)
      found.set(failure.property, { seed, ...small, message: again?.message ?? failure.message })
    }
    for (const [property, f] of found) {
      console.log(`\n== ${property} (seed ${f.seed})\nstart ${JSON.stringify(f.start)}`)
      for (const c of f.commands) console.log("  " + show(c))
      console.log(f.message)
    }
    expect([...found.keys()]).toEqual([])
  },
  { timeout: 120_000 },
)
