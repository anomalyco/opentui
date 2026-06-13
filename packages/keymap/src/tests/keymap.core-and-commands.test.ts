import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable, KeyEvent, type Renderable } from "@opentui/core"
import { createTestRenderer, setRendererCapabilities, type MockInput, type TestRenderer } from "@opentui/core/testing"
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

describe("keymap: core and commands", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })
  test("createOpenTuiKeymap returns a fresh keymap for each call", () => {
    const first = createBareKeymap(renderer)
    const second = createBareKeymap(renderer)

    expect(first).not.toBe(second)
  })

  test("OpenTUI host exposes platform and modifier metadata", () => {
    const keymap = createBareKeymap(renderer)
    const platform =
      process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
          ? "windows"
          : process.platform === "linux"
            ? "linux"
            : "unknown"

    expect(keymap.getHostMetadata()).toEqual({
      platform,
      primaryModifier: platform === "macos" ? "super" : platform === "unknown" ? "unknown" : "ctrl",
      modifiers: {
        ctrl: "supported",
        shift: "supported",
        meta: "supported",
        super: "unknown",
        hyper: "unknown",
      },
    })
  })

  test("OpenTUI host marks super and hyper supported when terminal capabilities report Kitty keyboard", () => {
    setRendererCapabilities(renderer, { kitty_keyboard: true })
    const keymap = createBareKeymap(renderer)

    expect(keymap.getHostMetadata().modifiers.super).toBe("supported")
    expect(keymap.getHostMetadata().modifiers.hyper).toBe("supported")
  })

  test("throws when requesting a keymap for a destroyed renderer", () => {
    createOpenTuiKeymap(renderer)
    renderer.destroy()

    expect(() => createOpenTuiKeymap(renderer)).toThrow("Cannot create a keymap for a destroyed renderer")
  })

  test("createOpenTuiKeymap stays bare until addons are installed", () => {
    const keymap = createBareKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)
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
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    mockInput.pressKey("x")
    expect(calls).toEqual([])
    expect(keymap.getActiveKeys()).toEqual([])
    expect(takeErrors().errors).toEqual(["No keymap binding parsers are registered"])

    addons.registerDefaultKeys(keymap)
    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "noop" }],
    })

    mockInput.pressKey("x")
    expect(calls).toEqual(["noop"])
  })

  test("createDefaultOpenTuiKeymap installs metadata and enabled fields", () => {
    const keymap = getKeymap(renderer)
    const { warnings } = captureDiagnostics(keymap)

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          desc: "Save file",
          title: "Save",
          category: "File",
          run() {},
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "save-file", desc: "Write current file", group: "File" }],
    })
    keymap.registerLayer({
      enabled: false,
      bindings: [{ key: "y", cmd: "save-file" }],
    })

    const activeKey = getActiveKey(keymap, "x", { includeMetadata: true })

    expect(getActiveKey(keymap, "y")).toBeUndefined()
    expect(activeKey?.bindingAttrs).toEqual({ desc: "Write current file", group: "File" })
    expect(activeKey?.commandAttrs).toEqual({ desc: "Save file", title: "Save", category: "File" })
    expect(warnings).toEqual([])
  })

  test("resolves bindings when their command layer is registered later", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "late-command" }],
    })

    expect(getActiveKeyNames(keymap)).toEqual([])
    expect(getActiveKey(keymap, "x")).toBeUndefined()

    mockInput.pressKey("x")
    expect(calls).toEqual([])

    keymap.registerLayer({
      commands: [
        {
          name: "late-command",
          run() {
            calls.push("late-command")
          },
        },
      ],
    })

    expect(getActiveKeyNames(keymap)).toEqual(["x"])
    expect(getActiveKey(keymap, "x")?.command).toBe("late-command")

    mockInput.pressKey("x")
    expect(calls).toEqual(["late-command"])
  })

  test("keeps non-renderer state and throws on renderer-backed reads after renderer destroy", () => {
    const keymap = getKeymap(renderer)

    keymap.setData("mode", "normal")
    keymap.registerLayer({ commands: [{ name: "noop", run() {} }] })
    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "noop" }],
    })

    renderer.destroy()

    expect(keymap.getData("mode")).toBe("normal")
    expect(keymap.getCommands().map((command) => command.name)).toEqual(["noop"])
    expect(
      keymap.createKeyMatcher("x")({
        name: "x",
        ctrl: false,
        shift: false,
        meta: false,
        super: false,
        hyper: false,
      }),
    ).toBe(true)

    expect(() => keymap.getActiveKeys()).toThrow("Cannot use a keymap after its host was destroyed")
  })

  test("defaults targetless layers to always active", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "global-default",
          run() {
            calls.push("global")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "global-default" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["global"])
  })

  test("supports function binding commands", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    const handler = () => {
      calls.push("handled")
    }

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: handler }],
    })

    expect(getActiveKey(keymap, "x")?.command).toBe(handler)
    expect(getActiveKey(keymap, "x", { includeBindings: true })?.bindings?.[0]?.command).toBe(handler)

    mockInput.pressKey("x")

    expect(calls).toEqual(["handled"])
  })

  test("runCommand and dispatchCommand execute commands and only include metadata when requested", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const command = {
      name: "save-file",
      run() {
        calls.push("save-file")
      },
    }

    keymap.registerLayer({
      commands: [command],
    })

    expect(keymap.runCommand("save-file")).toEqual({ ok: true })
    expect(keymap.dispatchCommand("save-file")).toEqual({ ok: true })
    expect(keymap.runCommand("save-file", { includeCommand: true })).toEqual({ ok: true, command })
    expect(keymap.dispatchCommand("save-file", { includeCommand: true })).toEqual({ ok: true, command })
    expect(keymap.runCommand("missing-command")).toEqual({ ok: false, reason: "not-found" })
    expect(keymap.dispatchCommand("missing-command")).toEqual({ ok: false, reason: "not-found" })
    expect(calls).toEqual(["save-file", "save-file", "save-file", "save-file"])
  })

  test("command contexts include invocation input and payload", () => {
    const keymap = getKeymap(renderer)
    const seen: Array<{ input: string; payload: unknown }> = []

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          run(ctx) {
            seen.push({ input: ctx.input, payload: ctx.payload })
          },
        },
      ],
      bindings: [{ key: "x", cmd: "save-file" }],
    })

    expect(keymap.runCommand("save-file", { payload: "run-payload" })).toEqual({ ok: true })
    expect(keymap.dispatchCommand("save-file", { payload: "dispatch-payload" })).toEqual({
      ok: true,
    })
    mockInput.pressKey("x")

    expect(seen).toEqual([
      { input: "save-file", payload: "run-payload" },
      { input: "save-file", payload: "dispatch-payload" },
      { input: "save-file", payload: undefined },
    ])
  })

  test("command resolvers can adjust invocation context for the resolved command", () => {
    const keymap = getKeymap(renderer)
    const seen: Array<{ input: string; payload: unknown }> = []

    keymap.registerLayer({
      commands: [
        {
          name: "target-command",
          run(ctx) {
            seen.push({ input: ctx.input, payload: ctx.payload })
          },
        },
      ],
    })

    keymap.appendCommandResolver((command, ctx) => {
      if (command !== "alias target") {
        return undefined
      }

      ctx.setPayload("leaked")
      return undefined
    })
    keymap.appendCommandResolver((command, ctx) => {
      if (command !== "alias target") {
        return undefined
      }

      ctx.setInput(command)
      ctx.setPayload({ parsed: true, original: ctx.payload })
      return ctx.getCommand("target-command")
    })

    expect(keymap.runCommand("alias target", { payload: "original-payload" })).toEqual({ ok: true })

    expect(seen).toEqual([
      {
        input: "alias target",
        payload: { parsed: true, original: "original-payload" },
      },
    ])
  })

  test("resolver returned registered commands keep active command target", () => {
    const keymap = getKeymap(renderer)
    const target = createFocusableBox("resolver-command-target")
    const seen: Array<boolean> = []

    renderer.root.add(target)

    keymap.registerLayer({
      target,
      commands: [
        {
          name: "target-command",
          run(ctx) {
            seen.push(ctx.target === target)
          },
        },
      ],
    })

    keymap.appendCommandResolver((command, ctx) => {
      if (command !== "alias-command") {
        return undefined
      }

      return ctx.getCommand("target-command")
    })

    target.focus()

    expect(keymap.dispatchCommand("alias-command")).toEqual({ ok: true })
    expect(seen).toEqual([true])
  })

  test("acquireResource shares setup and disposes on last release", () => {
    const keymap = getKeymap(renderer)
    const resource = Symbol("test-resource")
    const calls: string[] = []

    const offFirst = keymap.acquireResource(resource, () => {
      calls.push("setup")
      return () => {
        calls.push("dispose")
      }
    })
    const offSecond = keymap.acquireResource(resource, () => {
      calls.push("setup-again")
      return () => {
        calls.push("dispose-again")
      }
    })

    expect(calls).toEqual(["setup"])

    offFirst()
    expect(calls).toEqual(["setup"])

    offSecond()
    expect(calls).toEqual(["setup", "dispose"])
  })

  test("acquireResource disposes active resources when the renderer is destroyed", () => {
    const keymap = getKeymap(renderer)
    const resource = Symbol("destroyed-resource")
    let disposeCalls = 0

    const off = keymap.acquireResource(resource, () => {
      return () => {
        disposeCalls += 1
      }
    })

    renderer.destroy()

    expect(disposeCalls).toBe(1)

    off()
    expect(disposeCalls).toBe(1)
  })

  test("acquireResource does not retain failed setup attempts", () => {
    const keymap = getKeymap(renderer)
    const resource = Symbol("failing-resource")
    let attempts = 0

    expect(() => {
      keymap.acquireResource(resource, () => {
        attempts += 1
        throw new Error("boom")
      })
    }).toThrow("boom")

    const off = keymap.acquireResource(resource, () => {
      attempts += 1
      return () => {}
    })

    expect(attempts).toBe(2)
    off()
  })

  test("active layered commands take precedence over command resolvers", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "shared-command",
          run() {
            calls.push("registered")
          },
        },
      ],
    })

    keymap.appendCommandResolver((command) => {
      if (command !== "shared-command") {
        return undefined
      }

      return {
        name: command,
        run() {
          calls.push("resolver")
        },
      }
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "shared-command" }],
    })

    mockInput.pressKey("x")
    expect(keymap.runCommand("shared-command")).toEqual({ ok: true })
    expect(calls).toEqual(["registered", "registered"])
  })

  test("prependCommandResolver runs before appended resolvers", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendCommandResolver((command) => {
      if (command !== "shared-command") {
        return undefined
      }

      return {
        name: command,
        run() {
          calls.push("append")
        },
      }
    })
    keymap.prependCommandResolver((command) => {
      if (command !== "shared-command") {
        return undefined
      }

      return {
        name: command,
        run() {
          calls.push("prepend")
        },
      }
    })

    expect(keymap.runCommand("shared-command")).toEqual({ ok: true })
    expect(calls).toEqual(["prepend"])
  })

  test("clearCommandResolvers removes registered command resolvers", () => {
    const keymap = getKeymap(renderer)

    keymap.appendCommandResolver((command) => {
      if (command !== "shared-command") {
        return undefined
      }

      return {
        name: command,
        run() {},
      }
    })

    expect(keymap.runCommand("shared-command")).toEqual({ ok: true })

    keymap.clearCommandResolvers()

    expect(keymap.runCommand("shared-command")).toEqual({ ok: false, reason: "not-found" })
  })

  test("programmatic resolver fallback resolves freshly for each call", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    let resolverCalls = 0

    keymap.appendCommandResolver((command) => {
      if (command !== "dynamic-command") {
        return undefined
      }

      resolverCalls += 1
      const generation = resolverCalls
      return {
        name: command,
        run() {
          calls.push(`run:${generation}`)
        },
      }
    })

    expect(keymap.runCommand("dynamic-command")).toEqual({ ok: true })
    expect(keymap.runCommand("dynamic-command")).toEqual({ ok: true })
    expect(keymap.dispatchCommand("dynamic-command")).toEqual({ ok: true })
    expect(keymap.dispatchCommand("dynamic-command")).toEqual({ ok: true })
    expect(resolverCalls).toBe(4)
    expect(calls).toEqual(["run:1", "run:2", "run:3", "run:4"])
  })

  test("static binding resolver fallback resolves on each read and dispatch", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    let resolverCalls = 0

    keymap.appendCommandResolver((command) => {
      if (command !== "dynamic-binding") {
        return undefined
      }

      resolverCalls += 1
      const generation = resolverCalls
      return {
        name: command,
        generation,
        run() {
          calls.push(`run:${generation}`)
        },
      }
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "dynamic-binding" }],
    })

    expect(getActiveKey(keymap, "x", { includeMetadata: true })?.commandAttrs).toEqual({ generation: 3 })
    expect(resolverCalls).toBe(3)

    mockInput.pressKey("x")
    mockInput.pressKey("x")

    expect(resolverCalls).toBeGreaterThan(3)
    expect(calls).toHaveLength(2)
    expect(calls[0]).not.toBe(calls[1])

    expect(keymap.dispatchCommand("dynamic-binding")).toEqual({ ok: true })
    expect(keymap.runCommand("dynamic-binding")).toEqual({ ok: true })
    expect(resolverCalls).toBeGreaterThan(5)
    expect(calls).toHaveLength(4)
    expect(new Set(calls).size).toBe(4)
  })

  test("programmatic fallback resolves freshly after rejecting registered commands", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    let resolverCalls = 0

    keymap.registerLayer({
      commands: [
        {
          name: "shared-reject",
          run() {
            calls.push("registered")
            return false
          },
        },
      ],
    })

    keymap.appendCommandResolver((command) => {
      if (command !== "shared-reject") {
        return undefined
      }

      resolverCalls += 1
      const generation = resolverCalls
      return {
        name: command,
        run() {
          calls.push(`resolver:${generation}`)
        },
      }
    })

    expect(keymap.runCommand("shared-reject")).toEqual({ ok: true })
    expect(keymap.runCommand("shared-reject")).toEqual({ ok: true })
    expect(keymap.dispatchCommand("shared-reject")).toEqual({ ok: true })
    expect(keymap.dispatchCommand("shared-reject")).toEqual({ ok: true })
    expect(resolverCalls).toBe(4)
    expect(calls).toEqual([
      "registered",
      "resolver:1",
      "registered",
      "resolver:2",
      "registered",
      "resolver:3",
      "registered",
      "resolver:4",
    ])
  })

  test("dispatchCommand does not resolve fallback when active registered command handles", () => {
    const keymap = getKeymap(renderer)
    const { errors } = captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "handled-command",
          run() {
            calls.push("registered")
          },
        },
      ],
    })

    keymap.appendCommandResolver((command) => {
      if (command === "handled-command") {
        throw new Error("resolver should not run")
      }

      return undefined
    })

    expect(keymap.dispatchCommand("handled-command")).toEqual({ ok: true })
    expect(keymap.runCommand("handled-command")).toEqual({ ok: true })
    expect(calls).toEqual(["registered", "registered"])
    expect(errors).toEqual([])
  })

  test("dispatchCommand resolves active layer commands while runCommand uses registered precedence", () => {
    const keymap = getKeymap(renderer)
    const { warnings } = captureDiagnostics(keymap)
    const calls: string[] = []
    const target = createFocusableBox("layer-command-target")

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
          desc: "Local submit",
          run() {
            calls.push("local")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "submit" }],
    })

    expect(keymap.dispatchCommand("submit")).toEqual({ ok: true })
    expect(keymap.runCommand("submit")).toEqual({ ok: true })

    target.focus()

    expect(getActiveKey(keymap, "x", { includeMetadata: true })?.commandAttrs).toEqual({ desc: "Local submit" })

    mockInput.pressKey("x")

    expect(keymap.dispatchCommand("submit", { includeCommand: true })).toMatchObject({
      ok: true,
      command: { name: "submit", desc: "Local submit" },
    })
    expect(keymap.runCommand("submit", { includeCommand: true })).toMatchObject({
      ok: true,
      command: { name: "submit", desc: "Local submit" },
    })
    expect(calls).toEqual(["global", "local", "local", "local", "local"])
    expect(warnings).toEqual([])
  })

  test("runCommand falls through rejecting layer commands in active-layer order", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const parent = createFocusableBox("layer-command-parent")
    const child = createFocusableBox("layer-command-child")

    renderer.root.add(parent)
    parent.add(child)

    keymap.registerLayer({
      target: parent,
      commands: [
        {
          name: "submit",
          run() {
            calls.push("parent")
          },
        },
      ],
    })

    keymap.registerLayer({
      target: child,
      commands: [
        {
          name: "submit",
          run() {
            calls.push("child")
            return false
          },
        },
      ],
    })

    child.focus()

    expect(keymap.runCommand("submit")).toEqual({ ok: true })
    expect(calls).toEqual(["child", "parent"])
  })

  test("runCommand falls through rejecting layer commands to globals", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const target = createFocusableBox("layer-command-fallback-target")

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
          run() {
            calls.push("local")
            return false
          },
        },
      ],
    })

    target.focus()

    expect(keymap.runCommand("submit")).toEqual({ ok: true })
    expect(calls).toEqual(["local", "global"])
  })

  test("command handlers can update runtime data during dispatch and affect later fallthrough bindings", () => {
    const keymap = getKeymap(renderer)
    const { errors } = captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    keymap.registerLayer({
      commands: [
        {
          name: "enter-insert",
          run(ctx) {
            calls.push(`before:${String(ctx.keymap.getData("vim.mode"))}`)
            ctx.keymap.setData("vim.mode", "insert")
            calls.push(`after:${String(ctx.keymap.getData("vim.mode"))}`)
          },
        },
        {
          name: "follow-up",
          run(ctx) {
            calls.push(`follow:${String(ctx.data["vim.mode"])}`)
          },
        },
      ],
      bindings: [
        { key: "x", cmd: "enter-insert", fallthrough: true },
        { key: "x", mode: "insert", cmd: "follow-up" },
      ],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["before:undefined", "after:insert", "follow:insert"])
    expect(errors).toEqual([])
  })

  test("dispatchCommand reports inactive command-only layers while runCommand can execute them programmatically", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const target = createFocusableBox("command-only-layer-target")

    renderer.root.add(target)

    const off = keymap.registerLayer({
      target,
      commands: [
        {
          name: "submit",
          run() {
            calls.push("local")
          },
        },
      ],
    })

    expect(keymap.dispatchCommand("submit")).toEqual({ ok: false, reason: "inactive" })
    expect(keymap.dispatchCommand("submit", { includeCommand: true })).toMatchObject({
      ok: false,
      reason: "inactive",
      command: { name: "submit" },
    })
    expect(keymap.runCommand("submit")).toEqual({ ok: true })

    target.focus()

    expect(keymap.dispatchCommand("submit")).toEqual({ ok: true })
    expect(keymap.runCommand("submit")).toEqual({ ok: true })

    off()

    expect(keymap.dispatchCommand("submit")).toEqual({ ok: false, reason: "not-found" })
    expect(keymap.runCommand("submit")).toEqual({ ok: false, reason: "not-found" })
    expect(calls).toEqual(["local", "local", "local"])
  })

  test("refreshing global command resolution keeps same-name layer command bindings", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const target = createFocusableBox("layer-command-refresh-target")

    renderer.root.add(target)

    keymap.registerLayer({
      target,
      commands: [
        {
          name: "shared",
          run() {
            calls.push("local")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "shared" }],
    })

    keymap.registerLayer({
      commands: [
        {
          name: "shared",
          run() {
            calls.push("global")
          },
        },
      ],
    })

    target.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual(["global"])
  })

  test("treats thrown command resolvers as errors without emitting unresolved warnings", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings, takeErrors } = captureDiagnostics(keymap)

    keymap.appendCommandResolver(() => {
      throw new Error("resolver boom")
    })

    expect(() => {
      keymap.registerLayer({
        bindings: [{ key: "x", cmd: "external-run" }],
      })
    }).not.toThrow()

    expect(getActiveKey(keymap, "x")?.command).toBeUndefined()
    expect(takeWarnings().warnings).toEqual([])
    expect(keymap.dispatchCommand("external-run")).toEqual({ ok: false, reason: "error" })
    expect(keymap.runCommand("external-run")).toEqual({ ok: false, reason: "error" })
    const { errors } = takeErrors()
    expect(errors).toHaveLength(3)
    expect(errors.every((message) => message.includes('Error in command resolver for "external-run":'))).toBe(true)
  })
})
