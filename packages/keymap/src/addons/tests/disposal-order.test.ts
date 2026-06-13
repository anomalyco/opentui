import { afterEach, describe, expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import {
  registerAliasesField,
  registerBackspacePopsPendingSequence,
  registerBindingOverrides,
  registerCommaBindings,
  registerDeadBindingWarnings,
  registerDefaultKeys,
  registerEmacsBindings,
  registerEnabledFields,
  registerExCommands,
  registerEscapeClearsPendingSequence,
  registerMetadataFields,
  registerTimedLeader,
  registerUnresolvedCommandWarnings,
} from "@opentui/keymap/addons"
import { registerBaseLayoutFallback, registerManagedTextareaLayer } from "@opentui/keymap/addons/opentui"
import { Keymap } from "@opentui/keymap"
import { createDefaultOpenTuiKeymap, createOpenTuiKeymapHost } from "@opentui/keymap/opentui"
import { createDiagnosticHarness } from "../../tests/diagnostic-harness.js"

const diagnostics = createDiagnosticHarness()

function createDiagnosticsOpenTuiKeymap(renderer: TestRenderer) {
  return new Keymap(createOpenTuiKeymapHost(renderer))
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [items.slice()]
  }

  const result: T[][] = []
  for (let index = 0; index < items.length; index += 1) {
    const current = items[index]
    if (current === undefined) {
      continue
    }

    const rest = [...items.slice(0, index), ...items.slice(index + 1)]
    for (const tail of permutations(rest)) {
      result.push([current, ...tail])
    }
  }

  return result
}

function assertLiveEngine(renderer: TestRenderer, keymap: ReturnType<typeof createDefaultOpenTuiKeymap>): void {
  expect(renderer.isDestroyed).toBe(false)
  expect(() => keymap.getCommands()).not.toThrow()
  expect(() => keymap.getActiveKeys({ includeMetadata: true })).not.toThrow()
  expect(() => keymap.getPendingSequence()).not.toThrow()
  expect(() => keymap.runCommand(":write")).not.toThrow()
}

function assertExpectedTeardownDiagnostics(keymap: ReturnType<typeof createDefaultOpenTuiKeymap>): void {
  const capture = diagnostics.captureDiagnostics(keymap)
  const { warnings } = capture.takeWarnings()
  expect(
    warnings.every(
      (warning) =>
        warning ===
          '[Keymap] Unknown token "leader" in key sequence "<leader>a"; binding was skipped until the token is registered' ||
        warning === '[Keymap] Unknown binding field "desc" was ignored',
    ),
  ).toBe(true)
  expect(capture.takeErrors().errors).toEqual([])
}

async function createStatefulAddonScenario() {
  const testSetup = await createTestRenderer({ width: 60, height: 12, kittyKeyboard: true })
  const { renderer, mockInput } = testSetup
  const keymap = diagnostics.trackKeymap(createDefaultOpenTuiKeymap(renderer))
  const capture = diagnostics.captureDiagnostics(keymap)
  const editor = new TextareaRenderable(renderer, {
    width: 24,
    height: 4,
    initialValue: "Line 1\nLine 2\nLine 3",
  })
  renderer.root.add(editor)

  const offState = keymap.on("state", () => {})
  const offTimedLeader = registerTimedLeader(keymap, {
    trigger: { name: "x", ctrl: true },
    timeoutMs: 1_000,
  })
  const offExCommands = registerExCommands(keymap)
  const offManagedTextarea = registerManagedTextareaLayer(keymap, renderer, {
    bindings: [{ key: "dd", cmd: "input.delete.line" }],
  })
  const offBackspace = registerBackspacePopsPendingSequence(keymap)

  keymap.registerLayer({
    commands: [
      {
        name: "write",
        namespace: "excommands",
        run() {
          return true
        },
      },
      {
        name: "leader-action",
        run() {
          return true
        },
      },
    ],
    bindings: [{ key: "<leader>a", cmd: "leader-action", desc: "Leader action" }],
  })

  editor.focus()
  mockInput.pressKey("x", { ctrl: true })

  expect(editor.traits.suspend).toBe(true)
  expect(keymap.hasPendingSequence()).toBe(true)
  expect(capture.takeWarnings().warnings).toEqual([])
  expect(capture.takeErrors().errors).toEqual([])
  assertLiveEngine(renderer, keymap)

  return {
    renderer,
    keymap,
    disposers: {
      state: offState,
      timedLeader: offTimedLeader,
      exCommands: offExCommands,
      managedTextarea: offManagedTextarea,
      backspace: offBackspace,
    } as const,
  }
}

