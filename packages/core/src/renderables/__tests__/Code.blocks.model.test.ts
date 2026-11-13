// Model-based test of several highlighted Code blocks in one ScrollBox: when each block may discard its highlight.
//
// Environment: as Code.model.test.ts (MODEL_SEEDS, here default 1000, MODEL_STEPS, MODEL_SEED, MODEL_SHRINK,
// MODEL_SKIP, MODEL_SCRIPT, MODEL_DEBUG), and MODEL_SCRIPTS=0 skips the fixed sequences.
//
// A seed picks 2 to 5 streaming blocks without unstyled text (OpenCode's shape), a box at the top or inside an outer
// ScrollBox, and a command sequence: turns that change several blocks and the rows between them in one tick, in any
// order, some with an afterLayout growth hold; scrolls; anchoring a row in view; hiding and showing the box; worker
// replies and failures per block; frames. Every command runs on two twins; the second runs each turn's changes in
// reverse order. After each frame both must paint the same screen, and both are checked against the model: a block
// painted in two frames in a row never goes blank, paints only a highlight of one of its states (or its source after a
// failure), measures what it paints, measures its current text when culled; a growth hold reads the painted height and
// its scroll takes effect; the rows in view stay without input while an anchored row is in view; and the frame stays
// within a fixed number of layout rounds. Settled, every block paints the highlight of its current text.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { CodeRenderable } from "../Code.js"
import { BoxRenderable } from "../Box.js"
import { ScrollBoxRenderable } from "../ScrollBox.js"
import { TextRenderable } from "../Text.js"
import { SyntaxStyle } from "../../syntax-style.js"
import { createTestRenderer } from "../../testing/test-renderer.js"
import { ManualClock } from "../../testing/manual-clock.js"
import { Failure, ModelClient, fail, removeChunks, rendered, rng, text, tick } from "./code-model-harness.js"

type Op =
  | { op: "set"; block: number; text: string }
  | { op: "append"; block: number; text: string }
  | { op: "insert"; id: number; before: number; rows: number }
  | { op: "remove"; id: number }
  | { op: "resize"; id: number; rows: number }

type Command =
  | { op: "turn"; ops: Op[]; hold: boolean }
  | { op: "scroll"; to: number; y?: number }
  | { op: "toggle" }
  | { op: "reply"; block: number }
  | { op: "fail"; block: number; answer: boolean }
  | { op: "anchor" }
  | { op: "frame" }
  | { op: "tick" }

interface Start {
  sources: string[]
  // The box sits in an outer ScrollBox.
  nested?: boolean
}

const VIEW = 6
const EDGE = 15
// A frame needs one layout round, one more after afterLayout callbacks change layout, and one after a block's own
// change; more means work that grows with the number of blocks.
const ROUNDS_MAX = 3

const marker = (block: number) => `#b${block}\n`

function generate(seed: number, steps: number, blocks: number): Command[] {
  const r = rng(seed)
  const out: Command[] = []
  let spacers = 0
  let alive: number[] = []
  for (let i = 0; i < steps; i++) {
    const k = r()
    if (k < 0.3) {
      const ops: Op[] = []
      const fresh: number[] = []
      // A turn writes each block at most once: two writes to one block depend on their order by definition.
      const written = new Set<number>()
      // Two rows inserted before one block depend on their order too.
      const before = new Set<number>()
      for (let j = 1 + Math.floor(r() * 4); j > 0; j--) {
        const kind = r()
        const block = Math.floor(r() * blocks)
        const writes = !written.has(block) && kind < 0.6
        if (writes) written.add(block)
        if (writes && kind < 0.35) ops.push({ op: "set", block, text: text(r, 4) })
        else if (writes) ops.push({ op: "append", block, text: text(r, 2) })
        else if (kind < 0.8 || alive.length === 0) {
          if (before.has(block)) continue
          before.add(block)
          ops.push({ op: "insert", id: spacers, before: block, rows: 1 + Math.floor(r() * 12) })
          fresh.push(spacers++)
        } else {
          const id = alive[Math.floor(r() * alive.length)]
          // Each row once per turn, as each block.
          alive = alive.filter((other) => other !== id)
          if (kind < 0.9) {
            ops.push({ op: "remove", id })
          } else {
            ops.push({ op: "resize", id, rows: Math.floor(r() * 12) })
            fresh.push(id)
          }
        }
      }
      alive.push(...fresh)
      out.push({ op: "turn", ops, hold: r() < 0.3 })
    } else if (k < 0.45) out.push({ op: "scroll", to: r() })
    else if (k < 0.48) out.push({ op: "toggle" })
    else if (k < 0.62) out.push({ op: "reply", block: Math.floor(r() * blocks) })
    else if (k < 0.65) out.push({ op: "fail", block: Math.floor(r() * blocks), answer: r() < 0.5 })
    else if (k < 0.68) out.push({ op: "anchor" })
    else if (k < 0.92) out.push({ op: "frame" })
    else out.push({ op: "tick" })
  }
  return out
}

