import { afterEach, describe, expect, test } from "bun:test"
import { nativeConstants, nativeLayouts } from "../native-abi.generated.js"
import { RGBA } from "../lib/RGBA.js"
import { LayoutEvents, Renderable } from "../Renderable.js"
import { BoxRenderable } from "../renderables/Box.js"
import type { OptimizedBuffer } from "../buffer.js"
import { createTestRenderer, type TestRenderer } from "../testing.js"
import { NativeStatus, SceneStaging, resolveRenderLib, type NativeContextHandle, type SceneNodeHandle } from "../zig.js"

let renderer: TestRenderer | undefined

afterEach(() => {
  renderer?.destroy()
  renderer = undefined
})

describe("scene layout observations", () => {
  test("random writes inside and outside hooks: getters match native reads, and only some writes re-read", async () => {
    // Writes that make the next warm read call native again (issue 310), and whether they stage a flush.
    const invalidates = (name: string) => ["translateX", "translateY", "move"].includes(name)
    let hook: ((node: Renderable, phase: string) => void) | undefined
    const renderBefore = function (this: Renderable) {
      hook?.(this, "renderBefore")
    }
    class Probe extends BoxRenderable {
      protected override renderSelf(buffer: OptimizedBuffer): void {
        hook?.(this, "renderSelf")
        super.renderSelf(buffer)
      }
      protected override onUpdate(): void {
        hook?.(this, "onUpdate")
      }
    }
    // Keeps its children attached through destroy and reads them last, so only native detaches them.
    class Keeper extends BoxRenderable {
      watched: Renderable[] = []
      override remove(child: Renderable): void {
        if (!this.isDestroyed) super.remove(child)
      }
      protected override destroySelf(): void {
        for (const node of this.watched) if (!node.isDestroyed) void node.x
      }
    }
    for (let round = 1; round <= 10; round++) {
      let seed = round
      const random = (n: number) => ((seed = (Math.imul(seed, 48271) + 11) % 2147483647) >>> 0) % n
      const setup = await createTestRenderer({ width: 80, height: 20 })
      renderer = setup.renderer
      const scene = renderer.nativeScene
      const box = (options: object) => new BoxRenderable(renderer!, options)
      const a = box({ position: "absolute", left: 2, top: 1, width: 30, height: 10, flexDirection: "row" })
      const [b, d] = [box({ width: 8, height: 4, border: true }), box({ width: 6, height: 2 })]
      const probe = (options: object) => new Probe(renderer!, { ...options, renderBefore })
      const [c, f] = [probe({ width: 4, height: 1 }), probe({ marginLeft: 2, height: 2 })]
      const e = new Keeper(renderer, { position: "absolute", left: 40, top: 5, width: 20, height: 8, paddingTop: 1 })
      ;(b.add(c), a.add(b), a.add(d), e.add(f), renderer.root.add(a), renderer.root.add(e))
      await setup.renderOnce()
      const nodes: Renderable[] = (e.watched = [a, b, c, d, e, f])
      const live = () => nodes.filter((node) => !node.isDestroyed)
      // Each write changes its value: a write of the current value is skipped before it reaches the scene.
      const padding = new Map<Renderable, number>()
      const writes: [string, (node: any) => unknown][] = [
        ["width", (node) => (node.width = node._width === 5 ? 9 : 5)],
        ["paddingLeft", (node) => (node.paddingLeft = padding.set(node, 1 - (padding.get(node) ?? 0)).get(node))],
        ["opacity", (node) => (node.opacity = node.opacity === 1 ? 0.5 : 1)],
        ["zIndex", (node) => (node.zIndex += 1)],
        ["border", (node) => (node.border = node.border !== true)],
        ["backgroundColor", (node) => (node.backgroundColor = random(2) ? "#ff0000" : "#00ff00")],
        ["translateX", (node) => (node.translateX += random(2) ? 1 : -1)],
        ["translateY", (node) => (node.translateY += random(2) ? 1 : -1)],
        ["move", () => [a, b, e][random(3)].add([c, d, f][random(3)])],
        ["construct", () => box({})],
      ]
      // Every getter, then a fresh native read of each. Paint getters read the paint layout inside the node's hook
      // and the public layout outside it.
      const getters = (node: Renderable) => [node.x, node.y, node.width, node.height, node.screenX, node.screenY]
      const geometry = (node: any) => {
        const { left, top, width, height } = node.getLayout()
        const paint = [node._screenX, node._screenY, node._paintWidth, node._paintHeight]
        return [...getters(node), left, top, width, height, ...paint]
      }
      const native = (node: Renderable, inHook: boolean) => {
        const [p, y] = [scene.getLayout(node), scene.getLayout(node, true)]
        const s = inHook ? scene.getLayout(node, "paint") : p
        const at = (l: typeof p) => [l.screenX, l.screenY, l.width, l.height]
        return [...at(p), p.screenX, p.screenY, y.left, y.top, y.width, y.height, ...at(s)]
      }
      const stale: string[] = []
      const check = (label: string, hooked?: Renderable) =>
        live().forEach((node) => {
          const [got, want] = [geometry(node), native(node, node === hooked)]
          if (got.join() !== want.join()) stale.push(`${label} #${nodes.indexOf(node)}: ${got} != ${want}`)
        })
      // ot_scene_get_layout calls by mode (public, paint) and ot_scene_flush calls, while `read` runs.
      const symbols = (scene.driver.renderLib as any).opentui.symbols
      const { ot_scene_get_layout: getLayout, ot_scene_flush: flush } = symbols
      const work = (read: () => void) => {
        const counts = [0, 0, 0]
        const modes = [nativeConstants.OT_LAYOUT_PUBLIC, nativeConstants.OT_LAYOUT_PAINT]
        symbols.ot_scene_get_layout = (...args: any[]) => (counts[modes.indexOf(args[2])]++, getLayout(...args))
        symbols.ot_scene_flush = (...args: any[]) => (counts[2]++, flush(...args))
        try {
          read()
        } finally {
          Object.assign(symbols, { ot_scene_get_layout: getLayout, ot_scene_flush: flush })
        }
        return counts
      }
      const ownWork = (node: any) => work(() => void [...getters(node), node._screenX])
      check("first frame")
      for (let step = 0; step < 150; step++) {
        const [name, apply] = writes[random(writes.length)]
        const write = () => apply(nodes[random(6)])
        const label = `${round}:${step} ${name}`
        const inv = invalidates(name)
        const flushes = inv && name !== "move" ? 1 : 0
        if (random(3) === 0) {
          // The first hook of the phase writes; every later hook, on either node, checks: an earlier slot's write can
          // stale a later one.
          const phase = ["renderSelf", "onUpdate", "renderBefore"][random(3)]
          const seen = new Set<string>()
          let written = false
          hook = (node, current) => {
            // The first hook of each kind reads its own geometry from the request or slot without a native call.
            if (!seen.has(current)) {
              seen.add(current)
              const first = ownWork(node)
              if (first.join() !== "0,0,0") stale.push(`${label} first hook ${first}`)
            }
            check(`${label}@${phase} seen in #${nodes.indexOf(node)} ${current}`, node)
            if (written || current !== phase) return
            written = true
            write()
            const after = ownWork(node)
            if (after.join() !== [inv ? 1 : 0, 0, flushes].join()) stale.push(`${label}@${phase} work ${after}`)
            check(`${label}@${phase}`, node)
          }
        } else {
          write()
          const counts = work(() => live().forEach(getters))
          if (counts.join() !== [inv ? live().length : 0, 0, flushes].join()) stale.push(`${label} work ${counts}`)
          check(label)
        }
        if (hook || random(2) === 0) await setup.renderOnce()
        hook = undefined
        check(`${label} frame`)
      }
      e.destroy()
      check(`${round} destroy`)
      expect(() => e.getLayout()).toThrow()
      expect(stale).toEqual([])
      renderer.destroy()
    }
  })
})