async function createHookScenario() {
  const testSetup = await createTestRenderer({ width: 40, height: 10 })
  const { renderer, mockInput } = testSetup
  const keymap = diagnostics.trackKeymap(createDefaultOpenTuiKeymap(renderer))
  const capture = diagnostics.captureDiagnostics(keymap)

  const offWarning = keymap.on("warning", () => {})
  const offError = keymap.on("error", () => {})
  const offState = keymap.on("state", () => {})
  const offPendingSequence = keymap.on("pendingSequence", () => {})

  const offTimedLeader = registerTimedLeader(keymap, {
    trigger: { name: "x", ctrl: true },
    timeoutMs: 1_000,
  })
  const offWarnings = registerUnresolvedCommandWarnings(keymap)

  keymap.registerLayer({ commands: [{ name: "leader-action", run() {} }] })
  keymap.registerLayer({ bindings: [{ key: "<leader>a", cmd: "leader-action" }] })
  keymap.registerLayer({ bindings: [{ key: "z", cmd: "missing-command" }] })
  keymap.registerLayer({ commands: [{ name: "bad name", run() {} }] })

  mockInput.pressKey("x", { ctrl: true })
  expect(keymap.hasPendingSequence()).toBe(true)
  expect(capture.takeWarnings().warnings).toEqual(['[Keymap] Unresolved command "missing-command" for binding "z"'])
  expect(capture.takeErrors().errors).toEqual([
    'Invalid keymap command name "bad name": command names cannot contain whitespace',
  ])
  assertLiveEngine(renderer, keymap)

  return {
    renderer,
    keymap,
    cleanup: () => {
      offWarnings()
      offTimedLeader()
    },
    disposers: {
      warning: offWarning,
      error: offError,
      state: offState,
      pendingSequence: offPendingSequence,
    } as const,
  }
}

async function createInfrastructureScenario() {
  const testSetup = await createTestRenderer({ width: 40, height: 10 })
  const { renderer, mockInput } = testSetup
  const keymap = diagnostics.trackKeymap(createDiagnosticsOpenTuiKeymap(renderer))
  const capture = diagnostics.captureDiagnostics(keymap)

  const offDefaultKeys = registerDefaultKeys(keymap)
  const offEnabled = registerEnabledFields(keymap)
  const offMetadata = registerMetadataFields(keymap)
  const offAliases = registerAliasesField(keymap)
  const offBindingOverrides = registerBindingOverrides(keymap)
  const offComma = registerCommaBindings(keymap)
  const offEmacs = registerEmacsBindings(keymap)
  const offDeadWarnings = registerDeadBindingWarnings(keymap)
  const offUnresolvedWarnings = registerUnresolvedCommandWarnings(keymap)
  const offEscape = registerEscapeClearsPendingSequence(keymap)
  const offBaseLayout = registerBaseLayoutFallback(keymap)

  keymap.registerLayer({
    aliases: { enter: "return" },
    commands: [
      {
        name: "save-file",
        enabled: true,
        desc: "Save file",
        title: "Save",
        category: "File",
        run() {},
      },
    ],
    bindings: [
      { key: "enter", cmd: "save-file", desc: "Write file", group: "File" },
      { key: "space,tab", cmd: "save-file" },
      { key: "ctrl+x ctrl+s", cmd: "save-file" },
      { key: "y", cmd: "missing-command" },
      { key: "z", desc: "Dead binding" },
    ],
  })

  mockInput.pressKey("x", { ctrl: true })
  expect(capture.takeWarnings().warnings).toEqual([
    '[Keymap] Binding "z" has no command and no reachable continuations; it will never trigger',
    '[Keymap] Unresolved command "missing-command" for binding "y"',
  ])
  expect(capture.takeErrors().errors).toEqual([])
  expect(() => keymap.getActiveKeys({ includeMetadata: true })).not.toThrow()
  expect(() => keymap.getCommands()).not.toThrow()

  return {
    renderer,
    keymap,
    disposers: {
      defaultKeys: offDefaultKeys,
      enabled: offEnabled,
      metadata: offMetadata,
      aliases: offAliases,
      bindingOverrides: offBindingOverrides,
      comma: offComma,
      emacs: offEmacs,
      deadWarnings: offDeadWarnings,
      unresolvedWarnings: offUnresolvedWarnings,
      escape: offEscape,
      baseLayout: offBaseLayout,
    } as const,
  }
}

