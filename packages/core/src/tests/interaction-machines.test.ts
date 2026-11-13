import { test } from "bun:test"
import assert from "node:assert/strict"
import { BoxRenderable } from "../renderables/Box.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { TextRenderable } from "../renderables/Text.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { RecordingWriteStream } from "../testing/test-streams.js"
import { NativeSessionTerminalPhase } from "../zig.js"
import vectors from "./fixtures/interaction-machines.json" with { type: "json" }

type Xfail = [binding: string, record: string, symptom: string, paths?: string][]
interface Machine {
  initial: string
  states: Record<string, [string, Record<string, string>]>
  xfail: Xfail
}
type Fault = "pointer" | "selection" | "consumed" | "arrow" | "edge" | "policy"
const corpus = vectors as unknown as {
  depth: number
  seeds: number
  steps: number
  machines: Record<string, Machine>
  faults: Record<Fault | "release", { cycles: string[]; xfail: Xfail }>
}

// Known failures stay exact: the same symptom (on the same paths) must recur. OTUI_FSM_STRICT=1, or a
// record number, reports them again.
function expectedFailures(rows: Xfail) {
  const strict = process.env.OTUI_FSM_STRICT
  const known = new Set<string>(),
    seen = new Set<string>()
  for (const [binding, record, symptom, paths] of rows)
    if (binding === "core" && strict !== "1" && strict !== record)
      for (const key of paths ? paths.split(" ").map((path) => `${path} ${symptom}`) : [symptom]) known.add(key)
  return {
    has: (key: string) => known.has(key) && !!seen.add(key),
    check: () =>
      assert.deepEqual(
        [...known].filter((key) => !seen.has(key)),
        [],
        "expected failure disappeared",
      ),
  }
}

// Remove chunks, largest first, while the same failure remains.
async function shrink<T>(path: T[], fails: (candidate: T[]) => Promise<boolean>) {
  for (let size = path.length; size >= 1; size--)
    for (let i = path.length - size; i >= 0; i--) {
      const candidate = [...path.slice(0, i), ...path.slice(i + size)]
      if (await fails(candidate)) path = candidate
    }
  return path
}

function selection(r: TestRendererSetup, clock: ManualClock) {
  const { renderer, mockMouse } = r
  const text = new TextRenderable(renderer, { id: "text", content: "abc", height: 1 })
  renderer.root.add(text)
  return async (op: string) => {
    // Isolate gestures, but not the three presses within a line gesture.
    clock.advance(600)
    if (op === "press") await mockMouse.pressDown(0, 0)
    else if (op === "extend") await mockMouse.moveTo(1, 0)
    else if (op === "release") await mockMouse.release(1, 0)
    else if (op === "line") {
      for (let i = 0; i < 3; i++) {
        await mockMouse.pressDown(0, 0)
        await mockMouse.release(0, 0)
      }
    } else if (op === "drag") {
      await mockMouse.pressDown(0, 0)
      await mockMouse.moveTo(1, 0)
      await mockMouse.release(1, 0)
    } else if (op === "clear") renderer.clearSelection()
    else if (op === "replace") text.content = "abcd"
    else if (op === "disable" || op === "enable") text.selectable = op === "enable"
    else assert.equal(op, "mount")
    await r.renderOnce()
    return `${text.getSelectedText()}/${renderer.getSelection()?.getSelectedText() ?? ""}`
  }
}

