import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { KeyEvent, Renderable } from "@opentui/core"
import { createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { registerUnresolvedCommandWarnings } from "@opentui/keymap/addons"
import type { Keymap, WarningEvent } from "@opentui/keymap"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createDiagnosticHarness } from "../../../tests/diagnostic-harness.js"

let renderer: TestRenderer
const diagnostics = createDiagnosticHarness()

function getKeymap(renderer: TestRenderer) {
  return diagnostics.trackKeymap(createDefaultOpenTuiKeymap(renderer))
}

type OpenTuiKeymap = Keymap<Renderable, KeyEvent>

function captureWarnings(keymap: OpenTuiKeymap) {
  return diagnostics.captureDiagnostics(keymap)
}

describe("unresolved command warnings addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 12 })
    renderer = testSetup.renderer
  })

  afterEach(() => {
    renderer.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("warns when a binding references an unresolved string command", () => {
    const keymap = getKeymap(renderer)
    const capture = captureWarnings(keymap)

    registerUnresolvedCommandWarnings(keymap)
    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "missing-command" }],
    })

    const { warnings, warningEvents } = capture.takeWarnings()
    expect(warnings).toEqual(['[Keymap] Unresolved command "missing-command" for binding "x"'])
    expect(warningEvents).toHaveLength(1)
    expect(warningEvents[0]).toMatchObject({
      code: "unresolved-command",
      warning: {
        command: "missing-command",
        target: undefined,
        binding: {
          cmd: "missing-command",
          key: "x",
        },
      },
    })
  })

  test("does not warn for same-layer local commands", () => {
    const keymap = getKeymap(renderer)
    const { warnings } = captureWarnings(keymap)

    registerUnresolvedCommandWarnings(keymap)
    keymap.registerLayer({
      commands: [{ name: "local-run", run() {} }],
      bindings: [{ key: "x", cmd: "local-run" }],
    })

    expect(warnings).toEqual([])
  })

  test("does not warn when a command resolver resolves the binding command", () => {
    const keymap = getKeymap(renderer)
    const { warnings } = captureWarnings(keymap)

    registerUnresolvedCommandWarnings(keymap)
    keymap.appendCommandResolver((command) => {
      if (command !== "resolved-by-resolver") {
        return undefined
      }

      return { name: command, run() {} }
    })
    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "resolved-by-resolver" }],
    })

    expect(warnings).toEqual([])
  })

  test("deduplicates warnings across token-driven recompilation", () => {
    const keymap = getKeymap(renderer)
    const capture = captureWarnings(keymap)

    registerUnresolvedCommandWarnings(keymap)
    keymap.registerLayer({
      bindings: [{ key: "<leader>x", cmd: "missing-command" }],
    })

    keymap.registerToken({ name: "leader", key: { name: "space" } })

    expect(capture.takeWarnings().warnings).toEqual([
      '[Keymap] Unknown token "leader" in key sequence "<leader>x"; binding was skipped until the token is registered',
      '[Keymap] Unresolved command "missing-command" for binding "<leader>x"',
    ])
  })
})
