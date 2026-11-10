import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { KeyEvent } from "@opentui/core"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { stringifyKeySequence, type DispatchEvent } from "../index.js"
import { createDiagnosticHarness } from "./diagnostic-harness.js"
import { createKeymapTestHelpers, type OpenTuiKeymap } from "./keymap.test-support.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()
const { createFocusableBox, getKeymap } = createKeymapTestHelpers(diagnostics, () => renderer)

function collectDispatchEvents(keymap: OpenTuiKeymap): DispatchEvent[] {
  const events: DispatchEvent[] = []
  keymap.on("dispatch", (event) => {
    events.push(event)
  })
  return events
}

function labels(events: readonly DispatchEvent[]): string[] {
  return events.map((event) => `${event.phase}:${stringifyKeySequence(event.sequence, { preferDisplay: true })}`)
}

describe("keymap: dispatch events", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("emits binding-execute with layer, binding, command, attrs, and focus metadata", () => {
    const keymap = getKeymap(renderer)
    const target = createFocusableBox("dispatch-event-target")
    renderer.root.add(target)
    const events = collectDispatchEvents(keymap)

    keymap.registerLayer({
      target,
      priority: 5,
      commands: [{ name: "save", title: "Save", desc: "Save file", run() {} }],
      bindings: [{ key: "x", cmd: "save", desc: "Save binding" }],
    })

    target.focus()
    mockInput.pressKey("x")

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      phase: "binding-execute",
      event: "press",
      focused: target,
      command: "save",
      layer: {
        order: 0,
        priority: 5,
        target,
        targetMode: "focus-within",
      },
      binding: {
        command: "save",
        sourceLayerOrder: 0,
        bindingIndex: 0,
        attrs: { desc: "Save binding" },
        commandAttrs: { title: "Save", desc: "Save file" },
      },
    })
    expect(stringifyKeySequence(events[0]!.sequence, { preferDisplay: true })).toBe("x")
  })

  test("emits each executed fallthrough binding in dispatch order", () => {
    const keymap = getKeymap(renderer)
    const events = collectDispatchEvents(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      priority: 0,
      commands: [{ name: "low", run: () => calls.push("low") }],
      bindings: [{ key: "x", cmd: "low" }],
    })
    keymap.registerLayer({
      priority: 10,
      commands: [{ name: "high", run: () => calls.push("high") }],
      bindings: [{ key: "x", cmd: "high", fallthrough: true }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["high", "low"])
    expect(labels(events)).toEqual(["binding-execute:x", "binding-execute:x"])
    expect(events.map((event) => event.command)).toEqual(["high", "low"])
    expect(events.map((event) => event.layer?.priority)).toEqual([10, 0])
  })

  test("emits binding-reject and continues to later bindings", () => {
    const keymap = getKeymap(renderer)
    const events = collectDispatchEvents(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "reject",
          run() {
            calls.push("reject")
            return false
          },
        },
        {
          name: "accept",
          run() {
            calls.push("accept")
          },
        },
      ],
      bindings: [
        { key: "x", cmd: "reject" },
        { key: "x", cmd: "accept" },
      ],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["reject", "accept"])
    expect(labels(events)).toEqual(["binding-reject:x", "binding-execute:x"])
    expect(events.map((event) => event.command)).toEqual(["reject", "accept"])
  })

  test("emits sequence start, binding execution, and sequence clear", () => {
    const keymap = getKeymap(renderer)
    const events = collectDispatchEvents(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [{ name: "top", run: () => calls.push("top") }],
      bindings: [{ key: "gg", cmd: "top" }],
    })

    mockInput.pressKey("g")
    expect(labels(events)).toEqual(["sequence-start:g"])
    expect(keymap.getPendingSequence()).toHaveLength(1)

    mockInput.pressKey("g")

    expect(calls).toEqual(["top"])
    expect(labels(events)).toEqual(["sequence-start:g", "binding-execute:gg", "sequence-clear:gg"])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("emits sequence clear when a pending sequence misses", () => {
    const keymap = getKeymap(renderer)
    const events = collectDispatchEvents(keymap)

    keymap.registerLayer({
      commands: [{ name: "top", run() {} }],
      bindings: [{ key: "gg", cmd: "top" }],
    })

    mockInput.pressKey("g")
    mockInput.pressKey("x")

    expect(labels(events)).toEqual(["sequence-start:g", "sequence-clear:g"])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("emits release binding execution events", () => {
    const keymap = getKeymap(renderer)
    const events = collectDispatchEvents(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [{ name: "release-action", run: () => calls.push("release") }],
      bindings: [{ key: "y", event: "release", cmd: "release-action" }],
    })

    renderer.keyInput.emit(
      "keyrelease",
      new KeyEvent({
        name: "y",
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        sequence: "y",
        number: false,
        raw: "y",
        eventType: "release",
        source: "raw",
      }),
    )

    expect(calls).toEqual(["release"])
    expect(labels(events)).toEqual(["binding-execute:y"])
    expect(events[0]?.event).toBe("release")
  })
})