function editor(r: TestRendererSetup, kind: string) {
  const { renderer } = r
  const group = new BoxRenderable(renderer, { id: "group", height: 1 })
  const a = new TextareaRenderable(renderer, { id: "A", height: 1 })
  group.add(a)
  renderer.root.add(group)
  const b = new TextareaRenderable(renderer, { id: "B", height: 1 })
  renderer.root.add(b)
  const reset = () => {
    a.setText("ab")
    a.cursorOffset = 2 // The raw whole-document setters specify different cursor positions.
  }
  if (kind === "textarea") {
    a.focus()
    reset()
  }
  return async (op: string) => {
    switch (op) {
      case "a":
      case "focus":
        a.focus()
        break
      case "b":
        b.focus()
        break
      case "blur":
        renderer.currentFocusedRenderable?.blur()
        break
      case "hideGroup":
      case "showGroup":
        group.visible = op === "showGroup"
        break
      case "disableA":
      case "enableA":
        a.focusable = op === "enableA"
        break
      case "hide":
      case "show":
        a.showCursor = op === "show"
        break
      case "line":
      case "block":
        a.cursorStyle = { style: op, blinking: op === "block" }
        break
      case "left":
      case "shiftLeft":
        r.mockInput.pressArrow("left", { shift: op === "shiftLeft" })
        break
      case "right":
        r.mockInput.pressArrow("right")
        break
      case "insert":
        r.mockInput.pressKey("x")
        break
      case "newline":
        r.mockInput.pressEnter()
        break
      case "pasteNewline":
        await r.mockInput.pasteBracketedText("\n")
        break
      case "pauseKeys":
      case "resumeKeys":
        a.traits = { suspend: op === "pauseKeys" }
        break
      case "reset":
        reset()
        break
      default:
        assert.equal(op, "mount")
    }
    await r.renderOnce()
    if (kind === "textarea") return `${a.plainText}@${a.cursorOffset}/${a.getSelectedText()}`
    if (kind === "focus") {
      const widgets = [a, b],
        before = widgets.map((w) => w.plainText)
      r.mockInput.pressKey("x")
      const ids = (ws: TextareaRenderable[]) => ws.map((w) => w.id).join("") || "-"
      return [
        renderer.currentFocusedRenderable?.id ?? "-",
        ids(widgets.filter((w) => w.focused)),
        ids(widgets.filter((w, i) => w.plainText !== before[i])),
      ].join("/")
    }
    const c = renderer.getCursorState()
    return c.visible ? `${c.style}:${c.blinking}@${c.x},${c.y}` : "hidden"
  }
}

function scroll(r: TestRendererSetup, kind: string, horizontal: boolean) {
  const box = new ScrollBoxRenderable(r.renderer, {
    id: "box",
    height: 2,
    width: 2,
    scrollX: horizontal,
    scrollY: !horizontal,
    stickyScroll: true,
    stickyStart: horizontal ? (kind === "scroll-top" ? "left" : "right") : kind === "scroll-top" ? "top" : "bottom",
    scrollbarOptions: { visible: false },
  })
  const axis = horizontal ? "width" : "height"
  const content = new TextRenderable(r.renderer, {
    id: "child",
    [axis]: 3,
    flexShrink: 0,
    wrapMode: "none",
    content: horizontal ? "0123456" : "0\n1\n2\n3\n4\n5\n6",
  })
  box.add(content)
  r.renderer.root.add(box)
  const to = (offset: number) => box.scrollTo(horizontal ? { x: offset, y: 0 } : { x: 0, y: offset })
  return async (op: string) => {
    if (op === "shrink" || op === "grow" || op === "growAgain")
      content[axis] = op === "shrink" ? 3 : op === "grow" ? 6 : 7
    else if (["top", "middle", "end"].includes(op)) to(op === "top" ? 0 : op === "middle" ? 2 : Infinity)
    else assert.equal(op, "mount")
    await r.renderOnce()
    const offset = String(horizontal ? box.scrollLeft : box.scrollTop),
      cell = r.captureCharFrame()[0]
    return offset === cell ? offset : `offset=${offset}, painted=${cell}`
  }
}

// Every legal depth-four path (shorter at a terminal state); every prefix is observed.
function* traces(m: Machine): Generator<string[]> {
  function* visit(state: string, path: string[]): Generator<string[]> {
    const edges = Object.entries(m.states[state][1])
    if (path.length === corpus.depth || !edges.length) yield path
    else for (const [op, next] of edges) yield* visit(next, [...path, op])
  }
  yield* visit(m.initial, [])
  for (let seed = 0; seed < corpus.seeds; seed++) {
    let n = seed,
      state = m.initial
    const path = []
    for (let i = 0; i < corpus.steps; i++) {
      const keys = Object.keys(m.states[state][1]).sort()
      if (!keys.length) break
      n = (Math.imul(n, 1664525) + 1013904223) >>> 0
      const op = keys[(n >>> 16) % keys.length]
      path.push(op)
      state = m.states[state][1][op]
    }
    yield path
  }
}

for (const [kind, m] of Object.entries(corpus.machines)) {
  for (const horizontal of kind.startsWith("scroll-") ? [false, true] : [false]) {
    test(`shared interaction machine: ${kind}${horizontal ? " (x)" : ""}`, async () => {
      const known = expectedFailures(m.xfail)
      async function replay(path: string[]) {
        const clock = new ManualClock()
        const r = await createTestRenderer({ width: 8, height: 2, clock, useMouse: true })
        try {
          const step =
            kind === "selection"
              ? selection(r, clock)
              : kind.startsWith("scroll-")
                ? scroll(r, kind, horizontal)
                : editor(r, kind)
          let state = m.initial
          for (const op of ["mount", ...path]) {
            const next = op === "mount" ? state : m.states[state][1][op]
            if (!next) return // Not a legal subsequence for the shrinker.
            const expected = m.states[next][0],
              actual = await step(op)
            if (actual !== expected) {
              if (known.has(`${state} ${op} ${actual}`)) return
              return JSON.stringify({ state, op, expected, actual })
            }
            state = next
          }
        } finally {
          await r.dispose()
        }
      }
      for (const path of traces(m)) {
        const failure = await replay(path)
        if (!failure) continue
        // Keep a shorter path only if the same edge, check and values still fail from a fresh mount.
        const short = await shrink(path, async (candidate) => (await replay(candidate)) === failure)
        assert.fail(`${kind} ${JSON.stringify(short)}: ${failure}`)
      }
      known.check()
    })
  }
}

