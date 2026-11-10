import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { registerLeader } from "@opentui/keymap/addons"
import { createBindingLookup } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createDiagnosticHarness } from "../../../tests/diagnostic-harness.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()

function getKeymap(renderer: TestRenderer) {
  return diagnostics.trackKeymap(createDefaultOpenTuiKeymap(renderer))
}

describe("leader addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("registers leader as a plain token alias", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "leader-action",
          run() {
            calls.push("leader")
          },
        },
        {
          name: "plain-action",
          run() {
            calls.push("plain")
          },
        },
      ],
    })

    registerLeader(keymap, {
      trigger: { name: "x", ctrl: true },
    })

    keymap.registerLayer({
      bindings: [
        { key: "<leader>a", cmd: "leader-action" },
        { key: "a", cmd: "plain-action" },
      ],
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])

    mockInput.pressKey("a")

    expect(calls).toEqual(["leader", "plain"])
  })

  test("accepts a single binding lookup result as the trigger", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const bindings = createBindingLookup({ leader: { name: "x", ctrl: true } })

    keymap.registerLayer({
      commands: [
        {
          name: "leader-action",
          run() {
            calls.push("leader")
          },
        },
      ],
    })

    registerLeader(keymap, {
      trigger: bindings.get("leader"),
    })

    keymap.registerLayer({
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])
  })

  test("recompiles bindings that were registered before leader exists", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = diagnostics.captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "leader-action",
          run() {
            calls.push("leader")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    mockInput.pressKey("a")

    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Unknown token "leader" in key sequence "<leader>a"; binding was skipped until the token is registered',
    ])
    expect(calls).toEqual([])

    registerLeader(keymap, {
      trigger: { name: "x", ctrl: true },
    })

    mockInput.pressKey("a")

    expect(calls).toEqual([])

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])
  })

  test("can be disposed to remove the leader token mapping", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = diagnostics.captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "leader-only",
          run() {
            calls.push("leader")
          },
        },
      ],
    })

    const offLeader = registerLeader(keymap, {
      trigger: { name: "x", ctrl: true },
    })

    keymap.registerLayer({
      bindings: [{ key: "<leader>", cmd: "leader-only" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    expect(calls).toEqual(["leader"])

    offLeader()

    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Unknown token "leader" in key sequence "<leader>"; binding was skipped until the token is registered',
    ])

    mockInput.pressKey("x", { ctrl: true })
    expect(calls).toEqual(["leader"])
  })

  test("formats raw leader bindings through registered tokens", () => {
    const keymap = getKeymap(renderer)

    registerLeader(keymap, {
      trigger: { name: "space" },
    })

    expect(keymap.formatKey("<leader>s", { preferDisplay: true })).toBe("<leader>s")
    expect(keymap.formatKey("<leader>s", { separator: " " })).toBe("space s")
    expect(keymap.formatKey({ name: "x", ctrl: true })).toBe("ctrl+x")
  })
})
