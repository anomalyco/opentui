import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable, KeyEvent, type Renderable } from "@opentui/core"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import * as addons from "../addons/index.js"
import { formatCommandBindings } from "../extras/index.js"
import { getGraphSnapshot } from "../extras/graph.js"
import {
  KEYMAP_EXTENSION_CONTEXT,
  stringifyKeySequence,
  stringifyKeyStroke,
  type ActiveKey,
  type ActiveKeyOptions,
  type BindingParser,
  type Command,
  type ErrorEvent,
  type EventMatchResolverContext,
  type Keymap,
  type Layer,
  type ReactiveMatcher,
  type WarningEvent,
} from "../index.js"
import { createDefaultOpenTuiKeymap, createOpenTuiKeymap } from "../opentui.js"
import { createTestKeymap } from "../testing/index.js"
import { createLayerSlot } from "../services/extension-context.js"
import type { LayerService, LayerSlot } from "../services/layers.js"
import { createDiagnosticHarness } from "./diagnostic-harness.js"
import { createKeymapTestHelpers, type OpenTuiKeymap } from "./keymap.test-support.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()
const {
  createFocusableBox,
  getActiveKey,
  getActiveKeyNames,
  getParserKeymap,
  getKeymap,
  createBareKeymap,
  getCommand,
  getCommandEntry,
  getActiveKeyDisplay,
  captureDiagnostics,
  matchEventAs,
  createBracketTokenParser,
  createReactiveBoolean,
} = createKeymapTestHelpers(diagnostics, () => renderer)

type TestKeymap = ReturnType<typeof createTestKeymap>["keymap"]

// A keymap without a renderer, with the default keys and fields of `createDefaultOpenTuiKeymap`.
function createFieldKeymap() {
  const harness = createTestKeymap({ defaultKeys: true })
  addons.registerEnabledFields(harness.keymap)
  addons.registerMetadataFields(harness.keymap)
  return harness
}

// `useBindings`'s replace, by registration: `undefined` takes a new layer slot, a registered layer its own.
const layerSlots = new WeakMap<object, LayerSlot<any, any>>()
function replaceLayer(
  layers: Pick<LayerService<any, any>, "createSlot" | "replaceLayer">,
  previous: object | undefined,
  layer: Layer<any, any> | undefined,
) {
  const slot = (previous && layerSlots.get(previous)) || layers.createSlot()
  const next = layers.replaceLayer(slot, layer)
  if (next) layerSlots.set(next, slot)
  return next
}