// Two complete normal cycles. Each trial drops, repeats or swaps one event, including across the cycle
// boundary. It then probes the unaltered second cycle if it survived, or otherwise a full first cycle.
function* trials(cs: string[]) {
  for (const a of cs)
    for (const b of cs) {
      const normal = a + b
      for (let i = 0; i < normal.length; i++) {
        const event = normal[i]!
        const edits: [number, string][] = [
          [1, ""],
          [1, event.repeat(2)],
        ]
        if (i + 1 < normal.length) edits.push([2, normal[i + 1]! + event])
        for (const [take, replacement] of edits) {
          const intact = i + take <= a.length
          const prefix = normal.slice(0, i) + replacement + normal.slice(i + take, intact ? a.length : normal.length)
          yield [prefix, intact ? b : cs[0]!] as const
        }
      }
    }
}

function widgets(kind: Fault, t: TestRendererSetup, clock: ManualClock) {
  const r = t.renderer
  const mouse = (type: "down" | "drag" | "up", x: number, y = 0) =>
    r["processSingleMouseEvent"]({
      type,
      button: 0,
      x,
      y,
      modifiers: { ctrl: false, shift: false, alt: false },
    })
  if (kind === "pointer") {
    let down = "",
      drag = "",
      drop = "",
      end = ""
    for (const id of ["a", "b"]) {
      const box = new BoxRenderable(r, { id, width: 5, height: 1 })
      r.root.add(box)
      box.onMouse = (e) => {
        if (e.type === "down") down += id
        if (e.type === "drag") drag += id
        if (e.type === "drag-end") end += id
        if (e.type === "drop") drop += e.source?.id
      }
    }
    return (op: string) => {
      down = drag = drop = end = ""
      mouse(op === "u" ? "up" : op === "d" ? "drag" : "down", 0, Number(op !== "a"))
      return op === "u"
        ? `end:${end},drop:${drop},held:${!!r["capturedRenderable"] || !!r["pressedRenderable"]}`
        : down + drag
    }
  }
  if (kind === "selection" || kind === "consumed") {
    const text = new TextRenderable(r, { content: "abcdef", selectable: true })
    if (kind === "consumed") text.onMouseDown = (e) => e.preventDefault()
    r.root.add(text)
    return (op: string) => {
      if (op === "a" || op === "b") clock.advance(600) // Not a multi-click gesture.
      mouse(op === "u" ? "up" : op === "d" ? "drag" : "down", op === "a" ? 0 : op === "b" ? 3 : 4)
      const sel = r.getSelection()
      return `${sel?.isDragging ?? false}:${sel?.getSelectedText() ?? ""}/${text.getSelectedText()}`
    }
  }
  const box = new ScrollBoxRenderable(r, {
    width: 8,
    height: 6,
    verticalScrollbarOptions: { showArrows: true },
  })
  box.add(new TextRenderable(r, { content: "line\n".repeat(99), flexShrink: 0 }))
  r.root.add(box)
  r.root.add(new BoxRenderable(r, { width: 8, height: 1 }))
  if (kind === "edge")
    return async (op: string) => {
      if (op === "a" || op === "b") clock.advance(600)
      mouse(
        op === "u" || op === "v" ? "up" : op === "d" ? "drag" : "down",
        2,
        op === "a" ? 0 : op === "b" || op === "v" ? 6 : 5,
      )
      const before = box.scrollTop
      clock.advance(160)
      await t.renderOnce()
      return `${box.live}/${box.scrollTop > before}`
    }
  return (op: string) => {
    const before = box.scrollTop
    if (op === "t") clock.advance(500)
    else mouse(op === "u" || op === "v" ? "up" : "down", 7, op === "b" || op === "v" ? 6 : 5)
    if (op === "u" || op === "v") {
      const released = box.scrollTop
      clock.advance(500)
      return `post-release:${box.scrollTop - released}`
    }
    return String(box.scrollTop - before)
  }
}

