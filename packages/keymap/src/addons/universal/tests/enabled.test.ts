import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { stringifyKeySequence } from "@opentui/keymap"
import { registerDefaultKeys, registerEnabledFields } from "@opentui/keymap/addons"
import { createOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createDiagnosticHarness } from "../../../tests/diagnostic-harness.js"

let renderer: TestRenderer
let mockInput: MockInput
let keymap: ReturnType<typeof createOpenTuiKeymap>
const diagnostics = createDiagnosticHarness()

function getActiveKeyNames(): string[] {
  return keymap
    .getActiveKeys()
    .map((candidate) => candidate.stroke.name)
    .sort()
}

function getCommandNames(): string[] {
  return keymap
    .getCommands()
    .map((command) => command.name)
    .sort()
}

describe("enabled addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
    keymap = diagnostics.trackKeymap(createOpenTuiKeymap(renderer))
    registerDefaultKeys(keymap)
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("ignores enabled layer fields until the addon is registered", () => {
    const { takeWarnings } = diagnostics.captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "noop",
          run() {
            calls.push("noop")
          },
        },
      ],
    })

    expect(() => {
      keymap.registerLayer({
        enabled: false,
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(getActiveKeyNames()).toEqual(["x"])

    mockInput.pressKey("x")

    expect(takeWarnings().warnings).toEqual(['[Keymap] Unknown layer field "enabled" was ignored'])
    expect(calls).toEqual(["noop"])
  })

  test("ignores enabled command fields until the addon is registered", () => {
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "noop",
          enabled: false,
          run() {
            calls.push("noop")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "noop" }],
    })

    expect(getActiveKeyNames()).toEqual(["x"])
    expect(getCommandNames()).toEqual(["noop"])

    mockInput.pressKey("x")

    expect(calls).toEqual(["noop"])
  })

  test("registers layer and command enabled values from one addon registration", () => {
    const calls: string[] = []
    let layerEnabled = false
    let commandEnabled = false

    registerEnabledFields(keymap)
    keymap.registerLayer({
      commands: [
        {
          name: "layer-action",
          run() {
            calls.push("layer")
          },
        },
        {
          name: "always-off-command",
          enabled: false,
          run() {
            calls.push("always-off-command")
          },
        },
        {
          name: "dynamic-command",
          enabled: () => commandEnabled,
          run() {
            calls.push("dynamic-command")
          },
        },
      ],
    })

    keymap.registerLayer({
      enabled: false,
      bindings: [{ key: "x", cmd: "layer-action" }],
    })
    keymap.registerLayer({
      enabled: () => layerEnabled,
      bindings: [{ key: "y", cmd: "layer-action" }],
    })
    keymap.registerLayer({
      bindings: [
        { key: "z", cmd: "always-off-command" },
        { key: "u", cmd: "dynamic-command" },
      ],
    })

    expect(getActiveKeyNames()).toEqual([])
    expect(getCommandNames()).toEqual(["layer-action"])

    mockInput.pressKey("x")
    mockInput.pressKey("y")
    mockInput.pressKey("z")
    mockInput.pressKey("u")

    expect(calls).toEqual([])

    layerEnabled = true
    commandEnabled = true

    expect(getActiveKeyNames()).toEqual(["u", "y"])
    expect(getCommandNames()).toEqual(["dynamic-command", "layer-action"])

    mockInput.pressKey("y")
    mockInput.pressKey("u")

    expect(calls).toEqual(["layer", "dynamic-command"])
  })

  test("supports reactive enabled matchers and unsubscribes on layer unregister", () => {
    let current = false
    const listeners = new Set<() => void>()
    let evaluations = 0
    let subscribeCalls = 0
    let disposeCalls = 0

    const enabledMatcher = {
      get() {
        evaluations += 1
        return current
      },
      subscribe(onChange: () => void) {
        subscribeCalls += 1
        listeners.add(onChange)
        return () => {
          disposeCalls += 1
          listeners.delete(onChange)
        }
      },
    }

    const setEnabled = (next: boolean) => {
      if (current === next) {
        return
      }
      current = next
      for (const fn of listeners) {
        fn()
      }
    }

    registerEnabledFields(keymap)
    keymap.registerLayer({ commands: [{ name: "dynamic", run() {} }] })
    const off = keymap.registerLayer({
      enabled: enabledMatcher,
      bindings: [{ key: "y", cmd: "dynamic" }],
    })

    expect(subscribeCalls).toBe(1)
    expect(listeners.size).toBe(1)

    expect(getActiveKeyNames()).toEqual([])
    expect(evaluations).toBe(1)

    current = true
    expect(getActiveKeyNames()).toEqual(["y"])
    expect(evaluations).toBe(2)
    current = false

    setEnabled(true)
    expect(getActiveKeyNames()).toEqual(["y"])
    expect(evaluations).toBeGreaterThan(2)

    const enabledEvaluations = evaluations
    setEnabled(false)
    expect(getActiveKeyNames()).toEqual([])
    expect(evaluations).toBeGreaterThan(enabledEvaluations)

    off()
    expect(disposeCalls).toBe(1)
    expect(listeners.size).toBe(0)
  })

  test("supports reactive enabled command matchers and unsubscribes on layer unregister", () => {
    let current = false
    const listeners = new Set<() => void>()
    let evaluations = 0
    let subscribeCalls = 0
    let disposeCalls = 0

    const enabledMatcher = {
      get() {
        evaluations += 1
        return current
      },
      subscribe(onChange: () => void) {
        subscribeCalls += 1
        listeners.add(onChange)
        return () => {
          disposeCalls += 1
          listeners.delete(onChange)
        }
      },
    }

    const setEnabled = (next: boolean) => {
      if (current === next) {
        return
      }
      current = next
      for (const fn of listeners) {
        fn()
      }
    }

    registerEnabledFields(keymap)
    const off = keymap.registerLayer({
      commands: [{ name: "dynamic", enabled: enabledMatcher, run() {} }],
      bindings: [{ key: "y", cmd: "dynamic" }],
    })

    expect(subscribeCalls).toBe(1)
    expect(listeners.size).toBe(1)

    expect(getActiveKeyNames()).toEqual([])
    expect(getCommandNames()).toEqual([])
    expect(evaluations).toBeGreaterThan(0)

    current = true
    expect(getActiveKeyNames()).toEqual(["y"])
    expect(getCommandNames()).toEqual(["dynamic"])
    expect(evaluations).toBeGreaterThan(0)
    current = false

    setEnabled(true)
    expect(getActiveKeyNames()).toEqual(["y"])
    expect(getCommandNames()).toEqual(["dynamic"])
    expect(evaluations).toBeGreaterThan(0)

    const enabledEvaluations = evaluations
    setEnabled(false)
    expect(getActiveKeyNames()).toEqual([])
    expect(getCommandNames()).toEqual([])
    expect(evaluations).toBeGreaterThan(enabledEvaluations)

    off()
    expect(disposeCalls).toBe(1)
    expect(listeners.size).toBe(0)
  })

  test("clears pending sequences when enabled stops matching", () => {
    let enabled = true

    registerEnabledFields(keymap)
    keymap.registerLayer({ commands: [{ name: "delete-line", run() {} }] })
    keymap.registerLayer({
      enabled: () => enabled,
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    mockInput.pressKey("d")

    expect(keymap.getPendingSequence()).toHaveLength(1)

    enabled = false

    expect(keymap.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames()).toEqual([])
  })

  test("reactive enabled matchers synchronously emit pending sequence clears", () => {
    let enabled = true
    const listeners = new Set<() => void>()
    const changes: string[] = []

    registerEnabledFields(keymap)
    keymap.registerLayer({ commands: [{ name: "delete-line", run() {} }] })
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
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    keymap.on("pendingSequence", (sequence) => {
      changes.push(stringifyKeySequence(sequence, { preferDisplay: true }))
    })

    mockInput.pressKey("d")

    expect(changes).toEqual(["d"])

    enabled = false
    for (const listener of listeners) {
      listener()
    }

    expect(changes).toEqual(["d", ""])
  })

  test("rejects invalid enabled values on layer and command fields and can be disposed", () => {
    const offEnabled = registerEnabledFields(keymap)
    const calls: string[] = []
    const { takeErrors, takeWarnings } = diagnostics.captureDiagnostics(keymap)

    keymap.registerLayer({
      commands: [
        {
          name: "noop",
          run() {
            calls.push("noop")
          },
        },
      ],
    })

    expect(() => {
      keymap.registerLayer({
        enabled: "yes",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(() => {
      keymap.registerLayer({
        commands: [
          {
            name: "bad-command",
            enabled: "yes",
            run() {
              calls.push("bad")
            },
          },
        ],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual([
      'Keymap enabled field "enabled" must be a boolean, a function, or a reactive matcher',
      'Keymap enabled field "enabled" must be a boolean, a function, or a reactive matcher',
    ])
    expect(getActiveKeyNames()).toEqual([])
    expect(getCommandNames()).toEqual(["noop"])

    offEnabled()

    expect(() => {
      keymap.registerLayer({
        enabled: true,
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()
    expect(() => {
      keymap.registerLayer({
        commands: [
          {
            name: "active-command",
            enabled: false,
            run() {
              calls.push("active")
            },
          },
        ],
        bindings: [{ key: "y", cmd: "active-command" }],
      })
    }).not.toThrow()

    expect(getActiveKeyNames()).toEqual(["x", "y"])
    expect(getCommandNames()).toEqual(["active-command", "noop"])

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(takeWarnings().warnings).toEqual(['[Keymap] Unknown layer field "enabled" was ignored'])
    expect(calls).toEqual(["noop", "active"])
  })

  test("treats thrown enabled predicates as disabled for layer and command fields", () => {
    const { takeErrors } = diagnostics.captureDiagnostics(keymap)
    const calls: string[] = []

    registerEnabledFields(keymap)
    keymap.registerLayer({
      commands: [
        {
          name: "layer-noop",
          run() {
            calls.push("layer")
          },
        },
        {
          name: "command-noop",
          enabled: () => {
            throw new Error("command boom")
          },
          run() {
            calls.push("command")
          },
        },
      ],
    })
    keymap.registerLayer({
      enabled: () => {
        throw new Error("layer boom")
      },
      bindings: [{ key: "x", cmd: "layer-noop" }],
    })
    keymap.registerLayer({
      bindings: [{ key: "y", cmd: "command-noop" }],
    })

    expect(() => keymap.getActiveKeys()).not.toThrow()
    expect(getActiveKeyNames()).toEqual([])

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    const { errors } = takeErrors()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.every((message) => message === "[Keymap] Error evaluating runtime matcher from field enabled:")).toBe(
      true,
    )
    expect(calls).toEqual([])
  })
})
