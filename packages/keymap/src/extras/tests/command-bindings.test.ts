import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { commandBindings } from "../index.js"
import { createDefaultOpenTuiKeymap } from "../../opentui.js"
import { createDiagnosticHarness } from "../../tests/diagnostic-harness.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()

function getKeymap(renderer: TestRenderer) {
  return diagnostics.trackKeymap(createDefaultOpenTuiKeymap(renderer))
}

describe("commandBindings helper", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("expands command-to-key maps into full binding inputs", () => {
    expect(
      commandBindings({
        "  save-file  ": "x",
        "  :write session.log  ": "ctrl+s",
        "delete-line": { name: "y", ctrl: true },
      }),
    ).toEqual([
      { key: "x", cmd: "save-file" },
      { key: "ctrl+s", cmd: ":write session.log" },
      { key: { name: "y", ctrl: true }, cmd: "delete-line" },
    ])
  })

  test("only trims command keys and does not validate them", () => {
    expect(commandBindings({ "   ": "x" })).toEqual([{ key: "x", cmd: "" }])
  })

  test("skips invalid command-to-key entries by default", () => {
    expect(commandBindings({ save: (() => {}) as never } as never)).toEqual([])
  })

  test("reports invalid entries through onError and keeps valid ones", () => {
    const errors: string[] = []

    expect(
      commandBindings(
        {
          save: (() => {}) as never,
          quit: "q",
        } as never,
        {
          onError(error) {
            errors.push(`${error.code}:${error.command}`)
          },
        },
      ),
    ).toEqual([{ key: "q", cmd: "quit" }])

    expect(errors).toEqual(["invalid-command-binding:save"])
  })

  test("lets callers throw from onError when they want strict behavior", () => {
    expect(() =>
      commandBindings({ save: (() => {}) as never } as never, {
        onError(error) {
          throw error.reason
        },
      }),
    ).toThrow(
      'Invalid command binding for "save": command bindings must map command strings to key strings or keystroke objects',
    )
  })

  test("keeps the last key for a trimmed command and reports a warning", () => {
    const warnings: string[] = []

    expect(
      commandBindings(
        { " save-file ": "x", "save-file": "y" },
        {
          onWarning(warning) {
            warnings.push(
              `${warning.code}:${warning.command}:${String(warning.previousKey)}->${String(warning.nextKey)}`,
            )
          },
        },
      ),
    ).toEqual([{ key: "y", cmd: "save-file" }])
    expect(warnings).toEqual(["command-binding-override:save-file:x->y"])
  })

  test("supports integration with named command bindings", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          run() {
            calls.push("save")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: commandBindings({ " save-file ": "x" }),
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["save"])
  })

  test("supports config-style replacement via object merging", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          run() {
            calls.push("save")
          },
        },
      ],
    })

    const defaultBindings = { "save-file": "x" }
    const userBindings = { "save-file": "y" }

    keymap.registerLayer({ bindings: commandBindings({ ...defaultBindings, ...userBindings }) })

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["save"])
    expect(keymap.getActiveKeys().map((candidate) => candidate.stroke.name)).toEqual(["y"])
  })

  test("supports resolver command strings", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendCommandResolver((command) => {
      if (command !== ":write session.log") {
        return undefined
      }

      return {
        name: command,
        run() {
          calls.push("resolved")
        },
      }
    })

    keymap.registerLayer({
      bindings: commandBindings({ " :write session.log ": "x" }),
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["resolved"])
  })
})