describe("keymap: commands and queries", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })
  test("supports command metadata attributes in active keys and command contexts", () => {
    const keymap = getKeymap(renderer)
    const seen: Record<string, unknown>[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          desc: "Save the current file",
          title: "Save File",
          category: "File",
          run(ctx) {
            seen.push({
              desc: ctx.command?.desc,
              title: ctx.command?.title,
              category: ctx.command?.category,
            })
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "save-file" }],
    })

    const attrs = {
      desc: "Save the current file",
      title: "Save File",
      category: "File",
    }

    const activeKey = getActiveKey(keymap, "x", { includeBindings: true, includeMetadata: true })
    expect(activeKey?.bindings?.[0]?.command).toBe("save-file")
    expect(activeKey?.bindings?.[0]?.commandAttrs).toEqual(attrs)
    expect(activeKey?.command).toBe("save-file")
    expect(activeKey?.commandAttrs).toEqual(attrs)

    mockInput.pressKey("x")

    expect(seen).toEqual([attrs])
  })

  test("getCommands searches names by default and returns raw fields plus compiled attrs", () => {
    const keymap = getParserKeymap()

    keymap.registerCommandFields({
      title(value, ctx) {
        ctx.attr("label", value)
      },
    })

    keymap.registerLayer({
      commands: [
        {
          name: "save-current",
          namespace: "excommands",
          title: "Write File",
          usage: ":write <file>",
          tags: ["file", "write"],
          run() {},
        },
        {
          name: "session-reset",
          namespace: "excommands",
          title: "Reset Counters",
          run() {},
        },
        {
          name: "palette-help",
          namespace: "palette",
          title: "Open Help",
          run() {},
        },
      ],
    })

    expect(keymap.getCommands({ search: "save" }).map((command) => command.name)).toEqual(["save-current"])
    expect(keymap.getCommands({ search: "write" })).toEqual([])
    expect(keymap.getCommands({ search: "write", searchIn: ["title"] }).map((command) => command.name)).toEqual([
      "save-current",
    ])
    expect(keymap.getCommands({ search: "write", searchIn: ["label"] }).map((command) => command.name)).toEqual([
      "save-current",
    ])
    expect(getCommand(keymap, "save-current")).toMatchObject({
      name: "save-current",
      namespace: "excommands",
      title: "Write File",
      usage: ":write <file>",
      tags: ["file", "write"],
    })
  })

  test("getCommands supports namespace and filter queries across raw fields and attrs", () => {
    const keymap = getParserKeymap()

    keymap.registerCommandFields({
      title(value, ctx) {
        ctx.attr("label", value)
      },
    })

    const offCommands = keymap.registerLayer({
      commands: [
        {
          name: "save-current",
          namespace: "excommands",
          title: "Write File",
          usage: ":write <file>",
          tags: ["file", "write"],
          run() {},
        },
        {
          name: "session-reset",
          namespace: "excommands",
          title: "Reset Counters",
          tags: ["session"],
          run() {},
        },
        {
          name: "palette-help",
          namespace: "palette",
          title: "Open Help",
          tags: ["help"],
          run() {},
        },
        {
          name: "untagged-help",
          title: "excommands helper",
          tags: ["help"],
          run() {},
        },
      ],
    })

    expect(keymap.getCommands({ namespace: "excommands" }).map((command) => command.name)).toEqual([
      "save-current",
      "session-reset",
    ])
    expect(keymap.getCommands({ namespace: ["palette", "missing"] }).map((command) => command.name)).toEqual([
      "palette-help",
    ])
    expect(
      keymap
        .getCommands({ namespace: "excommands", search: "reset", searchIn: ["title"] })
        .map((command) => command.name),
    ).toEqual(["session-reset"])
    expect(keymap.getCommands({ filter: { namespace: "excommands" } }).map((command) => command.name)).toEqual([
      "save-current",
      "session-reset",
    ])
    expect(keymap.getCommands({ filter: { tags: "file" } }).map((command) => command.name)).toEqual(["save-current"])
    expect(keymap.getCommands({ filter: { label: "Reset Counters" } }).map((command) => command.name)).toEqual([
      "session-reset",
    ])
    expect(
      keymap
        .getCommands({
          filter: {
            usage(value: unknown, command: Command) {
              return typeof value === "string" && value.includes("<file>") && command.namespace === "excommands"
            },
          },
        })
        .map((command) => command.name),
    ).toEqual(["save-current"])
    expect(
      keymap
        .getCommands({
          namespace: "excommands",
          filter: {
            usage(value: unknown) {
              return typeof value === "string" && value.includes("<file>")
            },
          },
        })
        .map((command) => command.name),
    ).toEqual(["save-current"])
    expect(
      keymap.getCommands({ filter: (command) => command.name === "palette-help" }).map((command) => command.name),
    ).toEqual(["palette-help"])
    expect(
      keymap.getCommands({ filter: { name: ["palette-help", "missing"] } }).map((command) => command.name),
    ).toEqual(["palette-help"])
    expect(
      keymap
        .getCommands({ filter: { name: ["save-current", "palette-help"], namespace: "excommands" } })
        .map((command) => command.name),
    ).toEqual(["save-current"])
    expect(keymap.getCommands({ filter: { name: [] } }).map((command) => command.name)).toEqual([])

    offCommands()

    expect(keymap.getCommands()).toEqual([])
  })

  test("getCommands defaults to reachable commands and supports active and registered visibility", () => {
    const keymap = getKeymap(renderer)

    const target = createFocusableBox("command-visibility-target")
    renderer.root.add(target)

    keymap.registerLayer({
      commands: [
        { name: "save", title: "Global Save", run() {} },
        { name: "quit", title: "Quit", run() {} },
      ],
    })
    keymap.registerLayer({
      target,
      commands: [{ name: "save", title: "Local Save", run() {} }],
    })

    expect(keymap.getCommands().map((command) => command.name)).toEqual(["save", "quit"])
    expect(keymap.getCommands().map((command) => command.title)).toEqual(["Global Save", "Quit"])
    expect(keymap.getCommands({ visibility: "active" }).map((command) => command.title)).toEqual([
      "Global Save",
      "Quit",
    ])
    expect(keymap.getCommands({ visibility: "registered" }).map((command) => command.title)).toEqual([
      "Global Save",
      "Quit",
      "Local Save",
    ])

    target.focus()

    expect(keymap.getCommands().map((command) => command.title)).toEqual(["Local Save", "Quit"])
    expect(keymap.getCommands({ visibility: "active" }).map((command) => command.title)).toEqual([
      "Local Save",
      "Global Save",
      "Quit",
    ])
    expect(keymap.getCommands({ visibility: "registered" }).map((command) => command.title)).toEqual([
      "Global Save",
      "Quit",
      "Local Save",
    ])
  })

  test("getCommandEntries returns commands with bindings across visibility modes", () => {
    const keymap = getKeymap(renderer)
    const target = createFocusableBox("command-entry-visibility-target")
    renderer.root.add(target)

    keymap.registerLayer({
      commands: [
        { name: "save", title: "Global Save", run() {} },
        { name: "quit", title: "Quit", run() {} },
      ],
      bindings: [
        { key: "x", cmd: "save", desc: "Write current file" },
        { key: "q", cmd: "quit", desc: "Quit app" },
      ],
    })
    keymap.registerLayer({
      target,
      commands: [{ name: "save", title: "Local Save", run() {} }],
      bindings: [{ key: "l", cmd: "save", desc: "Save in panel" }],
    })

    const snapshot = (visibility?: "reachable" | "active" | "registered") => {
      return keymap.getCommandEntries(visibility ? { visibility } : undefined).map((entry) => ({
        title: entry.command.title,
        bindings: entry.bindings
          .map((binding) => stringifyKeySequence(binding.sequence, { preferDisplay: true }))
          .sort(),
      }))
    }

    expect(snapshot()).toEqual([
      { title: "Global Save", bindings: ["x"] },
      { title: "Quit", bindings: ["q"] },
    ])

    target.focus()

    expect(snapshot()).toEqual([
      { title: "Local Save", bindings: ["l", "x"] },
      { title: "Quit", bindings: ["q"] },
    ])
    expect(snapshot("active")).toEqual([
      { title: "Local Save", bindings: ["l", "x"] },
      { title: "Global Save", bindings: ["l", "x"] },
      { title: "Quit", bindings: ["q"] },
    ])
    expect(snapshot("registered")).toEqual([
      { title: "Global Save", bindings: ["l", "x"] },
      { title: "Quit", bindings: ["q"] },
      { title: "Local Save", bindings: ["l", "x"] },
    ])
  })

  test("getCommandBindings returns requested command binding groups", () => {
    const keymap = getKeymap(renderer)

    keymap.registerLayer({
      commands: [
        { name: "save", title: "Save", run() {} },
        { name: "quit", title: "Quit", run() {} },
      ],
      bindings: [
        { key: "ctrl+s", cmd: "save", desc: "Save with control" },
        { key: "s", cmd: "save" },
        { key: "q", cmd: "quit" },
        { key: "x", cmd: "unrequested" },
      ],
    })

    const bindings = keymap.getCommandBindings({
      visibility: "registered",
      commands: ["quit", "missing", "save"],
    })

    expect([...bindings.keys()]).toEqual(["quit", "missing", "save"])
    expect(bindings.get("quit")?.map((binding) => stringifyKeySequence(binding.sequence))).toEqual(["q"])
    expect(bindings.get("missing")).toEqual([])
    expect(bindings.get("save")?.map((binding) => stringifyKeySequence(binding.sequence))).toEqual(["ctrl+s", "s"])
    expect(bindings.get("save")?.[0]).toMatchObject({
      command: "save",
      commandAttrs: {
        title: "Save",
      },
      attrs: {
        desc: "Save with control",
      },
      event: "press",
      preventDefault: true,
      fallthrough: false,
    })
  })

  test("getCommandBindings collapses duplicate command records without duplicating bindings", () => {
    const keymap = getKeymap(renderer)

    keymap.registerLayer({
      commands: [{ name: "duplicate", title: "First", run() {} }],
      bindings: [{ key: "a", cmd: "duplicate" }],
    })
    keymap.registerLayer({
      commands: [{ name: "duplicate", title: "Second", run() {} }],
      bindings: [{ key: "b", cmd: "duplicate" }],
    })

    expect(
      keymap
        .getCommandEntries({ visibility: "registered", filter: { name: "duplicate" } })
        .map((entry) => entry.bindings.map((binding) => stringifyKeySequence(binding.sequence))),
    ).toEqual([
      ["a", "b"],
      ["a", "b"],
    ])
    expect(
      keymap
        .getCommandBindings({ visibility: "registered", commands: ["duplicate"] })
        .get("duplicate")
        ?.map((binding) => stringifyKeySequence(binding.sequence)),
    ).toEqual(["a", "b"])
  })

  test("getCommandBindings respects registered and active visibility", () => {
    const keymap = getKeymap(renderer)
    const target = createFocusableBox("command-binding-visibility-target")
    renderer.root.add(target)

    keymap.registerLayer({
      commands: [{ name: "save", title: "Global Save", run() {} }],
      bindings: [{ key: "x", cmd: "save" }],
    })
    keymap.registerLayer({
      target,
      commands: [{ name: "save", title: "Local Save", run() {} }],
      bindings: [{ key: "l", cmd: "save" }],
    })

    const labels = (visibility?: "reachable" | "active" | "registered") => {
      return keymap
        .getCommandBindings({ visibility, commands: ["save"] })
        .get("save")
        ?.map((binding) => stringifyKeySequence(binding.sequence))
    }

    expect(labels()).toEqual(["x"])
    expect(labels("active")).toEqual(["x"])
    expect(labels("registered")).toEqual(["x", "l"])

    target.focus()

    expect(labels()).toEqual(["l", "x"])
    expect(labels("active")).toEqual(["l", "x"])
    expect(labels("registered")).toEqual(["x", "l"])
  })

  test("getCommandBindings filters inactive bindings outside registered visibility", () => {
    const keymap = getKeymap(renderer)
    let enabled = false

    keymap.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap binding field "active" must be true')
        }

        ctx.activeWhen(() => enabled)
      },
    })
    keymap.registerLayer({
      commands: [{ name: "conditional", run() {} }],
      bindings: [{ key: "x", cmd: "conditional", active: true }],
    })

    const labels = (visibility?: "reachable" | "active" | "registered") => {
      return keymap
        .getCommandBindings({ visibility, commands: ["conditional"] })
        .get("conditional")
        ?.map((binding) => stringifyKeySequence(binding.sequence))
    }

    expect(labels()).toEqual([])
    expect(labels("active")).toEqual([])
    expect(labels("registered")).toEqual(["x"])

    enabled = true

    expect(labels()).toEqual(["x"])
    expect(labels("active")).toEqual(["x"])
  })

  test("getCommandBindings includes registered bindings and applies resolver visibility", () => {
    const keymap = getKeymap(renderer)

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "external-run" }],
    })

    const labels = (visibility?: "reachable" | "active" | "registered") => {
      return keymap
        .getCommandBindings({ visibility, commands: ["external-run"] })
        .get("external-run")
        ?.map((binding) => stringifyKeySequence(binding.sequence))
    }

    expect(labels("registered")).toEqual(["x"])
    expect(labels()).toEqual([])

    keymap.appendCommandResolver((command) => {
      if (command !== "external-run") {
        return undefined
      }

      return {
        name: command,
        title: "External Run",
        run() {},
      }
    })

    const activeBindings = keymap.getCommandBindings({ commands: ["external-run"] }).get("external-run")

    expect(activeBindings?.map((binding) => stringifyKeySequence(binding.sequence))).toEqual(["x"])
    expect(activeBindings?.[0]?.commandAttrs).toEqual({ title: "External Run" })
  })

  test("getCommandEntries reuses active binding views and keeps command-only entries", () => {
    const keymap = getKeymap(renderer)

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          desc: "Save the current file",
          title: "Save File",
          category: "File",
          run() {},
        },
        {
          name: "palette-help",
          title: "Open Help",
          run() {},
        },
      ],
      bindings: [{ key: "x", cmd: "save-file", desc: "Write current file", group: "File" }],
    })

    const save = getCommandEntry(keymap, "save-file")
    expect(save).toMatchObject({
      command: {
        name: "save-file",
        desc: "Save the current file",
        title: "Save File",
        category: "File",
      },
      bindings: [
        {
          sequence: save?.bindings[0]?.sequence,
          command: "save-file",
          commandAttrs: {
            desc: "Save the current file",
            title: "Save File",
            category: "File",
          },
          attrs: {
            desc: "Write current file",
            group: "File",
          },
          event: "press",
          preventDefault: true,
          fallthrough: false,
        },
      ],
    })

    expect(getCommandEntry(keymap, "palette-help")).toMatchObject({
      command: {
        name: "palette-help",
        title: "Open Help",
      },
      bindings: [],
    })
  })

  test("getCommandEntries applies command query filters before attaching bindings", () => {
    const keymap = getParserKeymap()

    keymap.registerCommandFields({
      title(value, ctx) {
        ctx.attr("label", value)
      },
    })

    keymap.registerLayer({
      commands: [
        {
          name: "save-current",
          namespace: "excommands",
          title: "Write File",
          usage: ":write <file>",
          run() {},
        },
        {
          name: "palette-help",
          namespace: "palette",
          title: "Open Help",
          usage: ":help",
          run() {},
        },
      ],
      bindings: [
        { key: "x", cmd: "save-current" },
        { key: "h", cmd: "palette-help" },
      ],
    })

    expect(
      keymap
        .getCommandEntries({ namespace: "excommands", search: "write", searchIn: ["title", "label"] })
        .map((entry) => ({
          name: entry.command.name,
          bindings: entry.bindings.map((binding) => stringifyKeySequence(binding.sequence, { preferDisplay: true })),
        })),
    ).toEqual([
      {
        name: "save-current",
        bindings: ["x"],
      },
    ])
  })

  test("getCommandEntries supports result limits", () => {
    const keymap = getParserKeymap()

    keymap.registerLayer({
      commands: [
        { name: "alpha", run() {} },
        { name: "beta", run() {} },
        { name: "gamma", run() {} },
      ],
      bindings: [
        { key: "a", cmd: "alpha" },
        { key: "b", cmd: "beta" },
        { key: "g", cmd: "gamma" },
      ],
    })

    expect(keymap.getCommandEntries({ visibility: "registered", limit: 2 }).map((entry) => entry.command.name)).toEqual(
      ["alpha", "beta"],
    )
    expect(keymap.getCommandEntries({ visibility: "registered", limit: 0 })).toEqual([])
  })

  test("getCommands treats thrown filter predicates as errors and returns no matches", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.registerLayer({
      commands: [
        { name: "save-current", usage: ":write <file>", run() {} },
        { name: "palette-help", usage: ":help", run() {} },
      ],
    })

    let queryResult: ReturnType<OpenTuiKeymap["getCommands"]> = []

    expect(() => {
      queryResult = keymap.getCommands({
        filter(command) {
          throw new Error(`query ${command.name}`)
        },
      })
    }).not.toThrow()

    expect(queryResult).toEqual([])
    expect(takeErrors().errors).toEqual([
      "[Keymap] Error in command query filter:",
      "[Keymap] Error in command query filter:",
    ])

    expect(() => {
      queryResult = keymap.getCommands({
        filter: {
          usage() {
            throw new Error("usage boom")
          },
        },
      })
    }).not.toThrow()

    expect(queryResult).toEqual([])
    expect(takeErrors().errors).toEqual([
      "[Keymap] Error in command query filter:",
      "[Keymap] Error in command query filter:",
    ])
  })

  test("failed command registration does not reserve the command name", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerCommandFields({
      broken() {
        throw new Error("broken command field")
      },
    })

    keymap.registerLayer({
      commands: [
        {
          name: "retry-command",
          broken: true,
          run() {
            calls.push("broken")
          },
        },
        {
          name: "retry-command",
          run() {
            calls.push("registered")
          },
        },
      ],
    })

    expect(keymap.getCommands().map((command) => command.name)).toEqual(["retry-command"])
    expect(keymap.runCommand("retry-command")).toEqual({ ok: true })
    expect(calls).toEqual(["registered"])
    expect(takeErrors().errors).toEqual(["broken command field"])
  })

  test("replacing a layer costs state events, entries, and labels only when its content changes", () => {
    // Object-valued fields keep their identity on a replace, so unchanged layers reuse one `tags` array.
    const tags: string[] = []
    const layerOf = (layer: number, commands: number, change?: string) => ({
      commands: Array.from({ length: commands + (change === "command added" ? 1 : 0) }, (_, c) => ({
        name: `l${layer}.c${c}`,
        tags: change === "array to object" ? {} : tags,
        run() {},
      })),
      bindings: [
        ...Array.from({ length: commands }, (_, c) => ({
          // A binding key compiles into a key sequence and compares by content, so a fresh key object is unchanged.
          key:
            c === 0 && change === "changed binding"
              ? "ctrl+shift+a"
              : c === 1
                ? { name: "b", ctrl: true }
                : `ctrl+${"abcdefghij"[c]}`,
          cmd: `l${layer}.c${c}`,
          ...(c === 0 && change === "binding field added" ? { desc: "d" } : {}),
        })),
        ...(change === "binding added" ? [{ key: "ctrl+z", cmd: `l${layer}.c0` }] : []),
      ],
    })
    // Layer 0, the oldest, is replaced and keeps its position. `work` is state events, entries built, and
    // labels formatted by a `state` listener.
    const rows = [
      { change: "identical", layers: 3, commands: 4, work: [0, 0, 0] },
      { change: "identical", layers: 6, commands: 4, work: [0, 0, 0] },
      { change: "fresh functions", layers: 3, commands: 4, work: [0, 0, 0] },
      { change: "fresh functions", layers: 3, commands: 8, work: [0, 0, 0] },
      { change: "changed binding", layers: 3, commands: 4, work: [1, 12, 12] },
      { change: "changed binding", layers: 6, commands: 4, work: [1, 24, 24] },
      { change: "binding added", layers: 3, commands: 4, work: [1, 12, 13] },
      { change: "command added", layers: 3, commands: 4, work: [1, 13, 12] },
      { change: "binding field added", layers: 3, commands: 4, work: [1, 12, 12] },
      { change: "array to object", layers: 3, commands: 4, work: [1, 12, 12] },
      { change: "removed", layers: 3, commands: 4, work: [1, 8, 8] },
      { change: "removed", layers: 3, commands: 8, work: [1, 16, 16] },
    ] as const

    for (const row of rows) {
      const { keymap } = createFieldKeymap()
      const { layers } = keymap[KEYMAP_EXTENSION_CONTEXT]()
      const first = layerOf(0, row.commands)
      const replaced = replaceLayer(layers, undefined, first)
      for (let layer = 1; layer < row.layers; layer += 1) replaceLayer(layers, undefined, layerOf(layer, row.commands))

      const work = [0, 0, 0]
      const countLabels = new Proxy({}, { get: () => void (work[2]! += 1) })
      keymap.on("state", () => {
        work[0]! += 1
        for (const entry of keymap.getCommandEntries()) {
          work[1]! += 1
          formatCommandBindings(entry.bindings, { keyNameAliases: countLabels })
        }
      })

      const next = { identical: first, removed: undefined }[row.change as string]
      replaceLayer(
        layers,
        replaced,
        row.change in { identical: 1, removed: 1 } ? next : layerOf(0, row.commands, row.change),
      )

      expect({ change: row.change, work }).toEqual({ change: row.change, work: [...row.work] })
      const kept = Array.from({ length: row.layers }, (_, layer) => layer).filter(
        (layer) => layer > 0 || row.change !== "removed",
      )
      const names = (order: number[]) => order.map((layer) => `l${layer}.c1`)
      const reachable = keymap.getCommands().map((command) => command.name)
      const registered = keymap.getCommands({ visibility: "registered" }).map((command) => command.name)
      expect(reachable.filter((name) => name.endsWith(".c1"))).toEqual(names(kept.toReversed()))
      expect(registered.filter((name) => name.endsWith(".c1"))).toEqual(names(kept))
      expect(keymap.getActiveKeys().find((key) => key.stroke.name === "b")?.command).toBe(`l${row.layers - 1}.c1`)
    }
  })

  test("a replace keeps a plain-data layer's objects and fully replaces anything else", () => {
    const calls: string[] = []
    const command = (label: string, extra: object = {}) => ({ name: "c", run: () => void calls.push(label), ...extra })
    const getter = (label: string) => ({
      name: "c",
      get title() {
        return "t"
      },
      run: () => void calls.push(label),
    })
    const hidden = (label: string) =>
      Object.defineProperty({ name: "c" }, "run", { value: () => void calls.push(label) })
    const tagged = (label: string) => Object.assign(() => void calls.push(label), { tag: label })
    const throwing = (target: object, when: () => boolean) =>
      new Proxy(target, {
        ownKeys: (target) => {
          if (when()) throw new Error("unreadable")
          return Reflect.ownKeys(target)
        },
      })
    const nested = (depth: number): object => (depth === 0 ? {} : { inner: nested(depth - 1) })
    const cyclic = () => {
      const meta: Record<string, unknown> = {}
      meta.self = meta
      return meta
    }
    let reads = 0
    // Reports static descriptors, but every read of `title` once armed returns a new value.
    const counting = (target: object) =>
      new Proxy(target, { get: (target, key) => (key === "title" && armed ? `t${reads++}` : Reflect.get(target, key)) })
    const symbol = Symbol("field")
    const meta = { label: "a" }
    const nullPrototype = Object.create(null)
    const [deep12, deep13] = [nested(12), nested(13)]
    const map = new Map()
    class Tags extends Array {}
    let armed = false
    let flag = true
    const enabled = () => flag
    // [state events, calls of `runCommand`, of a `run` read before the replace and of its `meta.call`, visible
    // commands]. A kept layer's retained objects call the new functions; a replaced layer's are the caller's.
    const outcomes = {
      kept: [0, ["new", "new"], 1],
      "kept, now disabled": [1, ["new", "new"], 0],
      "kept, enabled again": [1, ["new", "new"], 1],
      "replaced, retained meta": [1, ["new", "old", "meta old"], 1],
      replaced: [1, ["new", "old"], 1],
      "replaced, now disabled": [1, ["new", "old"], 0],
    }
    const rows: [string, object, object, keyof typeof outcomes][] = [
      ["fresh functions", command("old"), command("new"), "kept"],
      [
        "same null-prototype object",
        command("old", { meta: nullPrototype }),
        command("new", { meta: nullPrototype }),
        "kept",
      ],
      // Object-valued fields compare by identity, as on main: a fresh object is a change, even if equal.
      [
        "fresh object in a field",
        command("old", { meta: { call: () => void calls.push("meta old") } }),
        command("new", { meta: { call: () => void calls.push("meta new") } }),
        "replaced, retained meta",
      ],
      ["proxy that ignores writes", new Proxy(command("old"), { set: () => true }), command("new"), "kept"],
      // The kept layer is not read again, so a proxy that later throws does not matter.
      ["proxy that throws once registered", throwing(command("old"), () => armed), command("new"), "kept"],
      ["enabled same result", command("old", { enabled: () => true }), command("new", { enabled: () => true }), "kept"],
      [
        "enabled flips",
        command("old", { enabled: () => true }),
        command("new", { enabled: () => false }),
        "kept, now disabled",
      ],
      [
        "shared flag flips, fresh closure",
        command("old", { enabled: () => flag }),
        command("new", { enabled: () => flag }),
        "kept, now disabled",
      ],
      [
        "shared flag flips, same function",
        command("old", { enabled }),
        command("new", { enabled }),
        "kept, now disabled",
      ],
      [
        "shared flag flips back after an event",
        command("old", { enabled }),
        command("new", { enabled }),
        "kept, enabled again",
      ],
      // One row per rule that the plain-data check enforces.
      ["class instance", command("old", { meta: new Map() }), command("new", { meta: new Map() }), "replaced"],
      [
        "array subclass",
        command("old", { tags: Tags.from([1]) }),
        command("new", { tags: Tags.from([1]) }),
        "replaced",
      ],
      ["symbol key", command("old", { [symbol]: 1 }), command("new", { [symbol]: 1 }), "replaced"],
      [
        "symbol key on an array",
        command("old", { tags: Object.assign([1], { [symbol]: 1 }) }),
        command("new", { tags: Object.assign([1], { [symbol]: 1 }) }),
        "replaced",
      ],
      ["getter", getter("old"), getter("new"), "replaced"],
      ["plain after a getter", getter("old"), command("new", { title: "t" }), "replaced"],
      ["non-enumerable key", hidden("old"), hidden("new"), "replaced"],
      [
        "frozen object",
        command("old", { meta: Object.freeze({}) }),
        command("new", { meta: Object.freeze({}) }),
        "replaced",
      ],
      [
        "sealed object",
        command("old", { meta: Object.seal({}) }),
        command("new", { meta: Object.seal({}) }),
        "replaced",
      ],
      ["function with properties", { name: "c", run: tagged("old") }, { name: "c", run: tagged("new") }, "replaced"],
      // `meta` sits at depth 3 of the layer: 12 more levels end at depth 15, 13 at depth 16.
      ["depth 15", command("old", { meta: deep12 }), command("new", { meta: deep12 }), "kept"],
      ["deeper than 15", command("old", { meta: deep13 }), command("new", { meta: deep13 }), "replaced"],
      ["cycle", command("old", { meta: cyclic() }), command("new", { meta: cyclic() }), "replaced"],
      [
        "own __proto__ key",
        command("old", JSON.parse('{"__proto__":1}')),
        command("new", JSON.parse('{"__proto__":1}')),
        "replaced",
      ],
      [
        "proxy whose reads change",
        counting(command("old", { title: "t" })),
        counting(command("new", { title: "t" })),
        "replaced",
      ],
      [
        "reading it throws",
        command("old", { meta: throwing({}, () => true) }),
        command("new", { meta: throwing({}, () => true) }),
        "replaced",
      ],
      // A field holding the same object is unchanged, even if mutated in place (identity, as on main's API);
      // a non-plain object is never kept.
      ["same object mutated in place", command("old", { meta }), command("new", { meta }), "kept"],
      ["map mutated in place", command("old", { meta: map }), command("new", { meta: map }), "replaced"],
      ["function to string", command("old", { label: () => "d" }), command("new", { label: "d" }), "replaced"],
      [
        "enabled to boolean",
        command("old", { enabled: () => true }),
        command("new", { enabled: false }),
        "replaced, now disabled",
      ],
    ]

    for (const [change, first, next, outcome] of rows) {
      const { keymap } = createFieldKeymap()
      const { layers } = keymap[KEYMAP_EXTENSION_CONTEXT]()
      armed = false
      flag = true
      const copies = [{ ...first }, { ...next }]
      const registered = replaceLayer(layers, undefined, { commands: [first as never] })
      const retained = keymap.getCommands({ visibility: "registered" })[0]!
      // A reader reads the reachable commands, and so the `enabled` results.
      keymap.getCommands()
      const retainedRun = retained.run
      let events = 0
      keymap.on("state", () => void (events += 1))
      armed = true
      if (change === "same object mutated in place") meta.label = "b"
      if (change === "map mutated in place") map.set("key", 1)
      if (change.startsWith("shared flag")) flag = false
      if (change === "shared flag flips back after an event") {
        keymap.setData("unrelated", 1)
        // A reader reads again at the event and sees the command disabled.
        keymap.getCommands()
        flag = true
      }

      events = 0
      replaceLayer(layers, registered, { commands: [next as never] })
      calls.length = 0
      keymap.runCommand("c")
      retained.run({} as never)
      // A kept command keeps its forwarding methods.
      if (outcome.startsWith("kept")) expect([change, retained.run === retainedRun]).toEqual([change, true])
      ;(retained.meta as { call?: () => void } | undefined)?.call?.()
      expect([change, events, calls, keymap.getCommands().length]).toEqual([change, ...outcomes[outcome]])
      // A command that is not plain data is handed out as it is, with its symbol keys and function properties.
      if (change === "symbol key") expect((retained as unknown as Record<symbol, unknown>)[symbol]).toBe(1)
      if (change === "function with properties") expect((retained.run as { tag?: unknown }).tag).toBeDefined()
      armed = false
      expect([{ ...first }, { ...next }]).toEqual(copies)
    }
  })

  test("an identical replace keeps the layer's order and the latest inline handlers, also after a recompile", () => {
    const keymap = getKeymap(renderer)
    const { layers } = keymap[KEYMAP_EXTENSION_CONTEXT]()
    const calls: string[] = []
    const orders: number[][] = []
    keymap.on("dispatch", (event) => {
      if (event.layer && event.binding) orders.push([event.layer.order, event.binding.sourceLayerOrder])
    })
    // A layer `enabled` function sits in the frozen layer fields as a forwarder, so the layer is still kept.
    const layerOf = (version: string) => ({
      enabled: () => true,
      bindings: [{ key: "y", cmd: () => void calls.push(version) }],
    })

    const registered = replaceLayer(layers, undefined, layerOf("old"))
    replaceLayer(layers, undefined, { bindings: [{ key: "z", cmd: () => {} }] })
    getActiveKey(keymap, "y")
    expect(replaceLayer(layers, registered, layerOf("new"))).toBe(registered)

    mockInput.pressKey("y")
    ;(getActiveKey(keymap, "y")!.command as () => void)()
    keymap.appendDisambiguationResolver(() => undefined)
    mockInput.pressKey("y")
    // After the recompile, active keys hold the binding's forwarder again, so a later replace reaches them.
    const recompiled = getActiveKey(keymap, "y")!.command as () => void
    replaceLayer(layers, registered, layerOf("newest"))
    recompiled()
    expect(calls).toEqual(["new", "new", "new", "newest"])
    expect(orders).toEqual([
      [0, 0],
      [0, 0],
    ])
  })

  test("the plain-data check covers the layer object itself", () => {
    const commands = (...names: string[]) => names.map((name) => ({ name, run() {} }))
    const shared = { name: "c", meta: { label: "a" }, run() {} }
    const hidden = (key: string, value: unknown, layer: object = { commands: commands("c") }) =>
      Object.defineProperty(layer, key, { value })
    const rows: [string, () => object, () => object, string[]][] = [
      [
        "getter",
        () => ({
          get priority() {
            return 0
          },
          commands: commands("c"),
        }),
        () => ({
          get priority() {
            return 0
          },
          commands: commands("c"),
        }),
        ["c"],
      ],
      [
        "frozen layer",
        () => Object.freeze({ commands: commands("c") }),
        () => Object.freeze({ commands: commands("c") }),
        ["c"],
      ],
      ["non-enumerable priority", () => hidden("priority", 0), () => hidden("priority", 10), ["c"]],
      // A frozen layer is not plain data, so the next layer is registered anew even though it is plain.
      [
        "frozen layer, then its data changed in place",
        () => Object.freeze({ commands: [shared] }),
        () => {
          shared.meta.label = "b"
          return { commands: [shared] }
        },
        ["c"],
      ],
      [
        "non-enumerable commands",
        () => hidden("commands", commands("c"), {}),
        () => hidden("commands", commands("c", "d"), {}),
        ["c", "d"],
      ],
    ]

    for (const [change, first, next, names] of rows) {
      const { keymap } = createFieldKeymap()
      const { layers } = keymap[KEYMAP_EXTENSION_CONTEXT]()
      const registered = replaceLayer(layers, undefined, first() as never)
      let events = 0
      keymap.on("state", () => void (events += 1))

      const layer = next() as { commands: object[] }
      replaceLayer(layers, registered, layer as never)
      const registeredCommands = keymap.getCommands({ visibility: "registered" })
      const plainNext = change.startsWith("frozen layer, then")
      const sameObjects = plainNext || registeredCommands.every((command, index) => command === layer.commands[index])
      expect([change, events, registeredCommands.map(({ name }) => name), sameObjects]).toEqual([
        change,
        1,
        names,
        true,
      ])
    }
  })

  test("a replace compares the target by identity and the compiled layer by content", () => {
    const keymap = getKeymap(renderer)
    const plain = createTestKeymap()
    const first = createFocusableBox("first")
    const layerOf = (target: object, key = "x") => ({
      target,
      commands: [{ name: "c", run() {} }],
      bindings: [{ key, cmd: "c" }],
    })
    const counts: Record<string, number> = {}
    const replaceIn = (target: typeof keymap | typeof plain.keymap, step: string, steps: [string, () => object][]) => {
      const { layers } = target[KEYMAP_EXTENSION_CONTEXT]()
      let registered: unknown
      let events = 0
      target.on("state", () => void (events += 1))
      for (const [name, layer] of steps) {
        events = 0
        registered = replaceLayer(layers, registered as never, layer() as never)
        if (name) counts[`${step} ${name}`] = events
      }
    }
    let titles = 0
    let keys = 0

    replaceIn(keymap, "renderable", [
      ["", () => layerOf(first)],
      ["same", () => layerOf(first)],
      ["other", () => layerOf(createFocusableBox("second"))],
    ])
    replaceIn(plain.keymap, "plain target", [
      ["", () => layerOf({ id: "t" })],
      ["deeply equal", () => layerOf({ id: "t" })],
    ])
    const impure = getKeymap(renderer)
    impure.appendCommandTransformer((command) => void (command.title = `title ${titles++}`))
    impure.appendLayerBindingsTransformer((bindings) =>
      bindings.map((binding) => ({ ...binding, key: keys++ === 0 ? "x" : "y" })),
    )
    const cyclic = getKeymap(renderer)
    cyclic.appendCommandTransformer((command) => {
      const meta: Record<string, unknown> = {}
      command.meta = Object.assign(meta, { self: meta })
    })
    replaceIn(cyclic, "cyclic transformer output", [
      ["", () => layerOf(first)],
      ["again", () => layerOf(first)],
    ])
    replaceIn(impure, "impure transformers", [
      ["", () => layerOf(first, "q")],
      ["first", () => layerOf(first, "q")],
      ["second", () => layerOf(first, "q")],
    ])
    plain.cleanup()

    expect(counts).toEqual({
      "renderable same": 0,
      "renderable other": 1,
      "plain target deeply equal": 1,
      "cyclic transformer output again": 1,
      "impure transformers first": 1,
      "impure transformers second": 1,
    })
    const registered = impure.getCommandEntries({ visibility: "registered" })
    const used = registered.map(({ command, bindings }) => [command.title, stringifyKeySequence(bindings[0]!.sequence)])
    expect(used).toEqual([["title 2", "y"]])
  })

  test("compile hooks that make the compiled layer not plain data cause a full replace", () => {
    const calls: string[] = []
    let compiles = 0
    let getterRuns = 0
    const attr = (value: (compile: number) => unknown) => (keymap: TestKeymap) =>
      keymap.registerCommandFields({ meta: (_value, ctx) => ctx.attr("meta", value(compiles++)) })
    const map = new Map<string, number>()
    const throwing = new Proxy(
      { label: "" },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("unreadable")
        },
      },
    )
    // Each hook runs on both compiles. Commands that are not plain data are handed out as they are; other
    // compiled values that are not plain data compare unequal, without running getters.
    const hooks: [string, (keymap: TestKeymap) => void][] = [
      [
        "prototype run",
        (keymap) =>
          keymap.appendCommandTransformer((command) => {
            const { run } = command
            delete (command as { run?: unknown }).run
            Object.setPrototypeOf(command, { run })
          }),
      ],
      [
        "non-enumerable run",
        (keymap) =>
          keymap.appendCommandTransformer((command) => {
            Object.defineProperty(command, "run", { value: command.run, enumerable: false })
          }),
      ],
      [
        "command field whose descriptors throw",
        (keymap) => keymap.appendCommandTransformer((command) => void (command.meta = throwing)),
      ],
      ["map attr changed in place", attr((compile) => map.set("compiles", compile))],
      ["function attr with properties", attr(() => Object.assign(() => {}, { tag: 1 }))],
      [
        "getter attr in both layers",
        attr(() => ({
          get label() {
            return String(getterRuns++)
          },
        })),
      ],
      // A fresh attr object is a change (identity); the comparison does not run its trap.
      ["attr proxy whose reads run code", attr(() => new Proxy({ label: "0" }, { get: () => String(getterRuns++) }))],
      [
        "getter attr in the kept layer",
        attr((compile) =>
          compile === 0
            ? {
                get label() {
                  return String(getterRuns++)
                },
              }
            : { label: "0" },
        ),
      ],
      ["attr whose descriptors throw", attr(() => throwing)],
    ]

    for (const [hook, install] of hooks) {
      const { keymap } = createFieldKeymap()
      const { layers } = keymap[KEYMAP_EXTENSION_CONTEXT]()
      install(keymap)
      compiles = 0
      const layerOf = (label: string) => ({ commands: [{ name: "c", meta: 1, run: () => void calls.push(label) }] })
      const registered = replaceLayer(layers, undefined, layerOf("old"))
      let events = 0
      keymap.on("state", () => void (events += 1))

      replaceLayer(layers, registered, layerOf("new"))
      calls.length = 0
      keymap.runCommand("c")
      // The same object in both compiles (unreadable, or a Map changed in place) is unchanged by identity,
      // as on main's API, so that layer is kept without reading it.
      const same = [
        "command field whose descriptors throw",
        "map attr changed in place",
        "attr whose descriptors throw",
      ]
      const expectedEvents = same.includes(hook) ? 0 : 1
      expect([hook, events, calls, getterRuns]).toEqual([hook, expectedEvents, ["new"], 0])
    }
  })

  test("a layer read through a proxy is kept only when what it compiled to is unchanged", () => {
    const keymap = getKeymap(renderer)
    const { layers } = keymap[KEYMAP_EXTENSION_CONTEXT]()
    let reads = 0
    // The check and the compile read the proxy separately; every read of `title` returns a new value.
    const layerOf = () => ({
      commands: [
        new Proxy(
          { name: "c", title: "t", run() {} },
          { get: (target, key) => (key === "title" ? `t${reads++}` : Reflect.get(target, key)) },
        ),
      ],
    })
    let events = 0
    keymap.on("state", () => void (events += 1))

    let registered = replaceLayer(layers, undefined, layerOf())
    const seen: unknown[] = []
    for (let step = 0; step < 2; step += 1) {
      events = 0
      registered = replaceLayer(layers, registered, layerOf())
      const title = keymap.getCommands()[0]!.title as string
      // The kept command is the copy the compile made from its last read.
      seen.push([events, title === `t${reads - 1}`])
    }
    expect(seen).toEqual([
      [1, true],
      [1, true],
    ])
  })

  test("compiled values the API exposes compare by identity, whatever the compile read", () => {
    const requirement = { id: 1 }
    const gate = () => true
    const fresh = () => ({ id: 1 })
    const rows: [
      string,
      (keymap: TestKeymap) => void,
      (label: string, compile: number) => object,
      (keymap: TestKeymap) => unknown,
    ][] = [
      [
        "command attr from a field compiler",
        (keymap) => keymap.registerCommandFields({ meta: (_value, ctx) => ctx.attr("meta", fresh()) }),
        () => ({ commands: [{ name: "c", meta: 1, run() {} }], bindings: [{ key: "x", cmd: "c" }] }),
        (keymap) => keymap.getActiveKeys({ includeMetadata: true })[0]?.commandAttrs?.meta,
      ],
      [
        "requirement from a field compiler",
        (keymap) =>
          keymap.registerCommandFields({
            audience: (_value, ctx) => ctx.require("audience", compiles++ === 0 ? requirement : fresh()),
          }),
        () => ({ commands: [{ name: "c", audience: 1, run() {} }] }),
        (keymap) => keymap.dispatchCommand("c").ok,
      ],
      [
        "binding attr from a field compiler",
        (keymap) => keymap.registerBindingFields({ meta: (_value, ctx) => ctx.attr("meta", fresh()) }),
        () => ({ commands: [{ name: "c", run() {} }], bindings: [{ key: "x", cmd: "c", meta: 1 }] }),
        (keymap) => keymap.getCommandBindings({ commands: ["c"] }).get("c")?.[0]?.attrs?.meta,
      ],
      [
        // A function in the frozen binding attrs cannot move, so the layer is replaced.
        "function binding attr from a field compiler",
        (keymap) => keymap.registerBindingFields({ meta: (_value, ctx) => ctx.attr("meta", () => {}) }),
        () => ({ commands: [{ name: "c", run() {} }], bindings: [{ key: "x", cmd: "c", meta: 1 }] }),
        (keymap) => keymap.getCommandBindings({ commands: ["c"] }).get("c")?.[0]?.attrs?.meta,
      ],
      [
        "command field from a command transformer",
        (keymap) =>
          keymap.appendCommandTransformer((command) => void (command.meta = compiles++ === 0 ? requirement : fresh())),
        () => ({ commands: [{ name: "c", run() {} }] }),
        (keymap) => keymap.getCommands({ filter: { meta: requirement } }).length,
      ],
      [
        // A requirement compares data by identity; a fresh function is a different requirement.
        "requirement from a fresh function",
        (keymap) => {
          keymap.registerCommandFields({ gate: (value, ctx) => ctx.require("gate", value) })
          keymap.setData("gate", gate)
        },
        (_label, compile) => ({ commands: [{ name: "c", gate: compile === 0 ? gate : () => true, run() {} }] }),
        (keymap) => keymap.dispatchCommand("c").ok,
      ],
      [
        "layer requirement from a field compiler",
        (keymap) =>
          keymap.registerLayerFields({
            audience: (_value, ctx) => ctx.require("audience", compiles++ === 0 ? requirement : fresh()),
          }),
        () => ({ audience: 1, commands: [{ name: "c", run() {} }] }),
        (keymap) => keymap.dispatchCommand("c").ok,
      ],
      [
        // The check reads `audience` once; later reads (the compile) return an equal new object.
        "requirement read through a proxy",
        (keymap) => keymap.registerCommandFields({ audience: (value, ctx) => ctx.require("audience", value) }),
        (_label, compile) => {
          let reads = 0
          const command = { name: "c", audience: requirement, run() {} }
          if (compile === 0) return { commands: [command] }
          return {
            commands: [
              new Proxy(command, {
                get: (target, key) => (key === "audience" && reads++ > 1 ? fresh() : Reflect.get(target, key)),
              }),
            ],
          }
        },
        (keymap) => keymap.dispatchCommand("c").ok,
      ],
    ]
    let compiles = 0

    for (const [change, install, layerOf, observe] of rows) {
      const { keymap } = createFieldKeymap()
      const { layers } = keymap[KEYMAP_EXTENSION_CONTEXT]()
      install(keymap)
      keymap.setData("audience", requirement)
      compiles = 0
      const registered = replaceLayer(layers, undefined, layerOf("old", 0) as never)
      const before = observe(keymap)
      let events = 0
      keymap.on("state", () => void (events += 1))

      replaceLayer(layers, registered, layerOf("new", 1) as never)
      const after = observe(keymap)
      // As on main: the new compiled object (or dispatch result) is announced with a state event.
      const result = typeof after === "boolean" ? after : before !== after
      expect([change, events > 0, result]).toEqual([change, true, !change.includes("requirement from")])
    }
  })

  test("differential: a kept layer changes nothing the public API hands out, a replaced one matches main", () => {
    let seed = 334
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
    const calls: string[] = []
    const pool = { meta: { id: 1 }, audience: { id: 2 }, hint: { id: 3 }, section: { id: 4 } }
    type Key = keyof typeof pool
    // Hooks return the pooled object, or (when `freshHooks`) an equal new one.
    let freshHooks = false
    const hook = (key: Key) => (freshHooks ? { ...pool[key] } : pool[key])
    const install = (keymap: TestKeymap) => {
      keymap.registerLayerFields({ section: (_value, ctx) => ctx.attr("section", hook("section")) })
      keymap.registerCommandFields({
        audience: (value, ctx) => ctx.require("audience", value),
        note: (_value, ctx) => ctx.attr("note", hook("meta")),
      })
      keymap.registerBindingFields({ hint: (_value, ctx) => ctx.attr("hint", hook("hint")) })
      keymap.setData("audience", pool.audience)
      // A function requirement matches only the pooled function, so a fresh one disables its command.
      keymap.registerCommandFields({ gate: (value, ctx) => ctx.require("gate", value) })
      keymap.setData("gate", gate)
      const when = (value: unknown, ctx: { activeWhen(matcher: () => boolean): void }) =>
        ctx.activeWhen(value as () => boolean)
      keymap.registerLayerFields({ when })
      keymap.registerBindingFields({ when })
    }
    const gate = () => true
    type Gate = "pooled" | "fresh" | undefined
    const gateOf = (kind: Gate) => (kind === "fresh" ? { gate: () => true } : kind ? { gate } : {})
    // Condition functions are fresh closures on every build; "shared" ones read a flag that changes without an
    // event between the two registrations.
    type Condition = boolean | "shared" | undefined
    let shared = true
    const conditionOf = (field: string, condition: Condition) =>
      condition === undefined ? {} : { [field]: condition === "shared" ? () => shared : () => condition }
    type Spec = {
      title: string
      meta?: "pooled" | "fresh"
      audience?: "pooled" | "fresh"
      note?: number
      key?: string
      hint?: number
      enabled?: Condition
      gate?: Gate
      bindingWhen?: Condition
    }
    const object = (key: Key, kind?: "pooled" | "fresh") => (kind === "fresh" ? { ...pool[key] } : kind && pool[key])
    // A layer `enabled` function is a fresh closure on every build.
    const layerOf = (specs: readonly Spec[], section: boolean, label: string, enabled = false, when?: Condition) => ({
      ...(section ? { section: 1 } : {}),
      ...(enabled ? { enabled: () => true } : {}),
      ...conditionOf("when", when),
      commands: specs.map((spec, index) => ({
        name: `c${index}`,
        title: spec.title,
        ...(spec.meta ? { meta: object("meta", spec.meta) } : {}),
        ...(spec.audience ? { audience: object("audience", spec.audience) } : {}),
        ...(spec.note ? { note: spec.note } : {}),
        ...conditionOf("enabled", spec.enabled),
        ...gateOf(spec.gate),
        run: () => void calls.push(`${label}:c${index}`),
      })),
      bindings: specs.flatMap((spec, index) =>
        spec.key
          ? [
              {
                key: spec.key,
                cmd: `c${index}`,
                ...(spec.hint ? { hint: spec.hint } : {}),
                ...conditionOf("when", spec.bindingWhen),
              },
            ]
          : [],
      ),
    })
    const randomSpec = (): Spec => ({
      title: pick(["a", "b"]),
      meta: pick([undefined, "pooled", "pooled", "fresh"] as const),
      audience: pick([undefined, "pooled", "pooled", "fresh"] as const),
      note: pick([undefined, 1]),
      key: pick([undefined, "x", "y"]),
      hint: pick([undefined, 1]),
      enabled: pick([undefined, true, false, "shared"] as const),
      gate: pick([undefined, undefined, "pooled", "fresh"] as const),
      bindingWhen: pick([undefined, true, false, "shared"] as const),
    })
    const vary = (spec: Spec): Spec => {
      const change = pick([
        "same",
        "same",
        "same",
        "same",
        "same",
        "title",
        "meta",
        "audience",
        "enabled",
        "gate",
        "bindingWhen",
      ] as const)
      if (change === "gate") return { ...spec, gate: spec.gate === "fresh" ? "pooled" : "fresh" }
      if (change === "bindingWhen") return { ...spec, bindingWhen: !spec.bindingWhen }
      if (change === "title") return { ...spec, title: spec.title === "a" ? "b" : "a" }
      if (change === "meta") return { ...spec, meta: pick(["pooled", "fresh"] as const) }
      if (change === "audience") return { ...spec, audience: pick(["pooled", "fresh"] as const) }
      if (change === "enabled") return { ...spec, enabled: !spec.enabled }
      return spec
    }
    // Every object a public read hands out, by path; functions are left out (they move to the latest).
    const read = (keymap: TestKeymap) => {
      const names = keymap.getCommands({ visibility: "registered" }).map(({ name }) => name)
      const reads = {
        graph: getGraphSnapshot(keymap),
        bindings: [...keymap.getCommandBindings({ visibility: "registered", commands: names }).entries()],
        commands: keymap.getCommands({ visibility: "registered" }),
        entries: keymap.getCommandEntries({ visibility: "registered" }),
        keys: keymap.getActiveKeys({ includeBindings: true, includeMetadata: true }),
      }
      const objects = new Map<string, object>()
      const walk = (value: unknown, path: string, depth: number) => {
        if (typeof value !== "object" || value === null || depth > 8) return
        objects.set(path, value)
        if (
          !Array.isArray(value) &&
          Object.getPrototypeOf(value) !== Object.prototype &&
          Object.getPrototypeOf(value) !== null
        )
          return
        for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`, depth + 1)
      }
      walk(reads, "", 0)
      return objects
    }
    // What a reader sees: names, titles, fields, attrs, bindings, active keys and the command that dispatch runs.
    const content = (keymap: TestKeymap, label: string) => {
      calls.length = 0
      const commands = keymap
        .getCommands({ visibility: "registered" })
        .map(({ name, title, meta, audience, note }) => [name, title, meta, audience, note])
      const names = commands.map(([name]) => name as string)
      const dispatched = names.map((name) => keymap.dispatchCommand(name))
      const ran = calls.map((call) => call.replace(`${label}:`, ""))
      const reachable = keymap.getCommands().map(({ name }) => name)
      const bindings = [...keymap.getCommandBindings({ visibility: "registered", commands: names }).entries()]
      const keys = keymap
        .getActiveKeys({ includeMetadata: true })
        .map(({ display, command, bindingAttrs, commandAttrs }) => [display, command, bindingAttrs, commandAttrs])
      return JSON.stringify({
        commands,
        dispatched,
        reachable,
        ran,
        keys,
        bindings: bindings.map(([name, list]) => [name, list.map(({ attrs, commandAttrs }) => [attrs, commandAttrs])]),
      })
    }

    const failures: string[] = []
    let kept = 0
    for (let trial = 0; trial < 500; trial += 1) {
      const specs = Array.from({ length: 1 + Math.floor(random() * 3) }, randomSpec)
      const section = random() < 0.5
      const layerEnabled = random() < 0.1
      const layerWhen = pick([undefined, undefined, true, "shared"] as const)
      const nextLayerWhen = layerWhen === true && random() < 0.3 ? false : layerWhen
      shared = true
      const nextSpecs = specs.map(vary)
      const [tipHarness, mainHarness] = [
        createTestKeymap({ defaultKeys: true }),
        createTestKeymap({ defaultKeys: true }),
      ]
      const [tip, main] = [tipHarness.keymap, mainHarness.keymap]
      install(tip)
      install(main)
      freshHooks = false
      const { layers } = tip[KEYMAP_EXTENSION_CONTEXT]()
      const registered = replaceLayer(layers, undefined, layerOf(specs, section, "first", layerEnabled, layerWhen))
      const [first, second] = [read(tip), read(tip)]
      // Sometimes the flag changes without an event before a reader reads.
      if (random() < 0.3) shared = false
      const before = content(tip, "first")
      let events = 0
      tip.on("state", () => void (events += 1))

      freshHooks = random() < 0.2
      shared = random() < 0.7
      replaceLayer(layers, registered, layerOf(nextSpecs, section, "next", layerEnabled, nextLayerWhen))
      const after = content(tip, "next")
      main.registerLayer(layerOf(nextSpecs, section, "next", layerEnabled, nextLayerWhen))
      const expected = content(main, "next")

      if (after !== expected) failures.push(`${trial}: results differ from main`)
      if (events === 0) {
        kept += 1
        if (after !== before) failures.push(`${trial}: results changed without an event`)
        const third = read(tip)
        for (const [path, object] of first) {
          if (second.get(path) === object && third.get(path) !== object) failures.push(`${trial}: ${path} changed`)
        }
      }
      tipHarness.cleanup()
      mainHarness.cleanup()
    }
    // About 25 of the 500 trials take the fast path without an event.
    expect([failures.slice(0, 5), kept >= 20]).toEqual([[], true])
  })

  test("a kept layer whose binding condition turns false clears a pending sequence through it, as on main", () => {
    const keymap = getKeymap(renderer)
    const slot = createLayerSlot(keymap)
    keymap.registerBindingFields({ when: (value, ctx) => ctx.activeWhen(value as () => boolean) })
    const layerOf = (when: () => boolean) => ({
      commands: [{ name: "c", run() {} }],
      bindings: [{ key: "g g", cmd: "c", when }],
    })

    const registered = slot(layerOf(() => true))
    mockInput.pressKey("g")
    const pending = keymap.getPendingSequence().length
    expect(slot(layerOf(() => false))).toBe(registered)
    expect([pending, keymap.getPendingSequence().length]).toEqual([1, 0])
  })

  test("fresh binding transformer output that is unreadable or cyclic makes a full replace, not a throw", () => {
    const cyclic = () => {
      const meta: Record<string, unknown> = {}
      meta.self = meta
      return meta
    }
    const unreadable = () =>
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("unreadable")
          },
        },
      )
    for (const meta of [unreadable, cyclic]) {
      const { keymap } = createFieldKeymap()
      keymap.appendLayerBindingsTransformer((bindings) => bindings.map((binding) => ({ ...binding, meta: meta() })))
      const slot = createLayerSlot(keymap)
      const layerOf = () => ({ commands: [{ name: "c", run() {} }], bindings: [{ key: "x", cmd: "c" }] })
      slot(layerOf())
      let events = 0
      keymap.on("state", () => void (events += 1))
      slot(layerOf())
      expect(events).toBe(1)
    }
  })

  test("a kept layer emits state when an enabled result flips, even if no reader read it", () => {
    const keymap = getKeymap(renderer)
    const slot = createLayerSlot(keymap)
    let events = 0
    keymap.on("state", () => void (events += 1))
    const layerOf = (enabled: boolean) => ({ enabled: () => enabled, commands: [{ name: "c", run() {} }] })
    const registered = slot(layerOf(true))
    events = 0
    expect(slot(layerOf(false))).toBe(registered)
    expect([events, keymap.getCommands().length]).toEqual([1, 0])
  })

  test("carbon-1: a requirement function cached as failing reaches dispatch once a replace matches it", () => {
    const keymap = getKeymap(renderer)
    const slot = createLayerSlot(keymap)
    const calls: string[] = []
    const [gate1, gate2] = [() => true, () => true]
    keymap.registerCommandFields({ gate: (value, ctx) => ctx.require("gate", value) })
    keymap.setData("gate", gate1)
    const layerOf = (gate: () => boolean, label: string) => ({
      commands: [{ name: "c", gate, run: () => void calls.push(label) }],
      bindings: [{ key: "x", cmd: "c" }],
    })

    slot(layerOf(gate1, "v1"))
    keymap.setData("gate", gate2)
    const cached = [keymap.getCommands().length, keymap.getActiveKeys().length]
    slot(layerOf(gate2, "v2"))
    const after = [keymap.getCommands().length, keymap.getActiveKeys().length]
    mockInput.pressKey("x")
    const dispatched = keymap.dispatchCommand("c").ok
    expect([cached, after, dispatched, calls]).toEqual([[0, 0], [1, 1], true, ["v2", "v2"]])
  })

  test("carbon-1: a reader that saw a condition fail without an event hears when a replace makes it pass", () => {
    const keymap = getKeymap(renderer)
    const slot = createLayerSlot(keymap)
    let ready = true
    const layerOf = () => ({ enabled: () => ready, commands: [{ name: "c", run() {} }] })
    const names = () => keymap.getCommandEntries().map(({ command }) => command.name)

    slot(layerOf())
    ready = false
    let read = names()
    const mounted = [...read]
    keymap.on("state", () => void (read = names()))
    let events = 0
    keymap.on("state", () => void (events += 1))
    ready = true
    slot(layerOf())
    // The reader read again at that event; a replace that changes nothing it read emits no event.
    slot(layerOf())
    expect([mounted, read, events]).toEqual([[], ["c"], 1])
  })

  test("carbon-2: a kept layer whose condition turns false clears the pending sequence at once", async () => {
    const keymap = getKeymap(renderer)
    const slot = createLayerSlot(keymap)
    addons.registerNeovimDisambiguation(keymap, { timeoutMs: 10 })
    const calls: string[] = []
    let active = true
    const layerOf = (label: string) => ({
      enabled: () => active,
      bindings: [
        { key: "g", cmd: () => void calls.push(`g:${label}`) },
        { key: "g g", cmd: () => void calls.push(`gg:${label}`) },
      ],
    })
    const sequences: number[] = []
    keymap.on("pendingSequence", (sequence) => void sequences.push(sequence.length))

    slot(layerOf("v1"))
    mockInput.pressKey("g")
    active = false
    slot(layerOf("v2"))
    const cleared = [...sequences]
    await Bun.sleep(30)
    expect([cleared, calls]).toEqual([[1, 0], []])
  })

  test("carbon-3: a layer slot keeps its mount order while it is empty, waits for a target, or loses one", () => {
    const keymap = getKeymap(renderer)
    // The registered view lists layers in mount order.
    const ranks = () => keymap.getCommands({ visibility: "registered" }).map(({ name }) => name)
    const layerOf = (name: string, target?: Renderable) => ({ target, commands: [{ name, run() {} }] })
    const emptied = createLayerSlot(keymap)
    const waiting = createLayerSlot(keymap)
    const retargeted = createLayerSlot(keymap)
    const later = createLayerSlot(keymap)
    const first = createFocusableBox("first")

    emptied(layerOf("emptied"))
    waiting(undefined)
    retargeted(layerOf("retargeted", first))
    later(layerOf("later"))
    emptied({ commands: [] })
    emptied(layerOf("emptied"))
    waiting(layerOf("waiting"))
    first.destroyRecursively()
    retargeted(layerOf("retargeted", createFocusableBox("second")))
    expect(ranks()).toEqual(["emptied", "waiting", "retargeted", "later"])
  })

  test("carbon-4: a command function field is the exposed forwarder, also for exact filters", () => {
    const keymap = getKeymap(renderer)
    const slot = createLayerSlot(keymap)
    slot({ commands: [{ name: "c", action: () => {}, run() {} }] })
    const exposed = keymap.getCommands({ visibility: "registered" })[0]!
    const matches = () => keymap.getCommands({ visibility: "registered", filter: { action: [exposed.action] } }).length
    const before = matches()
    let events = 0
    keymap.on("state", () => void (events += 1))
    slot({ commands: [{ name: "c", action: () => {}, run() {} }] })
    expect([before, events, matches()]).toEqual([1, 0, 1])
  })

  test("carbon-4: a command that a transformer made non-extensible is replaced, not changed in place", () => {
    const keymap = getKeymap(renderer)
    const slot = createLayerSlot(keymap)
    const calls: string[] = []
    keymap.appendCommandTransformer((command) => void Object.preventExtensions(command))
    slot({ commands: [{ name: "c", run: () => void calls.push("old") }] })
    const retained = keymap.getCommands({ visibility: "registered" })[0]!
    const retainedRun = retained.run
    let events = 0
    keymap.on("state", () => void (events += 1))
    slot({ commands: [{ name: "c", run: () => void calls.push("new") }] })
    keymap.runCommand("c")
    expect([events, retained.run === retainedRun, calls]).toEqual([1, true, ["new"]])
  })

  test("carbon-4: command conditions of a disabled layer are not evaluated by registration or replace", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)
    const slot = createLayerSlot(keymap)
    const item: { ready: boolean } | null = null
    const layerOf = () => ({
      enabled: () => item !== null,
      commands: [{ name: "c", enabled: () => item!.ready, run() {} }],
    })
    keymap.on("state", () => {})
    slot(layerOf())
    keymap.setData("unrelated", 1)
    slot(layerOf())
    expect(takeErrors().errors).toEqual([])
  })

  test("carbon-4: a state listener that empties a layer slot during its update removes the new layer", () => {
    const keymap = getKeymap(renderer)
    const slot = createLayerSlot(keymap)
    const calls: string[] = []
    let unmount = false
    keymap.on("state", () => {
      if (!unmount) return
      unmount = false
      slot(undefined)
    })
    unmount = true
    slot({ commands: [{ name: "c", run: () => void calls.push("v2") }] })
    keymap.runCommand("c")
    expect(calls).toEqual([])
  })

  test("a failed reactive subscription is retried by the next replace", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)
    const { layers } = keymap[KEYMAP_EXTENSION_CONTEXT]()
    let attempts = 0
    const layerOf = () => ({
      enabled: {
        get: () => true,
        subscribe: () => {
          attempts += 1
          if (attempts === 1) throw new Error("not yet")
          return () => {}
        },
      },
      commands: [{ name: "c", run() {} }],
    })

    const registered = replaceLayer(layers, undefined, layerOf())
    replaceLayer(layers, registered, layerOf())
    expect(attempts).toBe(2)
    expect(takeErrors().errors).toEqual(["not yet"])
  })

  test("a command object shared by two layers keeps each layer's own handler", () => {
    const keymap = getKeymap(renderer)
    const { layers } = keymap[KEYMAP_EXTENSION_CONTEXT]()
    const calls: string[] = []
    const shared = { name: "c", run: () => void calls.push("shared") }

    const replaced = replaceLayer(layers, undefined, { commands: [shared] })
    replaceLayer(layers, undefined, { priority: -1, commands: [shared] })
    replaceLayer(layers, replaced, { commands: [{ name: "c", run: () => void calls.push("fresh") }] })
    keymap.runCommand("c")
    replaceLayer(layers, replaced, undefined)
    keymap.runCommand("c")
    expect(calls).toEqual(["fresh", "shared"])
  })

  test("registerLayer still rejects a frozen command, whose name it normalizes in place", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.registerLayer({ commands: [Object.freeze({ name: "c", run() {} })] })
    expect([keymap.getCommands().length, takeErrors().errors.length]).toEqual([0, 1])
  })

  test("getCommands returns the registered command object across repeated reads", () => {
    const keymap = getKeymap(renderer)
    const command = {
      name: "save-current",
      tags: ["file", "write"],
      run() {},
    }

    keymap.registerLayer({
      commands: [command],
    })

    const first = getCommand(keymap, "save-current")
    expect(first).toBe(command)

    const second = getCommand(keymap, "save-current")
    expect(second).toBe(first)
    expect(second?.tags).toEqual(["file", "write"])
  })

  test("getCommands returns command metadata by reference", () => {
    const keymap = getKeymap(renderer)
    const opaque = new Map([["recent", 1]])
    const helper = () => "ok"
    const payload = {
      nested: { title: "Write File" },
      tags: ["file", { kind: "write" }],
      opaque,
      helper,
    }

    keymap.registerLayer({
      commands: [
        {
          name: "save-current",
          payload,
          run() {},
        },
      ],
    })

    payload.nested.title = "Mutated"
    ;(payload.tags[1] as { kind: string }).kind = "mutated"

    const command = getCommand(keymap, "save-current")
    const storedPayload = command?.payload as typeof payload
    expect(storedPayload).toBeDefined()
    expect(storedPayload).toBe(payload)
    expect(storedPayload.nested).toBe(payload.nested)
    expect(storedPayload.tags).toBe(payload.tags)
    expect(storedPayload.tags[1]).toBe(payload.tags[1])
    expect(storedPayload.nested.title).toBe("Mutated")
    expect(storedPayload.tags[1]).toEqual({ kind: "mutated" })
    expect(storedPayload.opaque).toBe(opaque)
    expect(storedPayload.helper).toBe(helper)
  })

  test("keeps active key projections isolated across repeated reads", () => {
    const keymap = getKeymap(renderer)

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          desc: "Save the current file",
          title: "Save File",
          category: "File",
          run() {},
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "save-file", desc: "Write current file", group: "File" }],
    })

    const plain = getActiveKey(keymap, "x")
    const metadataOnly = getActiveKey(keymap, "x", { includeMetadata: true })
    const withBindings = getActiveKey(keymap, "x", { includeBindings: true })
    const withBindingsAndMetadata = getActiveKey(keymap, "x", { includeBindings: true, includeMetadata: true })
    const plainAgain = getActiveKey(keymap, "x")

    const commandAttrs = {
      desc: "Save the current file",
      title: "Save File",
      category: "File",
    }
    const bindingAttrs = {
      desc: "Write current file",
      group: "File",
    }

    expect(plain?.bindings).toBeUndefined()
    expect(plain?.bindingAttrs).toBeUndefined()
    expect(plain?.commandAttrs).toBeUndefined()
    expect(plain?.command).toBe("save-file")

    expect(metadataOnly?.bindings).toBeUndefined()
    expect(metadataOnly?.command).toBe("save-file")
    expect(metadataOnly?.bindingAttrs).toEqual(bindingAttrs)
    expect(metadataOnly?.commandAttrs).toEqual(commandAttrs)

    expect(withBindings?.bindingAttrs).toBeUndefined()
    expect(withBindings?.commandAttrs).toBeUndefined()
    expect(withBindings?.command).toBe("save-file")
    expect(withBindings?.bindings?.[0]?.attrs).toEqual(bindingAttrs)
    expect(withBindings?.bindings?.[0]?.command).toBe("save-file")
    expect(withBindings?.bindings?.[0]?.commandAttrs).toEqual(commandAttrs)

    expect(withBindingsAndMetadata?.bindingAttrs).toEqual(bindingAttrs)
    expect(withBindingsAndMetadata?.commandAttrs).toEqual(commandAttrs)
    expect(withBindingsAndMetadata?.command).toBe("save-file")
    expect(withBindingsAndMetadata?.bindings?.[0]?.attrs).toEqual(bindingAttrs)
    expect(withBindingsAndMetadata?.bindings?.[0]?.command).toBe("save-file")
    expect(withBindingsAndMetadata?.bindings?.[0]?.commandAttrs).toEqual(commandAttrs)

    expect(plainAgain?.bindings).toBeUndefined()
    expect(plainAgain?.bindingAttrs).toBeUndefined()
    expect(plainAgain?.commandAttrs).toBeUndefined()
    expect(plainAgain?.command).toBe("save-file")
  })
})
