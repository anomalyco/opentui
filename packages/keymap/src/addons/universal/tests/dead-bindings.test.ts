import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { KeyEvent, Renderable } from "@opentui/core"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { registerDeadBindingWarnings } from "@opentui/keymap/addons"
import type { Keymap, WarningEvent } from "@opentui/keymap"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createDiagnosticHarness } from "../../../tests/diagnostic-harness.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()

function getKeymap(renderer: TestRenderer) {
  return diagnostics.trackKeymap(createDefaultOpenTuiKeymap(renderer))
}

type OpenTuiKeymap = Keymap<Renderable, KeyEvent>

function captureWarnings(keymap: OpenTuiKeymap) {
  return diagnostics.captureDiagnostics(keymap)
}

describe("dead binding warnings addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 12 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("warns when an exact binding has no command and no reachable continuations", () => {
    const keymap = getKeymap(renderer)
    const capture = captureWarnings(keymap)
    registerDeadBindingWarnings(keymap)

    keymap.registerLayer({
      bindings: [{ key: "x" }],
    })

    const { warnings, warningEvents } = capture.takeWarnings()
    expect(warnings).toEqual([
      '[Keymap] Binding "x" has no command and no reachable continuations; it will never trigger',
    ])
    expect(warningEvents).toHaveLength(1)
    expect(warningEvents[0]).toMatchObject({
      code: "dead-binding",
      warning: {
        binding: { key: "x" },
        target: undefined,
      },
    })
  })

  test("does not warn for metadata-only prefix bindings", () => {
    const keymap = getKeymap(renderer)
    const { warnings } = captureWarnings(keymap)
    registerDeadBindingWarnings(keymap)

    keymap.registerLayer({
      bindings: [{ key: "g" }, { key: "gd", cmd: () => {} }],
    })

    expect(warnings).toEqual([])
  })

  test("warns for release bindings without commands", () => {
    const keymap = getKeymap(renderer)
    const capture = captureWarnings(keymap)
    registerDeadBindingWarnings(keymap)

    keymap.registerLayer({
      bindings: [{ key: "x", event: "release" }],
    })

    expect(capture.takeWarnings().warnings).toEqual([
      '[Keymap] Binding "x" has no command and no reachable continuations; it will never trigger',
    ])
  })

  test("deduplicates warnings across token recompilation", () => {
    const keymap = getKeymap(renderer)
    const capture = captureWarnings(keymap)
    registerDeadBindingWarnings(keymap)

    keymap.registerLayer({
      bindings: [{ key: "<leader>x" }],
    })

    keymap.registerToken({ name: "leader", key: { name: "space" } })

    expect(capture.takeWarnings().warnings).toEqual([
      '[Keymap] Unknown token "leader" in key sequence "<leader>x"; binding was skipped until the token is registered',
      '[Keymap] Binding "<leader>x" has no command and no reachable continuations; it will never trigger',
    ])
  })

  test("does not affect dispatch for real command bindings", () => {
    const keymap = getKeymap(renderer)
    const { warnings } = captureWarnings(keymap)
    const calls: string[] = []

    registerDeadBindingWarnings(keymap)
    keymap.registerLayer({
      commands: [
        {
          name: "run",
          run() {
            calls.push("run")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "run" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["run"])
    expect(warnings).toEqual([])
  })
})
