import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { registerCommaBindings } from "@opentui/keymap/addons"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createDiagnosticHarness } from "../../../tests/diagnostic-harness.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()

function getKeymap(renderer: TestRenderer) {
  return diagnostics.trackKeymap(createDefaultOpenTuiKeymap(renderer))
}

describe("comma bindings addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("splits comma-delimited key strings into multiple bindings", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    registerCommaBindings(keymap)
    keymap.registerLayer({
      commands: [
        {
          name: "command",
          run() {
            calls.push("command")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x, y", cmd: "command" }],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["command", "command"])
  })

  test("preserves display metadata from earlier expanders", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendBindingExpander(({ input }) => {
      if (input !== "alias") {
        return undefined
      }

      return [{ key: "ctrl+x, ctrl+y", displays: ["alias-x, alias-y"] }]
    })
    registerCommaBindings(keymap)
    keymap.registerLayer({
      commands: [
        {
          name: "command",
          run() {
            calls.push("command")
          },
        },
      ],
      bindings: [{ key: "alias", cmd: "command" }],
    })

    expect(keymap.getActiveKeys().map((key) => key.display)).toEqual(["alias-x", "alias-y"])

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("y", { ctrl: true })

    expect(calls).toEqual(["command", "command"])
  })

  test("skips bindings when a comma-delimited key string contains empty entries", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = diagnostics.captureDiagnostics(keymap)
    registerCommaBindings(keymap)

    expect(() => {
      keymap.registerLayer({
        bindings: [{ key: "x,,y", cmd() {} }],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual([
      'Invalid key sequence "x,,y": comma-separated bindings cannot contain empty entries',
    ])
    expect(keymap.getActiveKeys()).toEqual([])
  })

  test("can be disposed to restore default comma behavior", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    const offCommaBindings = registerCommaBindings(keymap)
    offCommaBindings()

    keymap.registerLayer({
      commands: [
        {
          name: "sequence",
          run() {
            calls.push("sequence")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x,y", cmd: "sequence" }],
    })

    mockInput.pressKey("x")
    expect(calls).toEqual([])

    mockInput.pressKey(",")
    mockInput.pressKey("y")

    expect(calls).toEqual(["sequence"])
  })
})
