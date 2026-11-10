import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as addons from "../addons/index.js"
import { Keymap, stringifyKeySequence, type KeymapHost } from "../index.js"
import {
  createTestHostMetadata,
  TestKeymapEvent as FakeEvent,
  TestKeymapHost as FakeHost,
  TestKeymapTarget as FakeTarget,
} from "../testing/index.js"
import { createDiagnosticHarness } from "./diagnostic-harness.js"

const diagnostics = createDiagnosticHarness()

const FAKE_HOST_METADATA = createTestHostMetadata()

describe("generic keymap host", () => {
  let host: FakeHost
  let keymap: Keymap<FakeTarget, FakeEvent>

  beforeEach(() => {
    host = new FakeHost({ metadata: FAKE_HOST_METADATA })
    keymap = diagnostics.trackKeymap(new Keymap(host))
    addons.registerDefaultKeys(keymap)
  })

  afterEach(() => {
    host?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("dispatches bindings through a host without OpenTUI types", () => {
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "run",
          run(ctx) {
            calls.push(`${ctx.event.name}:${ctx.target?.id ?? "none"}`)
          },
        },
      ],
    })
    keymap.registerLayer({ bindings: [{ key: "x", cmd: "run" }] })

    const event = host.press("x")

    expect(calls).toEqual(["x:none"])
    expect(event.defaultPrevented).toBe(true)
    expect(event.propagationStopped).toBe(true)
  })

  test("key:after observes no-match dispatch and can consume afterward", () => {
    const seen: Array<{ handled: boolean; reason: string }> = []

    keymap.intercept("key:after", (ctx) => {
      seen.push({ handled: ctx.handled, reason: ctx.reason })
      ctx.consume()
    })

    const event = host.press("x")

    expect(seen).toEqual([{ handled: false, reason: "no-match" }])
    expect(event.defaultPrevented).toBe(true)
    expect(event.propagationStopped).toBe(true)
  })

  test("key:after observes handled binding details before optionally consuming", () => {
    const calls: string[] = []
    const seen: Array<{
      handled: boolean
      reason: string
      stoppedBeforeAfter: boolean
      sequence: string
    }> = []

    keymap.registerLayer({
      commands: [
        {
          name: "save",
          run(ctx) {
            calls.push(ctx.input)
          },
        },
      ],
      bindings: [{ key: "x", cmd: "save", preventDefault: false }],
    })

    keymap.intercept("key:after", (ctx) => {
      seen.push({
        handled: ctx.handled,
        reason: ctx.reason,
        stoppedBeforeAfter: ctx.event.propagationStopped,
        sequence: stringifyKeySequence(ctx.sequence, { preferDisplay: true }),
      })
      ctx.consume()
    })

    const event = host.press("x")

    expect(calls).toEqual(["save"])
    expect(seen).toEqual([
      {
        handled: true,
        reason: "binding-handled",
        stoppedBeforeAfter: false,
        sequence: "x",
      },
    ])
    expect(event.defaultPrevented).toBe(true)
    expect(event.propagationStopped).toBe(true)
  })

  test("key:after still runs for pre-consumed keys and does not dispatch bindings", () => {
    const calls: string[] = []
    const seen: string[] = []

    keymap.registerLayer({ bindings: [{ key: "x", cmd: () => void calls.push("binding") }] })
    keymap.intercept("key", ({ consume }) => {
      consume()
    })
    keymap.intercept("key:after", (ctx) => {
      seen.push(`${ctx.reason}:${ctx.handled}:${ctx.event.propagationStopped}`)
      ctx.consume()
    })
    keymap.intercept("key:after", (ctx) => {
      seen.push(`second:${ctx.reason}`)
    })

    const event = host.press("x")

    expect(calls).toEqual([])
    expect(seen).toEqual(["intercept-consumed:true:true", "second:intercept-consumed"])
    expect(event.defaultPrevented).toBe(true)
    expect(event.propagationStopped).toBe(true)
  })

  test("key:after reports rejected bindings without treating them as handled", () => {
    const seen: Array<{ handled: boolean; reason: string; sequence: string }> = []

    keymap.registerLayer({
      commands: [
        {
          name: "reject",
          run() {
            return false
          },
        },
      ],
      bindings: [{ key: "x", cmd: "reject" }],
    })

    keymap.intercept("key:after", (ctx) => {
      seen.push({
        handled: ctx.handled,
        reason: ctx.reason,
        sequence: stringifyKeySequence(ctx.sequence, { preferDisplay: true }),
      })
      ctx.consume()
    })

    const event = host.press("x")

    expect(seen).toEqual([{ handled: false, reason: "binding-rejected", sequence: "x" }])
    expect(event.defaultPrevented).toBe(true)
    expect(event.propagationStopped).toBe(true)
  })

  test("key:after reports handled fallthrough dispatch once", () => {
    const calls: string[] = []
    const seen: Array<{ handled: boolean; reason: string; sequence: string }> = []

    keymap.registerLayer({
      priority: 0,
      commands: [{ name: "low", run: () => void calls.push("low") }],
      bindings: [{ key: "x", cmd: "low" }],
    })
    keymap.registerLayer({
      priority: 10,
      commands: [{ name: "high", run: () => void calls.push("high") }],
      bindings: [{ key: "x", cmd: "high", fallthrough: true }],
    })

    keymap.intercept("key:after", (ctx) => {
      seen.push({
        handled: ctx.handled,
        reason: ctx.reason,
        sequence: stringifyKeySequence(ctx.sequence, { preferDisplay: true }),
      })
    })

    host.press("x")

    expect(calls).toEqual(["high", "low"])
    expect(seen).toEqual([{ handled: true, reason: "binding-handled", sequence: "x" }])
  })

  test("key:after reports sequence pending and sequence miss outcomes", () => {
    const seen: Array<{ reason: string; handled: boolean; sequence: string; pending: string }> = []

    keymap.registerLayer({ bindings: [{ key: "gg", cmd: () => {} }] })
    keymap.intercept("key:after", (ctx) => {
      seen.push({
        reason: ctx.reason,
        handled: ctx.handled,
        sequence: stringifyKeySequence(ctx.sequence, { preferDisplay: true }),
        pending: stringifyKeySequence(ctx.pendingSequence, { preferDisplay: true }),
      })
    })

    const first = host.press("g")
    const second = host.press("x")

    expect(seen).toEqual([
      { reason: "sequence-pending", handled: true, sequence: "g", pending: "g" },
      { reason: "sequence-miss", handled: false, sequence: "g", pending: "" },
    ])
    expect(first.propagationStopped).toBe(true)
    expect(second.propagationStopped).toBe(false)
  })

  test("key:after release listeners only observe release dispatch", () => {
    const calls: string[] = []
    const seen: string[] = []

    keymap.registerLayer({ bindings: [{ key: "x", event: "release", cmd: () => void calls.push("release") }] })
    keymap.intercept(
      "key:after",
      (ctx) => {
        seen.push(`${ctx.eventType}:${ctx.reason}:${ctx.handled}`)
      },
      { release: true },
    )

    host.press("x")
    host.release("x")

    expect(calls).toEqual(["release"])
    expect(seen).toEqual(["release:binding-handled:true"])
  })

  test("exposes mandatory host metadata", () => {
    expect(keymap.getHostMetadata()).toBe(FAKE_HOST_METADATA)
    expect(keymap.getHostMetadata()).toEqual({
      platform: "unknown",
      primaryModifier: "unknown",
      modifiers: {
        ctrl: "unknown",
        shift: "unknown",
        meta: "unknown",
        super: "unknown",
        hyper: "unknown",
      },
    })
  })

  test("supports hosts without explicit destroy notifications", () => {
    const hostWithoutDestroy: KeymapHost<FakeTarget, FakeEvent> = {
      metadata: FAKE_HOST_METADATA,
      rootTarget: host.rootTarget,
      get isDestroyed() {
        return host.isDestroyed
      },
      getFocusedTarget() {
        return host.getFocusedTarget()
      },
      getParentTarget(target) {
        return host.getParentTarget(target)
      },
      isTargetDestroyed(target) {
        return host.isTargetDestroyed(target)
      },
      onKeyPress(listener) {
        return host.onKeyPress(listener)
      },
      onKeyRelease(listener) {
        return host.onKeyRelease(listener)
      },
      onFocusChange(listener) {
        return host.onFocusChange(listener)
      },
      onTargetDestroy(target, listener) {
        return host.onTargetDestroy(target, listener)
      },
      onRawInput(listener) {
        return host.onRawInput(listener)
      },
      createCommandEvent() {
        return host.createCommandEvent()
      },
    }
    const localKeymap = diagnostics.trackKeymap(new Keymap(hostWithoutDestroy))
    addons.registerDefaultKeys(localKeymap)
    const calls: string[] = []

    localKeymap.registerLayer({
      commands: [
        {
          name: "run",
          run() {
            calls.push("run")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "run" }],
    })

    host.press("x")

    expect(calls).toEqual(["run"])
  })

  test("uses host parent traversal for focus-within layers", () => {
    const parent = host.rootTarget.append(new FakeTarget("parent"))
    const child = parent.append(new FakeTarget("child"))
    const calls: string[] = []

    keymap.registerLayer({
      targetMode: "focus-within",
      target: parent,
      commands: [
        {
          name: "focus-parent",
          run(ctx) {
            calls.push(ctx.target?.id ?? "none")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "focus-parent" }],
    })

    host.focus(child)

    expect(keymap.getActiveKeys().map((candidate) => candidate.stroke.name)).toEqual(["x"])

    host.press("x")

    expect(calls).toEqual(["parent"])
  })

  test("drops target layers when the host reports target destruction", () => {
    const target = host.rootTarget.append(new FakeTarget("target"))
    const calls: string[] = []

    keymap.registerLayer({
      targetMode: "focus-within",
      target,
      commands: [
        {
          name: "run",
          run() {
            calls.push("run")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "run" }],
    })

    host.focus(target)
    expect(keymap.getActiveKeys().map((candidate) => candidate.stroke.name)).toEqual(["x"])

    host.destroyTarget(target)

    expect(keymap.getActiveKeys()).toEqual([])

    host.press("x")
    expect(calls).toEqual([])
  })

  test("uses the host synthetic command event for runCommand", () => {
    const events: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "run",
          run(ctx) {
            events.push(ctx.event.name)
          },
        },
      ],
    })

    expect(keymap.runCommand("run")).toEqual({ ok: true })
    expect(events).toEqual(["synthetic"])
  })

  test("supports raw input hooks through the host", () => {
    const seen: string[] = []

    keymap.intercept("raw", ({ sequence, stop }) => {
      seen.push(sequence)
      stop()
    })

    expect(host.raw(":write")).toBe(true)
    expect(seen).toEqual([":write"])
  })

  test("keeps command metadata after host destroy but blocks host-backed reads", () => {
    keymap.registerLayer({
      commands: [{ name: "run", run() {} }],
      bindings: [{ key: "x", cmd: "run" }],
    })

    host.destroy()

    expect(keymap.getCommands().map((command) => command.name)).toEqual(["run"])
    expect(() => keymap.getActiveKeys()).toThrow("Cannot use a keymap after its host was destroyed")
  })
})
