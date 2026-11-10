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
import { getGraphSnapshot } from "../extras/graph.js"
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
  getGraphKeymap,
  createBareKeymap,
  getCommand,
  getCommandEntry,
  getActiveKeyDisplay,
  captureDiagnostics,
  matchEventAs,
  createBracketTokenParser,
  createReactiveBoolean,
} = createKeymapTestHelpers(diagnostics, () => renderer)

describe("keymap: fields and reactive matchers", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })
  test("supports typed binding fields through key intercepts", () => {
    const keymap = getGraphKeymap(renderer)
    const calls: string[] = []

    keymap.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    keymap.intercept("key", ({ event, setData }) => {
      if (event.name === "x") {
        setData("vim.mode", "normal")
      }
    })

    keymap.registerLayer({
      commands: [
        {
          name: "typed-field",
          run() {
            calls.push("field")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", mode: "normal", cmd: "typed-field" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["field"])
    expect(keymap.getData("vim.mode")).toBe("normal")
  })

  test("supports binding metadata attributes through typed fields", () => {
    const keymap = getKeymap(renderer)

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          run() {},
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "save-file", desc: "Save file", group: "File" }],
    })

    const activeKey = getActiveKey(keymap, "x", { includeBindings: true })
    const activeBinding = activeKey?.bindings?.[0]
    expect(activeKey?.bindings).toHaveLength(1)
    expect(activeBinding?.attrs).toEqual({ desc: "Save file", group: "File" })
    expect(activeBinding?.command).toBe("save-file")
    expect(activeBinding?.commandAttrs).toBeUndefined()
    expect(activeKey?.command).toBe("save-file")
    expect(activeKey?.commandAttrs).toBeUndefined()
  })

  test("typed binding fields can emit both requirements and attributes", () => {
    const keymap = getKeymap(renderer)
    const seen: string[] = []

    keymap.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
        ctx.attr("mode", value)
      },
    })

    keymap.registerLayer({
      commands: [
        {
          name: "record-mode",
          run(ctx) {
            seen.push(String(ctx.data["vim.mode"]))
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", mode: "normal", cmd: "record-mode" }],
    })

    expect(getActiveKeyNames(keymap)).toEqual([])

    keymap.setData("vim.mode", "normal")

    const activeKey = getActiveKey(keymap, "x", { includeBindings: true })
    expect(activeKey?.bindings?.[0]?.attrs).toEqual({ mode: "normal" })

    mockInput.pressKey("x")

    expect(seen).toEqual(["normal"])
  })

  test("typed binding fields can emit runtime matchers", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    let enabled = false

    keymap.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap binding field "active" must be true')
        }

        ctx.activeWhen(() => enabled)
      },
    })

    keymap.registerLayer({
      commands: [
        {
          name: "runtime-binding",
          run() {
            calls.push("binding")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", active: true, cmd: "runtime-binding" }],
    })

    expect(getActiveKeyNames(keymap)).toEqual([])

    enabled = true

    expect(getActiveKeyNames(keymap)).toEqual(["x"])

    mockInput.pressKey("x")

    expect(calls).toEqual(["binding"])

    enabled = false

    expect(getActiveKeyNames(keymap)).toEqual([])
  })

  test("includeMetadata re-evaluates unkeyed binding matchers on each read", () => {
    const keymap = getKeymap(renderer)
    let enabled = false

    keymap.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap binding field "active" must be true')
        }

        ctx.activeWhen(() => enabled)
        ctx.attr("label", "Runtime binding")
      },
    })

    keymap.registerLayer({ commands: [{ name: "runtime-binding", run() {} }] })
    keymap.registerLayer({
      bindings: [{ key: "x", active: true, cmd: "runtime-binding" }],
    })

    expect(getActiveKey(keymap, "x", { includeMetadata: true })?.bindingAttrs).toBeUndefined()
    expect(getActiveKey(keymap, "x", { includeMetadata: true })?.commandAttrs).toBeUndefined()

    enabled = true

    expect(getActiveKey(keymap, "x", { includeMetadata: true })?.bindingAttrs).toEqual({ label: "Runtime binding" })
    expect(getActiveKey(keymap, "x", { includeMetadata: true })?.commandAttrs).toBeUndefined()
  })

  test("typed binding field matchers clear pending sequences when they stop matching", () => {
    const keymap = getKeymap(renderer)
    let enabled = true

    keymap.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap binding field "active" must be true')
        }

        ctx.activeWhen(() => enabled)
      },
    })

    keymap.registerLayer({ commands: [{ name: "delete-line", run() {} }] })
    keymap.registerLayer({
      bindings: [{ key: "dd", active: true, cmd: "delete-line" }],
    })

    mockInput.pressKey("d")

    expect(keymap.getPendingSequence()).toHaveLength(1)

    enabled = false

    expect(keymap.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames(keymap)).toEqual([])
  })

  test("treats thrown binding runtime matchers as non-matching", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap binding field "active" must be true')
        }

        ctx.activeWhen(() => {
          throw new Error("boom")
        })
      },
    })

    keymap.registerLayer({
      commands: [
        {
          name: "runtime-binding",
          run() {
            calls.push("binding")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", active: true, cmd: "runtime-binding" }],
    })

    expect(() => keymap.getActiveKeys()).not.toThrow()
    expect(getActiveKeyNames(keymap)).toEqual([])

    mockInput.pressKey("x")

    const { errors } = takeErrors()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.every((message) => message === "[Keymap] Error evaluating runtime matcher from field active:")).toBe(
      true,
    )
    expect(calls).toEqual([])
  })

  test("typed binding field matchers can use reactive matchers", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const enabled = createReactiveBoolean(false)
    let evaluations = 0

    keymap.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap binding field "active" must be true')
        }

        ctx.activeWhen({
          get() {
            evaluations += 1
            return enabled.get()
          },
          subscribe(onChange) {
            return enabled.subscribe(onChange)
          },
        })
      },
    })

    keymap.registerLayer({
      commands: [
        {
          name: "runtime-binding",
          run() {
            calls.push("binding")
          },
        },
      ],
    })
    keymap.registerLayer({
      bindings: [{ key: "x", active: true, cmd: "runtime-binding" }],
    })

    expect(getActiveKeyNames(keymap)).toEqual([])
    expect(evaluations).toBe(1)

    expect(getActiveKeyNames(keymap)).toEqual([])
    expect(evaluations).toBe(2)

    keymap.setData("unrelated", true)

    expect(getActiveKeyNames(keymap)).toEqual([])
    expect(evaluations).toBe(3)

    enabled.set(true)

    expect(getActiveKeyNames(keymap)).toEqual(["x"])
    expect(evaluations).toBeGreaterThan(3)

    mockInput.pressKey("x")

    expect(calls).toEqual(["binding"])

    enabled.set(false)

    expect(getActiveKeyNames(keymap)).toEqual([])
    expect(evaluations).toBeGreaterThan(4)
  })

  test("reactive matchers: subscribe at layer register, dispose at unregister", () => {
    const keymap = getKeymap(renderer)
    const enabled = createReactiveBoolean(true)

    keymap.registerLayerFields({
      active(_value, ctx) {
        ctx.activeWhen(enabled)
      },
    })

    keymap.registerLayer({ commands: [{ name: "noop", run() {} }] })

    expect(enabled.subscribeCalls).toBe(0)
    expect(enabled.subscriptions).toBe(0)

    const off = keymap.registerLayer({
      active: true,
      bindings: [{ key: "x", cmd: "noop" }],
    })

    expect(enabled.subscribeCalls).toBe(1)
    expect(enabled.subscriptions).toBe(1)
    expect(enabled.disposeCalls).toBe(0)

    off()

    expect(enabled.disposeCalls).toBe(1)
    expect(enabled.subscriptions).toBe(0)
  })

  test("reactive matchers: dispose on renderer destroy", () => {
    const keymap = getKeymap(renderer)
    const enabled = createReactiveBoolean(true)

    keymap.registerLayerFields({
      active(_value, ctx) {
        ctx.activeWhen(enabled)
      },
    })

    keymap.registerLayer({ commands: [{ name: "noop", run() {} }] })
    keymap.registerLayer({
      active: true,
      bindings: [{ key: "x", cmd: "noop" }],
    })

    expect(enabled.subscriptions).toBe(1)

    renderer.destroy()

    expect(enabled.disposeCalls).toBe(1)
    expect(enabled.subscriptions).toBe(0)
  })

  test("reactive matchers: recompute when active keys are queried", () => {
    const keymap = getKeymap(renderer)
    const firstEnabled = createReactiveBoolean(false)
    const secondEnabled = createReactiveBoolean(false)

    let firstEvals = 0
    let secondEvals = 0

    keymap.registerLayerFields({
      first(_value, ctx) {
        ctx.activeWhen({
          get() {
            firstEvals += 1
            return firstEnabled.get()
          },
          subscribe: firstEnabled.subscribe,
        })
      },
      second(_value, ctx) {
        ctx.activeWhen({
          get() {
            secondEvals += 1
            return secondEnabled.get()
          },
          subscribe: secondEnabled.subscribe,
        })
      },
    })

    keymap.registerLayer({ commands: [{ name: "noop", run() {} }] })
    keymap.registerLayer({
      first: true,
      bindings: [{ key: "a", cmd: "noop" }],
    })
    keymap.registerLayer({
      second: true,
      bindings: [{ key: "b", cmd: "noop" }],
    })

    expect(getActiveKeyNames(keymap)).toEqual([])
    expect(firstEvals).toBe(1)
    expect(secondEvals).toBe(1)

    firstEnabled.set(true)
    expect(getActiveKeyNames(keymap)).toEqual(["a"])
    expect(firstEvals).toBe(2)
    expect(secondEvals).toBe(2)

    secondEnabled.set(true)
    expect(getActiveKeyNames(keymap)).toEqual(["a", "b"])
    expect(firstEvals).toBe(3)
    expect(secondEvals).toBe(3)
  })

  test("reactive matchers: errors in subscribe are routed to error channel and registration continues", () => {
    const keymap = getKeymap(renderer)
    const errors: string[] = []
    const causes: unknown[] = []
    keymap.on("error", (event) => {
      errors.push(event.message)
      causes.push(event.error)
    })

    const badMatcher: ReactiveMatcher = {
      get: () => true,
      subscribe() {
        throw new Error("subscribe boom")
      },
    }

    keymap.registerLayerFields({
      active(_value, ctx) {
        ctx.activeWhen(badMatcher)
      },
    })

    keymap.registerLayer({ commands: [{ name: "noop", run() {} }] })

    expect(() => {
      keymap.registerLayer({
        active: true,
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe("subscribe boom")
    expect(causes[0]).toBeInstanceOf(Error)
    expect(getActiveKeyNames(keymap)).toEqual(["x"])
  })

  test("reactive matchers: errors in dispose are routed to error channel", () => {
    const keymap = getKeymap(renderer)
    const errors: string[] = []
    keymap.on("error", (event) => {
      errors.push(event.message)
    })

    const badMatcher: ReactiveMatcher = {
      get: () => true,
      subscribe() {
        return () => {
          throw new Error("dispose boom")
        }
      },
    }

    keymap.registerLayerFields({
      active(_value, ctx) {
        ctx.activeWhen(badMatcher)
      },
    })

    keymap.registerLayer({ commands: [{ name: "noop", run() {} }] })
    const off = keymap.registerLayer({
      active: true,
      bindings: [{ key: "x", cmd: "noop" }],
    })

    expect(() => off()).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe("dispose boom")
  })

  test("reactive matchers: errors in get are routed to error channel and evaluate to false", () => {
    const keymap = getKeymap(renderer)
    const errors: { code: string; message: string; error: unknown }[] = []
    keymap.on("error", (event) => {
      errors.push({ code: event.code, message: event.message, error: event.error })
    })

    const cause = new Error("get boom")
    const badMatcher: ReactiveMatcher = {
      get() {
        throw cause
      },
      subscribe: () => () => {},
    }

    keymap.registerLayerFields({
      active(_value, ctx) {
        ctx.activeWhen(badMatcher)
      },
    })

    keymap.registerLayer({ commands: [{ name: "noop", run() {} }] })
    keymap.registerLayer({
      active: true,
      bindings: [{ key: "x", cmd: "noop" }],
    })

    expect(getActiveKeyNames(keymap)).toEqual([])
    expect(
      errors.some(
        (event) =>
          event.code === "runtime-matcher-error" &&
          event.message.includes("Error evaluating runtime matcher") &&
          event.error === cause,
      ),
    ).toBe(true)
  })

  test("reactive matchers: coexist with require()-based data dependencies on the same layer", () => {
    const keymap = getKeymap(renderer)
    const enabled = createReactiveBoolean(false)

    keymap.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
      active(_value, ctx) {
        ctx.activeWhen(enabled)
      },
    })

    keymap.registerLayer({ commands: [{ name: "noop", run() {} }] })
    keymap.registerLayer({
      mode: "normal",
      active: true,
      bindings: [{ key: "x", cmd: "noop" }],
    })

    expect(getActiveKeyNames(keymap)).toEqual([])

    keymap.setData("vim.mode", "normal")
    expect(getActiveKeyNames(keymap)).toEqual([])

    keymap.setData("vim.mode", undefined)
    enabled.set(true)
    expect(getActiveKeyNames(keymap)).toEqual([])

    keymap.setData("vim.mode", "normal")
    expect(getActiveKeyNames(keymap)).toEqual(["x"])

    enabled.set(false)
    expect(getActiveKeyNames(keymap)).toEqual([])
  })

  test("reactive matchers: raw callback matchers still work", () => {
    const keymap = getKeymap(renderer)
    let enabled = false
    let evaluations = 0

    keymap.registerLayerFields({
      active(_value, ctx) {
        ctx.activeWhen(() => {
          evaluations += 1
          return enabled
        })
      },
    })

    keymap.registerLayer({ commands: [{ name: "noop", run() {} }] })
    keymap.registerLayer({
      active: true,
      bindings: [{ key: "x", cmd: "noop" }],
    })

    expect(getActiveKeyNames(keymap)).toEqual([])
    expect(evaluations).toBe(1)

    expect(getActiveKeyNames(keymap)).toEqual([])
    expect(evaluations).toBe(2)

    enabled = true
    expect(getActiveKeyNames(keymap)).toEqual(["x"])
    expect(evaluations).toBe(3)
  })

  test("reactive matchers: rejects non-function non-reactive matcher values", () => {
    const keymap = getKeymap(renderer)
    const errors: string[] = []
    keymap.on("error", (event) => {
      errors.push(event.message)
    })

    keymap.registerLayerFields({
      active(_value, ctx) {
        ctx.activeWhen(42 as unknown as () => boolean)
      },
    })

    keymap.registerLayer({ commands: [{ name: "noop", run() {} }] })

    expect(() => {
      keymap.registerLayer({
        active: true,
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(errors.some((m) => m.includes("expected a function or a reactive matcher"))).toBe(true)
  })

  test("reactive matchers on binding fields: re-subscribe after token-driven recompile", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = captureDiagnostics(keymap)
    const enabled = createReactiveBoolean(true)

    keymap.registerBindingFields({
      active(_value, ctx) {
        ctx.activeWhen(enabled)
      },
    })

    keymap.registerLayer({ commands: [{ name: "noop", run() {} }] })

    const offToken = keymap.registerToken({ name: "leader", key: { name: "x", ctrl: true } })
    keymap.registerLayer({
      bindings: [{ key: "<leader>a", active: true, cmd: "noop" }],
    })

    expect(enabled.subscriptions).toBe(1)
    const subscribesBefore = enabled.subscribeCalls
    const disposesBefore = enabled.disposeCalls

    // Token changes recompile bindings, so binding-level matchers must
    // re-subscribe.
    offToken()

    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Unknown token "leader" in key sequence "<leader>a"; binding was skipped until the token is registered',
    ])
    expect(enabled.disposeCalls).toBe(disposesBefore + 1)
    expect(enabled.subscribeCalls).toBe(subscribesBefore)
    expect(enabled.subscriptions).toBe(0)

    keymap.registerToken({ name: "leader", key: { name: "y", ctrl: true } })

    expect(enabled.subscribeCalls).toBe(subscribesBefore + 1)
    expect(enabled.subscriptions).toBe(1)
  })

  test("supports typed layer fields for local scopes", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    keymap.registerLayer({
      commands: [
        {
          name: "local-mode",
          run() {
            calls.push("local")
          },
        },
      ],
    })

    const target = createFocusableBox("layer-field-target")
    renderer.root.add(target)

    keymap.registerLayer({
      target,
      mode: "normal",
      bindings: [{ key: "x", cmd: "local-mode" }],
    })

    target.focus()

    expect(getActiveKeyNames(keymap)).toEqual([])

    mockInput.pressKey("x")
    expect(calls).toEqual([])

    keymap.setData("vim.mode", "normal")

    expect(getActiveKeyNames(keymap)).toEqual(["x"])

    mockInput.pressKey("x")
    expect(calls).toEqual(["local"])
  })

  test("typed layer fields can emit runtime matchers", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    let enabled = false

    keymap.registerLayerFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap layer field "active" must be true')
        }

        ctx.activeWhen(() => enabled)
      },
    })

    keymap.registerLayer({
      commands: [
        {
          name: "runtime-layer",
          run() {
            calls.push("layer")
          },
        },
      ],
    })

    keymap.registerLayer({
      active: true,
      bindings: [{ key: "x", cmd: "runtime-layer" }],
    })

    expect(getActiveKeyNames(keymap)).toEqual([])

    enabled = true

    expect(getActiveKeyNames(keymap)).toEqual(["x"])

    mockInput.pressKey("x")

    expect(calls).toEqual(["layer"])

    enabled = false

    expect(getActiveKeyNames(keymap)).toEqual([])
  })

  test("typed layer fields can emit attrs for graph projections", () => {
    const keymap = getGraphKeymap(renderer)

    keymap.registerLayerFields({
      name(value, ctx) {
        if (typeof value !== "string") {
          throw new Error("name must be a string")
        }

        ctx.attr("name", value.trim())
      },
      mode(value, ctx) {
        ctx.require("vim.mode", value)
        ctx.attr("mode", value)
      },
    })

    keymap.registerLayer({
      name: " Normal Mode ",
      mode: "normal",
      bindings: [{ key: "x", cmd: () => {} }],
    })

    const [layer] = getGraphSnapshot(keymap).layers
    expect(layer?.fields).toEqual({ name: " Normal Mode ", mode: "normal" })
    expect(layer?.attrs).toEqual({ name: "Normal Mode", mode: "normal" })
    expect(layer?.active).toBe(false)

    keymap.setData("vim.mode", "normal")

    const [activeLayer] = getGraphSnapshot(keymap).layers
    expect(activeLayer?.attrs).toEqual({ name: "Normal Mode", mode: "normal" })
    expect(activeLayer?.active).toBe(true)
  })

  test("typed layer field matchers clear pending sequences when they stop matching", () => {
    const keymap = getKeymap(renderer)
    let enabled = true

    keymap.registerLayerFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap layer field "active" must be true')
        }

        ctx.activeWhen(() => enabled)
      },
    })

    keymap.registerLayer({ commands: [{ name: "delete-line", run() {} }] })
    keymap.registerLayer({
      active: true,
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    mockInput.pressKey("d")

    expect(keymap.getPendingSequence()).toHaveLength(1)

    enabled = false

    expect(keymap.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames(keymap)).toEqual([])
  })

  test("typed layer field matchers clear pending sequences when reactive matchers flip off", () => {
    const keymap = getKeymap(renderer)
    const enabled = createReactiveBoolean(true)

    keymap.registerLayerFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap layer field "active" must be true')
        }

        ctx.activeWhen(enabled)
      },
    })

    keymap.registerLayer({ commands: [{ name: "delete-line", run() {} }] })
    keymap.registerLayer({
      active: true,
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    mockInput.pressKey("d")

    expect(keymap.getPendingSequence()).toHaveLength(1)

    enabled.set(false)

    expect(keymap.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames(keymap)).toEqual([])
  })

  test("typed command fields can emit requirements and attrs", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerCommandFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
        ctx.attr("mode", value)
      },
    })

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          mode: "normal",
          run(ctx) {
            calls.push(String(ctx.command?.mode))
          },
        },
      ],
      bindings: [{ key: "x", cmd: "save-file" }],
    })

    expect(keymap.getCommands({ visibility: "registered" }).map((command) => command.name)).toEqual(["save-file"])
    expect(keymap.getCommands().map((command) => command.name)).toEqual([])
    expect(getActiveKeyNames(keymap)).toEqual([])

    keymap.setData("vim.mode", "normal")

    expect(keymap.getCommands().map((command) => command.name)).toEqual(["save-file"])
    expect(getCommand(keymap, "save-file")).toMatchObject({
      name: "save-file",
      mode: "normal",
    })
    expect(getActiveKeyNames(keymap)).toEqual(["x"])

    mockInput.pressKey("x")

    expect(calls).toEqual(["normal"])
  })

  test("typed command field matchers can use reactive matchers and unsubscribe on layer unregister", () => {
    const keymap = getKeymap(renderer)
    const enabled = createReactiveBoolean(true)

    keymap.registerCommandFields({
      active(_value, ctx) {
        ctx.activeWhen(enabled)
      },
    })

    expect(enabled.subscribeCalls).toBe(0)
    expect(enabled.subscriptions).toBe(0)

    const off = keymap.registerLayer({
      commands: [{ name: "save-file", active: true, run() {} }],
      bindings: [{ key: "x", cmd: "save-file" }],
    })

    expect(enabled.subscribeCalls).toBe(1)
    expect(enabled.subscriptions).toBe(1)
    expect(keymap.getCommands().map((command) => command.name)).toEqual(["save-file"])
    expect(getActiveKeyNames(keymap)).toEqual(["x"])

    enabled.set(false)

    expect(keymap.getCommands().map((command) => command.name)).toEqual([])
    expect(getActiveKeyNames(keymap)).toEqual([])

    off()

    expect(enabled.disposeCalls).toBe(1)
    expect(enabled.subscriptions).toBe(0)
  })

  test("typed command field matchers dispose on renderer destroy", () => {
    const keymap = getKeymap(renderer)
    const enabled = createReactiveBoolean(true)

    keymap.registerCommandFields({
      active(_value, ctx) {
        ctx.activeWhen(enabled)
      },
    })

    keymap.registerLayer({
      commands: [{ name: "save-file", active: true, run() {} }],
      bindings: [{ key: "x", cmd: "save-file" }],
    })

    expect(enabled.subscriptions).toBe(1)

    renderer.destroy()

    expect(enabled.disposeCalls).toBe(1)
    expect(enabled.subscriptions).toBe(0)
  })

  test("dispatchCommand reports disabled commands while runCommand can execute registered disabled commands", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const target = createFocusableBox("command-condition-target")

    renderer.root.add(target)

    keymap.registerLayer({
      commands: [
        {
          name: "submit",
          run() {
            calls.push("global")
          },
        },
      ],
    })

    keymap.registerLayer({
      target,
      commands: [
        {
          name: "submit",
          enabled: false,
          run() {
            calls.push("local")
          },
        },
        {
          name: "hidden-local",
          enabled: false,
          run() {
            calls.push("hidden")
          },
        },
      ],
      bindings: [
        { key: "x", cmd: "submit" },
        { key: "y", cmd: "hidden-local" },
      ],
    })

    target.focus()

    expect(getActiveKey(keymap, "x")?.command).toBe("submit")
    expect(getActiveKey(keymap, "y")).toBeUndefined()
    expect(keymap.dispatchCommand("submit")).toEqual({ ok: true })
    expect(keymap.dispatchCommand("hidden-local")).toEqual({ ok: false, reason: "disabled" })
    expect(keymap.dispatchCommand("hidden-local", { includeCommand: true })).toMatchObject({
      ok: false,
      reason: "disabled",
      command: {
        name: "hidden-local",
        enabled: false,
      },
    })
    expect(keymap.runCommand("submit")).toEqual({ ok: true })
    expect(keymap.runCommand("hidden-local")).toEqual({ ok: true })

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["global", "local", "hidden", "global"])
  })

  test("layer and binding requirements compose", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })
    keymap.registerBindingFields({
      state(value, ctx) {
        ctx.require("vim.state", value)
      },
    })

    keymap.registerLayer({
      commands: [
        {
          name: "composed",
          run() {
            calls.push("hit")
          },
        },
      ],
    })

    keymap.registerLayer({
      mode: "normal",
      bindings: [{ key: "x", state: "idle", cmd: "composed" }],
    })

    expect(getActiveKeyNames(keymap)).toEqual([])

    keymap.setData("vim.mode", "normal")
    expect(getActiveKeyNames(keymap)).toEqual([])

    keymap.setData("vim.state", "idle")
    expect(getActiveKeyNames(keymap)).toEqual(["x"])

    mockInput.pressKey("x")
    expect(calls).toEqual(["hit"])

    keymap.setData("vim.mode", "visual")
    expect(getActiveKeyNames(keymap)).toEqual([])
  })
})
