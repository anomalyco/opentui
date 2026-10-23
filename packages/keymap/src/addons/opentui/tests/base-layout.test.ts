import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { registerBaseLayoutFallback } from "@opentui/keymap/addons/opentui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createDiagnosticHarness } from "../../../tests/diagnostic-harness.js"
import {
  baseLayoutBindings,
  baseLayoutVectorName,
  baseLayoutVectors,
} from "../../../../../core/src/lib/keybinding.base-layout.fixture.js"

let renderer: TestRenderer
const diagnostics = createDiagnosticHarness()

function getKeymap(renderer: TestRenderer) {
  return diagnostics.trackKeymap(createDefaultOpenTuiKeymap(renderer))
}

describe("base layout fallback addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true })
    renderer = testSetup.renderer
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  for (const row of baseLayoutVectors) {
    const [name, baseCode, modifiers, matches] = row
    test(baseLayoutVectorName(row), () => {
      const keymap = getKeymap(renderer)
      const calls: string[] = []

      registerBaseLayoutFallback(keymap)
      keymap.registerLayer({
        commands: baseLayoutBindings.map((key) => ({ name: key, run: () => void calls.push(key) })),
        bindings: baseLayoutBindings.map((key) => {
          const parts = key.split("+")
          return { key: { name: parts.at(-1)!, ctrl: parts.includes("ctrl"), meta: parts.includes("meta") }, cmd: key }
        }),
      })

      const base = baseCode === undefined ? "" : `::${baseCode}`
      renderer.stdin.emit(
        "data",
        Buffer.from(`\x1b[${name.codePointAt(0)}${base};${{ ctrl: 5, meta: 3, "": 1 }[modifiers]}u`),
      )

      expect(calls).toEqual(matches.slice(0, 1))
    })
  }

  test("keeps lower-layer direct stroke matches ahead of higher-layer base-layout fallbacks", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    registerBaseLayoutFallback(keymap)
    keymap.registerLayer({
      commands: [
        {
          name: "delete-to-end",
          run() {
            calls.push("delete-to-end")
          },
        },
      ],
      bindings: [{ key: { name: "л", ctrl: true }, cmd: "delete-to-end" }],
    })
    keymap.registerLayer({
      commands: [
        {
          name: "paste",
          run() {
            calls.push("paste")
          },
        },
      ],
      bindings: [{ key: "ctrl+k", cmd: "paste" }],
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[1083::107;5u"))

    expect(calls).toEqual(["delete-to-end"])
  })

  test("can be disposed to stop base-layout fallback matching", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    const offFallback = registerBaseLayoutFallback(keymap)
    offFallback()

    keymap.registerLayer({
      commands: [
        {
          name: "copy",
          run() {
            calls.push("copy")
          },
        },
      ],
    })
    keymap.registerLayer({ bindings: [{ key: "ctrl+c", cmd: "copy" }] })

    renderer.stdin.emit("data", Buffer.from("\x1b[12618::99;5u"))

    expect(calls).toEqual([])
  })
})
