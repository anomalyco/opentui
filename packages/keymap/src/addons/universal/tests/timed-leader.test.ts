import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { registerTimedLeader } from "@opentui/keymap/addons"
import { createBindingLookup } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createDiagnosticHarness } from "../../../tests/diagnostic-harness.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()

function getKeymap(renderer: TestRenderer) {
  return diagnostics.trackKeymap(createDefaultOpenTuiKeymap(renderer))
}

describe("timed leader addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("supports leader extensions", () => {
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
      ],
    })

    registerTimedLeader(keymap, {
      trigger: { name: "x", ctrl: true },
    })

    keymap.registerLayer({
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])
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

    registerTimedLeader(keymap, {
      trigger: bindings.get("leader"),
    })

    keymap.registerLayer({
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])
  })

  test("supports hyper leader triggers", () => {
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
      ],
    })

    registerTimedLeader(keymap, {
      trigger: { name: "x", hyper: true },
    })

    keymap.registerLayer({
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[27;17;120~"))
    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])
  })

  test("disarms after its timeout", async () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const states: string[] = []

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

    registerTimedLeader(keymap, {
      trigger: { name: "x", ctrl: true },
      timeoutMs: 5,
      onArm() {
        states.push("armed")
      },
      onDisarm() {
        states.push("disarmed")
      },
    })

    keymap.registerLayer({
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    await Bun.sleep(20)
    mockInput.pressKey("a")

    expect(calls).toEqual([])
    expect(states).toEqual(["armed", "disarmed"])
  })

  test("disarms when disposed while armed", async () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = diagnostics.captureDiagnostics(keymap)
    const states: string[] = []

    const off = registerTimedLeader(keymap, {
      trigger: { name: "x", ctrl: true },
      timeoutMs: 5,
      onArm() {
        states.push("armed")
      },
      onDisarm() {
        states.push("disarmed")
      },
    })

    keymap.registerLayer({
      commands: [
        {
          name: "leader-action",
          run() {},
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    off()
    await Bun.sleep(20)

    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Unknown token "leader" in key sequence "<leader>a"; binding was skipped until the token is registered',
    ])
    expect(states).toEqual(["armed", "disarmed"])
  })

  test("disarms immediately when reactive invalidation clears the pending leader sequence", () => {
    const keymap = getKeymap(renderer)
    const states: string[] = []
    let enabled = true
    const listeners = new Set<() => void>()

    registerTimedLeader(keymap, {
      trigger: { name: "x", ctrl: true },
      timeoutMs: 1000,
      onArm() {
        states.push("armed")
      },
      onDisarm() {
        states.push("disarmed")
      },
    })

    keymap.registerLayer({ commands: [{ name: "leader-action", run() {} }] })
    keymap.registerLayer({
      enabled: {
        get() {
          return enabled
        },
        subscribe(onChange) {
          listeners.add(onChange)
          return () => {
            listeners.delete(onChange)
          }
        },
      },
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })

    expect(states).toEqual(["armed"])

    enabled = false
    for (const listener of listeners) {
      listener()
    }

    expect(states).toEqual(["armed", "disarmed"])
  })
})
