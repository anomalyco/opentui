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

describe("keymap: intercepts and release", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })
  test("supports raw intercepts and stop semantics", () => {
    const keymap = getKeymap(renderer)
    const rawCalls: string[] = []
    const keyCalls: string[] = []

    keymap.intercept("raw", ({ sequence, stop }) => {
      rawCalls.push(sequence)
      stop()
    })

    renderer.keyInput.on("keypress", (event) => {
      keyCalls.push(event.name)
    })

    renderer.stdin.emit("data", Buffer.from("x"))

    expect(rawCalls).toEqual(["x"])
    expect(keyCalls).toEqual([])
  })

  test("supports release key intercepts", async () => {
    renderer.destroy()
    const testSetup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput

    const keymap = getKeymap(renderer)
    const events: string[] = []

    keymap.intercept(
      "key",
      ({ event }) => {
        events.push(`${event.name}:${event.eventType}`)
      },
      { release: true },
    )

    renderer.stdin.emit("data", Buffer.from("\x1b[97;1:3u"))

    expect(events).toEqual(["a:release"])
  })

  test("supports declarative release bindings", async () => {
    renderer.destroy()
    const testSetup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput

    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "release-command",
          run() {
            calls.push("release")
          },
        },
        {
          name: "press-command",
          run() {
            calls.push("press")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [
        { key: "a", cmd: "release-command", event: "release" },
        { key: "b", cmd: "press-command" },
      ],
    })

    expect(getActiveKeyNames(keymap)).toEqual(["b"])

    mockInput.pressKey("a")
    expect(calls).toEqual([])

    renderer.stdin.emit("data", Buffer.from("\x1b[97;1:3u"))
    expect(calls).toEqual(["release"])

    mockInput.pressKey("b")
    expect(calls).toEqual(["release", "press"])
  })

  test("skips release bindings with multiple strokes", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.registerLayer({ commands: [{ name: "noop", run() {} }] })

    expect(() => {
      keymap.registerLayer({
        bindings: [{ key: "dd", cmd: "noop", event: "release" }],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual(["Keymap release bindings only support a single key stroke"])
    expect(getActiveKey(keymap, "d")).toBeUndefined()
  })

  test("ignores destroyed target layers and lets lower layers continue", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "local",
          run() {
            calls.push("local")
          },
        },
        {
          name: "global",
          run() {
            calls.push("global")
          },
        },
      ],
    })

    const target = createFocusableBox("destroy-target")
    renderer.root.add(target)

    keymap.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "local" }],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "global" }],
    })

    target.destroy()
    mockInput.pressKey("x")

    expect(calls).toEqual(["global"])
  })

  test("passes target and runtime data to commands", () => {
    const keymap = getKeymap(renderer)
    const seen: Array<{ target: string; command: string; mode: string }> = []

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
          name: "record",
          run(ctx) {
            seen.push({
              target: ctx.target?.id ?? "none",
              command: ctx.command?.name ?? "none",
              mode: String(ctx.data["vim.mode"]),
            })
          },
        },
      ],
    })

    const parent = createFocusableBox("ctx-parent")
    const child = createFocusableBox("ctx-child")
    parent.add(child)
    renderer.root.add(parent)

    keymap.registerLayer({
      target: parent,
      bindings: [{ key: "x", mode: "normal", cmd: "record" }],
    })

    child.focus()
    mockInput.pressKey("x")

    expect(seen).toEqual([{ target: "ctx-parent", command: "record", mode: "normal" }])
  })

  test("passes fresh runtime data snapshots to commands after data changes", () => {
    const keymap = getKeymap(renderer)
    const seen: string[] = []

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
      bindings: [{ key: "x", cmd: "record-mode" }],
    })

    keymap.setData("vim.mode", "normal")
    mockInput.pressKey("x")

    keymap.setData("vim.mode", "visual")
    mockInput.pressKey("x")

    expect(seen).toEqual(["normal", "visual"])
  })

  test("orders key intercepts by priority, exposes getData, and cleans them up", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.setData("vim.mode", "normal")

    const offLow = keymap.intercept(
      "key",
      ({ event, getData }) => {
        if (event.name !== "x") {
          return
        }

        calls.push(`low:${String(getData("vim.mode"))}`)
      },
      { priority: 1 },
    )

    keymap.intercept(
      "key",
      ({ event }) => {
        if (event.name === "x") {
          calls.push("high:first")
        }
      },
      { priority: 10 },
    )

    keymap.intercept(
      "key",
      ({ event }) => {
        if (event.name === "x") {
          calls.push("high:second")
        }
      },
      { priority: 10 },
    )

    mockInput.pressKey("x")

    expect(calls).toEqual(["high:first", "high:second", "low:normal"])

    offLow()
    calls.length = 0

    mockInput.pressKey("x")

    expect(calls).toEqual(["high:first", "high:second"])
  })

  test("uses a stable key intercept snapshot when interceptors unsubscribe mid-dispatch", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    let offSecond!: () => void

    keymap.intercept(
      "key",
      ({ event }) => {
        if (event.name !== "x") {
          return
        }

        calls.push("first")
        offSecond()
      },
      { priority: 3 },
    )

    offSecond = keymap.intercept(
      "key",
      ({ event }) => {
        if (event.name === "x") {
          calls.push("second")
        }
      },
      { priority: 2 },
    )

    keymap.intercept(
      "key",
      ({ event }) => {
        if (event.name === "x") {
          calls.push("third")
        }
      },
      { priority: 1 },
    )

    mockInput.pressKey("x")
    expect(calls).toEqual(["first", "second", "third"])

    calls.length = 0
    mockInput.pressKey("x")
    expect(calls).toEqual(["first", "third"])
  })

  test("orders raw intercepts by priority and cleans them up", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    const offLow = keymap.intercept(
      "raw",
      ({ sequence }) => {
        calls.push(`low:${sequence}`)
      },
      { priority: 1 },
    )

    keymap.intercept(
      "raw",
      ({ sequence }) => {
        calls.push(`high:first:${sequence}`)
      },
      { priority: 10 },
    )

    keymap.intercept(
      "raw",
      ({ sequence }) => {
        calls.push(`high:second:${sequence}`)
      },
      { priority: 10 },
    )

    renderer.stdin.emit("data", Buffer.from("x"))

    expect(calls).toEqual(["high:first:x", "high:second:x", "low:x"])

    offLow()
    calls.length = 0

    renderer.stdin.emit("data", Buffer.from("y"))

    expect(calls).toEqual(["high:first:y", "high:second:y"])
  })

  test("prefers higher-priority layers and newer layers within the same priority", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "global-low",
          run() {
            calls.push("global-low")
          },
        },
        {
          name: "global-high",
          run() {
            calls.push("global-high")
          },
        },
        {
          name: "older",
          run() {
            calls.push("older")
          },
        },
        {
          name: "newer",
          run() {
            calls.push("newer")
          },
        },
      ],
    })

    keymap.registerLayer({
      priority: 1,
      bindings: [{ key: "x", cmd: "global-low" }],
    })
    keymap.registerLayer({
      priority: 2,
      bindings: [{ key: "x", cmd: "global-high" }],
    })
    keymap.registerLayer({
      bindings: [{ key: "y", cmd: "older" }],
    })
    keymap.registerLayer({
      bindings: [{ key: "y", cmd: "newer" }],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["global-high", "newer"])
  })

  test("lets commands decline handling so lower layers can continue", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    let renderableCount = 0
    let laterGlobalCount = 0

    const target = createFocusableBox("decline-target")
    target.onKeyDown = () => {
      renderableCount += 1
    }
    renderer.root.add(target)

    renderer.keyInput.on("keypress", () => {
      laterGlobalCount += 1
    })

    keymap.registerLayer({
      commands: [
        {
          name: "local-decline",
          run() {
            calls.push("local")
            return false
          },
        },
        {
          name: "global-handle",
          run() {
            calls.push("global")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "global-handle" }],
    })
    keymap.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "local-decline" }],
    })

    target.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual(["local", "global"])
    expect(renderableCount).toBe(0)
    expect(laterGlobalCount).toBe(0)
  })

  test("consumes async command bindings immediately", async () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    let laterGlobalCount = 0
    let renderableCount = 0

    const target = createFocusableBox("async-target")
    target.onKeyDown = () => {
      renderableCount += 1
    }
    renderer.root.add(target)

    renderer.keyInput.on("keypress", () => {
      laterGlobalCount += 1
    })

    keymap.registerLayer({
      commands: [
        {
          name: "async-command",
          async run() {
            await Bun.sleep(0)
            calls.push("async")
          },
        },
      ],
    })

    keymap.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "async-command" }],
    })

    target.focus()
    mockInput.pressKey("x")

    expect(renderableCount).toBe(0)
    expect(laterGlobalCount).toBe(0)

    await Bun.sleep(0)

    expect(calls).toEqual(["async"])
  })
})
