import { describe, expect, test } from "bun:test"
import { registerCommaBindings, registerLeader, registerTimedLeader } from "../addons/index.js"
import { createBindingLookup } from "../extras/index.js"
import { stringifyKeySequence } from "../index.js"
import { createTestKeymap } from "../testing/index.js"

function unknownTokenWarning(token: string, sequence: string) {
  return `[Keymap] Unknown token "${token}" in key sequence "${sequence}"; binding was skipped until the token is registered`
}

describe("keymap: unresolved tokens", () => {
  test("skips the whole unresolved token binding instead of compiling the remaining keys", () => {
    const harness = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []

    harness.keymap.registerLayer({
      commands: [{ name: "run", run: () => calls.push("run") }],
      bindings: [{ key: "g<leader>q", cmd: "run" }],
    })

    expect(harness.diagnostics.takeWarnings().warnings).toEqual([unknownTokenWarning("leader", "g<leader>q")])
    expect(harness.keymap.getActiveKeys()).toEqual([])

    harness.host.press("g")
    harness.host.press("q")

    expect(calls).toEqual([])
    harness.cleanup()
  })

  test("keeps unresolved token bindings dormant until the token is registered", () => {
    const harness = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []

    harness.keymap.registerLayer({
      commands: [{ name: "leader-action", run: () => calls.push("leader") }],
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    expect(harness.diagnostics.takeWarnings().warnings).toEqual([unknownTokenWarning("leader", "<leader>a")])
    expect(harness.keymap.getActiveKeys()).toEqual([])

    harness.host.press("a")
    expect(calls).toEqual([])

    const offToken = harness.keymap.registerToken({ name: "leader", key: { name: "x", ctrl: true } })

    expect(harness.keymap.getActiveKeys().map((key) => key.display)).toEqual(["<leader>"])

    harness.host.press("a")
    expect(calls).toEqual([])

    harness.host.press("x", { ctrl: true })
    expect(stringifyKeySequence(harness.keymap.getPendingSequence(), { preferDisplay: true })).toBe("<leader>")

    harness.host.press("a")
    expect(calls).toEqual(["leader"])

    offToken()

    expect(harness.keymap.getActiveKeys()).toEqual([])
    expect(harness.diagnostics.takeWarnings().warnings).toEqual([])

    harness.host.press("a")
    expect(calls).toEqual(["leader"])
    harness.cleanup()
  })

  test("drops only unresolved comma-expanded alternatives", () => {
    const harness = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []
    registerCommaBindings(harness.keymap)

    harness.keymap.registerLayer({
      commands: [{ name: "exit", run: () => calls.push("exit") }],
      bindings: [{ key: "ctrl+c,ctrl+d,<leader>q", cmd: "exit" }],
    })

    expect(harness.diagnostics.takeWarnings().warnings).toEqual([unknownTokenWarning("leader", "<leader>q")])
    expect(harness.keymap.getActiveKeys().map((key) => key.display)).toEqual(["ctrl+c", "ctrl+d"])

    harness.host.press("q")
    expect(calls).toEqual([])

    harness.host.press("c", { ctrl: true })
    harness.host.press("d", { ctrl: true })
    expect(calls).toEqual(["exit", "exit"])

    harness.keymap.registerToken({ name: "leader", key: { name: "x", ctrl: true } })

    expect(harness.keymap.getActiveKeys().map((key) => key.display)).toEqual(["ctrl+c", "ctrl+d", "<leader>"])

    harness.host.press("x", { ctrl: true })
    harness.host.press("q")
    expect(calls).toEqual(["exit", "exit", "exit"])
    harness.cleanup()
  })

  test("parseKeySequence fails closed for unresolved tokens", () => {
    const harness = createTestKeymap({ defaultKeys: true })

    expect(harness.keymap.parseKeySequence("<leader>q")).toEqual([])
    expect(harness.diagnostics.takeWarnings().warnings).toEqual([unknownTokenWarning("leader", "<leader>q")])

    harness.keymap.registerToken({ name: "leader", key: { name: "space" } })

    expect(harness.keymap.parseKeySequence("<leader>q").map((part) => part.display)).toEqual(["<leader>", "q"])
    harness.cleanup()
  })

  test("leader addons treat empty binding lookup triggers as disabled", () => {
    const harness = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []
    const lookup = createBindingLookup({ leader: "none" })

    expect(() => registerLeader(harness.keymap, { trigger: lookup.get("leader") })).not.toThrow()
    expect(() => registerTimedLeader(harness.keymap, { trigger: lookup.get("leader") })).not.toThrow()

    harness.keymap.registerLayer({
      commands: [{ name: "leader-action", run: () => calls.push("leader") }],
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    expect(harness.diagnostics.takeWarnings().warnings).toEqual([unknownTokenWarning("leader", "<leader>a")])
    expect(harness.keymap.getActiveKeys()).toEqual([])

    harness.host.press("a")
    expect(calls).toEqual([])
    harness.cleanup()
  })
})
