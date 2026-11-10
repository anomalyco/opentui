import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable, KeyEvent, type Renderable } from "@opentui/core"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import * as addons from "../addons/index.js"
import {
  stringifyKeySequence,
  stringifyKeyStroke,
  type ActiveKey,
  type ActiveKeyOptions,
  type BindingParser,
  type ErrorEvent,
  type EventMatchResolverContext,
  type Keymap,
  type ReactiveMatcher,
  type WarningEvent,
} from "../index.js"
import { createDefaultOpenTuiKeymap, createOpenTuiKeymap } from "../opentui.js"
import { createDiagnosticHarness } from "./diagnostic-harness.js"
import { createKeymapTestHelpers, type OpenTuiKeymap } from "./keymap.test-support.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()
const {
  createFocusableBox,
  getActiveKey,
  getActiveKeyNames,
  getParserKeymap,
  getKeymap,
  createBareKeymap,
  getCommand,
  getCommandEntry,
  getActiveKeyDisplay,
  captureDiagnostics,
  matchEventAs,
  createBracketTokenParser,
  createReactiveBoolean,
} = createKeymapTestHelpers(diagnostics, () => renderer)

describe("keymap: tokens and lifecycle", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })
  test("clears pending sequences when a layer is disposed", () => {
    const keymap = getKeymap(renderer)

    keymap.registerLayer({ commands: [{ name: "delete-line", run() {} }] })

    const offLayer = keymap.registerLayer({
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    mockInput.pressKey("d")
    expect(keymap.getPendingSequence()).toHaveLength(1)

    offLayer()

    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("clears pending sequences when layer requirements stop matching", () => {
    const keymap = getKeymap(renderer)

    keymap.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    keymap.registerLayer({ commands: [{ name: "delete-line", run() {} }] })
    keymap.registerLayer({
      mode: "normal",
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    keymap.setData("vim.mode", "normal")
    mockInput.pressKey("d")
    expect(keymap.getPendingSequence()).toHaveLength(1)

    keymap.setData("vim.mode", "visual")

    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("can unsubscribe pending sequence listeners", () => {
    const keymap = getKeymap(renderer)
    const changes: string[] = []

    keymap.registerLayer({ commands: [{ name: "delete-ca", run() {} }] })
    keymap.registerLayer({
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    const off = keymap.on("pendingSequence", (sequence) => {
      changes.push(stringifyKeySequence(sequence, { preferDisplay: true }))
    })

    mockInput.pressKey("d")
    off()
    mockInput.pressKey("c")
    keymap.clearPendingSequence()

    expect(changes).toEqual(["d"])
  })

  test("uses a stable pending sequence listener snapshot when listeners unsubscribe mid-notification", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({ commands: [{ name: "delete-ca", run() {} }] })
    keymap.registerLayer({
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    let offSecond!: () => void

    keymap.on("pendingSequence", (sequence) => {
      calls.push(`first:${stringifyKeySequence(sequence, { preferDisplay: true })}`)
      offSecond()
    })

    offSecond = keymap.on("pendingSequence", (sequence) => {
      calls.push(`second:${stringifyKeySequence(sequence, { preferDisplay: true })}`)
    })

    mockInput.pressKey("d")
    keymap.clearPendingSequence()

    expect(calls).toEqual(["first:d", "second:d", "first:"])
  })

  test("emits pending sequence listener failures and continues notifying remaining listeners", () => {
    const changes: string[] = []
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.registerLayer({ commands: [{ name: "delete-ca", run() {} }] })
    keymap.registerLayer({
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    const offBadListener = keymap.on("pendingSequence", () => {
      throw new Error("boom")
    })
    const offGoodListener = keymap.on("pendingSequence", (sequence) => {
      changes.push(stringifyKeySequence(sequence, { preferDisplay: true }))
    })

    mockInput.pressKey("d")

    expect(changes).toEqual(["d"])
    expect(takeErrors().errors.some((message) => message.includes("Error in pending sequence listener:"))).toBe(true)

    offBadListener()
    offGoodListener()
  })

  test("recompiles tokenized layers when tokens are registered and disposed", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = captureDiagnostics(keymap)
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

    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Unknown token "leader" in key sequence "<leader>a"; binding was skipped until the token is registered',
    ])

    expect(getActiveKeyNames(keymap)).toEqual([])

    mockInput.pressKey("a")
    expect(calls).toEqual([])

    const offToken = keymap.registerToken({
      name: "leader",
      key: { name: "x", ctrl: true },
    })

    expect(getActiveKeyNames(keymap)).toEqual(["x"])
    expect(getActiveKeyDisplay(keymap, "<leader>")?.command).toBeUndefined()

    mockInput.pressKey("a")
    expect(calls).toEqual([])

    mockInput.pressKey("x", { ctrl: true })
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("<leader>")
    expect(getActiveKeyNames(keymap)).toEqual(["a"])

    mockInput.pressKey("a")
    expect(calls).toEqual(["leader"])

    offToken()

    expect(getActiveKeyNames(keymap)).toEqual([])

    mockInput.pressKey("a")
    expect(calls).toEqual(["leader"])
  })

  test("keeps token-only bindings inactive until the token is registered", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "leader-only",
          run() {
            calls.push("leader-only")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "<leader>", cmd: "leader-only" }],
    })

    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Unknown token "leader" in key sequence "<leader>"; binding was skipped until the token is registered',
    ])

    expect(keymap.getActiveKeys()).toEqual([])

    keymap.registerToken({
      name: "leader",
      key: { name: "x", ctrl: true },
    })

    expect(getActiveKeyDisplay(keymap, "<leader>")?.command).toBe("leader-only")

    mockInput.pressKey("x", { ctrl: true })

    expect(calls).toEqual(["leader-only"])
  })

  test("clears pending tokenized sequences when token disposal recompiles their layer", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = captureDiagnostics(keymap)

    keymap.registerLayer({ commands: [{ name: "leader-action", run() {} }] })
    const offToken = keymap.registerToken({
      name: "leader",
      key: { name: "x", ctrl: true },
    })
    keymap.registerLayer({
      bindings: [{ key: "<leader>ab", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("a")

    expect(keymap.getPendingSequence()).toMatchObject([
      {
        stroke: { name: "x", ctrl: true, shift: false, meta: false, super: false },
        display: "<leader>",
      },
      {
        stroke: { name: "a", ctrl: false, shift: false, meta: false, super: false },
        display: "a",
      },
    ])

    offToken()

    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Unknown token "leader" in key sequence "<leader>ab"; binding was skipped until the token is registered',
    ])
    expect(keymap.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames(keymap)).toEqual([])
  })

  test("skips conflicting tokenized bindings when token registration creates a prefix conflict", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors, takeWarnings } = captureDiagnostics(keymap)

    keymap.registerLayer({
      commands: [
        { name: "plain", run() {} },
        { name: "tokenized", run() {} },
      ],
    })

    keymap.registerLayer({
      bindings: [
        { key: "a", cmd: "plain" },
        { key: "<leader>b", cmd: "tokenized" },
      ],
    })

    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Unknown token "leader" in key sequence "<leader>b"; binding was skipped until the token is registered',
    ])

    expect(getActiveKeyNames(keymap)).toEqual(["a"])

    expect(() => {
      keymap.registerToken({
        name: "leader",
        key: "a",
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual([
      "Keymap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
    ])
    expect(getActiveKeyNames(keymap)).toEqual(["a"])
  })

  test("can dispose layer, binding, and command field registrations", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = captureDiagnostics(keymap)

    keymap.registerLayer({ commands: [{ name: "noop", run() {} }] })

    const offLayerFields = keymap.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })
    offLayerFields()

    expect(() => {
      keymap.registerLayer({
        mode: "normal",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(getActiveKeyNames(keymap)).toContain("x")

    const offBindingFields = keymap.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })
    offBindingFields()

    expect(() => {
      keymap.registerLayer({
        bindings: [{ key: "y", mode: "normal", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(getActiveKeyNames(keymap)).toContain("y")

    const offCommandFields = keymap.registerCommandFields({
      summary(value, ctx) {
        ctx.attr("desc", value)
      },
    })
    offCommandFields()

    expect(() => {
      keymap.registerLayer({
        commands: [
          {
            name: "noop-with-desc",
            summary: "No operation",
            run() {},
          },
        ],
      })
    }).not.toThrow()

    keymap.registerLayer({
      bindings: [{ key: "z", cmd: "noop-with-desc" }],
    })

    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Unknown layer field "mode" was ignored',
      '[Keymap] Unknown binding field "mode" was ignored',
    ])
    expect(getActiveKeyNames(keymap)).toContain("z")
  })

  test("getActiveKeys follows dispatch order and fallthrough across layers", () => {
    const keymap = getKeymap(renderer)
    const target = createFocusableBox("dispatch-active-target")

    renderer.root.add(target)

    keymap.registerLayer({
      commands: [
        { name: "save", category: "File", run() {} },
        { name: "help", category: "Help", run() {} },
      ],
    })

    keymap.registerLayer({
      bindings: [
        { key: "x", cmd: "save", desc: "Global x" },
        { key: "y", cmd: "help", desc: "Global y" },
      ],
    })
    keymap.registerLayer({
      target,
      bindings: [
        { key: "x", cmd: "help", desc: "Local x" },
        { key: "y", cmd: "save", desc: "Local y", fallthrough: true },
      ],
    })

    target.focus()

    const activeX = getActiveKey(keymap, "x", { includeBindings: true, includeMetadata: true })

    expect(activeX?.command).toBe("help")
    expect(activeX?.bindings?.map((binding) => binding.command)).toEqual(["help"])
    expect(activeX?.bindingAttrs).toEqual({ desc: "Local x" })

    const activeY = getActiveKey(keymap, "y", { includeBindings: true, includeMetadata: true })

    expect(activeY?.command).toBe("save")
    expect(activeY?.bindings?.map((binding) => binding.command)).toEqual(["save", "help"])
    expect(activeY?.bindingAttrs).toEqual({ desc: "Local y" })
  })

  test("getActiveKeys uses the first matching prefix layer before lower exact layers", () => {
    const keymap = getKeymap(renderer)
    const target = createFocusableBox("prefix-dispatch-target")

    renderer.root.add(target)

    keymap.registerToken({
      name: "leader",
      key: { name: "x", ctrl: true },
    })

    keymap.registerLayer({
      commands: [
        { name: "plain", run() {} },
        { name: "leader", run() {} },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "ctrl+x", cmd: "plain" }],
    })
    keymap.registerLayer({
      target,
      bindings: [{ key: "<leader>a", cmd: "leader" }],
    })

    target.focus()

    const activeKey = keymap.getActiveKeys().find((candidate) => candidate.stroke.name === "x" && candidate.stroke.ctrl)

    expect(activeKey?.command).toBeUndefined()
    expect(activeKey?.continues).toBe(true)
  })

  test("validates command names and command inputs", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    expect(() => {
      keymap.registerLayer({ commands: [{ name: "", run() {} }] })
    }).not.toThrow()

    expect(() => {
      keymap.registerLayer({ commands: [{ name: "bad name", run() {} }] })
    }).not.toThrow()

    expect(() => {
      keymap.registerLayer({
        bindings: [{ key: "x", cmd: "   " }],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual([
      "Invalid keymap command name: name cannot be empty",
      'Invalid keymap command name "bad name": command names cannot contain whitespace',
      "Invalid keymap command: command cannot be empty",
    ])
    expect(keymap.getCommands()).toEqual([])
    expect(getActiveKey(keymap, "x")).toBeUndefined()
    expect(keymap.runCommand("   ")).toEqual({ ok: false, reason: "invalid-args" })
    expect(keymap.dispatchCommand("   ")).toEqual({ ok: false, reason: "invalid-args" })
  })

  test("requires registered token keys to resolve to a single key stroke", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    expect(() => {
      keymap.registerToken({ name: "leader", key: "dd" })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual(['Invalid key "dd": expected a single key stroke'])
  })
})
