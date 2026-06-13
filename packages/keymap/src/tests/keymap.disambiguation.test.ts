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

describe("keymap: disambiguation", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })
  test("keeps earlier bindings when a later binding is both an exact key and a prefix", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.registerLayer({
      commands: [
        { name: "one", run() {} },
        { name: "two", run() {} },
      ],
    })

    expect(() => {
      keymap.registerLayer({
        bindings: [
          { key: "d", cmd: "one" },
          { key: "dd", cmd: "two" },
        ],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual([
      "Keymap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
    ])
    expect(getActiveKey(keymap, "d")?.command).toBe("one")
  })

  test("allows a non-dispatch binding to label a prefix", () => {
    const keymap = getKeymap(renderer)

    keymap.registerLayer({ commands: [{ name: "delete-line", run() {} }] })
    keymap.registerLayer({
      bindings: [
        { key: "d", group: "Delete" },
        { key: "dd", cmd: "delete-line" },
      ],
    })

    const activeKey = getActiveKey(keymap, "d", { includeBindings: true, includeMetadata: true })

    expect(activeKey?.command).toBeUndefined()
    expect(activeKey?.bindingAttrs).toEqual({ group: "Delete" })
    expect(activeKey?.bindings?.map((binding) => binding.command)).toEqual([undefined])
  })

  test("disambiguation resolvers can choose the exact binding and preserve binding event effects", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const snapshots: string[] = []
    let outsideSeen = 0

    renderer.keyInput.on("keypress", (event) => {
      if (event.name === "g") {
        outsideSeen += 1
      }
    })

    keymap.registerLayer({
      commands: [
        {
          name: "go",
          run() {
            calls.push("go")
          },
        },
        {
          name: "top",
          run() {
            calls.push("top")
          },
        },
      ],
    })

    keymap.appendDisambiguationResolver((ctx) => {
      snapshots.push(
        `${stringifyKeySequence(ctx.sequence, { preferDisplay: true })}:${ctx.exact.map((binding) => binding.command).join(",")}:${ctx.continuations.map((key) => key.display).join(",")}`,
      )
      return ctx.runExact()
    })

    keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "go", preventDefault: false },
        { key: "gg", cmd: "top" },
      ],
    })

    const activeKey = getActiveKey(keymap, "g", { includeBindings: true, includeMetadata: true })

    expect(activeKey?.command).toBe("go")
    expect(activeKey?.continues).toBe(true)
    expect(activeKey?.bindings?.map((binding) => binding.command)).toEqual(["go"])

    mockInput.pressKey("g")

    expect(snapshots).toEqual(["g:go:g"])
    expect(calls).toEqual(["go"])
    expect(keymap.getPendingSequence()).toEqual([])
    expect(outsideSeen).toBe(1)
  })

  test("disambiguation resolvers can continue the sequence and consume the key synchronously", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    let outsideSeen = 0

    renderer.keyInput.on("keypress", (event) => {
      if (event.name === "g") {
        outsideSeen += 1
      }
    })

    keymap.registerLayer({
      commands: [
        {
          name: "go",
          run() {
            calls.push("go")
          },
        },
        {
          name: "top",
          run() {
            calls.push("top")
          },
        },
      ],
    })

    keymap.appendDisambiguationResolver((ctx) => ctx.continueSequence())

    keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "go", preventDefault: false },
        { key: "gg", cmd: "top" },
      ],
    })

    mockInput.pressKey("g")

    expect(calls).toEqual([])
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("g")
    expect(outsideSeen).toBe(0)

    mockInput.pressKey("g")

    expect(calls).toEqual(["top"])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("the first disambiguation resolver to decide wins", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const order: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "go",
          run() {
            calls.push("go")
          },
        },
        {
          name: "top",
          run() {
            calls.push("top")
          },
        },
      ],
    })

    keymap.appendDisambiguationResolver((ctx) => {
      order.push("append")
      return ctx.runExact()
    })
    keymap.prependDisambiguationResolver((ctx) => {
      order.push("prepend")
      return ctx.continueSequence()
    })

    keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "go" },
        { key: "gg", cmd: "top" },
      ],
    })

    mockInput.pressKey("g")
    mockInput.pressKey("g")

    expect(order).toEqual(["prepend"])
    expect(calls).toEqual(["top"])
  })

  test("warns once and falls back to prefix handling when no disambiguation resolver resolves", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const { takeWarnings } = captureDiagnostics(keymap)

    keymap.registerLayer({
      commands: [
        {
          name: "go",
          run() {
            calls.push("go")
          },
        },
        {
          name: "top",
          run() {
            calls.push("top")
          },
        },
      ],
    })

    keymap.appendDisambiguationResolver(() => undefined)

    keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "go" },
        { key: "gg", cmd: "top" },
      ],
    })

    mockInput.pressKey("g")
    mockInput.pressKey("g")
    mockInput.pressKey("g")

    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Ambiguous exact/prefix sequence "g" fell back to prefix handling because no disambiguation resolver resolved it',
    ])
    expect(calls).toEqual(["top"])
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("g")
  })

  test("invalid disambiguation resolver returns emit errors and fall through to later resolvers", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.registerLayer({ commands: [{ name: "top", run() {} }] })

    keymap.appendDisambiguationResolver(() => {
      return Promise.resolve(undefined) as unknown as never
    })
    keymap.appendDisambiguationResolver((ctx) => ctx.continueSequence())

    keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "top" },
        { key: "gg", cmd: "top" },
      ],
    })

    mockInput.pressKey("g")

    expect(takeErrors().errors).toEqual([
      "[Keymap] Disambiguation resolvers must return synchronously; use ctx.defer(...) for async handling",
    ])
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("g")
  })

  test("deferred disambiguation can resolve to the exact binding after a timeout", async () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    let resolveGoRan: () => void = () => {}
    const goRan = new Promise<void>((resolve) => {
      resolveGoRan = resolve
    })

    keymap.registerLayer({
      commands: [
        {
          name: "go",
          run() {
            calls.push("go")
            resolveGoRan()
          },
        },
        {
          name: "top",
          run() {
            calls.push("top")
          },
        },
      ],
    })

    keymap.appendDisambiguationResolver((ctx) => {
      return ctx.defer(async (deferred) => {
        const elapsed = await deferred.sleep(1)
        if (!elapsed) {
          return
        }

        return deferred.runExact()
      })
    })

    keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "go" },
        { key: "gg", cmd: "top" },
      ],
    })

    mockInput.pressKey("g")

    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("g")

    await goRan

    expect(calls).toEqual(["go"])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("disambiguation resolvers can choose the exact binding after entering a pending prefix", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "delete-char",
          run() {
            calls.push("delete-char")
          },
        },
        {
          name: "delete-ca",
          run() {
            calls.push("delete-ca")
          },
        },
      ],
    })

    keymap.appendDisambiguationResolver((ctx) => {
      if (stringifyKeySequence(ctx.sequence, { preferDisplay: true }) === "dc") {
        return ctx.runExact()
      }

      return ctx.continueSequence()
    })

    keymap.registerLayer({
      bindings: [
        { key: "dc", cmd: "delete-char" },
        { key: "dca", cmd: "delete-ca" },
      ],
    })

    mockInput.pressKey("d")
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("d")

    mockInput.pressKey("c")

    expect(calls).toEqual(["delete-char"])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("the next stroke cancels deferred disambiguation", async () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "go",
          run() {
            calls.push("go")
          },
        },
        {
          name: "top",
          run() {
            calls.push("top")
          },
        },
      ],
    })

    keymap.appendDisambiguationResolver((ctx) => {
      return ctx.defer(async (deferred) => {
        const elapsed = await deferred.sleep(10)
        if (!elapsed) {
          return
        }

        return deferred.runExact()
      })
    })

    keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "go" },
        { key: "gg", cmd: "top" },
      ],
    })

    mockInput.pressKey("g")
    mockInput.pressKey("g")
    await Bun.sleep(25)

    expect(calls).toEqual(["top"])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("clearing a pending sequence cancels deferred disambiguation", async () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "go",
          run() {
            calls.push("go")
          },
        },
        {
          name: "top",
          run() {
            calls.push("top")
          },
        },
      ],
    })

    keymap.appendDisambiguationResolver((ctx) => {
      return ctx.defer(async (deferred) => {
        const elapsed = await deferred.sleep(5)
        if (!elapsed) {
          return
        }

        return deferred.runExact()
      })
    })

    keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "go" },
        { key: "gg", cmd: "top" },
      ],
    })

    mockInput.pressKey("g")
    keymap.clearPendingSequence()
    await Bun.sleep(20)

    expect(calls).toEqual([])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("popping a changed pending sequence cancels deferred disambiguation", async () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "delete-char",
          run() {
            calls.push("delete-char")
          },
        },
        {
          name: "delete-ca",
          run() {
            calls.push("delete-ca")
          },
        },
      ],
    })

    keymap.appendDisambiguationResolver((ctx) => {
      if (stringifyKeySequence(ctx.sequence, { preferDisplay: true }) !== "dc") {
        return ctx.continueSequence()
      }

      return ctx.defer(async (deferred) => {
        const elapsed = await deferred.sleep(5)
        if (!elapsed) {
          return
        }

        return deferred.runExact()
      })
    })

    keymap.registerLayer({
      bindings: [
        { key: "dc", cmd: "delete-char" },
        { key: "dca", cmd: "delete-ca" },
      ],
    })

    mockInput.pressKey("d")
    mockInput.pressKey("c")

    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("dc")

    keymap.popPendingSequence()
    await Bun.sleep(20)

    expect(calls).toEqual([])
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("d")
  })

  test("focus changes cancel deferred disambiguation with the pending sequence", async () => {
    const keymap = getKeymap(renderer)
    const first = createFocusableBox("disambiguation-first")
    const second = createFocusableBox("disambiguation-second")
    const calls: string[] = []

    renderer.root.add(first)
    renderer.root.add(second)

    keymap.registerLayer({
      commands: [
        {
          name: "go",
          run() {
            calls.push("go")
          },
        },
        {
          name: "top",
          run() {
            calls.push("top")
          },
        },
      ],
    })

    keymap.appendDisambiguationResolver((ctx) => {
      return ctx.defer(async (deferred) => {
        const elapsed = await deferred.sleep(5)
        if (!elapsed) {
          return
        }

        return deferred.runExact()
      })
    })

    keymap.registerLayer({
      target: first,
      bindings: [
        { key: "g", cmd: "go" },
        { key: "gg", cmd: "top" },
      ],
    })

    first.focus()
    mockInput.pressKey("g")
    second.focus()
    await Bun.sleep(20)

    expect(calls).toEqual([])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("runtime invalidation cancels deferred disambiguation", async () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    keymap.registerLayer({
      commands: [
        {
          name: "go",
          run() {
            calls.push("go")
          },
        },
        {
          name: "top",
          run() {
            calls.push("top")
          },
        },
      ],
    })

    keymap.appendDisambiguationResolver((ctx) => {
      return ctx.defer(async (deferred) => {
        const elapsed = await deferred.sleep(5)
        if (!elapsed) {
          return
        }

        return deferred.runExact()
      })
    })

    keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "go", mode: "normal" },
        { key: "gg", cmd: "top", mode: "normal" },
      ],
    })

    keymap.setData("vim.mode", "normal")
    mockInput.pressKey("g")
    keymap.setData("vim.mode", "visual")
    await Bun.sleep(20)

    expect(calls).toEqual([])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("disposing a layer cancels deferred disambiguation", async () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "go",
          run() {
            calls.push("go")
          },
        },
        {
          name: "top",
          run() {
            calls.push("top")
          },
        },
      ],
    })

    keymap.appendDisambiguationResolver((ctx) => {
      return ctx.defer(async (deferred) => {
        const elapsed = await deferred.sleep(5)
        if (!elapsed) {
          return
        }

        return deferred.runExact()
      })
    })

    const offLayer = keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "go" },
        { key: "gg", cmd: "top" },
      ],
    })

    mockInput.pressKey("g")
    offLayer()
    await Bun.sleep(20)

    expect(calls).toEqual([])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("token recompilation cancels deferred disambiguation", async () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "plain",
          run() {
            calls.push("plain")
          },
        },
        {
          name: "leader-action",
          run() {
            calls.push("leader")
          },
        },
      ],
    })

    keymap.appendDisambiguationResolver((ctx) => {
      return ctx.defer(async (deferred) => {
        const elapsed = await deferred.sleep(5)
        if (!elapsed) {
          return
        }

        return deferred.runExact()
      })
    })

    keymap.registerLayer({
      bindings: [
        { key: "a", cmd: "plain" },
        { key: "ac", cmd: "plain" },
        { key: "<leader>ab", cmd: "leader-action" },
      ],
    })

    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Unknown token "leader" in key sequence "<leader>ab"; binding was skipped until the token is registered',
    ])

    mockInput.pressKey("a")
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("a")

    keymap.registerToken({
      name: "leader",
      key: { name: "x", ctrl: true },
    })
    await Bun.sleep(20)

    expect(calls).toEqual([])
    expect(keymap.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames(keymap)).toEqual(["a", "x"])
  })

  test("clear decisions consume the key and clear the sequence", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    let outsideSeen = 0

    renderer.keyInput.on("keypress", (event) => {
      if (event.name === "g") {
        outsideSeen += 1
      }
    })

    keymap.registerLayer({
      commands: [
        {
          name: "go",
          run() {
            calls.push("go")
          },
        },
        {
          name: "top",
          run() {
            calls.push("top")
          },
        },
      ],
    })

    keymap.appendDisambiguationResolver((ctx) => ctx.clear())

    keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "go", preventDefault: false },
        { key: "gg", cmd: "top" },
      ],
    })

    mockInput.pressKey("g")

    expect(calls).toEqual([])
    expect(keymap.getPendingSequence()).toEqual([])
    expect(outsideSeen).toBe(0)
  })

  test("adding the first disambiguation resolver recompiles ambiguous layers and removing the last one restores strict validation", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.registerLayer({
      commands: [
        {
          name: "go",
          run() {
            calls.push("go")
          },
        },
        {
          name: "top",
          run() {
            calls.push("top")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "go" },
        { key: "gg", cmd: "top" },
      ],
    })

    expect(takeErrors().errors).toEqual([
      "Keymap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
    ])
    expect(getActiveKey(keymap, "g")?.continues).toBe(false)

    const offResolver = keymap.appendDisambiguationResolver((ctx) => ctx.continueSequence())

    expect(getActiveKey(keymap, "g")?.command).toBe("go")
    expect(getActiveKey(keymap, "g")?.continues).toBe(true)

    mockInput.pressKey("g")
    mockInput.pressKey("g")

    expect(calls).toEqual(["top"])

    offResolver()

    expect(takeErrors().errors).toEqual([
      "Keymap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
    ])
    expect(getActiveKey(keymap, "g")?.command).toBe("go")
    expect(getActiveKey(keymap, "g")?.continues).toBe(false)
  })

  test("removing one of multiple disambiguation resolvers keeps ambiguity enabled until the last resolver is removed", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.registerLayer({
      commands: [
        { name: "go", run() {} },
        { name: "top", run() {} },
      ],
    })

    keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "go" },
        { key: "gg", cmd: "top" },
      ],
    })

    expect(takeErrors().errors).toEqual([
      "Keymap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
    ])

    const offFirst = keymap.appendDisambiguationResolver((ctx) => ctx.continueSequence())
    const offSecond = keymap.appendDisambiguationResolver((ctx) => ctx.runExact())

    expect(getActiveKey(keymap, "g")?.command).toBe("go")
    expect(getActiveKey(keymap, "g")?.continues).toBe(true)

    offFirst()

    expect(getActiveKey(keymap, "g")?.command).toBe("go")
    expect(getActiveKey(keymap, "g")?.continues).toBe(true)
    expect(takeErrors().errors).toEqual([])

    offSecond()

    expect(takeErrors().errors).toEqual([
      "Keymap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
    ])
    expect(getActiveKey(keymap, "g")?.command).toBe("go")
    expect(getActiveKey(keymap, "g")?.continues).toBe(false)
  })
})
