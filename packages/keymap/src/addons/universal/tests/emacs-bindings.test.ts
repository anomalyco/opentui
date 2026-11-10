import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { stringifyKeySequence } from "@opentui/keymap"
import { registerEmacsBindings } from "@opentui/keymap/addons"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createDiagnosticHarness } from "../../../tests/diagnostic-harness.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()

function getKeymap(renderer: TestRenderer) {
  return diagnostics.trackKeymap(createDefaultOpenTuiKeymap(renderer))
}

describe("emacs bindings addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("supports emacs-style multi-stroke definitions when the addon is registered", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    registerEmacsBindings(keymap)
    keymap.registerLayer({
      commands: [
        {
          name: "save-buffer",
          run() {
            calls.push("save")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "ctrl+x ctrl+s", cmd: "save-buffer" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("ctrl+x")

    mockInput.pressKey("s", { ctrl: true })
    expect(calls).toEqual(["save"])
  })

  test("keeps emacs syntax unavailable until the addon is registered", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = diagnostics.captureDiagnostics(keymap)

    expect(() => {
      keymap.registerLayer({
        bindings: [{ key: "ctrl+x ctrl+s", cmd() {} }],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual(['Invalid key "ctrl+x ctrl+s": multiple key names are not supported'])
    expect(keymap.getActiveKeys()).toEqual([])
  })

  test("can be disposed to restore default parsing behavior", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = diagnostics.captureDiagnostics(keymap)

    const offEmacsBindings = registerEmacsBindings(keymap)
    offEmacsBindings()

    expect(() => {
      keymap.registerLayer({
        bindings: [{ key: "ctrl+x ctrl+s", cmd() {} }],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual(['Invalid key "ctrl+x ctrl+s": multiple key names are not supported'])
    expect(keymap.getActiveKeys()).toEqual([])
  })
})
