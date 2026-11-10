import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { stringifyKeySequence } from "../index.js"
import { getGraphSnapshot, type GraphSnapshot } from "../extras/graph.js"
import { createDiagnosticHarness } from "./diagnostic-harness.js"
import { createKeymapTestHelpers, type OpenTuiKeymap } from "./keymap.test-support.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()
const { createFocusableBox, getGraphKeymap } = createKeymapTestHelpers(diagnostics, () => renderer)

function bindingLabel(binding: GraphSnapshot["bindings"][number]): string {
  return stringifyKeySequence(binding.sequence, { preferDisplay: true })
}

function getBinding(snapshot: GraphSnapshot, label: string): GraphSnapshot["bindings"][number] {
  const binding = snapshot.bindings.find((candidate) => bindingLabel(candidate) === label)
  expect(binding).toBeDefined()
  return binding!
}

function getCommand(snapshot: GraphSnapshot, name: string, title?: string): GraphSnapshot["commands"][number] {
  const command = snapshot.commands.find((candidate) => {
    return candidate.name === name && (title === undefined || candidate.command.title === title)
  })
  expect(command).toBeDefined()
  return command!
}

describe("keymap: graph snapshot", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("exposes registered layers, sequence nodes, commands, and bindings", () => {
    const keymap = getGraphKeymap(renderer)

    keymap.registerLayerFields({
      name(value, ctx) {
        if (typeof value !== "string") {
          throw new Error("name field expected string")
        }
        ctx.attr("name", value)
      },
    })

    keymap.registerLayer({
      name: "Primary",
      priority: 2,
      commands: [{ name: "save", title: "Save", desc: "Save file", run() {} }],
      bindings: [{ key: "ctrl+s", cmd: "save", desc: "Save with control" }],
    })

    const snapshot = getGraphSnapshot(keymap)
    expect(snapshot.focused).toBeNull()
    expect(snapshot.layers).toHaveLength(1)
    expect(snapshot.commands).toHaveLength(1)
    expect(snapshot.bindings).toHaveLength(1)

    const [layer] = snapshot.layers
    expect(layer).toMatchObject({ priority: 2, active: true, focusActive: true, enabled: true })
    expect(layer?.fields).toEqual({ name: "Primary" })
    expect(layer?.attrs).toEqual({ name: "Primary" })
    expect(layer?.bindingIds).toEqual([snapshot.bindings[0]?.id])
    expect(layer?.commandIds).toEqual([snapshot.commands[0]?.id])
    expect(layer?.rootNodeId).toBe(snapshot.sequenceNodes.find((node) => node.depth === 0)?.id)

    expect(snapshot.commands[0]).toMatchObject({ name: "save", active: true, reachable: true, enabled: true })
    expect(snapshot.commands[0]?.fields).toEqual({ title: "Save", desc: "Save file" })
    expect(snapshot.commands[0]?.attrs).toEqual({ title: "Save", desc: "Save file" })

    expect(snapshot.bindings[0]).toMatchObject({ active: true, reachable: true, commandResolved: true })
    expect(bindingLabel(snapshot.bindings[0]!)).toBe("ctrl+s")
    expect(snapshot.bindings[0]?.commandIds).toEqual([snapshot.commands[0]?.id])
    expect(snapshot.bindings[0]?.attrs).toEqual({ desc: "Save with control" })
    expect(snapshot.bindings[0]?.commandAttrs).toEqual({ title: "Save", desc: "Save file" })

    const bindingNode = snapshot.sequenceNodes.find((node) => node.id === snapshot.bindings[0]?.nodeId)
    expect(bindingNode).toMatchObject({ active: true, reachable: true, display: "ctrl+s" })
    expect(bindingNode?.bindingIds).toEqual([snapshot.bindings[0]?.id])
  })

  test("tracks focus-scoped layer and command reachability", () => {
    const keymap = getGraphKeymap(renderer)
    const target = createFocusableBox("graph-focus-target")
    renderer.root.add(target)

    keymap.registerLayer({
      commands: [{ name: "save", title: "Global Save", run() {} }],
      bindings: [{ key: "x", cmd: "save" }],
    })
    keymap.registerLayer({
      target,
      targetMode: "focus-within",
      commands: [{ name: "save", title: "Local Save", run() {} }],
      bindings: [{ key: "l", cmd: "save" }],
    })

    let snapshot = getGraphSnapshot(keymap)
    const globalCommand = getCommand(snapshot, "save", "Global Save")
    const inactiveLocalCommand = getCommand(snapshot, "save", "Local Save")
    const localLayer = snapshot.layers.find((layer) => layer.target === target)

    expect(globalCommand).toMatchObject({ active: true, reachable: true })
    expect(inactiveLocalCommand).toMatchObject({ active: false, reachable: false })
    expect(inactiveLocalCommand.inactiveReasons).toContain("focus")
    expect(localLayer).toMatchObject({ active: false, focusActive: false, enabled: true })

    target.focus()
    snapshot = getGraphSnapshot(keymap)
    const shadowedGlobalCommand = getCommand(snapshot, "save", "Global Save")
    const activeLocalCommand = getCommand(snapshot, "save", "Local Save")

    expect(snapshot.focused).toBe(target)
    expect(activeLocalCommand).toMatchObject({ active: true, reachable: true })
    expect(shadowedGlobalCommand).toMatchObject({ active: true, reachable: false })
    expect(shadowedGlobalCommand.inactiveReasons).toContain("shadowed")
  })

  test("reports binding inactive reasons for disabled bindings and unavailable commands", () => {
    const keymap = getGraphKeymap(renderer)

    keymap.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error("active field expected true")
        }
        ctx.activeWhen(() => false)
      },
    })

    keymap.registerLayer({
      commands: [
        { name: "save", run() {} },
        { name: "disabled", enabled: false, run() {} },
      ],
      bindings: [
        { key: "s", cmd: "save", active: true },
        { key: "d", cmd: "disabled" },
        { key: "m", cmd: "missing" },
      ],
    })

    const snapshot = getGraphSnapshot(keymap)
    const disabledBinding = getBinding(snapshot, "s")
    const disabledCommandBinding = getBinding(snapshot, "d")
    const missingCommandBinding = getBinding(snapshot, "m")
    const disabledCommand = getCommand(snapshot, "disabled")

    expect(disabledBinding).toMatchObject({ active: false, reachable: false, enabled: false, commandResolved: true })
    expect(disabledBinding.inactiveReasons).toContain("binding-disabled")
    expect(disabledCommand).toMatchObject({ active: false, reachable: false, enabled: false })
    expect(disabledCommand.inactiveReasons).toContain("command-disabled")
    expect(disabledCommandBinding).toMatchObject({ active: false, reachable: false, commandResolved: false })
    expect(disabledCommandBinding.inactiveReasons).toContain("command-disabled")
    expect(missingCommandBinding).toMatchObject({ active: false, reachable: false, commandResolved: false })
    expect(missingCommandBinding.inactiveReasons).toContain("command-unresolved")
  })

  test("marks pending sequence paths and active continuation keys", () => {
    const keymap = getGraphKeymap(renderer)

    keymap.registerLayer({
      commands: [{ name: "top", run() {} }],
      bindings: [{ key: "gg", cmd: "top", desc: "Go top" }],
    })

    mockInput.pressKey("g")

    const snapshot = getGraphSnapshot(keymap)
    expect(stringifyKeySequence(snapshot.pendingSequence, { preferDisplay: true })).toBe("g")
    expect(snapshot.activeKeys.map((key) => key.display)).toEqual(["g"])

    const pendingNode = snapshot.sequenceNodes.find((node) => {
      return node.pending && stringifyKeySequence(node.sequence, { preferDisplay: true }) === "g"
    })
    const terminalNode = snapshot.sequenceNodes.find((node) => {
      return stringifyKeySequence(node.sequence, { preferDisplay: true }) === "gg"
    })

    expect(pendingNode).toMatchObject({ pending: true, pendingPath: true, reachable: true })
    expect(terminalNode).toMatchObject({ pending: false, pendingPath: false, active: true, reachable: true })
    expect(getBinding(snapshot, "gg")).toMatchObject({ active: true, reachable: true })
  })

  test("marks statically shadowed bindings while respecting fallthrough", () => {
    const keymap = getGraphKeymap(renderer)

    keymap.registerLayer({
      priority: 0,
      commands: [{ name: "low", run() {} }],
      bindings: [{ key: "x", cmd: "low" }],
    })
    keymap.registerLayer({
      priority: 10,
      commands: [{ name: "high", run() {} }],
      bindings: [{ key: "x", cmd: "high" }],
    })

    let snapshot = getGraphSnapshot(keymap)
    const highBinding = snapshot.bindings.find((binding) => binding.command === "high")
    const lowBinding = snapshot.bindings.find((binding) => binding.command === "low")

    expect(highBinding).toMatchObject({ active: true, reachable: true, shadowed: false })
    expect(lowBinding).toMatchObject({ active: true, reachable: false, shadowed: true })
    expect(lowBinding?.inactiveReasons).toContain("shadowed")

    const fallthroughKeymap = getGraphKeymap(renderer)
    fallthroughKeymap.registerLayer({
      commands: [{ name: "low", run() {} }],
      bindings: [{ key: "x", cmd: "low" }],
    })
    fallthroughKeymap.registerLayer({
      priority: 10,
      commands: [{ name: "high", run() {} }],
      bindings: [{ key: "x", cmd: "high", fallthrough: true }],
    })

    snapshot = getGraphSnapshot(fallthroughKeymap)
    expect(snapshot.bindings.find((binding) => binding.command === "high")).toMatchObject({ reachable: true })
    expect(snapshot.bindings.find((binding) => binding.command === "low")).toMatchObject({ reachable: true })
  })

  test("can omit target references", () => {
    const keymap = getGraphKeymap(renderer)
    const target = createFocusableBox("graph-targetless")
    renderer.root.add(target)
    target.focus()

    keymap.registerLayer({
      target,
      commands: [{ name: "target-command", run() {} }],
      bindings: [{ key: "t", cmd: "target-command" }],
    })

    const snapshot = getGraphSnapshot(keymap, { includeTargets: false })
    expect(snapshot.focused).toBeUndefined()
    expect(snapshot.layers[0]?.target).toBeUndefined()
    expect(snapshot.commands[0]?.target).toBeUndefined()
  })

  test("supports explicit focused projections without changing host focus", () => {
    const keymap = getGraphKeymap(renderer)
    const target = createFocusableBox("graph-explicit-focus")
    renderer.root.add(target)

    keymap.registerLayer({ bindings: [{ key: "g", cmd: () => {} }] })
    keymap.registerLayer({ target, bindings: [{ key: "t", cmd: () => {} }] })

    const snapshot = getGraphSnapshot(keymap, { focused: target })
    expect(renderer.currentFocusedRenderable).not.toBe(target)
    expect(snapshot.focused).toBe(target)
    expect(snapshot.activeKeys.map((key) => key.display).sort()).toEqual(["g", "t"])
    expect(getBinding(snapshot, "t")).toMatchObject({ active: true, reachable: true })
  })
})