// Suspend, resume and pause, observed through the session phase and the delivered screen.
function policy(t: TestRendererSetup, output: RecordingWriteStream) {
  const r = t.renderer,
    s = r["nativeSession"]
  const phase = () => NativeSessionTerminalPhase[s.renderLib.sessionGetTerminalState(s.context, s.session)]
  return async (op: string) => {
    if (op === "s") await r.suspend()
    else if (op === "p") r.pause()
    else {
      try {
        await r.resume()
      } catch (err) {
        // A duplicate or reordered resume can be rejected; while active, it must not lose the lease.
        assert.match(String(err), /requires completed suspension/)
        if (phase() === "Suspended") return "rejected while suspended"
        assert.equal(phase(), "Active")
      }
    }
    const out = output.text()
    const alt = out.lastIndexOf("\x1b[?1049h") > out.lastIndexOf("\x1b[?1049l")
    return `${phase()}/${alt}/${r.useMouse}/${r.stdin.listenerCount("data")}`
  }
}

async function observe(kind: Fault, prefix: string, recovery: string): Promise<string[][]> {
  const clock = new ManualClock(),
    output = new RecordingWriteStream(8, 7)
  const t = await createTestRenderer({
    width: 8,
    height: 7,
    clock,
    useMouse: true,
    ...(kind === "policy" && {
      screenMode: "alternate-screen",
      stdout: output as unknown as NodeJS.WriteStream,
      bufferedOutput: "stdout",
    }),
  })
  try {
    if (kind === "policy") await t.renderer.setupTerminal()
    const step = kind === "policy" ? policy(t, output) : widgets(kind, t, clock)
    if (kind !== "policy") await t.renderOnce()
    for (const op of prefix) await step(op)
    const receipts: string[][] = []
    for (const cycle of [recovery, corpus.faults[kind].cycles[0]!]) {
      const receipt = []
      for (const op of cycle) receipt.push(await step(op))
      receipts.push(receipt)
    }
    return receipts
  } finally {
    await t.dispose()
  }
}

// A broken hit map, inert timer or disabled input must not become its own fresh oracle.
const controls: Record<Fault, [string, string[]]> = {
  pointer: ["adu", ["a", "a", "end:a,drop:a,held:false"]],
  selection: ["bdu", ["true:/", "true:de/de", "false:de/de"]],
  consumed: ["bdu", ["true:/", "true:de/de", "false:de/de"]],
  arrow: ["atu", ["3", "3", "post-release:0"]],
  edge: ["adu", ["false/false", "true/true", "false/false"]],
  policy: ["srp", ["Suspended/false/false/0", "Active/true/true/1", "Active/true/true/1"]],
}

for (const kind of Object.keys(controls) as Fault[]) {
  const { cycles: cs, xfail } = corpus.faults[kind]
  test(`one lost, repeated or reordered event: ${kind}`, async () => {
    const fresh = new Map<string, string[][]>()
    for (const cycle of cs) fresh.set(cycle, await observe(kind, "", cycle))
    const [word, expected] = controls[kind]
    assert.deepEqual(fresh.get(word)![0], expected)
    const known = expectedFailures(xfail)
    const seen = new Set<string>(),
      failures = new Map<string, [string, string, number]>()
    function difference(receipts: string[][], cycle: string) {
      const result = []
      for (const [n, expected] of [fresh.get(cycle)![0]!, fresh.get(cs[0]!)![0]!].entries()) {
        const word = n === 0 ? cycle : cs[0]!
        const i = expected.findIndex((x, i) => x !== receipts[n]![i])
        if (i >= 0) result.push(`${n + 1}:${word[i]} ${expected[i]} -> ${receipts[n]![i]}`)
      }
      return result
    }
    for (const [prefix, cycle] of trials(cs)) {
      const key = `${prefix}/${cycle}`
      if (seen.has(key)) continue
      seen.add(key)
      for (const problem of difference(await observe(kind, prefix, cycle), cycle)) {
        if (known.has(`${key} ${problem}`)) continue
        const row = failures.get(problem) ?? [prefix, cycle, 0]
        row[2]++
        failures.set(problem, row)
      }
    }
    for (const [problem, [start, cycle, count]] of failures) {
      const path = await shrink([...start], async (candidate) =>
        difference(await observe(kind, candidate.join(""), cycle), cycle).includes(problem),
      )
      console.error(`${kind} ${count}/${seen.size} ${path.join("")}|${cycle}: ${problem}`)
    }
    assert.equal(failures.size, 0)
    known.check()
  }, 30_000)
}
