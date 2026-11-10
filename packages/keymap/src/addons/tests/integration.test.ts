import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable, TextareaRenderable, type Renderable } from "@opentui/core"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { registerExCommands, registerLeader } from "@opentui/keymap/addons"
import { registerManagedTextareaLayer } from "@opentui/keymap/addons/opentui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createDiagnosticHarness } from "../../tests/diagnostic-harness.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()

function createFocusableBox(id: string): BoxRenderable {
  return new BoxRenderable(renderer, {
    id,
    width: 10,
    height: 4,
    focusable: true,
  })
}

describe("keymap addon composition", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 70, height: 24, kittyKeyboard: true })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("leader, ex commands, managed textareas, passthrough typing, and focus traversal compose together", () => {
    const keymap = diagnostics.trackKeymap(createDefaultOpenTuiKeymap(renderer))
    const alpha = createFocusableBox("alpha")
    const beta = createFocusableBox("beta")
    const notes = new TextareaRenderable(renderer, {
      id: "notes",
      width: 24,
      height: 4,
      initialValue: "Notes",
    })
    const draft = new TextareaRenderable(renderer, {
      id: "draft",
      width: 24,
      height: 4,
      initialValue: "Line 1\nLine 2\nLine 3",
    })

    renderer.root.add(alpha)
    renderer.root.add(beta)
    renderer.root.add(notes)
    renderer.root.add(draft)

    const focusables: Renderable[] = [alpha, beta, notes, draft]
    let alphaCount = 0
    let betaCount = 0
    const actions: string[] = []

    const focusOffset = (delta: number) => {
      const current = renderer.currentFocusedRenderable
      const currentIndex = focusables.findIndex((candidate) => candidate === current)
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + delta + focusables.length) % focusables.length
      focusables[nextIndex]?.focus()
    }

    registerLeader(keymap, {
      trigger: { name: "x", ctrl: true },
    })

    registerExCommands(keymap)

    keymap.registerLayer({
      commands: [
        {
          name: "reset",
          namespace: "excommands",
          aliases: ["r"],
          nargs: "0",
          run() {
            alphaCount = 0
            betaCount = 0
            actions.push("reset")
          },
        },
        {
          name: "focus-next",
          run() {
            focusOffset(1)
          },
        },
        {
          name: "focus-prev",
          run() {
            focusOffset(-1)
          },
        },
        {
          name: "alpha-inc",
          run() {
            alphaCount += 1
          },
        },
        {
          name: "alpha-dec",
          run() {
            alphaCount -= 1
          },
        },
        {
          name: "beta-inc",
          run() {
            betaCount += 5
          },
        },
        {
          name: "beta-dec",
          run() {
            betaCount -= 5
          },
        },
        {
          name: "write-session-log",
          run() {
            actions.push("session.log")
          },
        },
      ],
      bindings: [
        { key: "tab", cmd: "focus-next" },
        { key: "shift+tab", cmd: "focus-prev" },
        { key: "<leader>s", cmd: "write-session-log" },
      ],
    })

    keymap.registerLayer({
      target: alpha,
      bindings: [
        { key: "j", cmd: "alpha-dec" },
        { key: "k", cmd: "alpha-inc" },
        { key: "r", cmd: ":reset" },
      ],
    })

    keymap.registerLayer({
      target: beta,
      bindings: [
        { key: "j", cmd: "beta-dec" },
        { key: "k", cmd: "beta-inc" },
      ],
    })

    const offManagedTextareas = registerManagedTextareaLayer(keymap, renderer, {
      bindings: [{ key: "dd", cmd: "input.delete.line" }],
    })

    alpha.focus()
    expect(renderer.currentFocusedRenderable).toBe(alpha)

    mockInput.pressKey("k")
    expect(alphaCount).toBe(1)

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("s")
    expect(actions).toEqual(["session.log"])

    mockInput.pressTab()
    expect(renderer.currentFocusedRenderable).toBe(beta)

    mockInput.pressKey("k")
    expect(betaCount).toBe(5)

    mockInput.pressTab({ shift: true })
    expect(renderer.currentFocusedRenderable).toBe(alpha)

    mockInput.pressKey("r")
    expect(alphaCount).toBe(0)
    expect(betaCount).toBe(0)
    expect(actions).toEqual(["session.log", "reset"])

    mockInput.pressTab()
    mockInput.pressTab()
    expect(renderer.currentFocusedRenderable).toBe(notes)

    notes.cursorOffset = notes.plainText.length
    mockInput.pressKey("x")
    expect(notes.plainText).toBe("Notesx")

    mockInput.pressTab()
    expect(renderer.currentFocusedRenderable).toBe(draft)

    draft.gotoLine(1)
    mockInput.pressKey("d")
    mockInput.pressKey("d")
    expect(draft.plainText).toBe("Line 1\nLine 3")

    offManagedTextareas()
  })
})
