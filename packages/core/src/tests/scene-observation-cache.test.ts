import { afterEach, describe, expect, test } from "bun:test"
import { nativeConstants, nativeLayouts } from "../native-abi.generated.js"
import { RGBA } from "../lib/RGBA.js"
import { LayoutEvents, Renderable } from "../Renderable.js"
import { BoxRenderable } from "../renderables/Box.js"
import { createTestRenderer, type TestRenderer } from "../testing.js"
import { SceneStaging, resolveRenderLib, type NativeContextHandle, type SceneNodeHandle } from "../zig.js"

let renderer: TestRenderer | undefined

afterEach(() => {
  renderer?.destroy()
  renderer = undefined
})

describe("scene layout observations", () => {
  test("repeated reads follow frames, host writes, and translations", async () => {
    const setup = await createTestRenderer({ width: 20, height: 5 })
    renderer = setup.renderer
    const box = new BoxRenderable(renderer, { width: 4, height: 1 })
    renderer.root.add(box)
    await setup.renderOnce()

    const first = box.getComputedLayout()
    expect(first.width).toBe(4)
    first.width = 99
    expect(box.getComputedLayout().width).toBe(4)
    expect(box.getComputedLayout()).not.toBe(box.getComputedLayout())
    expect(box.width).toBe(4)

    box.width = 7
    await setup.renderOnce()
    expect(box.getComputedLayout().width).toBe(7)
    expect(box.width).toBe(7)

    box.translateX = 3
    expect(box.x).toBe(3)

    box.destroy()
    expect(() => box.getComputedLayout()).toThrow()
  })

  test("a style set and restored before a frame still runs layout", async () => {
    const setup = await createTestRenderer({ width: 20, height: 5 })
    renderer = setup.renderer
    const box = new BoxRenderable(renderer, { width: 5, height: 1 })
    renderer.root.add(box)
    await setup.renderOnce()
    let changes = 0
    renderer.root.on(LayoutEvents.LAYOUT_CHANGED, () => changes++)
    await setup.renderOnce()
    expect(changes).toBe(0)

    box.width = 10
    box.width = 5
    await setup.renderOnce()
    expect(changes).toBe(1)
    expect(box.width).toBe(5)

    // Values Yoga compares as equal although their bits differ still leave the run dirty.
    for (const writes of [
      [0, 10, -0],
      [-0, 10, 0],
      [{ unit: 0, value: 1 }, 10, { unit: 0, value: 2 }],
      [undefined, 10, { unit: 1, value: NaN }],
    ]) {
      changes = 0
      for (const value of writes) box.setMinWidth(value as never)
      await setup.renderOnce()
      expect(changes).toBe(1)
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
    [
      "an unknown style group",
      (staging) => staging.stageStyle(context, nodeAt(1, 1), 9, 0, 0, 0, 0, 0),
      "InvalidArgument",
    ],
    ["an infinite style value", (staging) => stageWidth(staging, nodeAt(1, 1), Infinity), "Scene style value"],
    [
      "a fractional enum value",
      (staging) => staging.stageStyle(context, nodeAt(1, 1), 0, 9, 0, 0, 0.5, 0),
      "enum value",
    ],
    ["another Context object", (staging) => stageWidth(staging, nodeAt(1, 1), 1, otherContext), "WrongContext"],
    ["another Context id", (staging) => stageWidth(staging, { ...nodeAt(1, 1), contextId: 8n }), "WrongContext"],
    ["a destroyed node's paint", (staging) => staging.stagePaint(context, nodeAt(1, 2), { zIndex: 2 }), "StaleHandle"],
    ["an invalid paint", (staging) => staging.stagePaint(context, nodeAt(1, 1), { opacity: 2 }), "opacity"],
    ["a destroyed paint owner", (staging) => staging.stagePaint(context, nodeAt(2, 1), {}, rejectingOwner), "owner"],
    [
      "a destroyed background owner",
      (staging) => staging.stageBackground(context, nodeAt(2, 1), color(1), rejectingOwner),
      "owner",
    ],
    ["a borrow for another Context", (staging) => staging._views(otherContext), "WrongContext"],
    ["a consume without a borrow", (staging) => staging.consume(0), "not borrowed"],
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

  test("a flush reports a record native rejects once and then applies later records", async () => {
    const setup = await createTestRenderer({ width: 20, height: 5 })
    renderer = setup.renderer
    // Only Box paints border sides; the encoder cannot see the node kind, so native rejects this record.
    class BorderedText extends Renderable {
      stageBorder(): void {
        this.setNativeScenePaint({ border: 15 })
      }
    }
    const custom = new BorderedText(renderer, { width: 3, height: 1 })
    const box = new BoxRenderable(renderer, { width: 3, height: 1 })
    renderer.root.add(custom)
    renderer.root.add(box)
    await setup.renderOnce()

    custom.stageBorder()
    box.width = 9
    expect(() => renderer!.nativeScene.flushStaged()).toThrow("InvalidArgument after 0 of 2 staged entries")
    expect(renderer.nativeScene.hasStagedMutations).toBe(true)
    await setup.renderOnce()
    expect(renderer.nativeScene.hasStagedMutations).toBe(false)
    expect(box.width).toBe(9)
    custom.destroy()
  })
})
