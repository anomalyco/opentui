import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { terminalNamedSingleStrokeKeys, type KeyEvent, type Renderable } from "@opentui/core"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { Keymap } from "@opentui/keymap"
import { registerDefaultKeys } from "@opentui/keymap/addons"
import { createOpenTuiKeymapHost } from "@opentui/keymap/opentui"
import { createDiagnosticHarness } from "../../../tests/diagnostic-harness.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()

describe("default parser addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 12 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("bare keymaps do not parse string bindings until the addon is registered", () => {
    const keymap = diagnostics.trackKeymap(new Keymap<Renderable, KeyEvent>(createOpenTuiKeymapHost(renderer)))
    const { takeErrors } = diagnostics.captureDiagnostics(keymap)

    keymap.registerLayer({
      commands: [{ name: "run", run() {} }],
      bindings: [{ key: "x", cmd: "run" }],
    })

    expect(takeErrors().errors).toEqual(["No keymap binding parsers are registered"])
    expect(keymap.getActiveKeys()).toEqual([])
  })

  test("registerDefaultKeys restores the standard parser and event matching", () => {
    const keymap = diagnostics.trackKeymap(new Keymap<Renderable, KeyEvent>(createOpenTuiKeymapHost(renderer)))
    const { takeWarnings } = diagnostics.captureDiagnostics(keymap)
    const calls: string[] = []

    registerDefaultKeys(keymap)

    keymap.registerLayer({
      commands: [
        {
          name: "run",
          run() {
            calls.push("run")
          },
        },
      ],
      bindings: [{ key: "<leader>d", cmd: "run" }],
    })
    keymap.registerToken({ name: "leader", key: { name: "x", ctrl: true } })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("d")

    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Unknown token "leader" in key sequence "<leader>d"; binding was skipped until the token is registered',
    ])
    expect(calls).toEqual(["run"])
  })

  test('registerDefaultKeys keeps the " " to "space" mapping in the addon, not the engine', () => {
    const keymap = diagnostics.trackKeymap(new Keymap<Renderable, KeyEvent>(createOpenTuiKeymapHost(renderer)))
    const calls: string[] = []

    registerDefaultKeys(keymap)

    keymap.registerLayer({
      commands: [
        {
          name: "space",
          run() {
            calls.push("space")
          },
        },
      ],
      bindings: [{ key: " ", cmd: "space" }],
    })

    mockInput.pressKey(" ")

    expect(calls).toEqual(["space"])
  })

  test("registerDefaultKeys parses every named single-stroke key emitted by terminal hosts", () => {
    const keymap = diagnostics.trackKeymap(new Keymap<Renderable, KeyEvent>(createOpenTuiKeymapHost(renderer)))

    registerDefaultKeys(keymap)

    keymap.registerLayer({
      commands: [{ name: "run", run() {} }],
      bindings: terminalNamedSingleStrokeKeys.map((key) => ({ key, cmd: "run" })),
    })

    const activeKeyNames = new Set(keymap.getActiveKeys().map((candidate) => candidate.stroke.name))

    for (const key of terminalNamedSingleStrokeKeys) {
      expect(activeKeyNames.has(key)).toBe(true)
    }
  })

  test("registerDefaultKeys parses named single-stroke keys inside concatenated sequences", () => {
    const keymap = diagnostics.trackKeymap(new Keymap<Renderable, KeyEvent>(createOpenTuiKeymapHost(renderer)))

    registerDefaultKeys(keymap)
    keymap.registerToken({ name: "leader", key: { name: "x", ctrl: true } })
    keymap.registerSequencePattern({
      name: "count",
      match(event) {
        return /^\d$/.test(event.name) ? { value: event.name } : undefined
      },
    })

    expect(keymap.parseKeySequence("<leader>down")).toMatchObject([
      { display: "<leader>", tokenName: "leader", stroke: { name: "x", ctrl: true } },
      { display: "down", stroke: { name: "down", ctrl: false } },
    ])
    expect(keymap.parseKeySequence("gdown")).toMatchObject([
      { display: "g", stroke: { name: "g" } },
      { display: "down", stroke: { name: "down" } },
    ])
    expect(keymap.parseKeySequence("{count}pagedown")).toMatchObject([
      { display: "{count}", patternName: "count", stroke: { name: "count" } },
      { display: "pagedown", stroke: { name: "pagedown" } },
    ])
    expect(keymap.parseKeySequence("f12leftctrl")).toMatchObject([
      { display: "f12", stroke: { name: "f12" } },
      { display: "leftctrl", stroke: { name: "leftctrl" } },
    ])
    expect(keymap.parseKeySequence("<leader>space")).toMatchObject([
      { display: "<leader>", tokenName: "leader", stroke: { name: "x", ctrl: true } },
      { display: "space", stroke: { name: "space" } },
    ])
  })

  test("registerDefaultKeys parses modified named keys inside concatenated sequences", () => {
    const keymap = diagnostics.trackKeymap(new Keymap<Renderable, KeyEvent>(createOpenTuiKeymapHost(renderer)))

    registerDefaultKeys(keymap)
    keymap.registerToken({ name: "leader", key: { name: "x", ctrl: true } })

    expect(keymap.parseKeySequence("<leader>ctrl+downa")).toMatchObject([
      { display: "<leader>", tokenName: "leader", stroke: { name: "x", ctrl: true } },
      { display: "ctrl+down", stroke: { name: "down", ctrl: true } },
      { display: "a", stroke: { name: "a", ctrl: false } },
    ])
    expect(keymap.parseKeySequence("ctrl+shift+f12x")).toMatchObject([
      { display: "ctrl+shift+f12", stroke: { name: "f12", ctrl: true, shift: true } },
      { display: "x", stroke: { name: "x", ctrl: false, shift: false } },
    ])
  })

  test("registerDefaultKeys parses bare modifier names as named keys", () => {
    const keymap = diagnostics.trackKeymap(new Keymap<Renderable, KeyEvent>(createOpenTuiKeymapHost(renderer)))

    registerDefaultKeys(keymap)

    expect(keymap.parseKeySequence("ctrl")).toMatchObject([{ display: "ctrl", stroke: { name: "ctrl" } }])
    expect(keymap.parseKeySequence("control")).toMatchObject([{ display: "control", stroke: { name: "control" } }])
    expect(keymap.parseKeySequence("shift")).toMatchObject([{ display: "shift", stroke: { name: "shift" } }])
  })

  test("registerDefaultKeys dispatches tokenized named-key sequences as named strokes", () => {
    const keymap = diagnostics.trackKeymap(new Keymap<Renderable, KeyEvent>(createOpenTuiKeymapHost(renderer)))
    const calls: string[] = []

    registerDefaultKeys(keymap)
    keymap.registerToken({ name: "leader", key: { name: "x", ctrl: true } })
    keymap.registerLayer({
      commands: [
        {
          name: "move-down",
          run() {
            calls.push("down")
          },
        },
      ],
      bindings: [{ key: "<leader>down", cmd: "move-down" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("d")
    mockInput.pressKey("o")
    mockInput.pressKey("w")
    mockInput.pressKey("n")
    expect(calls).toEqual([])

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressArrow("down")
    expect(calls).toEqual(["down"])
  })
})
