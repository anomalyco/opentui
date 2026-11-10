import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { registerCommaBindings, registerDefaultKeys, registerModBindings } from "@opentui/keymap/addons"
import { Keymap, type HostMetadata } from "../../../index.js"
import {
  createTestHostMetadata,
  TestKeymapEvent as FakeEvent,
  TestKeymapHost as FakeHost,
  TestKeymapTarget as FakeTarget,
} from "../../../testing/index.js"
import { createDiagnosticHarness } from "../../../tests/diagnostic-harness.js"

const diagnostics = createDiagnosticHarness()

function createMetadata(
  primaryModifier: HostMetadata["primaryModifier"],
  modifiers: Partial<HostMetadata["modifiers"]> = {},
): HostMetadata {
  return createTestHostMetadata({
    platform: primaryModifier === "super" ? "macos" : primaryModifier === "ctrl" ? "linux" : "unknown",
    primaryModifier,
    modifiers: {
      ctrl: "supported",
      shift: "supported",
      meta: "supported",
      super: "supported",
      hyper: "unknown",
      ...modifiers,
    },
  })
}

function createKeymap(metadata: HostMetadata): { host: FakeHost; keymap: Keymap<FakeTarget, FakeEvent> } {
  const host = new FakeHost({ metadata })
  const keymap = diagnostics.trackKeymap(new Keymap(host))
  registerDefaultKeys(keymap)
  return { host, keymap }
}

describe("mod bindings addon", () => {
  afterEach(() => {
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("resolves mod to the host super primary modifier and preserves display", () => {
    const { host, keymap } = createKeymap(createMetadata("super"))
    const calls: string[] = []

    registerModBindings(keymap)
    keymap.registerLayer({
      bindings: [
        {
          key: "mod+s",
          cmd() {
            calls.push("save")
          },
        },
      ],
    })

    const activeKey = keymap.getActiveKeys()[0]
    expect(activeKey?.stroke).toMatchObject({ name: "s", ctrl: false, super: true })
    expect(activeKey?.display).toBe("mod+s")

    host.press("s", { ctrl: true })
    host.press("s", { super: true })
    expect(calls).toEqual(["save"])
  })

  test("falls back to ctrl when the host primary modifier is unknown", () => {
    const { host, keymap } = createKeymap(createMetadata("unknown"))
    const calls: string[] = []

    registerModBindings(keymap)
    keymap.registerLayer({
      bindings: [
        {
          key: "mod+s",
          cmd() {
            calls.push("save")
          },
        },
      ],
    })

    const activeKey = keymap.getActiveKeys()[0]
    expect(activeKey?.stroke).toMatchObject({ name: "s", ctrl: true, super: false })
    expect(activeKey?.display).toBe("mod+s")

    host.press("s", { super: true })
    host.press("s", { ctrl: true })
    expect(calls).toEqual(["save"])
  })

  test("falls back to ctrl when the primary modifier is unsupported", () => {
    const { host, keymap } = createKeymap(createMetadata("super", { super: "unsupported" }))
    const calls: string[] = []

    registerModBindings(keymap)
    keymap.registerLayer({
      bindings: [
        {
          key: "mod+s",
          cmd() {
            calls.push("save")
          },
        },
      ],
    })

    expect(keymap.getActiveKeys()[0]?.stroke).toMatchObject({ name: "s", ctrl: true, super: false })

    host.press("s", { ctrl: true })
    expect(calls).toEqual(["save"])
  })

  test("stacks with comma bindings when mod is registered before comma", () => {
    const { host, keymap } = createKeymap(createMetadata("ctrl"))
    const calls: string[] = []

    registerModBindings(keymap)
    registerCommaBindings(keymap)
    keymap.registerLayer({
      bindings: [
        {
          key: "mod+x, mod+y",
          cmd() {
            calls.push("hit")
          },
        },
      ],
    })

    expect(keymap.getActiveKeys().map((key) => key.display)).toEqual(["mod+x", "mod+y"])
    expect(keymap.getActiveKeys().map((key) => key.stroke.ctrl)).toEqual([true, true])

    host.press("x")
    host.press("x", { ctrl: true })
    host.press("y", { ctrl: true })
    expect(calls).toEqual(["hit", "hit"])
  })

  test("stacks with comma bindings when comma is registered before mod", () => {
    const { host, keymap } = createKeymap(createMetadata("ctrl"))
    const calls: string[] = []

    registerCommaBindings(keymap)
    registerModBindings(keymap)
    keymap.registerLayer({
      bindings: [
        {
          key: "mod+x, mod+y",
          cmd() {
            calls.push("hit")
          },
        },
      ],
    })

    expect(keymap.getActiveKeys().map((key) => key.display)).toEqual(["mod+x", "mod+y"])
    expect(keymap.getActiveKeys().map((key) => key.stroke.ctrl)).toEqual([true, true])

    host.press("x")
    host.press("x", { ctrl: true })
    host.press("y", { ctrl: true })
    expect(calls).toEqual(["hit", "hit"])
  })
})