describe("scene staging", () => {
  const c = nativeConstants
  const context = Object.freeze({}) as NativeContextHandle
  const nodeAt = (slot: number, generation: number) => ({ context, contextId: 7n, slot, generation }) as SceneNodeHandle
  const headerWords = nativeLayouts.ot_scene_property_update.size / 4
  const styleWords = headerWords + nativeLayouts.ot_scene_style_property.size / 4
  // Paint fields in header bit order: update name, wire field, and generated values.
  const color = (index: number) => RGBA.fromInts(index, 0, 0, 255)
  const paintFields = [
    ["zIndex", "z_index", [-2, 0, 3]],
    ["opacity", "opacity", [0, 0.5, 1]],
    ["translateX", "translate_x", [0, 1, 2.5]],
    ["translateY", "translate_y", [0, -1, 2]],
    ["border", "border_sides", [0, 5, 15]],
    ["shouldFill", "should_fill", [false, true]],
    ["backgroundColor", "background", [color(1), color(2)]],
    ["borderColor", "border_color", [color(3), color(4)]],
    ["borderStyle", "border_style", ["single", "rounded"]],
    ["focusable", "focusable", [false, true]],
    ["focusedBorderColor", "focused_border_color", [color(5), color(6)]],
  ] as const
  const paintFieldWords = paintFields.map(([, field]) => nativeLayouts.ot_scene_paint_options.fields[field].size / 4)
  const translations = [2, 3]

  // Yoga's stored value: undefined, auto, or a number in a unit (-1 for enums and floats).
  type Stored = "undefined" | "auto" | { unit: number; value: number }
  type StyleState = { value: Stored; flexShrink: Stored; dirty: boolean }
  type StyleProp = { group: number; kind: number; edge: number; flags: number }
  type StyleWrite = { key: string; prop: StyleProp; unit: number; value: number }
  type StagedRecord = {
    slot: number
    generation: number
    style?: { prop: StyleProp; unit: number; value: number }
    paint?: Map<number, number[]>
  }

  const props: StyleProp[] = [
    { group: c.OT_STYLE_DIMENSION, kind: c.OT_DIMENSION_WIDTH, edge: c.OT_EDGE_NONE, flags: 0 },
    {
      group: c.OT_STYLE_DIMENSION,
      kind: c.OT_DIMENSION_WIDTH,
      edge: c.OT_EDGE_NONE,
      flags: c.OT_STYLE_DISABLE_FLEX_SHRINK,
    },
    { group: c.OT_STYLE_VALUE, kind: c.OT_STYLE_VALUE_MIN_WIDTH, edge: c.OT_EDGE_NONE, flags: 0 },
    { group: c.OT_STYLE_VALUE, kind: c.OT_STYLE_VALUE_MARGIN, edge: c.OT_EDGE_TOP, flags: 0 },
    { group: c.OT_STYLE_FLOAT, kind: c.OT_STYLE_FLOAT_ASPECT_RATIO, edge: c.OT_EDGE_NONE, flags: 0 },
    { group: c.OT_STYLE_FLOAT, kind: c.OT_STYLE_FLOAT_FLEX_GROW, edge: c.OT_EDGE_NONE, flags: 0 },
    { group: c.OT_STYLE_ENUM, kind: c.OT_STYLE_ENUM_DISPLAY, edge: c.OT_EDGE_NONE, flags: 0 },
  ]
  const values = [0, -0, 1, 10, 2.5, NaN, 1e-45, 0.1, 0.1 + 1e-12, 3e38, -5]
  const initialValues: Stored[] = [
    "undefined",
    "auto",
    { unit: c.OT_UNIT_POINT, value: 0 },
    { unit: c.OT_UNIT_POINT, value: 10 },
    { unit: c.OT_UNIT_PERCENT, value: 10 },
    { unit: -1, value: 0 },
    { unit: -1, value: 1 },
    { unit: -1, value: 2.5 },
  ]
  const initialShrinks: Stored[] = ["undefined", { unit: -1, value: 0 }, { unit: -1, value: 1 }]

  // +0 and -0 compare equal, as in Yoga.
  const sameStored = (a: Stored, b: Stored) =>
    typeof a === "string" || typeof b === "string" ? a === b : a.unit === b.unit && a.value === b.value
  const sameWords = (a: number[] | undefined, b: number[] | undefined) =>
    a !== undefined && b !== undefined && a.length === b.length && a.every((word, index) => word === b[index])

  /** One native write, as yoga-bridge.cpp and Yoga's setters compare and store it. */
  function applyYogaWrite(state: StyleState, prop: StyleProp, unit: number, value: number): void {
    const zero = { unit: -1, value: 0 }
    let next: Stored
    if (prop.group === c.OT_STYLE_ENUM || prop.group === c.OT_STYLE_FLOAT) {
      next = Number.isNaN(value) ? "undefined" : { unit: -1, value }
    } else if (unit === c.OT_UNIT_AUTO) {
      next = "auto"
    } else {
      next = unit === c.OT_UNIT_UNDEFINED || Number.isNaN(value) ? "undefined" : { unit, value }
    }
    const disablesShrink = prop.flags !== 0
    if (sameStored(state.value, next) && (!disablesShrink || sameStored(state.flexShrink, zero))) return
    // Yoga compares an aspect ratio before it stores 0 as undefined, so writing 0 always dirties.
    const aspectZero = prop.group === c.OT_STYLE_FLOAT && prop.kind === c.OT_STYLE_FLOAT_ASPECT_RATIO && value === 0
    state.value = aspectZero ? "undefined" : next
    if (disablesShrink) state.flexShrink = zero
    state.dirty = true
  }

  function check(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(message)
  }

  /** Borrows the stream, checks its wire layout, and returns the records without consuming any. */
  function readStream(staging: SceneStaging): StagedRecord[] {
    if (!staging.pending) {
      check(staging.byteLength === 0, "an empty stream has bytes")
      return []
    }
    const words = staging._views(context)
    const valueWord = new Uint32Array(1)
    const value = new Float32Array(valueWord.buffer)
    try {
      const records: StagedRecord[] = []
      let offset = 0
      for (let index = 0; index < staging.count; index++) {
        check(words[offset] === 7 && words[offset + 1] === 0, `record ${index} has another context id`)
        const fields = words[offset + 4]
        const size = words[offset + 5] / 4
        const record: StagedRecord = { slot: words[offset + 2], generation: words[offset + 3] }
        if (fields === c.OT_SCENE_PROPERTY_STYLE) {
          check(size === styleWords && words[offset + 9] === 0, `style record ${index} has a bad size or reserved word`)
          const packed = words[offset + 6]
          const flags = words[offset + 7]
          const [group, kind, edge] = [packed & 0xff, (packed >>> 8) & 0xff, (packed >>> 16) & 0xff]
          const prop = props.find((p) => p.group === group && p.kind === kind && p.edge === edge && p.flags === flags)
          check(prop !== undefined, `style record ${index} targets an unknown property`)
          valueWord[0] = words[offset + 8]
          record.style = { prop, unit: packed >>> 24, value: value[0] }
        } else {
          record.paint = new Map()
          let at = offset + headerWords
          for (let bit = 0; bit < paintFields.length; bit++) {
            if ((fields & (1 << bit)) === 0) continue
            record.paint.set(bit, Array.from(words.subarray(at, at + paintFieldWords[bit])))
            at += paintFieldWords[bit]
          }
          check(size === ((at - offset + 1) >> 1) << 1, `paint record ${index} has a bad size`)
          for (; at < offset + size; at++) check(words[at] === 0, `paint record ${index} has nonzero padding`)
        }
        records.push(record)
        offset += size
      }
      check(offset * 4 === staging.byteLength, "record sizes do not add up to byteLength")
      return records
    } finally {
      staging.consume(0)
    }
  }

  function createRandom(seed: number): () => number {
    // mulberry32
    return () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  type Operation =
    | { style: StyleProp; node: number; unit: number; value: number; edge?: number }
    | { paint: Record<string, unknown>; node: number }
    // Native accepts this share of the staged records.
    | { accept: number }
    | { destroy: number }

  const show = (value: unknown) =>
    JSON.stringify(value, (_, item) => (Object.is(item, -0) ? "-0" : Number.isNaN(item) ? "NaN" : item))
  const showRecords = (records: StagedRecord[]) =>
    show(records.map((record) => ({ ...record, paint: record.paint && [...record.paint] })))

  function randomOperations(random: () => number): Operation[] {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
    const pool = [pick(props), pick(props)]
    const operations: Operation[] = []
    for (let step = 1 + Math.floor(random() * 16); step > 0; step--) {
      const roll = random()
      const node = random() < 0.5 ? 0 : 1
      if (roll < 0.25) {
        const paint: Record<string, unknown> = {}
        const full = random() < 0.1
        for (const [name, , choices] of paintFields) if (full || random() < 0.25) paint[name] = pick<unknown>(choices)
        operations.push({ paint, node })
      } else if (roll < 0.4) {
        operations.push({ accept: random() })
      } else if (roll < 0.45) {
        operations.push({ destroy: node })
      } else {
        // Bursts of writes to the node's properties are where staging coalesces.
        for (let burst = 1 + Math.floor(random() * 3); burst > 0; burst--) {
          const style = pick(pool)
          const autoInvalid = style.group === c.OT_STYLE_VALUE && style.kind === c.OT_STYLE_VALUE_MIN_WIDTH
          const unit =
            style.group <= c.OT_STYLE_FLOAT ? c.OT_UNIT_UNDEFINED : pick(autoInvalid ? [0, 1, 2] : [0, 1, 2, 3])
          const value = style.group === c.OT_STYLE_ENUM ? pick([0, 1]) : pick(values)
          // Size kinds ignore the edge; staging must clear it before comparing records.
          const edge = style.kind === c.OT_STYLE_VALUE_MIN_WIDTH ? pick([c.OT_EDGE_NONE, c.OT_EDGE_ALL]) : undefined
          operations.push({ style, node, unit, value, edge })
        }
      }
    }
    return operations
  }

  /** Stages the operations, checks the stream after each one, and compares what native applied with what was written. */
  function runOperations(operations: Operation[]): void {
    const staging = new SceneStaging(1)
    const generations = [1, 1]
    const written: StyleWrite[] = []
    const applied: StyleWrite[] = []
    const writtenPaint = new Map<string, Map<number, number[]>>()
    const appliedPaint = new Map<string, Map<number, number[]>>()
    const paintOf = (map: Map<string, Map<number, number[]>>, key: string) =>
      map.get(key) ?? map.set(key, new Map()).get(key)!
    const styleKey = (slot: number, generation: number, prop: StyleProp) =>
      `${slot}:${generation}:${prop.group}:${prop.kind}:${prop.edge}`
    let stream: StagedRecord[] = []

    const acceptPrefix = (count: number) => {
      for (const record of stream.slice(0, count)) {
        check(record.generation === generations[record.slot - 1], "a destroyed node's record reached native")
        if (record.style) {
          const { prop, unit, value } = record.style
          applied.push({ key: styleKey(record.slot, record.generation, prop), prop, unit, value })
        } else {
          const paint = paintOf(appliedPaint, `${record.slot}:${record.generation}`)
          for (const [bit, words] of record.paint!) paint.set(bit, words)
        }
      }
      staging._views(context)
      staging.consume(count)
      check(showRecords(readStream(staging)) === showRecords(stream.slice(count)), "consume kept other records")
    }

    for (const operation of operations) {
      if ("accept" in operation) {
        if (staging.pending) acceptPrefix(Math.floor(operation.accept * (staging.count + 1)))
      } else if ("destroy" in operation) {
        staging.discard(nodeAt(operation.destroy + 1, generations[operation.destroy]))
        generations[operation.destroy]++
      } else if ("paint" in operation) {
        const node = nodeAt(operation.node + 1, generations[operation.node])
        const before = stream
        staging.stagePaint(context, node, operation.paint)
        stream = readStream(staging)
        const oracle = new SceneStaging(1)
        oracle.stagePaint(context, node, operation.paint)
        const expected = readStream(oracle)[0]?.paint ?? new Map<number, number[]>()
        const target = paintOf(writtenPaint, `${node.slot}:${node.generation}`)
        for (const [bit, words] of expected) target.set(bit, words)
        // A changed translation must not move ahead of records staged before it.
        for (const bit of translations) {
          if (!expected.has(bit)) continue
          const at = stream.findLastIndex((record) => record.slot === node.slot && record.paint?.has(bit))
          check(at >= 0 && sameWords(stream[at].paint!.get(bit), expected.get(bit)), "translation was not staged")
          check(
            at === stream.length - 1 || sameWords(before[at]?.paint?.get(bit), expected.get(bit)),
            "a changed translation merged into an earlier record",
          )
        }
      } else {
        const { style, unit, value } = operation
        const { group, kind, edge, flags } = style
        const node = nodeAt(operation.node + 1, generations[operation.node])
        staging.stageStyle(context, node, group, kind, operation.edge ?? edge, unit, value, flags)
        written.push({ key: styleKey(node.slot, node.generation, style), prop: style, unit, value: Math.fround(value) })
      }
      stream = readStream(staging)
    }
    if (staging.pending) acceptPrefix(staging.count)
    check(!staging.pending, "a full acceptance left records staged")

    const live = (key: string) => {
      const [slot, generation] = key.split(":").map(Number)
      return generation === generations[slot - 1]
    }
    for (const [key, paint] of writtenPaint) {
      if (!live(key)) continue
      for (const [bit, words] of paint) {
        check(sameWords(appliedPaint.get(key)?.get(bit), words), `paint ${key} field ${bit} lost its last write`)
      }
    }
    compareEffects(written, applied, live)
  }

  /** Replays both write lists from every initial native state and compares the final Yoga state per property. */
  function compareEffects(written: StyleWrite[], applied: StyleWrite[], live: (key: string) => boolean): void {
    for (const value of initialValues) {
      for (const flexShrink of initialShrinks) {
        const replay = (writes: StyleWrite[]) => {
          const states = new Map<string, StyleState>()
          for (const write of writes) {
            if (!live(write.key)) continue
            const state =
              states.get(write.key) ?? states.set(write.key, { value, flexShrink, dirty: false }).get(write.key)!
            applyYogaWrite(state, write.prop, write.unit, write.value)
          }
          return states
        }
        const expected = replay(written)
        const actual = replay(applied)
        for (const [key, want] of expected) {
          const got = actual.get(key) ?? { value, flexShrink, dirty: false }
          check(
            sameStored(want.value, got.value) &&
              sameStored(want.flexShrink, got.flexShrink) &&
              want.dirty === got.dirty,
            `${key} from ${JSON.stringify([value, flexShrink])}: written ${JSON.stringify(want)}, applied ${JSON.stringify(got)}`,
          )
        }
      }
    }
  }

  test("every staged run of three writes to one property has the same Yoga effect", () => {
    const edgeValues = [0, -0, 10, NaN, 1e-45]
    const runs: [StyleProp, number[]][] = [
      [props[0], [c.OT_UNIT_UNDEFINED, c.OT_UNIT_POINT, c.OT_UNIT_PERCENT, c.OT_UNIT_AUTO]],
      [props[4], [c.OT_UNIT_UNDEFINED]],
    ]
    for (const [prop, units] of runs) {
      const symbols = units.flatMap((unit) => edgeValues.map((value) => [unit, value] as const))
      for (const first of symbols) {
        for (const second of symbols) {
          for (const third of symbols) {
            const staging = new SceneStaging(1)
            const written = [first, second, third].map(([unit, value]) => {
              staging.stageStyle(context, nodeAt(1, 1), prop.group, prop.kind, prop.edge, unit, value, prop.flags)
              return { key: "run", prop, unit, value: Math.fround(value) }
            })
            const applied = readStream(staging).map(({ style }) => ({ key: "run", ...style! }))
            try {
              compareEffects(written, applied, () => true)
            } catch (error) {
              throw new Error(`${show(prop)} ${show([first, second, third])}: ${(error as Error).message}`)
            }
          }
        }
      }
    }
  })

  test("native Yoga runs layout after staged writes exactly when the model marks the node dirty", async () => {
    const setup = await createTestRenderer({ width: 40, height: 10 })
    renderer = setup.renderer
    const box = new BoxRenderable(renderer, { width: 5, height: 1 })
    renderer.root.add(box)
    await setup.renderOnce()
    let layouts = 0
    renderer.root.on(LayoutEvents.LAYOUT_CHANGED, () => layouts++)
    const [width, widthDisablingShrink, minWidth, , aspectRatio] = props
    const { OT_UNIT_UNDEFINED: none, OT_UNIT_POINT: point, OT_UNIT_PERCENT: percent, OT_UNIT_AUTO: auto } = c
    const flexShrink = { group: c.OT_STYLE_FLOAT, kind: c.OT_STYLE_FLOAT_FLEX_SHRINK, edge: c.OT_EDGE_NONE, flags: 0 }
    type Write = [unit: number, value: number]
    // Each row writes the property's initial value and flex shrink, runs a frame, then stages the writes.
    const cases: [prop: StyleProp, shrink: number, dirty: boolean, initial: Write, ...writes: Write[]][] = [
      [aspectRatio, 1, true, [none, NaN], [none, 0]],
      [aspectRatio, 1, true, [none, 0], [none, 0]],
      [aspectRatio, 1, true, [none, 0], [none, -0]],
      [aspectRatio, 1, true, [none, 2], [none, NaN]],
      [widthDisablingShrink, 1, true, [point, 5], [point, 5]],
      [widthDisablingShrink, 0, false, [point, 5], [point, 5]],
      [width, 1, true, [point, 5], [point, 10], [point, 5]],
      [width, 1, true, [auto, NaN], [point, 5], [auto, 3]],
      [minWidth, 1, false, [point, 0], [point, -0]],
      [minWidth, 1, true, [point, 0], [point, 10], [point, -0]],
      [minWidth, 1, false, [none, 3], [point, NaN]],
      [minWidth, 1, true, [none, 1], [point, 10], [none, 2]],
      [minWidth, 1, true, [percent, 0], [point, 0]],
      [minWidth, 1, true, [point, 1e-45], [point, 0]],
    ]
    const stage = (prop: StyleProp, [unit, value]: Write) =>
      renderer!.nativeScene.setStyle(box, prop.group, prop.kind, prop.edge, unit, value, prop.flags)
    for (const [prop, shrink, dirty, initial, ...writes] of cases) {
      const setupProp = { ...prop, flags: 0 }
      stage(flexShrink, [none, shrink])
      stage(setupProp, initial)
      await setup.renderOnce()
      const state: StyleState = { value: "undefined", flexShrink: { unit: -1, value: shrink }, dirty: false }
      applyYogaWrite(state, setupProp, ...initial)
      state.dirty = false
      layouts = 0
      for (const write of writes) {
        stage(prop, write)
        applyYogaWrite(state, prop, write[0], Math.fround(write[1]))
      }
      await setup.renderOnce()
      const row = show([prop, initial, writes])
      expect([row, layouts === 1, state.dirty]).toEqual([row, dirty, dirty])
    }
  })

  test("staged streams have the same Yoga effect as the original writes", () => {
    const width = (node: number, value: number): Operation => ({ style: props[0], node, unit: c.OT_UNIT_POINT, value })
    const growPaint: Operation[] = [{ paint: { zIndex: 1 }, node: 0 }, width(1, 0), width(1, 20)]
    growPaint.push({ paint: { opacity: 0.5, border: 5 }, node: 0 })
    const scenarios: Operation[][] = [
      // A paint record that grows ahead of an open run shifts it; a Yoga-equal or restored value must not merge.
      [...growPaint, width(1, -0)],
      [...growPaint, width(1, 0)],
      // Accepting part of a run closes it.
      [width(1, 10), width(1, 20), { accept: 0.5 }, width(1, 10)],
    ]
    for (const operations of scenarios) {
      try {
        runOperations(operations)
      } catch (error) {
        throw new Error(`${(error as Error).message}\n${show(operations)}`)
      }
    }
    for (const seed of [1, 2, 3, 4]) {
      const random = createRandom(seed)
      for (let sequence = 0; sequence < 500; sequence++) {
        const operations = randomOperations(random)
        try {
          runOperations(operations)
        } catch (error) {
          throw new Error(`seed ${seed} sequence ${sequence}: ${(error as Error).message}\n${show(operations)}`)
        }
      }
    }
    // Plain point values need at most two records per property run.
    const random = createRandom(5)
    const { group, kind, edge, flags } = props[0]
    for (let sequence = 0; sequence < 200; sequence++) {
      const staging = new SceneStaging(1)
      for (let step = 0; step < 12; step++) {
        staging.stageStyle(
          context,
          nodeAt(1, 1),
          group,
          kind,
          edge,
          c.OT_UNIT_POINT,
          1 + Math.floor(random() * 4),
          flags,
        )
      }
      expect(staging.count).toBeLessThanOrEqual(2)
    }
  })

  const otherContext = Object.freeze({}) as NativeContextHandle
  const rejectingOwner = {
    assertMutable() {
      throw new Error("owner is destroyed")
    },
  }
  const stageWidth = (staging: SceneStaging, node = nodeAt(1, 1), value = 1, target = context) =>
    staging.stageStyle(target, node, c.OT_STYLE_DIMENSION, c.OT_DIMENSION_WIDTH, 0, c.OT_UNIT_POINT, value, 0)
  test.each<[string, (staging: SceneStaging) => unknown, string]>([
    ["an infinite style value", (staging) => stageWidth(staging, nodeAt(1, 1), Infinity), "Scene style value"],
    [
      "a fractional enum value",
      (staging) => staging.stageStyle(context, nodeAt(1, 1), 0, 9, 0, 0, 0.5, 0),
      "enum value",
    ],
    // Packed records hold each field in one byte; a wider value would alias another property.
    ...(
      [
        [256 + c.OT_STYLE_DIMENSION, c.OT_DIMENSION_WIDTH, 0, c.OT_UNIT_POINT],
        [2 ** 31, c.OT_DIMENSION_WIDTH, 0, c.OT_UNIT_POINT],
        [c.OT_STYLE_VALUE, 256 + c.OT_STYLE_VALUE_MARGIN, 0, c.OT_UNIT_POINT],
        [c.OT_STYLE_VALUE, c.OT_STYLE_VALUE_MARGIN, 256, c.OT_UNIT_POINT],
        [c.OT_STYLE_DIMENSION, c.OT_DIMENSION_WIDTH, 0, 256 + c.OT_UNIT_POINT],
      ] as const
    ).map(([group, kind, edge, unit]): [string, (staging: SceneStaging) => unknown, string] => [
      `style fields ${[group, kind, edge, unit]}`,
      (staging) => staging.stageStyle(context, nodeAt(1, 1), group, kind, edge, unit, 1, 0),
      "InvalidArgument",
    ]),
    ["another Context object", (staging) => stageWidth(staging, nodeAt(1, 1), 1, otherContext), "WrongContext"],
    ["another Context id", (staging) => stageWidth(staging, { ...nodeAt(1, 1), contextId: 8n }), "WrongContext"],
    ["a destroyed node's paint", (staging) => staging.stagePaint(context, nodeAt(1, 2), { zIndex: 2 }), "StaleHandle"],
    ["a destroyed paint owner", (staging) => staging.stagePaint(context, nodeAt(2, 1), {}, rejectingOwner), "owner"],
    [
      "a destroyed background owner",
      (staging) => staging.stageBackground(context, nodeAt(2, 1), color(1), rejectingOwner),
      "owner",
    ],
    ["a borrow for another Context", (staging) => staging._views(otherContext), "WrongContext"],
    ["a consume without a borrow", (staging) => staging.consume(0), "not borrowed"],
    [
      "an acknowledged prefix longer than the stream",
      (staging) => {
        staging._views(context)
        staging.consume(3)
      },
      "Invalid scene flush prefix",
    ],
    ["a flush for an unknown Context", (staging) => resolveRenderLib().sceneFlush(context, staging), "WrongContext"],
    [
      "a write during a native flush",
      (staging) => {
        staging._views(context)
        try {
          stageWidth(staging, nodeAt(2, 1))
        } finally {
          staging.consume(0)
        }
      },
      "during a native flush",
    ],
  ])("%s leaves staged records unchanged", (_, call, error) => {
    const staging = new SceneStaging(1)
    stageWidth(staging)
    staging.stagePaint(context, nodeAt(1, 1), { zIndex: 1 })
    const before = readStream(staging)
    expect(() => call(staging)).toThrow(error)
    expect(readStream(staging)).toEqual(before)
    stageWidth(staging, nodeAt(1, 1), 2)
    expect(staging.count).toBe(3)
  })

  test.each([
    ["InvalidArgument", [3]],
    ["WrongKind", [3]],
    ["StaleHandle", [3]],
    ["OutOfMemory", [2, 3]],
    ["ContextBusy", [2, 3]],
    ["ObjectLimit", [2, 3]],
    ["InternalError", [2, 3]],
  ] as const)("a flush that native fails with %s after one record", (status, remaining) => {
    const staging = new SceneStaging(1)
    for (let slot = 1; slot <= 3; slot++) stageWidth(staging, nodeAt(slot, 1))
    // Swap in a native flush that accepts one record and then fails with the status.
    const lib = resolveRenderLib()
    const internals = lib as unknown as { opentui: unknown; nativeContexts: Map<NativeContextHandle, number> }
    const opentui = internals.opentui
    const ot_scene_flush = (_context: unknown, _updates: unknown, _bytes: number, applied: Uint32Array) => {
      applied[0] = 1
      return NativeStatus[status]
    }
    internals.opentui = { symbols: { ot_scene_flush } }
    internals.nativeContexts.set(context, 1)
    try {
      expect(() => lib.sceneFlush(context, staging)).toThrow(`${status} after 1 of 3 staged entries`)
    } finally {
      internals.opentui = opentui
      internals.nativeContexts.delete(context)
    }
    // A record native rejects for its node is dropped; any other failure keeps it for retry.
    expect(readStream(staging).map(({ slot }) => slot)).toEqual([...remaining])
  })

  test("staging bounds its capacity, ignores other Contexts' nodes, and snapshots reentrant paint", () => {
    for (const capacity of [0, 1.5, SceneStaging.limit + 1])
      expect(() => new SceneStaging(capacity)).toThrow(RangeError)
    const staging = new SceneStaging(1)
    for (let slot = 1; slot <= SceneStaging.limit; slot++) stageWidth(staging, nodeAt(slot, 1))
    expect(staging.full).toBe(true)
    expect(() => stageWidth(staging, nodeAt(0, 1))).toThrow("ObjectLimit")
    staging.discard({ ...nodeAt(1, 1), contextId: 8n })
    expect(staging.count).toBe(SceneStaging.limit)
    staging.clear()

    // A getter that stages another node's paint while this paint encodes uses its own scratch record.
    staging.stagePaint(context, nodeAt(1, 1), {
      get zIndex() {
        staging.stagePaint(context, nodeAt(2, 1), { zIndex: 2 })
        return 1
      },
    })
    expect(readStream(staging).map(({ slot, paint }) => [slot, paint!.get(0)])).toEqual([
      [2, [2]],
      [1, [1]],
    ])
  })

  class Custom extends Renderable {
    paint(paint: { border: number }): void {
      this.setNativeScenePaint(paint)
    }
  }
  // Native validates staged records; one it rejects is reported once by the flush, which then applies later records.
  test.each<[string, (node: Custom) => void]>([
    // Only Box paints border sides; the encoder cannot see the node kind.
    ["a border on a non-box", (node) => node.paint({ border: 15 })],
    ["an unknown style group", (node) => renderer!.nativeScene.setStyle(node, 9, 0, 0, 0, 0)],
  ])("a flush rejects %s once and then applies later records", async (_, stage) => {
    const setup = await createTestRenderer({ width: 20, height: 5 })
    renderer = setup.renderer
    const custom = new Custom(renderer, { width: 3, height: 1 })
    const box = new BoxRenderable(renderer, { width: 3, height: 1 })
    renderer.root.add(custom)
    renderer.root.add(box)
    await setup.renderOnce()

    stage(custom)
    box.width = 9
    expect(() => renderer!.nativeScene.flushStaged()).toThrow("InvalidArgument after 0 of 2 staged entries")
    expect(renderer.nativeScene.hasStagedMutations).toBe(true)
    await setup.renderOnce()
    expect(renderer.nativeScene.hasStagedMutations).toBe(false)
    expect(box.width).toBe(9)
    custom.destroy()
  })
})
