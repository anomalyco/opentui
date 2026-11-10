import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { commandBindings } from "@opentui/keymap/extras"
import { registerBindingOverrides } from "@opentui/keymap/addons"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createDiagnosticHarness } from "../../../tests/diagnostic-harness.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()

function getKeymap(renderer: TestRenderer) {
  return diagnostics.trackKeymap(createDefaultOpenTuiKeymap(renderer))
}

describe("bindingOverrides addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("replaces matching bindings within the layer and keeps unmatched bindings", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    registerBindingOverrides(keymap)
    keymap.registerLayer({
      commands: [
        { name: "save-file", run: () => calls.push("save") },
        { name: "quit", run: () => calls.push("quit") },
      ],
    })

    keymap.registerLayer({
      bindingOverrides: commandBindings({ " save-file ": "y" }),
      bindings: [
        { key: "x", cmd: "save-file" },
        { key: "q", cmd: "quit" },
      ],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("y")
    mockInput.pressKey("q")

    expect(calls).toEqual(["save", "quit"])
    expect(
      keymap
        .getActiveKeys()
        .map((candidate) => candidate.stroke.name)
        .sort(),
    ).toEqual(["q", "y"])
  })

  test("can add bindings when the layer only provides bindingOverrides", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    registerBindingOverrides(keymap)
    keymap.registerLayer({
      commands: [{ name: "save-file", run: () => calls.push("save") }],
    })

    keymap.registerLayer({
      bindingOverrides: commandBindings({ "save-file": "x" }),
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["save"])
  })

  test("matches resolver command strings by trimmed command value", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    registerBindingOverrides(keymap)
    keymap.appendCommandResolver((command) => {
      if (command !== ":write session.log") {
        return undefined
      }

      return {
        name: command,
        run() {
          calls.push("write")
        },
      }
    })

    keymap.registerLayer({
      bindingOverrides: commandBindings({ " :write session.log ": "x" }),
      bindings: [{ key: "y", cmd: ":write session.log" }],
    })

    mockInput.pressKey("y")
    mockInput.pressKey("x")

    expect(calls).toEqual(["write"])
  })

  test("can be disposed to stop rewriting future layers", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = diagnostics.captureDiagnostics(keymap)
    const calls: string[] = []

    const offOverrides = registerBindingOverrides(keymap)
    offOverrides()

    keymap.registerLayer({
      commands: [{ name: "save-file", run: () => calls.push("save") }],
    })
    keymap.registerLayer({
      bindingOverrides: commandBindings({ "save-file": "x" }),
      bindings: [{ key: "y", cmd: "save-file" }],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(takeWarnings().warnings).toEqual(['[Keymap] Unknown layer field "bindingOverrides" was ignored'])
    expect(calls).toEqual(["save"])
  })

  test("rejects non-array bindingOverrides input", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = diagnostics.captureDiagnostics(keymap)

    registerBindingOverrides(keymap)
    keymap.registerLayer({
      bindingOverrides: { "save-file": "x" } as never,
      bindings: [{ key: "y", cmd: "save-file" }],
    })

    expect(takeErrors().errors).toEqual(['Keymap layer field "bindingOverrides" must be an array of binding objects'])
  })
})
