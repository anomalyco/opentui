import { Buffer } from "node:buffer"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Readable } from "node:stream"
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

  test.each([
    { kind: "stroke", trigger: { name: "x", ctrl: true }, input: "\x18" },
    {
      kind: "binding lookup",
      trigger: createBindingLookup({ leader: { name: "x", ctrl: true } }).get("leader"),
      input: "\x18",
    },
    { kind: "hyper", trigger: { name: "x", hyper: true }, input: "\x1b[27;17;120~" },
  ])("supports a $kind leader trigger", ({ trigger, input }) => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    registerTimedLeader(keymap, { trigger })
    keymap.registerLayer({
      commands: [{ name: "leader-action", run: () => void calls.push("leader") }],
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })
    renderer.stdin.emit("data", Buffer.from(input))
    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])
  })

  test("disarms after its timeout", async () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const states: string[] = []
    const disarmed = Promise.withResolvers<void>()

    registerTimedLeader(keymap, {
      trigger: { name: "x", ctrl: true },
      timeoutMs: 5,
      onArm() {
        states.push("armed")
      },
      onDisarm() {
        states.push("disarmed")
        disarmed.resolve()
      },
    })

    keymap.registerLayer({
      bindings: [{ key: "<leader>a", cmd: () => void calls.push("leader") }],
    })

    mockInput.pressKey("x", { ctrl: true })
    await disarmed.promise
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

for (const addon of ["leader", "neovim"]) {
  test.each([
    { delay: 35, stall: 0, expected: "chord" },
    { delay: 340, stall: 0, expected: addon === "leader" ? "plain f" : "exact,plain f" },
    { delay: 35, stall: 700, expected: "chord" },
  ])(`${addon}: follow-up at +$delay ms with a $stall ms stall`, async ({ delay, stall, expected }) => {
    const timeout = 250
    await using child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "timed-sequence.fixture.ts"), addon, String(timeout), String(stall)],
      {
        stdin: "pipe",
        stdout: "pipe",
        timeout: 4000,
      },
    )
    child.stdin.write(addon === "leader" ? "\x18" : "g")
    await child.stdin.flush()
    const lines = createInterface({ input: Readable.from(child.stdout) })[Symbol.asyncIterator]()
    const armedAt = Number((await lines.next()).value)
    await Bun.sleep(delay)
    child.stdin.write("fb")
    await child.stdin.flush()
    expect(Date.now() - armedAt < timeout).toBe(delay < timeout)
    expect((await lines.next()).value).toBe(expected)
    // The old timer must not discard the plain prefix started in the same read as f.
    await Bun.sleep(35)
    child.stdin.write("a")
    await child.stdin.flush()
    expect((await lines.next()).value).toBe("next chord")
    expect(await child.exited).toBe(0)
  })
}