describe("addon teardown order", () => {
  afterEach(() => {
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("singleton builtin addons are idempotent and reference counted", async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    const { renderer, mockInput } = testSetup
    const keymap = diagnostics.trackKeymap(createDiagnosticsOpenTuiKeymap(renderer))
    const capture = diagnostics.captureDiagnostics(keymap)
    const installSingletons = () => [
      registerDefaultKeys(keymap),
      registerEnabledFields(keymap),
      registerMetadataFields(keymap),
      registerAliasesField(keymap),
      registerBindingOverrides(keymap),
      registerCommaBindings(keymap),
      registerEmacsBindings(keymap),
      registerDeadBindingWarnings(keymap),
      registerUnresolvedCommandWarnings(keymap),
      registerBaseLayoutFallback(keymap),
    ]

    const firstDisposers = installSingletons()
    const secondDisposers = installSingletons()
    const calls: string[] = []

    expect(capture.takeErrors().errors).toEqual([])

    for (const dispose of firstDisposers) {
      dispose()
    }

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          enabled: true,
          desc: "Save file",
          title: "Save",
          category: "File",
          run() {
            calls.push("save")
          },
        },
        {
          name: "override-command",
          run() {
            calls.push("override")
          },
        },
        {
          name: "comma-command",
          run() {
            calls.push("comma")
          },
        },
        {
          name: "emacs-command",
          run() {
            calls.push("emacs")
          },
        },
      ],
    })
    keymap.registerLayer({
      aliases: { enter: "return" },
      bindings: [{ key: "enter", cmd: "save-file", desc: "Save binding", group: "File" }],
    })
    keymap.registerLayer({
      bindingOverrides: [{ key: "o", cmd: "override-command" }],
      bindings: [{ key: "p", cmd: "override-command" }],
    })
    keymap.registerLayer({ bindings: [{ key: "a,b", cmd: "comma-command" }] })
    keymap.registerLayer({ bindings: [{ key: "ctrl+x ctrl+s", cmd: "emacs-command" }] })
    keymap.registerLayer({ bindings: [{ key: "u", cmd: "missing-command" }, { key: "d" }] })

    expect(capture.takeWarnings().warnings).toEqual([
      '[Keymap] Binding "d" has no command and no reachable continuations; it will never trigger',
      '[Keymap] Unresolved command "missing-command" for binding "u"',
    ])
    expect(capture.takeErrors().errors).toEqual([])
    expect(
      keymap.getCommands({ visibility: "registered" }).find((command) => command.name === "save-file"),
    ).toMatchObject({
      desc: "Save file",
      title: "Save",
      category: "File",
    })
    expect(
      keymap.getActiveKeys({ includeMetadata: true }).find((key) => key.stroke.name === "return")?.bindingAttrs,
    ).toEqual({ desc: "Save binding", group: "File" })

    mockInput.pressEnter()
    mockInput.pressKey("o")
    mockInput.pressKey("p")
    mockInput.pressKey("a")
    mockInput.pressKey("b")
    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("s", { ctrl: true })

    expect(calls).toEqual(["save", "override", "comma", "comma", "emacs"])

    for (const dispose of secondDisposers) {
      dispose()
    }

    keymap.registerLayer({
      enabled: false,
      commands: [{ name: "after-dispose", run() {} }],
      bindings: [{ key: { name: "q" }, cmd: "after-dispose", desc: "After dispose" }],
    })

    expect(capture.takeWarnings().warnings).toEqual([
      '[Keymap] Unknown layer field "enabled" was ignored',
      '[Keymap] Unknown binding field "desc" was ignored',
    ])
    expect(
      keymap.getActiveKeys({ includeMetadata: true }).find((key) => key.stroke.name === "q")?.bindingAttrs,
    ).toBeUndefined()

    renderer.destroy()
  })

  test("stateful addon and hook disposers stay safe in every live-order permutation", async () => {
    const orderings = permutations(["state", "timedLeader", "exCommands", "managedTextarea", "backspace"] as const)

    for (const ordering of orderings) {
      const scenario = await createStatefulAddonScenario()

      try {
        for (const name of ordering) {
          expect(() => scenario.disposers[name]()).not.toThrow()
          assertLiveEngine(scenario.renderer, scenario.keymap)
        }
      } finally {
        if (!scenario.renderer.isDestroyed) {
          scenario.renderer.destroy()
        }

        assertExpectedTeardownDiagnostics(scenario.keymap)
      }
    }
  })

  test("stateful addon disposers stay safe in every order at every destroy pivot", async () => {
    const orderings = permutations(["timedLeader", "exCommands", "managedTextarea", "backspace"] as const)

    for (const ordering of orderings) {
      for (let pivot = 0; pivot <= ordering.length; pivot += 1) {
        const scenario = await createStatefulAddonScenario()

        try {
          for (const name of ordering.slice(0, pivot)) {
            expect(() => scenario.disposers[name]()).not.toThrow()
            assertLiveEngine(scenario.renderer, scenario.keymap)
          }

          expect(() => scenario.renderer.destroy()).not.toThrow()
          expect(scenario.renderer.isDestroyed).toBe(true)

          for (const name of ordering.slice(pivot)) {
            expect(() => scenario.disposers[name]()).not.toThrow()
          }
        } finally {
          if (!scenario.renderer.isDestroyed) {
            scenario.renderer.destroy()
          }

          assertExpectedTeardownDiagnostics(scenario.keymap)
        }
      }
    }
  })

  test("hook listeners stay safe in every order before and after host destruction", async () => {
    const orderings = permutations(["warning", "error", "state", "pendingSequence"] as const)

    for (const ordering of orderings) {
      for (let pivot = 0; pivot <= ordering.length; pivot += 1) {
        const scenario = await createHookScenario()

        try {
          for (const name of ordering.slice(0, pivot)) {
            expect(() => scenario.disposers[name]()).not.toThrow()
            assertLiveEngine(scenario.renderer, scenario.keymap)
          }

          expect(() => scenario.renderer.destroy()).not.toThrow()
          expect(scenario.renderer.isDestroyed).toBe(true)

          for (const name of ordering.slice(pivot)) {
            expect(() => scenario.disposers[name]()).not.toThrow()
          }

          expect(() => scenario.cleanup()).not.toThrow()
        } finally {
          if (!scenario.renderer.isDestroyed) {
            scenario.renderer.destroy()
          }

          assertExpectedTeardownDiagnostics(scenario.keymap)
        }
      }
    }
  })

  test("field, parser, analyzer, transformer, resolver, and intercept addon disposers remain safe live and post-destroy", async () => {
    const liveOrder = [
      "baseLayout",
      "comma",
      "unresolvedWarnings",
      "aliases",
      "bindingOverrides",
      "escape",
      "deadWarnings",
      "metadata",
      "enabled",
      "emacs",
      "defaultKeys",
    ] as const
    const destroyedOrder = [
      "enabled",
      "defaultKeys",
      "aliases",
      "bindingOverrides",
      "baseLayout",
      "metadata",
      "comma",
      "escape",
      "emacs",
      "deadWarnings",
      "unresolvedWarnings",
    ] as const

    {
      const scenario = await createInfrastructureScenario()

      try {
        for (const name of liveOrder) {
          expect(() => scenario.disposers[name]()).not.toThrow()
          expect(() => scenario.keymap.getCommands()).not.toThrow()
          expect(() => scenario.keymap.getActiveKeys({ includeMetadata: true })).not.toThrow()
        }
      } finally {
        if (!scenario.renderer.isDestroyed) {
          scenario.renderer.destroy()
        }

        assertExpectedTeardownDiagnostics(scenario.keymap)
      }
    }

    {
      const scenario = await createInfrastructureScenario()

      try {
        expect(() => scenario.renderer.destroy()).not.toThrow()
        expect(scenario.renderer.isDestroyed).toBe(true)

        for (const name of destroyedOrder) {
          expect(() => scenario.disposers[name]()).not.toThrow()
        }
      } finally {
        if (!scenario.renderer.isDestroyed) {
          scenario.renderer.destroy()
        }

        assertExpectedTeardownDiagnostics(scenario.keymap)
      }
    }
  })
})
