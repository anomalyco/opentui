import { describe, expect, test } from "bun:test"
import { Keymap } from "../index.js"
import {
  captureKeymapDiagnostics,
  createTestHostMetadata,
  createTestKeymap,
  createTestKeymapHost,
  DEFAULT_TEST_HOST_METADATA,
  TestKeymapEvent,
  TestKeymapTarget,
} from "../testing/index.js"

describe("keymap testing entrypoint", () => {
  test("creates a host-agnostic keymap with default keys on request", () => {
    const harness = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []

    harness.keymap.registerLayer({
      commands: [
        {
          name: "run",
          run(ctx) {
            calls.push(`${ctx.event.name}:${ctx.target?.id ?? "none"}`)
          },
        },
      ],
      bindings: [{ key: "x", cmd: "run" }],
    })

    const event = harness.host.press("x")

    expect(calls).toEqual(["x:none"])
    expect(event.defaultPrevented).toBe(true)
    expect(event.propagationStopped).toBe(true)
    expect(harness.diagnostics.takeErrors().errors).toEqual([])

    harness.cleanup()
  })

  test("leaves string parsing uninstalled for bare test keymaps", () => {
    const harness = createTestKeymap()

    harness.keymap.registerLayer({
      commands: [{ name: "run", run() {} }],
      bindings: [{ key: "x", cmd: "run" }],
    })

    expect(harness.diagnostics.takeErrors().errors).toEqual(["No keymap binding parsers are registered"])
    harness.cleanup()
  })

  test("supports focus, parent traversal, raw input, and target destruction", () => {
    const harness = createTestKeymap({ defaultKeys: true })
    const parent = harness.root.append(harness.host.createTarget("parent"))
    const child = parent.append(harness.host.createTarget("child"))
    const calls: string[] = []
    const raw: string[] = []

    harness.keymap.registerLayer({
      target: parent,
      targetMode: "focus-within",
      commands: [
        {
          name: "local",
          run(ctx) {
            calls.push(ctx.target?.id ?? "none")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "local" }],
    })
    harness.keymap.intercept("raw", ({ sequence, stop }) => {
      raw.push(sequence)
      stop()
    })

    harness.host.focus(child)
    harness.host.press("x")
    expect(calls).toEqual(["parent"])
    expect(harness.host.raw(":write")).toBe(true)
    expect(raw).toEqual([":write"])

    harness.host.destroyTarget(parent)
    expect(harness.keymap.getActiveKeys()).toEqual([])
    harness.cleanup()
  })

  test("accepts host metadata overrides", () => {
    const metadata = createTestHostMetadata({
      platform: "macos",
      primaryModifier: "super",
      modifiers: { super: "supported", ctrl: "supported" },
    })
    const host = createTestKeymapHost({ metadata })

    expect(host.metadata).toBe(metadata)
    expect(host.metadata).toMatchObject({
      platform: "macos",
      primaryModifier: "super",
      modifiers: { super: "supported", ctrl: "supported" },
    })
  })

  test("captures diagnostics without depending on a test framework", () => {
    const host = createTestKeymapHost()
    const keymap = new Keymap(host)
    const diagnostics = captureKeymapDiagnostics(keymap)

    keymap.registerLayer({ bindings: [{ key: "x", cmd: "missing" }] })

    expect(diagnostics.takeErrors().errors).toEqual(["No keymap binding parsers are registered"])
    expect(diagnostics.takeErrors().errors).toEqual([])

    diagnostics.dispose()
    host.destroy()
  })

  test("exports reusable target and event classes", () => {
    const target = new TestKeymapTarget("target")
    const event = new TestKeymapEvent("x", { ctrl: true, hyper: true })

    expect(DEFAULT_TEST_HOST_METADATA.platform).toBe("unknown")
    expect(target.id).toBe("target")
    expect(event.ctrl).toBe(true)
    expect(event.hyper).toBe(true)
  })
})
