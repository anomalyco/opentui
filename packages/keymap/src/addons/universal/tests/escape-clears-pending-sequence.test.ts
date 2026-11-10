import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { registerEscapeClearsPendingSequence } from "@opentui/keymap/addons"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createDiagnosticHarness } from "../../../tests/diagnostic-harness.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()

function getKeymap(renderer: TestRenderer) {
  return diagnostics.trackKeymap(createDefaultOpenTuiKeymap(renderer))
}

describe("escape clears pending sequence addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("clears pending sequence on escape and only intercepts escape while pending", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "delete-line",
          run() {
            calls.push("delete")
          },
        },
        {
          name: "escape-command",
          run() {
            calls.push("escape")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [
        { key: "dd", cmd: "delete-line" },
        { key: "escape", cmd: "escape-command" },
      ],
    })

    registerEscapeClearsPendingSequence(keymap)

    mockInput.pressKey("d")
    expect(keymap.hasPendingSequence()).toBe(true)
    expect(keymap.getPendingSequence()).toMatchObject([
      {
        stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false },
        display: "d",
      },
    ])

    mockInput.pressEscape()

    expect(keymap.hasPendingSequence()).toBe(false)
    expect(keymap.getPendingSequence()).toEqual([])
    expect(calls).toEqual([])

    mockInput.pressEscape()

    expect(calls).toEqual(["escape"])
  })

  test("can clear pending sequence without consuming escape", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "delete-line",
          run() {
            calls.push("delete")
          },
        },
        {
          name: "escape-command",
          run() {
            calls.push("escape")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [
        { key: "dd", cmd: "delete-line" },
        { key: "escape", cmd: "escape-command" },
      ],
    })

    registerEscapeClearsPendingSequence(keymap, { preventDefault: false })

    mockInput.pressKey("d")
    expect(keymap.hasPendingSequence()).toBe(true)
    mockInput.pressEscape()

    expect(keymap.hasPendingSequence()).toBe(false)
    expect(keymap.getPendingSequence()).toEqual([])
    expect(calls).toEqual(["escape"])
  })

  test("can be disposed to stop pending escape forwarding behavior", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "delete-line",
          run() {
            calls.push("delete")
          },
        },
        {
          name: "escape-command",
          run() {
            calls.push("escape")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [
        { key: "dd", cmd: "delete-line" },
        { key: "escape", cmd: "escape-command" },
      ],
    })

    const offEscapeAddon = registerEscapeClearsPendingSequence(keymap, { preventDefault: false })

    mockInput.pressKey("d")
    mockInput.pressEscape()
    expect(calls).toEqual(["escape"])

    mockInput.pressKey("d")
    offEscapeAddon()
    mockInput.pressEscape()

    expect(keymap.hasPendingSequence()).toBe(false)
    expect(calls).toEqual(["escape"])
  })
})
