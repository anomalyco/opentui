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
import { MAX_STATE_CHANGE_FLUSH_ITERATIONS } from "../services/notify.js"

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

describe("keymap: sequences and state", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })
  test("supports multi-key sequences and reports active continuation keys", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "delete-line",
          run() {
            calls.push("delete-line")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    expect(getActiveKeyNames(keymap)).toEqual(["d"])

    mockInput.pressKey("d")

    expect(keymap.getPendingSequence()).toMatchObject([
      {
        stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false },
        display: "d",
      },
    ])
    expect(getActiveKeyNames(keymap)).toEqual(["d"])
    expect(getActiveKey(keymap, "d")?.command).toBe("delete-line")
    expect(getActiveKey(keymap, "d")?.display).toBe("d")

    mockInput.pressKey("d")

    expect(calls).toEqual(["delete-line"])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("hasPendingSequence reflects pending lifecycle", () => {
    const keymap = getKeymap(renderer)

    keymap.registerLayer({ commands: [{ name: "delete-line", run() {} }] })
    keymap.registerLayer({
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    expect(keymap.hasPendingSequence()).toBe(false)

    mockInput.pressKey("d")
    expect(keymap.hasPendingSequence()).toBe(true)

    keymap.popPendingSequence()
    expect(keymap.hasPendingSequence()).toBe(false)

    mockInput.pressKey("d")
    expect(keymap.hasPendingSequence()).toBe(true)

    keymap.clearPendingSequence()
    expect(keymap.hasPendingSequence()).toBe(false)
  })

  test("key intercepts can be gated by hasPendingSequence", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "delete-line",
          run() {
            calls.push("delete")
          },
        },
      ],
    })
    keymap.registerLayer({
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    const off = keymap.intercept("key", ({ event }) => {
      if (!keymap.hasPendingSequence()) {
        return
      }

      calls.push(`pending:${event.name}`)
    })

    mockInput.pressKey("d")
    mockInput.pressKey("x")
    mockInput.pressKey("d")
    mockInput.pressKey("d")

    expect(calls).toEqual(["pending:x", "pending:d", "delete"])

    off()
    calls.length = 0

    mockInput.pressKey("d")
    mockInput.pressKey("x")

    expect(calls).toEqual([])
  })

  test("notifies pending sequence changes synchronously", () => {
    const keymap = getKeymap(renderer)
    const changes: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "delete-ca",
          run() {},
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    keymap.on("pendingSequence", (sequence) => {
      changes.push(stringifyKeySequence(sequence, { preferDisplay: true }))
    })

    mockInput.pressKey("d")
    mockInput.pressKey("c")
    keymap.popPendingSequence()
    keymap.clearPendingSequence()

    expect(changes).toEqual(["d", "dc", "d", ""])
  })

  test("notifies state changes with the current pending sequence and active keys", () => {
    const keymap = getKeymap(renderer)
    const snapshots: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "delete-ca",
          run() {},
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    keymap.on("state", () => {
      const pending = stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true }) || "<root>"
      const active = getActiveKeyNames(keymap).join(",") || "<none>"
      snapshots.push(`${pending}:${active}`)
    })

    mockInput.pressKey("d")
    mockInput.pressKey("c")
    keymap.popPendingSequence()
    keymap.clearPendingSequence()

    expect(snapshots).toEqual(["d:c", "dc:a", "d:c", "<root>:d"])
  })

  test("coalesces state changes when runtime data clears a pending sequence", () => {
    const keymap = getKeymap(renderer)
    const snapshots: string[] = []

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

    keymap.on("state", () => {
      const pending = stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true }) || "<root>"
      const active = getActiveKeyNames(keymap).join(",") || "<none>"
      snapshots.push(`${pending}:${active}`)
    })

    keymap.setData("vim.mode", "visual")

    expect(snapshots).toEqual(["<root>:<none>"])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("notifies state changes when focus changes active layers and direct blur clears focus", () => {
    const keymap = getKeymap(renderer)
    const target = createFocusableBox("state-target")
    const snapshots: string[] = []

    renderer.root.add(target)

    keymap.registerLayer({ commands: [{ name: "local", run() {} }] })
    keymap.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "local" }],
    })

    keymap.on("state", () => {
      snapshots.push(getActiveKeyNames(keymap).join(",") || "<none>")
    })

    target.focus()
    target.blur()

    expect(snapshots).toEqual(["x", "<none>"])
  })

  test("coalesces state changes when blur clears a pending sequence", () => {
    const keymap = getKeymap(renderer)
    const target = createFocusableBox("pending-target")
    const snapshots: string[] = []

    renderer.root.add(target)

    keymap.registerLayer({ commands: [{ name: "delete-line", run() {} }] })
    keymap.registerLayer({
      target,
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    target.focus()
    mockInput.pressKey("d")

    keymap.on("state", () => {
      const pending = stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true }) || "<root>"
      const active = getActiveKeyNames(keymap).join(",") || "<none>"
      snapshots.push(`${pending}:${active}`)
    })

    target.blur()

    expect(snapshots).toEqual(["<root>:<none>"])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("clears global pending sequences when focus changes to another renderable", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    const first = createFocusableBox("global-pending-first")
    const second = createFocusableBox("global-pending-second")
    renderer.root.add(first)
    renderer.root.add(second)

    keymap.registerLayer({
      commands: [
        {
          name: "global-delete",
          run() {
            calls.push("global")
          },
        },
        {
          name: "local-delete",
          run() {
            calls.push("local")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "dd", cmd: "global-delete" }],
    })
    keymap.registerLayer({
      target: second,
      bindings: [{ key: "d", cmd: "local-delete" }],
    })

    first.focus()
    mockInput.pressKey("d")

    expect(keymap.getPendingSequence()).toHaveLength(1)

    second.focus()

    expect(keymap.getPendingSequence()).toEqual([])

    mockInput.pressKey("d")

    expect(calls).toEqual(["local"])
  })

  test("clears global pending sequences when direct blur clears focus", () => {
    const keymap = getKeymap(renderer)
    const target = createFocusableBox("global-pending-blur")

    renderer.root.add(target)

    keymap.registerLayer({ commands: [{ name: "global-delete", run() {} }] })
    keymap.registerLayer({
      bindings: [{ key: "dd", cmd: "global-delete" }],
    })

    target.focus()
    mockInput.pressKey("d")

    expect(keymap.getPendingSequence()).toHaveLength(1)

    target.blur()

    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("can unsubscribe state listeners", () => {
    const keymap = getKeymap(renderer)
    const target = createFocusableBox("unsubscribe-target")
    const snapshots: string[] = []

    renderer.root.add(target)

    keymap.registerLayer({ commands: [{ name: "local", run() {} }] })
    keymap.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "local" }],
    })

    const off = keymap.on("state", () => {
      snapshots.push(getActiveKeyNames(keymap).join(",") || "<none>")
    })

    off()
    target.focus()

    expect(snapshots).toEqual([])
  })

  test("uses a stable state listener snapshot when listeners unsubscribe mid-notification", () => {
    const keymap = getKeymap(renderer)
    const target = createFocusableBox("state-snapshot-target")
    const calls: string[] = []

    renderer.root.add(target)

    keymap.registerLayer({ commands: [{ name: "local", run() {} }] })
    keymap.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "local" }],
    })

    let offSecond!: () => void

    keymap.on("state", () => {
      calls.push(`first:${getActiveKeyNames(keymap).join(",") || "<none>"}`)
      offSecond()
    })

    offSecond = keymap.on("state", () => {
      calls.push(`second:${getActiveKeyNames(keymap).join(",") || "<none>"}`)
    })

    target.focus()
    target.blur()

    expect(calls).toEqual(["first:x", "second:x", "first:<none>"])
  })

  test("state listeners can queue a bounded number of follow-up state changes", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)
    const calls: string[] = []
    let count = 0

    keymap.on("state", () => {
      count += 1
      calls.push(`state:${count}`)

      if (count < 4) {
        keymap.setData(`bounded-${count}`, count)
      }
    })

    keymap.setData("bounded-start", 0)

    expect(calls).toEqual(["state:1", "state:2", "state:3", "state:4"])
    expect(takeErrors().errors).toEqual([])
  })

  test("pending sequence listeners can update runtime data and clear pending state during dispatch", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerLayer({ commands: [{ name: "delete-line", run() {} }] })
    keymap.registerLayer({
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    keymap.on("pendingSequence", (sequence) => {
      const display = stringifyKeySequence(sequence, { preferDisplay: true })
      calls.push(`pending:${display}`)

      if (sequence.length > 0) {
        keymap.setData("vim.pending", display)
        keymap.clearPendingSequence()
      }
    })

    mockInput.pressKey("d")

    expect(calls).toEqual(["pending:d", "pending:"])
    expect(keymap.getData("vim.pending")).toBe("d")
    expect(keymap.getPendingSequence()).toEqual([])
    expect(takeErrors().errors).toEqual([])
  })

  test("state listener feedback loops are cut off and reported", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)
    let calls = 0
    let nextValue = 0

    const off = keymap.on("state", () => {
      calls += 1
      nextValue += 1
      keymap.setData("loop", nextValue)
    })

    keymap.setData("loop", 0)
    off()

    expect(calls).toBe(MAX_STATE_CHANGE_FLUSH_ITERATIONS)
    expect(takeErrors().errors).toEqual([
      `[Keymap] Possible infinite state listener feedback loop detected after ${MAX_STATE_CHANGE_FLUSH_ITERATIONS} iterations; pending state notifications were dropped`,
    ])
  })

  test("supports token aliases inside longer sequences", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerToken({
      name: "leader",
      key: { name: "x", ctrl: true },
    })

    keymap.registerLayer({
      commands: [
        {
          name: "go-definition",
          run() {
            calls.push("go-definition")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "<leader>gd", cmd: "go-definition" }],
    })

    mockInput.pressKey("x", { ctrl: true })

    expect(getActiveKeyNames(keymap)).toEqual(["g"])
    expect(getActiveKeyDisplay(keymap, "g")?.command).toBeUndefined()
    expect(keymap.getPendingSequence()).toMatchObject([
      {
        stroke: { name: "x", ctrl: true, shift: false, meta: false, super: false },
        display: "<leader>",
        tokenName: "leader",
      },
    ])
    expect(getActiveKey(keymap, "g")?.command).toBeUndefined()

    mockInput.pressKey("g")

    expect(getActiveKeyNames(keymap)).toEqual(["d"])
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("<leader>g")
    expect(getActiveKey(keymap, "d")?.command).toBe("go-definition")

    mockInput.pressKey("d")

    expect(calls).toEqual(["go-definition"])
  })

  test("uses preserved display for unambiguous active token prefixes", () => {
    const keymap = getKeymap(renderer)

    keymap.registerToken({
      name: "leader",
      key: { name: "x", ctrl: true },
    })

    keymap.registerLayer({
      commands: [
        { name: "save", run() {} },
        { name: "help", run() {} },
      ],
    })

    keymap.registerLayer({
      bindings: [
        { key: "<leader>s", cmd: "save" },
        { key: "<leader>h", cmd: "help" },
      ],
    })

    const activeKey = getActiveKeyDisplay(keymap, "<leader>", { includeBindings: true })

    expect(activeKey?.command).toBeUndefined()
    expect(activeKey?.tokenName).toBe("leader")
    expect(activeKey?.bindings).toBeUndefined()
    expect(stringifyKeyStroke(activeKey!, { preferDisplay: true })).toBe("<leader>")
  })

  test("clears active key token provenance when token and literal prefixes share a key", () => {
    const keymap = getKeymap(renderer)

    keymap.registerToken({ name: "leader", key: { name: "space" } })
    keymap.registerLayer({
      commands: [
        { name: "token-command", run() {} },
        { name: "literal-command", run() {} },
      ],
      bindings: [
        { key: "<leader>s", cmd: "token-command" },
        { key: " h", cmd: "literal-command" },
      ],
    })

    const activeKey = getActiveKey(keymap, "space", { includeBindings: true })

    expect(activeKey?.display).toBe("space")
    expect(activeKey?.tokenName).toBeUndefined()
    expect(activeKey?.bindings).toBeUndefined()
  })

  test("supports branching sequences", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "delete-a",
          run() {
            calls.push("da")
          },
        },
        {
          name: "delete-b",
          run() {
            calls.push("db")
          },
        },
        {
          name: "delete-ca",
          run() {
            calls.push("dca")
          },
        },
        {
          name: "delete-cb",
          run() {
            calls.push("dcb")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [
        { key: "da", cmd: "delete-a" },
        { key: "db", cmd: "delete-b" },
        { key: "dca", cmd: "delete-ca" },
        { key: "dcb", cmd: "delete-cb" },
      ],
    })

    mockInput.pressKey("d")
    expect(getActiveKeyNames(keymap)).toEqual(["a", "b", "c"])

    mockInput.pressKey("c")
    expect(getActiveKeyNames(keymap)).toEqual(["a", "b"])

    mockInput.pressKey("b")
    expect(calls).toEqual(["dcb"])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("merges pending sequence continuations across matching prefix layers", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    const target = createFocusableBox("sequence-target")
    renderer.root.add(target)

    keymap.registerLayer({
      commands: [
        {
          name: "local-delete",
          run() {
            calls.push("local")
          },
        },
        {
          name: "global-delete",
          run() {
            calls.push("global")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "da", cmd: "global-delete" }],
    })

    keymap.registerLayer({
      target,
      bindings: [{ key: "dd", cmd: "local-delete" }],
    })

    target.focus()
    mockInput.pressKey("d")

    expect(getActiveKeyNames(keymap)).toEqual(["a", "d"])

    mockInput.pressKey("d")

    expect(calls).toEqual(["local"])
  })

  test("merges shared leader-style prefixes across local and global layers", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const target = createFocusableBox("shared-leader-target")

    renderer.root.add(target)

    keymap.registerToken({
      name: "leader",
      key: { name: "x", ctrl: true },
    })

    keymap.registerLayer({
      commands: [
        {
          name: "global-model",
          run() {
            calls.push("global-model")
          },
        },
        {
          name: "local-editor",
          run() {
            calls.push("local-editor")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "<leader>m", cmd: "global-model" }],
    })
    keymap.registerLayer({
      target,
      bindings: [{ key: "<leader>e", cmd: "local-editor" }],
    })

    target.focus()
    mockInput.pressKey("x", { ctrl: true })

    expect(getActiveKeyNames(keymap)).toEqual(["e", "m"])

    mockInput.pressKey("m")
    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("e")

    expect(calls).toEqual(["global-model", "local-editor"])
  })

  test("supports addon-style backspace editing for pending sequences", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "delete-ca",
          run() {
            calls.push("delete-ca")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    keymap.intercept("key", ({ event, consume }) => {
      if (event.name !== "backspace") {
        return
      }

      if (!keymap.popPendingSequence()) {
        return
      }

      consume()
    })

    mockInput.pressKey("d")
    mockInput.pressKey("c")

    expect(keymap.getPendingSequence()).toMatchObject([
      {
        stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false },
        display: "d",
      },
      {
        stroke: { name: "c", ctrl: false, shift: false, meta: false, super: false },
        display: "c",
      },
    ])

    mockInput.pressBackspace()

    expect(keymap.getPendingSequence()).toMatchObject([
      {
        stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false },
        display: "d",
      },
    ])
    expect(getActiveKeyNames(keymap)).toEqual(["c"])

    mockInput.pressKey("c")
    mockInput.pressKey("a")

    expect(calls).toEqual(["delete-ca"])
  })

  test("clears pending sequences on invalid continuation", () => {
    const keymap = getKeymap(renderer)

    keymap.registerLayer({ commands: [{ name: "delete-line", run() {} }] })
    keymap.registerLayer({
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    mockInput.pressKey("d")
    expect(keymap.getPendingSequence()).toHaveLength(1)

    mockInput.pressKey("x")

    expect(keymap.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames(keymap)).toEqual(["d"])
  })

  test("getActiveKeys respects runtime requirements", () => {
    const keymap = getKeymap(renderer)

    keymap.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    keymap.registerLayer({
      commands: [
        { name: "normal-delete", run() {} },
        { name: "visual-delete", run() {} },
      ],
    })

    keymap.registerLayer({
      bindings: [
        { key: "dd", mode: "normal", cmd: "normal-delete" },
        { key: "vv", mode: "visual", cmd: "visual-delete" },
      ],
    })

    expect(getActiveKeyNames(keymap)).toEqual([])

    keymap.setData("vim.mode", "normal")
    expect(getActiveKeyNames(keymap)).toEqual(["d"])

    keymap.setData("vim.mode", "visual")
    expect(getActiveKeyNames(keymap)).toEqual(["v"])
  })
})