function startFor(seed: number): Start {
  const r = rng(seed ^ 0x5bd1e995)
  return {
    sources: Array.from({ length: 2 + (seed % 4) }, (_, i) => marker(i) + text(r, 3)),
    nested: Math.floor(seed / 4) % 2 === 1,
  }
}

function show(c: Command): string {
  if (c.op !== "turn") return Object.values(c).join(" ")
  const ops = c.ops.map((o) =>
    Object.values(o)
      .map((v) => (typeof v === "string" ? JSON.stringify(v) : v))
      .join(" "),
  )
  return `turn${c.hold ? " (hold)" : ""}: ${ops.join("; ")}`
}

interface Tag {
  block: CodeRenderable
  epoch: number
}

async function fixture(nested: boolean) {
  const { renderer, renderOnce, captureCharFrame, dispose } = await createTestRenderer({
    width: 30,
    height: 10,
    clock: new ManualClock(),
  })
  const syntaxStyle = SyntaxStyle.create(renderer.nativeScene)
  const box = new ScrollBoxRenderable(renderer, { width: 30, height: VIEW, flexShrink: 0 })
  if (nested) {
    const outer = new ScrollBoxRenderable(renderer, { width: 30, height: VIEW + 2 })
    renderer.root.add(outer)
    outer.add(new TextRenderable(renderer, { content: "outer", flexShrink: 0 }))
    outer.add(box)
  } else renderer.root.add(box)
  // The scene culls only parents with at least 16 children.
  for (const prefix of ["a", "z"]) {
    for (let i = 0; i < EDGE; i++) box.add(new TextRenderable(renderer, { content: `${prefix}${i}`, flexShrink: 0 }))
  }
  const errors: unknown[] = []
  renderer.on("render:error", (error) => errors.push(error))
  const close = async () => {
    await dispose()
    syntaxStyle.destroy()
  }
  return { renderer, box, renderOnce, captureCharFrame, syntaxStyle, errors, close, tail: box.getChildren()[EDGE] }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
let fixtures: Fixture[][]
beforeAll(async () => {
  fixtures = []
  for (const nested of [false, true]) fixtures.push([await fixture(nested), await fixture(nested)])
})
afterAll(async () => {
  for (const f of fixtures.flat()) await f.close()
})

function world(start: Start, reversed: boolean, f: Fixture) {
  const { renderer, box, renderOnce, captureCharFrame, syntaxStyle, errors, tail } = f
  const client = new ModelClient()
  box.scrollTo(0)
  const options = { filetype: "hide", syntaxStyle, streaming: true, drawUnstyledText: false, treeSitterClient: client }
  const code = start.sources.map(
    (content) => new CodeRenderable(renderer, { ...options, content, width: "100%", flexShrink: 0 }),
  )
  for (const block of code) box.insertBefore(block, tail)
  const spacers = new Map<number, BoxRenderable>()

  // Per block: every content it has had, the render epoch, and the last current reply (failed or held).
  const model = start.sources.map((content) => ({
    content,
    history: [content],
    epoch: 0,
    failed: undefined as Tag | undefined,
    held: undefined as Tag | undefined,
    painted: false,
    visible: false,
    // The newest state whose highlight it painted.
    shown: 0,
  }))
  const indexOf = (content: string) => Number(content.slice(2, content.indexOf("\n")))
  const isCurrent = (i: number, tag: Tag | undefined) => tag?.block === code[i] && tag.epoch === model[i].epoch
  client.tag = (content) => ({ block: code[indexOf(content)], epoch: model[indexOf(content)].epoch })
  client.answered = (tag) => {
    const i = code.indexOf((tag as Tag).block)
    if (!isCurrent(i, tag as Tag)) return
    model[i].failed = undefined
    model[i].held = tag as Tag
  }
  let holdRead: number | undefined
  let holdWant: number | undefined
  // Input or a worker reply since the last checked frame, and the rows in view then.
  let input = true
  let lastView: string[] | undefined
  let release: (() => void) | undefined
  let anchored: BoxRenderable | TextRenderable | undefined
  let anchorWasInView = false
  let scrolled = false

  const apply = (o: Op) => {
    if (o.op === "set" || o.op === "append") {
      const m = model[o.block]
      const next = o.op === "set" ? marker(o.block) + o.text : m.content + o.text
      if (next === m.content) return
      m.content = next
      m.history.push(next)
      m.epoch++
      code[o.block].content = next
    } else if (o.op === "insert") {
      const spacer = new BoxRenderable(renderer, { height: o.rows, flexShrink: 0 })
      spacers.set(o.id, spacer)
      box.insertBefore(spacer, code[o.before])
    } else if (o.op === "remove") {
      spacers.get(o.id)?.destroy()
      spacers.delete(o.id)
    } else {
      const spacer = spacers.get(o.id)
      if (spacer) spacer.height = o.rows
    }
  }

  const visibleRows = (block: CodeRenderable, lines: string[]) => {
    const top = box.viewport.y
    const v0 = Math.max(top, block.y)
    const v1 = Math.min(top + VIEW, block.y + block.height)
    if (!box.visible || v1 <= v0) return undefined
    const rows: string[] = []
    for (let y = v0; y < v1; y++) rows.push((lines[y] ?? "").slice(block.x, block.x + block.width).trimEnd())
    return { rows, skip: v0 - block.y }
  }
  const matches = (rows: string[], skip: number, want: string[]) =>
    rows.every((row, i) => row === (want[i + skip] ?? "").trimEnd())
  const check = (label: string) => {
    const frame = captureCharFrame()
    const lines = frame.split("\n")
    if (errors.length) fail("bounded", `${label}: ${(errors[0] as Error)?.message ?? String(errors[0])}`)
    const rounds = renderer.getNativeStats().frameWork.layoutRounds
    if (rounds > ROUNDS_MAX) fail("bounded", `${label}: ${rounds} layout rounds`)
    // A block the previous frame painted and this one culls may keep its old height for this frame.
    let pushedOut = false
    code.forEach((block, i) => {
      const m = model[i]
      const seen = visibleRows(block, lines)
      if (process.env.MODEL_DEBUG)
        console.log(
          `  [${label}] b${i} y ${block.y} h ${block.height} view ${box.viewport.y} rows ${JSON.stringify(seen?.rows)}`,
        )
      if (!seen) {
        if (m.visible) pushedOut = true
        if (box.visible && !renderer.nativeScene.reachesHooks(block)) {
          const styled = rendered(m.content, "hide", true).length
          const ok = isCurrent(i, m.held) ? [styled] : [m.content.split("\n").length, styled]
          if (m.visible) ok.push(...m.history.map((c) => rendered(c, "hide", true).length))
          if (!ok.includes(block.height))
            fail("culled-height", `${label}: culled b${i} measures ${block.height}, current text has ${ok} rows`)
        }
        m.painted = m.visible = false
        return
      }
      const { rows, skip } = seen
      const blank = rows.every((row) => row === "")
      const hits = m.history.flatMap((c, at) => (matches(rows, skip, rendered(c, "hide", true)) ? [at] : []))
      const styledHits = hits.map((at) => m.history[at])
      const rawHit = matches(rows, skip, m.content.split("\n"))
      // Blank rows are drawn text when a highlight of a state it may still show is blank there.
      if (blank && m.painted && !hits.some((at) => at >= m.shown))
        fail("no-blank", `${label}: b${i} painted in the frame before, blank now`)
      const failed = isCurrent(i, m.failed)
      m.painted = !blank && !failed
      m.visible = true
      if (blank) return
      if (hits.length) m.shown = Math.max(m.shown, ...hits)
      if (styledHits.length === 0 && !(failed && rawHit))
        fail("foreign", `${label}: b${i} paints ${JSON.stringify(rows)}, no highlight of its states`)
      const heights = [
        ...styledHits.map((c) => rendered(c, "hide", true).length),
        ...(failed && rawHit ? [m.content.split("\n").length] : []),
      ]
      if (skip === 0 && !heights.includes(block.height))
        fail("height", `${label}: b${i} paints ${JSON.stringify(rows)} but measures ${block.height}`)
    })
    if (holdRead !== undefined && holdRead !== box.scrollHeight && !pushedOut)
      fail("hold", `${label}: the growth hold read scrollHeight ${holdRead}, the frame paints ${box.scrollHeight}`)
    // The hold's scroll took effect (within the range the frame paints).
    const max = Math.max(0, box.scrollHeight - VIEW)
    if (holdWant !== undefined && !release && box.scrollTop !== Math.min(max, Math.max(0, holdWant)))
      fail("hold", `${label}: the growth hold scrolled to ${holdWant}, the view is at ${box.scrollTop}`)
    holdRead = holdWant = undefined
    scrolled = false
    // Without input or a reply, the rows around an anchored row in view stay. Without an anchor, a block that the frame
    // before painted and pushed above the view moves them in the next frame (code.mdx).
    const { x, y, width } = box.viewport
    const rows = box.visible ? lines.slice(y, y + VIEW).map((row) => row.slice(x, x + width)) : []
    const top = box.viewport.y
    const anchorInView = !!anchored && !anchored.isDestroyed && anchored.y >= top && anchored.y < top + VIEW
    const still = anchorInView && anchorWasInView
    anchorWasInView = anchorInView
    if (still && !input && lastView && rows.join("\n") !== lastView.join("\n"))
      fail(
        "still",
        `${label}: no input since the last frame, rows ${JSON.stringify(lastView)} -> ${JSON.stringify(rows)}`,
      )
    lastView = rows
    input = false
    return frame
  }

  // A scroll may end an anchor (at the end of the content); the model ends it at every scroll.
  const unanchor = () => {
    release?.()
    release = anchored = undefined
  }

  const step = async (c: Command, i: number) => {
    if (c.op !== "frame" && c.op !== "tick") input = true
    if (c.op === "scroll") unanchor()
    switch (c.op) {
      case "turn": {
        const before = box.scrollHeight
        for (const o of reversed ? [...c.ops].reverse() : c.ops) apply(o)
        if (c.hold)
          box.afterLayout(() => {
            unanchor()
            holdRead = box.scrollHeight
            if (!scrolled) holdWant = box.scrollTop + box.scrollHeight - before
            box.scrollBy(box.scrollHeight - before)
          })
        return
      }
      // Anchors the first row in view that is not a block, or releases the anchor.
      case "anchor": {
        if (release) return unanchor()
        const top = box.viewport.y
        anchored = box
          .getChildren()
          .find((child) => !(child instanceof CodeRenderable) && child.y >= top && child.y < top + VIEW) as
          | BoxRenderable
          | TextRenderable
          | undefined
        if (anchored) release = box.anchor(anchored)
        return
      }
      case "scroll":
        // A later scroll replaces the hold's.
        holdWant = undefined
        scrolled = true
        box.scrollTo(c.y ?? Math.round(c.to * Math.max(0, box.scrollHeight - VIEW)))
        return
      case "toggle":
        box.visible = !box.visible
        return
      case "reply": {
        const at = client.pending.findIndex((p) => p.content.startsWith(marker(c.block)))
        if (at >= 0) client.reply(at)
        await tick()
        return
      }
      case "fail": {
        const at = client.pending.findIndex((p) => p.content.startsWith(marker(c.block)))
        if (at >= 0) {
          const tag = client.pending[at].tag as Tag
          // A current failure ends the kept highlight: its fallback is the source, which a later change hides.
          if (isCurrent(c.block, tag))
            [model[c.block].failed, model[c.block].held, model[c.block].painted] = [tag, undefined, false]
          client.fail(at, c.answer)
        }
        await tick()
        return
      }
      case "frame":
        await renderOnce()
        return check(`step ${i}`)
      case "tick":
        await tick()
        return
    }
  }

  // Scroll again after layout or a reply moves the block. Stop when the frame needs neither.
  const scrollAndHighlight = async (block: CodeRenderable, passes: number) => {
    for (let pass = 0; pass < passes; pass++) {
      box.scrollTo(block.y - box.viewport.y + box.scrollTop)
      await renderOnce()
      if (!client.pending.length && block.y === box.viewport.y) break
      while (client.pending.length) client.reply(0)
      await tick()
    }
  }

  // Each block in view in turn, every reply released: it settles on the highlight of its current text.
  const settle = async () => {
    release?.()
    box.visible = true
    for (let i = 0; i < code.length; i++) {
      const block = code[i]
      await scrollAndHighlight(block, 6)
      box.scrollTo(block.y - box.viewport.y + box.scrollTop)
      await renderOnce()
      const m = model[i]
      // The last current reply decides; a failure leaves the source.
      const want = isCurrent(i, m.failed) ? m.content.split("\n") : rendered(m.content, "hide", true)
      if (block.plainText !== want.join("\n"))
        fail("settled", `b${i} settles on ${JSON.stringify(block.plainText)}, want ${JSON.stringify(want.join("\n"))}`)
      if (block.height !== want.length) fail("settled", `b${i} measures ${block.height}, want ${want.length}`)
      const seen = visibleRows(block, captureCharFrame().split("\n"))
      if (want.join("") !== "" && (!seen || !matches(seen.rows, seen.skip, want)))
        fail("settled", `b${i} paints ${JSON.stringify(seen?.rows)}, want ${JSON.stringify(want)}`)
    }
  }

  const close = () => {
    for (const child of [...code, ...spacers.values()]) child.destroy()
  }

  // Highlight every block first, so the commands start from painted highlights.
  const ready = async () => {
    for (const block of code) await scrollAndHighlight(block, 3)
    box.scrollTo(EDGE)
    await renderOnce()
    check("start")
    if (code.length && code[0].y !== box.viewport.y)
      fail("start", "the first block does not start at the top of the viewport")
  }

  return { step, settle, close, ready }
}

async function run(start: Start, commands: Command[], trace?: string[]): Promise<void> {
  const warn = console.warn
  console.warn = () => {}
  const pair = fixtures[start.nested ? 1 : 0]
  try {
    const twins = pair.map((f, i) => world(start, i === 1, f))
    for (const twin of twins) await twin.ready()
    for (let i = 0; i < commands.length; i++) {
      trace?.push(show(commands[i]))
      const frame = await twins[0].step(commands[i], i)
      if ((await twins[1].step(commands[i], i)) !== frame)
        fail("order", `step ${i}: the frame differs when the turn's changes run in reverse order`)
    }
    for (const twin of twins) await twin.settle()
    for (const twin of twins) twin.close()
  } catch (error) {
    // A failed trace may leave afterLayout callbacks on the box. Replay the shrinker on clean fixtures.
    for (const [i, f] of pair.entries()) {
      await f.close()
      pair[i] = await fixture(!!start.nested)
    }
    throw error
  } finally {
    console.warn = warn
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

async function shrink(start: Start, commands: Command[], property: string): Promise<Command[]> {
  const same = async (cs: Command[]) => (await failureOf(start, cs))?.property === property
  let best = await removeChunks(commands, same)
  // Drop single changes from turns.
  for (let i = 0; i < best.length; i++) {
    const c = best[i]
    if (c.op !== "turn") continue
    for (let j = 0; j < c.ops.length && c.ops.length > 1; ) {
      const candidate = [...best]
      candidate[i] = { ...c, ops: c.ops.filter((_, k) => k !== j) }
      if (await same(candidate)) {
        best = candidate
        c.ops = (candidate[i] as typeof c).ops
      } else j++
    }
  }
  return best
}

// Short sequences the seeds may reach rarely.
const lines = (count: number) => Array.from({ length: count }, (_, i) => `a${i + 1}`).join("\n")
const SCRIPTS: [string, Start, Command[]][] = [
  // A block in view keeps its rows while the block above it shrinks out of view and rows mount above it (the twin runs
  // the changes in reverse order).
  [
    "two blocks, either order",
    { sources: [marker(0) + lines(16), marker(1) + "B"] },
    [
      { op: "scroll", to: 0, y: 31 },
      { op: "frame" },
      {
        op: "turn",
        hold: false,
        ops: [
          { op: "insert", id: 0, before: 1, rows: 15 },
          { op: "set", block: 1, text: "B\n1\n2\n3\n4" },
          { op: "set", block: 0, text: "a" },
        ],
      },
      { op: "frame" },
      { op: "frame" },
    ],
  ],
  // Four blocks shrink out of view above a fifth: the frame stays within its layout rounds.
  [
    "five blocks",
    { sources: [0, 1, 2, 3].map((i) => marker(i) + lines(16)).concat(marker(4) + "B") },
    [
      { op: "scroll", to: 0, y: 79 },
      { op: "frame" },
      {
        op: "turn",
        hold: false,
        ops: [
          { op: "insert", id: 0, before: 4, rows: 60 },
          ...[0, 1, 2, 3].map((block) => ({ op: "set" as const, block, text: "a" })),
          { op: "set", block: 4, text: "B\n1\n2\n3\n4" },
        ],
      },
      { op: "frame" },
      { op: "frame" },
    ],
  ],
]

const SEEDS = Number(process.env.MODEL_SEEDS ?? 1000)
const STEPS = Number(process.env.MODEL_STEPS ?? 80)
const ONE = process.env.MODEL_SEED

test(
  "Code blocks in one ScrollBox follow the reference model",
  async () => {
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
    const failures: string[] = []
    // MODEL_SCRIPTS=0 skips the fixed sequences, to look at the seeds behind a known failure.
    for (const [name, start, commands] of ONE === undefined && process.env.MODEL_SCRIPTS !== "0" ? SCRIPTS : []) {
      const failure = await failureOf(start, commands)
      if (failure) failures.push(`${name}: ${failure.message}`)
    }
    expect(failures).toEqual([])
    const seeds = ONE !== undefined ? [Number(ONE)] : Array.from({ length: SEEDS }, (_, i) => i)
    const found = new Map<string, { seed: number; start: Start; commands: Command[]; message: string }>()
    for (const seed of seeds) {
      const start = startFor(seed)
      const commands = generate(seed, STEPS, start.sources.length)
      if (ONE !== undefined) {
        const trace: string[] = []
        await run(start, commands, trace).catch(() => {})
        console.log(JSON.stringify(start), "\n" + trace.join("\n"))
      }
      const failure = await failureOf(start, commands)
      if (!failure || found.has(failure.property)) continue
      const small = process.env.MODEL_SHRINK === "0" ? commands : await shrink(start, commands, failure.property)
      const again = await failureOf(start, small)
      found.set(failure.property, { seed, start, commands: small, message: again?.message ?? failure.message })
    }
    for (const [property, f] of found) {
      console.log(`\n== ${property} (seed ${f.seed})\nstart ${JSON.stringify(f.start)}`)
      for (const c of f.commands) console.log("  " + show(c))
      console.log(f.message)
    }
    expect([...found.keys()]).toEqual([])
  },
  { timeout: 600_000 },
)
