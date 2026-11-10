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

describe("keymap: layers and dispatch", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })
  test("matches a target layer by default with focus-within semantics", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    const parent = createFocusableBox("parent")
    const child = createFocusableBox("child")
    parent.add(child)
    renderer.root.add(parent)

    keymap.registerLayer({
      commands: [
        {
          name: "parent-action",
          run() {
            calls.push("parent")
          },
        },
      ],
    })

    keymap.registerLayer({
      target: parent,
      bindings: [{ key: "x", cmd: "parent-action" }],
    })

    child.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual(["parent"])
  })

  test("does not match focus-only layers for focused descendants", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    const parent = createFocusableBox("focus-parent")
    const child = createFocusableBox("focus-child")
    parent.add(child)
    renderer.root.add(parent)

    keymap.registerLayer({
      commands: [
        {
          name: "focus-only",
          run() {
            calls.push("focus-only")
          },
        },
      ],
    })

    keymap.registerLayer({
      target: parent,
      targetMode: "focus",
      bindings: [{ key: "x", cmd: "focus-only" }],
    })

    child.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual([])
  })

  test("prefers local layers over global ones and supports fallthrough", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    const target = createFocusableBox("target")
    renderer.root.add(target)

    keymap.registerLayer({
      commands: [
        {
          name: "global-action",
          run() {
            calls.push("global")
          },
        },
        {
          name: "local-action",
          run() {
            calls.push("local")
          },
        },
        {
          name: "fallthrough-action",
          run() {
            calls.push("fallthrough-local")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [
        { key: "x", cmd: "global-action" },
        { key: "y", cmd: "global-action" },
      ],
    })

    keymap.registerLayer({
      target,
      bindings: [
        { key: "x", cmd: "local-action" },
        { key: "y", cmd: "fallthrough-action", fallthrough: true },
      ],
    })

    target.focus()

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["local", "fallthrough-local", "global"])
  })

  test("consumes matched keys by default", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    let laterGlobalCount = 0
    let renderableCount = 0

    const target = createFocusableBox("consumed-target")
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
          name: "consume",
          run() {
            calls.push("keymap")
          },
        },
      ],
    })

    keymap.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "consume" }],
    })

    target.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual(["keymap"])
    expect(laterGlobalCount).toBe(0)
    expect(renderableCount).toBe(0)
  })

  test("preventDefault and fallthrough are orthogonal: two axes, four combinations", () => {
    // `preventDefault` controls whether the key leaves the keymap;
    // `fallthrough` controls whether dispatch continues inside it.
    const keymap = getKeymap(renderer)
    const runs: Record<string, string[]> = { a: [], b: [], c: [], d: [] }
    const outsideSeen: Record<string, boolean> = { a: false, b: false, c: false, d: false }

    function register(keyName: "a" | "b" | "c" | "d", preventDefault: boolean, fallthrough: boolean): void {
      const bucket = runs[keyName]!
      keymap.registerLayer({
        commands: [
          {
            name: `primary-${keyName}`,
            run() {
              bucket.push("primary")
            },
          },
          {
            name: `followup-${keyName}`,
            run() {
              bucket.push("followup")
            },
          },
        ],
      })
      // Keep both bindings on the same `preventDefault` value so each case
      // varies only one axis.
      keymap.registerLayer({
        bindings: [
          { key: keyName, cmd: `primary-${keyName}`, preventDefault, fallthrough },
          { key: keyName, cmd: `followup-${keyName}`, preventDefault },
        ],
      })
    }

    // This runs after keymap dispatch, so it only sees keys that were not
    // consumed.
    renderer.keyInput.on("keypress", (event) => {
      if (event.name in outsideSeen) {
        outsideSeen[event.name] = true
      }
    })

    register("a", true, false) // defaults: consumed, no fallthrough
    register("b", false, false) // not consumed, no fallthrough
    register("c", true, true) // consumed, fallthrough
    register("d", false, true) // not consumed, fallthrough

    mockInput.pressKey("a")
    mockInput.pressKey("b")
    mockInput.pressKey("c")
    mockInput.pressKey("d")

    expect(runs.a).toEqual(["primary"])
    expect(runs.b).toEqual(["primary"])
    expect(runs.c).toEqual(["primary", "followup"])
    expect(runs.d).toEqual(["primary", "followup"])

    expect(outsideSeen.a).toBe(false)
    expect(outsideSeen.b).toBe(true)
    expect(outsideSeen.c).toBe(false)
    expect(outsideSeen.d).toBe(true)
  })

  test("preventDefault false lets the focused renderable keep handling the key", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    let laterGlobalCount = 0
    let renderableCount = 0

    const target = createFocusableBox("passthrough-target")
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
          name: "passthrough",
          run() {
            calls.push("keymap")
          },
        },
      ],
    })

    keymap.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "passthrough", preventDefault: false }],
    })

    target.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual(["keymap"])
    expect(laterGlobalCount).toBe(1)
    expect(renderableCount).toBe(1)
  })

  test("registerLayer emits an error when bindings is not an array", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        { name: "save-file", run: () => calls.push("save") },
        { name: "quit", run: () => calls.push("quit") },
      ],
    })

    keymap.registerLayer({
      bindings: { quit: "q" } as never,
    })

    mockInput.pressKey("q")

    expect(calls).toEqual([])
    expect(getActiveKeyNames(keymap)).toEqual([])
    expect(takeErrors().errors).toEqual(["Invalid keymap bindings: expected an array of binding objects"])
  })

  test("allows duplicate command names across layers and dedupes reachable commands by name", () => {
    const keymap = getKeymap(renderer)
    const { errors } = captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [{ name: "dup", run: () => calls.push("first") }],
    })

    keymap.registerLayer({
      commands: [{ name: "dup", run: () => calls.push("second") }],
    })

    expect(errors).toEqual([])
    expect(keymap.getCommands().map((command) => command.name)).toEqual(["dup"])
    expect(keymap.getCommands({ visibility: "active" }).map((command) => command.name)).toEqual(["dup", "dup"])
    expect(keymap.getCommands({ visibility: "registered" }).map((command) => command.name)).toEqual(["dup", "dup"])
    expect(keymap.runCommand("dup")).toEqual({ ok: true })
    expect(calls).toEqual(["second"])
  })

  test("can dispose command resolvers and refresh existing bindings", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "external-run" }],
    })

    expect(getActiveKey(keymap, "x")?.command).toBeUndefined()

    const offResolver = keymap.appendCommandResolver((command) => {
      if (command !== "external-run") {
        return undefined
      }

      return {
        name: command,
        run() {
          calls.push("external")
        },
      }
    })

    expect(getActiveKey(keymap, "x")?.command).toBe("external-run")

    mockInput.pressKey("x")
    expect(calls).toEqual(["external"])

    offResolver()

    expect(getActiveKey(keymap, "x")?.command).toBeUndefined()

    mockInput.pressKey("x")
    expect(calls).toEqual(["external"])
  })
})
