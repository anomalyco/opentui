import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type MockInput, createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { stringifyKeySequence } from "../index.js"
import { createDiagnosticHarness } from "./diagnostic-harness.js"
import { createKeymapTestHelpers, type OpenTuiKeymap } from "./keymap.test-support.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()
const { getActiveKeyNames, getKeymap, captureDiagnostics } = createKeymapTestHelpers(diagnostics, () => renderer)

function registerCountPattern(keymap: OpenTuiKeymap): () => void {
  return keymap.registerSequencePattern({
    name: "count",
    match(event) {
      if (!/^\d$/.test(event.name)) {
        return undefined
      }

      return { value: event.name, display: event.name }
    },
    finalize(values) {
      return Number(values.join(""))
    },
  })
}

describe("keymap: sequence patterns", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("defaults payload key to the pattern name", () => {
    const keymap = getKeymap(renderer)
    const calls: number[] = []

    registerCountPattern(keymap)
    keymap.registerLayer({
      commands: [
        {
          name: "word",
          run({ payload }) {
            calls.push((payload as { count: number }).count)
          },
        },
      ],
      bindings: [{ key: "{count}w", cmd: "word" }],
    })

    expect(getActiveKeyNames(keymap)).toEqual(["count"])

    mockInput.pressKey("1")
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("1")
    expect(getActiveKeyNames(keymap)).toEqual(["w"])

    mockInput.pressKey("2")
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("12")
    expect(getActiveKeyNames(keymap)).toEqual(["w"])

    mockInput.pressKey("w")

    expect(calls).toEqual([12])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("supports infix and root sequence patterns in the same layer", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    registerCountPattern(keymap)
    keymap.registerLayer({
      commands: [
        {
          name: "delete-word",
          run({ payload }) {
            calls.push(`word:${(payload as { count: number }).count}`)
          },
        },
        {
          name: "delete-lines",
          run({ payload }) {
            calls.push(`lines:${(payload as { count: number }).count}`)
          },
        },
      ],
      bindings: [
        { key: "d{count}w", cmd: "delete-word" },
        { key: "{count}dd", cmd: "delete-lines" },
      ],
    })

    mockInput.pressKey("d")
    expect(getActiveKeyNames(keymap)).toEqual(["count"])
    mockInput.pressKey("3")
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("d3")
    mockInput.pressKey("w")

    mockInput.pressKey("4")
    expect(getActiveKeyNames(keymap)).toEqual(["d"])
    mockInput.pressKey("d")
    mockInput.pressKey("d")

    expect(calls).toEqual(["word:3", "lines:4"])
  })

  test("composes static tokens and sequence patterns", () => {
    const keymap = getKeymap(renderer)
    const calls: number[] = []

    keymap.registerToken({ name: "leader", key: { name: "x", ctrl: true } })
    registerCountPattern(keymap)
    keymap.registerLayer({
      commands: [
        {
          name: "leader-word",
          run({ payload }) {
            calls.push((payload as { count: number }).count)
          },
        },
      ],
      bindings: [{ key: "<leader>{count}w", cmd: "leader-word" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("<leader>")
    expect(getActiveKeyNames(keymap)).toEqual(["count"])

    mockInput.pressKey("9")
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("<leader>9")
    expect(getActiveKeyNames(keymap)).toEqual(["w"])

    mockInput.pressKey("w")
    expect(calls).toEqual([9])
  })

  test("honors pattern min and max limits with custom payload keys", () => {
    const keymap = getKeymap(renderer)
    const calls: number[] = []

    keymap.registerSequencePattern({
      name: "two-digits",
      payloadKey: "value",
      min: 2,
      max: 2,
      match(event) {
        return /^\d$/.test(event.name) ? { value: event.name } : undefined
      },
      finalize(values) {
        return Number(values.join(""))
      },
    })
    keymap.registerLayer({
      commands: [
        {
          name: "exact-two",
          run({ payload }) {
            calls.push((payload as { value: number }).value)
          },
        },
      ],
      bindings: [{ key: "{two-digits}w", cmd: "exact-two" }],
    })

    mockInput.pressKey("1")
    mockInput.pressKey("w")
    expect(calls).toEqual([])
    expect(keymap.getPendingSequence()).toEqual([])

    mockInput.pressKey("1")
    mockInput.pressKey("2")
    mockInput.pressKey("w")
    expect(calls).toEqual([12])

    mockInput.pressKey("1")
    mockInput.pressKey("2")
    mockInput.pressKey("3")
    expect(keymap.getPendingSequence()).toEqual([])
    expect(calls).toEqual([12])
  })

  test("popPendingSequence removes one captured pattern stroke at a time", () => {
    const keymap = getKeymap(renderer)

    registerCountPattern(keymap)
    keymap.registerLayer({
      commands: [{ name: "word", run() {} }],
      bindings: [{ key: "{count}w", cmd: "word" }],
    })

    mockInput.pressKey("1")
    mockInput.pressKey("2")
    mockInput.pressKey("3")
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("123")

    expect(keymap.popPendingSequence()).toBe(true)
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("12")

    expect(keymap.popPendingSequence()).toBe(true)
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("1")

    expect(keymap.popPendingSequence()).toBe(true)
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("reports pattern matcher and finalizer failures as diagnostics", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.registerSequencePattern({
      name: "bad",
      match(event) {
        if (event.name === "1") {
          return { value: event.name }
        }

        if (event.name === "2") {
          throw new Error("match failed")
        }

        return undefined
      },
      finalize() {
        throw new Error("finalize failed")
      },
    })
    keymap.registerLayer({
      commands: [{ name: "bad", run() {} }],
      bindings: [{ key: "{bad}w", cmd: "bad" }],
    })

    mockInput.pressKey("2")
    expect(takeErrors().errors).toEqual(['[Keymap] Error matching sequence pattern "bad":'])

    mockInput.pressKey("1")
    mockInput.pressKey("w")
    expect(takeErrors().errors).toEqual(['[Keymap] Error finalizing sequence pattern "bad":'])
  })
})
