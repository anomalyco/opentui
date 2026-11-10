import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { registerNeovimDisambiguation } from "@opentui/keymap/addons"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { stringifyKeySequence } from "../../../index.js"
import { createDiagnosticHarness } from "../../../tests/diagnostic-harness.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()

function createRunSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function getKeymap(renderer: TestRenderer) {
  return diagnostics.trackKeymap(createDefaultOpenTuiKeymap(renderer))
}

describe("neovim disambiguation addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("runs the exact binding after its timeout when no continuation arrives", async () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const goRan = createRunSignal()

    keymap.registerLayer({
      commands: [
        {
          name: "go",
          run() {
            calls.push("go")
            goRan.resolve()
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

    registerNeovimDisambiguation(keymap, { timeoutMs: 5 })

    keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "go" },
        { key: "gg", cmd: "top" },
      ],
    })

    mockInput.pressKey("g")

    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("g")

    await goRan.promise

    expect(calls).toEqual(["go"])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("uses a 300ms default timeout", async () => {
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

    registerNeovimDisambiguation(keymap)

    keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "go" },
        { key: "gg", cmd: "top" },
      ],
    })

    mockInput.pressKey("g")
    await Bun.sleep(100)

    expect(calls).toEqual([])
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("g")

    await Bun.sleep(260)

    expect(calls).toEqual(["go"])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("lets the continuation win when the next key arrives before the timeout", async () => {
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

    registerNeovimDisambiguation(keymap, { timeoutMs: 10 })

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

  test("works after entering a pending prefix before the ambiguous step", async () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const deleteCharRan = createRunSignal()

    keymap.registerLayer({
      commands: [
        {
          name: "delete-char",
          run() {
            calls.push("delete-char")
            deleteCharRan.resolve()
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

    registerNeovimDisambiguation(keymap, { timeoutMs: 5 })

    keymap.registerLayer({
      bindings: [
        { key: "dc", cmd: "delete-char" },
        { key: "dca", cmd: "delete-ca" },
      ],
    })

    mockInput.pressKey("d")
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("d")

    mockInput.pressKey("c")
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("dc")

    await deleteCharRan.promise

    expect(calls).toEqual(["delete-char"])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("cancels the deferred exact binding when the pending sequence is cleared", async () => {
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

    registerNeovimDisambiguation(keymap, { timeoutMs: 5 })

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

  test("stops applying when disposed", async () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = diagnostics.captureDiagnostics(keymap)
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

    const off = registerNeovimDisambiguation(keymap, { timeoutMs: 5 })

    keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "go" },
        { key: "gg", cmd: "top" },
      ],
    })

    mockInput.pressKey("g")
    await Bun.sleep(20)

    expect(calls).toEqual(["go"])

    off()

    expect(takeErrors().errors).toEqual([
      "Keymap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
    ])

    mockInput.pressKey("g")
    await Bun.sleep(20)

    expect(calls).toEqual(["go", "go"])
  })

  test("cancels a pending timeout when disposed while ambiguous input is pending", async () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = diagnostics.captureDiagnostics(keymap)
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

    const off = registerNeovimDisambiguation(keymap, { timeoutMs: 5 })

    keymap.registerLayer({
      bindings: [
        { key: "g", cmd: "go" },
        { key: "gg", cmd: "top" },
      ],
    })

    mockInput.pressKey("g")
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("g")

    off()
    await Bun.sleep(20)

    expect(takeErrors().errors).toEqual([
      "Keymap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
    ])
    expect(calls).toEqual([])
    expect(keymap.getPendingSequence()).toEqual([])
  })
})
