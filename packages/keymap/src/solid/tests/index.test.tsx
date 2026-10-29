import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Renderable } from "@opentui/core"
import { createTestRenderer, type TestRendererOptions } from "@opentui/core/testing"
import * as addons from "@opentui/keymap/addons"
import { KEYMAP_EXTENSION_CONTEXT, stringifyKeySequence } from "@opentui/keymap"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import {
  KeymapProvider,
  reactiveMatcherFromSignal,
  useBindings,
  useKeymap,
  useKeymapSelector,
} from "@opentui/keymap/solid"
import { render, type JSX } from "@opentui/solid"
import { Show, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { formatCommandBindings } from "@opentui/keymap/extras"
import { createDiagnosticHarness } from "../../tests/diagnostic-harness.js"

const diagnostics = createDiagnosticHarness()

async function testRender(node: () => JSX.Element, renderConfig: TestRendererOptions = {}) {
  const testSetup = await createTestRenderer({
    ...renderConfig,
    onDestroy: () => {
      renderConfig.onDestroy?.()
    },
  })

  const keymap = diagnostics.trackKeymap(createDefaultOpenTuiKeymap(testSetup.renderer))
  await render(() => <KeymapProvider keymap={keymap}>{node()}</KeymapProvider>, testSetup.renderer)

  return testSetup
}

let testSetup: Awaited<ReturnType<typeof testRender>>

describe("solid keymap hooks", () => {
  beforeEach(async () => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("useKeymap returns the provided keymap", async () => {
    let first: ReturnType<typeof useKeymap> | undefined
    let second: ReturnType<typeof useKeymap> | undefined

    function Probe() {
      first = useKeymap()
      second = useKeymap()

      return <box width={10} height={4} />
    }

    testSetup = await testRender(() => <Probe />, { width: 20, height: 6 })

    expect(first).toBeDefined()
    expect(second).toBe(first)
  })

  test("useBindings registers global bindings and cleans them up on unmount", async () => {
    const calls: string[] = []
    let setVisible!: (value: boolean) => void

    function GlobalBindings() {
      const manager = useKeymap()
      const offCommands = manager.registerLayer({
        commands: [
          {
            name: "global",
            run() {
              calls.push("global")
            },
          },
        ],
      })

      useBindings(() => ({
        bindings: [{ key: "x", cmd: "global" }],
      }))

      onCleanup(() => {
        offCommands()
      })

      return <text>bindings</text>
    }

    function App() {
      const [visible, setVisibleSignal] = createSignal(true)
      setVisible = setVisibleSignal

      return (
        <box width={20} height={6}>
          <Show when={visible()}>
            <GlobalBindings />
          </Show>
        </box>
      )
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6 })

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["global"])

    setVisible(false)
    await Bun.sleep(0)

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["global"])
  })

  test("inline useBindings layer objects do not re-register on Solid reactive updates", async () => {
    let setTick!: (value: number) => void
    let registerCalls = 0

    function App() {
      const manager = useKeymap()
      const [tick, setTickSignal] = createSignal(0)
      setTick = setTickSignal

      const offCommands = manager.registerLayer({ commands: [{ name: "probe", run() {} }] })
      const layers = manager[KEYMAP_EXTENSION_CONTEXT]().layers
      const original = layers.replaceLayer
      layers.replaceLayer = (slot, layer) => {
        registerCalls += 1
        return original(slot, layer)
      }

      useBindings(() => ({
        bindings: [{ key: "x", cmd: "probe" }],
      }))

      onCleanup(() => {
        layers.replaceLayer = original
        offCommands()
      })

      return <text>{tick()}</text>
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6 })

    expect(registerCalls).toBe(1)

    setTick(1)
    await Bun.sleep(0)

    expect(registerCalls).toBe(1)
  })

  test("useBindings updates that leave layers unchanged do not rerun keymap selectors", async () => {
    const [tick, setTick] = createSignal(0)
    const [key, setKey] = createSignal("x")
    let selectorRuns = 0

    function App() {
      for (const name of ["first", "second", "third"]) {
        useBindings(() => {
          tick()
          return { commands: [{ name, run() {} }], bindings: [{ key: name === "first" ? key() : "y", cmd: name }] }
        })
      }

      const entries = useKeymapSelector((keymap) => {
        selectorRuns += 1
        return keymap.getCommandEntries()
      })

      return <text>{`${entries().length}`}</text>
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6 })
    const runs = [selectorRuns]

    setTick(1)
    await Bun.sleep(0)
    runs.push(selectorRuns)

    setKey("z")
    await Bun.sleep(0)
    runs.push(selectorRuns)

    expect(runs.map((count) => count - runs[0]!)).toEqual([0, 0, 1])
  })

  test("useBindings layers built from a Solid store follow store changes", async () => {
    const calls: string[] = []
    const [store, setStore] = createStore({
      spread: { name: "spread", title: "one", run: () => void calls.push("spread one") },
      proxy: { name: "proxy", title: "one", run: () => void calls.push("proxy one") },
      keys: { spread: "x", proxy: "y" },
    })
    let labels!: () => string

    function App() {
      // A plain copy of store data, and the store proxy itself, which is not plain data.
      useBindings(() => ({ commands: [{ ...store.spread }], bindings: [{ key: store.keys.spread, cmd: "spread" }] }))
      useBindings(() => ({ commands: [store.proxy], bindings: [{ key: store.keys.proxy, cmd: "proxy" }] }))
      labels = useKeymapSelector((keymap) =>
        keymap
          .getCommandEntries()
          .map(({ command, bindings }) => `${command.name}:${command.title}:${formatCommandBindings(bindings)}`)
          .sort()
          .join(" "),
      )
      return <text>{labels()}</text>
    }

    testSetup = await testRender(() => <App />, { width: 40, height: 6 })
    const seen = [labels()]
    setStore("spread", "title", "two")
    setStore("proxy", "title", "two")
    setStore("keys", "spread", "z")
    await Bun.sleep(0)
    seen.push(labels())
    setStore("spread", "run", () => () => void calls.push("spread two"))
    setStore("proxy", "run", () => () => void calls.push("proxy two"))
    await Bun.sleep(0)
    testSetup.mockInput.pressKey("z")
    testSetup.mockInput.pressKey("y")

    expect(seen).toEqual(["proxy:one:y spread:one:x", "proxy:two:y spread:two:z"])
    expect(calls).toEqual(["spread two", "proxy two"])
  })

  test("useBindings supports declarative release bindings", async () => {
    const calls: string[] = []

    function App() {
      const manager = useKeymap()
      const activeKeys = useKeymapSelector((keymap) => keymap.getActiveKeys())
      const offCommands = manager.registerLayer({
        commands: [
          {
            name: "release-command",
            run() {
              calls.push("release")
            },
          },
          {
            name: "press-command",
            run() {
              calls.push("press")
            },
          },
        ],
      })

      useBindings(() => ({
        bindings: [
          { key: "a", cmd: "release-command", event: "release" },
          { key: "b", cmd: "press-command" },
        ],
      }))

      onCleanup(() => {
        offCommands()
      })

      return (
        <text>{`Active: ${
          activeKeys()
            .map((key) => key.stroke.name)
            .join(",") || "<none>"
        }`}</text>
      )
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6, kittyKeyboard: true })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Active: b")

    testSetup.mockInput.pressKey("a")
    expect(calls).toEqual([])

    testSetup.renderer.stdin.emit("data", Buffer.from("\x1b[97;1:3u"))
    expect(calls).toEqual(["release"])

    testSetup.mockInput.pressKey("b")
    expect(calls).toEqual(["release", "press"])
  })

  test("useKeymapSelector updates on focus changes and direct blur", async () => {
    let firstTarget!: Renderable
    let secondTarget!: Renderable

    function App() {
      const manager = useKeymap()
      const [firstBindingTarget, setFirstBindingTarget] = createSignal<Renderable | undefined>(undefined)
      const [secondBindingTarget, setSecondBindingTarget] = createSignal<Renderable | undefined>(undefined)
      const activeKeys = useKeymapSelector((keymap) => keymap.getActiveKeys())
      const offCommands = manager.registerLayer({
        commands: [
          { name: "first", run() {} },
          { name: "second", run() {} },
        ],
      })

      useBindings(() => ({
        targetMode: "focus-within",
        target: firstBindingTarget,
        bindings: [{ key: "x", cmd: "first" }],
      }))
      useBindings(() => ({
        targetMode: "focus-within",
        target: secondBindingTarget,
        bindings: [{ key: "y", cmd: "second" }],
      }))

      onCleanup(() => {
        offCommands()
      })

      return (
        <box width={24} height={8} flexDirection="column">
          <text>{`Active: ${
            activeKeys()
              .map((key) => key.stroke.name)
              .join(",") || "<none>"
          }`}</text>
          <box
            ref={(value: Renderable) => {
              setFirstBindingTarget(value)
              firstTarget = value
            }}
            width={8}
            height={2}
            focusable
            focused
          />
          <box
            ref={(value: Renderable) => {
              setSecondBindingTarget(value)
              secondTarget = value
            }}
            width={8}
            height={2}
            focusable
          />
        </box>
      )
    }

    testSetup = await testRender(() => <App />, { width: 24, height: 8 })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Active: x")

    secondTarget.focus()
    await Bun.sleep(0)
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Active: y")

    secondTarget.blur()
    await Bun.sleep(0)
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Active: <none>")
  })

  test("useKeymapSelector can project the pending sequence", async () => {
    function App() {
      const manager = useKeymap()
      const pendingSequence = useKeymapSelector((keymap) => keymap.getPendingSequence())
      const offCommands = manager.registerLayer({ commands: [{ name: "delete-line", run() {} }] })

      useBindings(() => ({
        bindings: [{ key: "dd", cmd: "delete-line" }],
      }))

      onCleanup(() => {
        offCommands()
      })

      return <text>{`Pending: ${stringifyKeySequence(pendingSequence(), { preferDisplay: true }) || "<root>"}`}</text>
    }

    testSetup = await testRender(() => <App />, { width: 24, height: 6 })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Pending: <root>")

    testSetup.mockInput.pressKey("d")
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Pending: d")

    testSetup.mockInput.pressKey("x")
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Pending: <root>")
  })

  test("useBindings can bind local bindings through a target accessor", async () => {
    const calls: string[] = []
    let setActive!: (value: "first" | "second") => void

    function App() {
      const manager = useKeymap()
      const [active, setActiveSignal] = createSignal<"first" | "second">("first")
      const [target, setTarget] = createSignal<Renderable | undefined>(undefined)
      setActive = setActiveSignal

      const offCommands = manager.registerLayer({
        commands: [
          {
            name: "target",
            run() {
              calls.push("target")
            },
          },
        ],
      })

      onCleanup(() => {
        offCommands()
      })

      useBindings(() => ({
        targetMode: "focus-within",
        target,
        bindings: [{ key: "x", cmd: "target" }],
      }))

      return (
        <box width={20} height={6}>
          <box ref={setTarget} width={8} height={3} focusable focused={active() === "first"} />
          <box width={8} height={3} focusable focused={active() === "second"} />
        </box>
      )
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6 })

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["target"])

    setActive("second")
    await Bun.sleep(0)

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["target"])
  })

  test("useBindings can reactively enable layers with a Solid signal", async () => {
    const calls: string[] = []
    let setEnabled!: (value: boolean) => void

    function App() {
      const manager = useKeymap()
      const [enabled, setEnabledSignal] = createSignal(false)
      setEnabled = setEnabledSignal

      const offCommands = manager.registerLayer({
        commands: [
          {
            name: "reactive",
            run() {
              calls.push("reactive")
            },
          },
        ],
      })

      useBindings(() => ({
        enabled: reactiveMatcherFromSignal(enabled),
        bindings: [{ key: "x", cmd: "reactive" }],
      }))

      onCleanup(() => {
        offCommands()
      })

      return <box width={20} height={6} />
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6 })

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual([])

    setEnabled(true)
    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["reactive"])

    setEnabled(false)
    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["reactive"])
  })

  test("useBindings rejects local bindings without a target accessor", async () => {
    function App() {
      useBindings(() => ({
        targetMode: "focus-within",
        bindings: [{ key: "x", cmd: "target" }],
      }))

      return <text>bindings</text>
    }

    await expect(
      testRender(() => <App />, {
        width: 20,
        height: 6,
      }),
    ).rejects.toThrow("useBindings local bindings need a target accessor")
  })

  test("useBindings can wait for an explicit reactive target to become available", async () => {
    const calls: string[] = []
    let setVisible!: (value: boolean) => void

    function App() {
      const manager = useKeymap()
      const [visible, setVisibleSignal] = createSignal(false)
      const [target, setTarget] = createSignal<Renderable | undefined>(undefined)
      setVisible = setVisibleSignal

      const offCommands = manager.registerLayer({
        commands: [
          {
            name: "target",
            run() {
              calls.push("target")
            },
          },
        ],
      })

      useBindings<Renderable>(() => ({
        targetMode: "focus-within",
        target,
        bindings: [{ key: "x", cmd: "target" }],
      }))

      onCleanup(() => {
        offCommands()
      })

      return (
        <box width={20} height={6}>
          <Show when={visible()}>{() => <box ref={setTarget} width={8} height={3} focusable focused />}</Show>
        </box>
      )
    }

    testSetup = await testRender(() => <App />, {
      width: 20,
      height: 6,
    })

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual([])

    setVisible(true)
    await Bun.sleep(0)

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["target"])
  })

  test("timed leader exposes root and mounted dialog continuations together", async () => {
    const calls: string[] = []
    let setDialogOpen!: (value: boolean) => void

    let offLeader: (() => void) | undefined
    testSetup = await createTestRenderer({
      width: 80,
      height: 10,
      onDestroy() {
        offLeader?.()
      },
    })

    const keymap = diagnostics.trackKeymap(createDefaultOpenTuiKeymap(testSetup.renderer))
    offLeader = addons.registerTimedLeader(keymap, {
      trigger: { name: "x", ctrl: true },
      timeoutMs: 1_000,
    })

    function Dialog() {
      const [target, setTarget] = createSignal<Renderable | undefined>(undefined)

      useBindings<Renderable>(() => ({
        targetMode: "focus-within",
        target,
        commands: [
          {
            name: "dialog-delete",
            run() {
              calls.push("dialog-delete")
            },
          },
          {
            name: "dialog-write",
            run() {
              calls.push("dialog-write")
            },
          },
        ],
        bindings: [
          { key: "<leader>d", cmd: "dialog-delete", desc: "dialog-delete" },
          { key: "<leader>w", cmd: "dialog-write", desc: "dialog-write" },
        ],
      }))

      return <box id="dialog" ref={setTarget} width={24} height={3} focusable border />
    }

    function App() {
      const [dialogOpen, setDialogOpenSignal] = createSignal(true)
      setDialogOpen = setDialogOpenSignal

      useBindings(() => ({
        commands: [
          {
            name: "root-refresh",
            run() {
              calls.push("root-refresh")
            },
          },
          {
            name: "root-save",
            run() {
              calls.push("root-save")
            },
          },
        ],
        bindings: [
          { key: "<leader>r", cmd: "root-refresh", desc: "root-refresh" },
          { key: "<leader>s", cmd: "root-save", desc: "root-save" },
        ],
      }))

      return (
        <box width={80} height={10} flexDirection="column">
          <text>{`Dialog: ${dialogOpen() ? "open" : "closed"}`}</text>
          <Show when={dialogOpen()}>{() => <Dialog />}</Show>
        </box>
      )
    }

    await render(
      () => (
        <KeymapProvider keymap={keymap}>
          <App />
        </KeymapProvider>
      ),
      testSetup.renderer,
    )

    const flush = async () => {
      await Bun.sleep(0)
      await testSetup.renderOnce()
    }
    const getPending = () => stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true }) || "<root>"
    const getActive = () => {
      return (
        keymap
          .getActiveKeys({ includeMetadata: true })
          .map((activeKey) => `${activeKey.display}=${String(activeKey.bindingAttrs?.desc ?? activeKey.command ?? "")}`)
          .sort()
          .join(",") || "<none>"
      )
    }

    await flush()
    let frame = testSetup.captureCharFrame()
    expect(frame).toContain("Dialog: open")
    expect(getPending()).toBe("<root>")

    testSetup.renderer.root.findDescendantById("dialog")?.focus()
    await flush()

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()
    expect(getPending()).toBe("<leader>")
    expect(getActive()).toBe("d=dialog-delete,r=root-refresh,s=root-save,w=dialog-write")

    testSetup.mockInput.pressKey("r")
    await flush()
    expect(getPending()).toBe("<root>")
    expect(calls).toEqual(["root-refresh"])

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()
    testSetup.mockInput.pressKey("w")
    await flush()
    expect(calls).toEqual(["root-refresh", "dialog-write"])

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()
    testSetup.mockInput.pressKey("d")
    await flush()
    expect(calls).toEqual(["root-refresh", "dialog-write", "dialog-delete"])

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()
    testSetup.mockInput.pressKey("s")
    await flush()
    expect(calls).toEqual(["root-refresh", "dialog-write", "dialog-delete", "root-save"])

    setDialogOpen(false)
    await flush()
    frame = testSetup.captureCharFrame()
    expect(frame).toContain("Dialog: closed")

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()
    expect(getPending()).toBe("<leader>")
    expect(getActive()).toBe("r=root-refresh,s=root-save")

    testSetup.mockInput.pressKey("w")
    await flush()
    expect(calls).toEqual(["root-refresh", "dialog-write", "dialog-delete", "root-save"])
  })

  test("timed leader resolves root bindings when global commands live on a separate layer", async () => {
    const calls: string[] = []
    let setDialogOpen!: (value: boolean) => void

    let offLeader: (() => void) | undefined
    testSetup = await createTestRenderer({
      width: 80,
      height: 10,
      onDestroy() {
        offLeader?.()
      },
    })

    const keymap = diagnostics.trackKeymap(createDefaultOpenTuiKeymap(testSetup.renderer))
    offLeader = addons.registerTimedLeader(keymap, {
      trigger: { name: "x", ctrl: true },
      timeoutMs: 1_000,
    })

    function Dialog() {
      const [target, setTarget] = createSignal<Renderable | undefined>(undefined)

      useBindings<Renderable>(() => ({
        targetMode: "focus-within",
        target,
        commands: [
          {
            name: "dialog-delete",
            run() {
              calls.push("dialog-delete")
            },
          },
          {
            name: "dialog-write",
            run() {
              calls.push("dialog-write")
            },
          },
        ],
        bindings: [
          { key: "<leader>d", cmd: "dialog-delete", desc: "dialog-delete" },
          { key: "<leader>w", cmd: "dialog-write", desc: "dialog-write" },
        ],
      }))

      return <box id="dialog" ref={setTarget} width={24} height={3} focusable border />
    }

    function App() {
      const [dialogOpen, setDialogOpenSignal] = createSignal(true)
      setDialogOpen = setDialogOpenSignal

      useBindings(() => ({
        commands: [
          {
            name: "root-refresh",
            run() {
              calls.push("root-refresh")
            },
          },
          {
            name: "root-save",
            run() {
              calls.push("root-save")
            },
          },
        ],
      }))

      useBindings(() => ({
        bindings: [
          { key: "<leader>r", cmd: "root-refresh", desc: "root-refresh" },
          { key: "<leader>s", cmd: "root-save", desc: "root-save" },
        ],
      }))

      return (
        <box width={80} height={10} flexDirection="column">
          <text>{`Dialog: ${dialogOpen() ? "open" : "closed"}`}</text>
          <Show when={dialogOpen()}>{() => <Dialog />}</Show>
        </box>
      )
    }

    await render(
      () => (
        <KeymapProvider keymap={keymap}>
          <App />
        </KeymapProvider>
      ),
      testSetup.renderer,
    )

    const flush = async () => {
      await Bun.sleep(0)
      await testSetup.renderOnce()
    }
    const getPending = () => stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true }) || "<root>"
    const getActive = () => {
      return (
        keymap
          .getActiveKeys({ includeMetadata: true })
          .map((activeKey) => `${activeKey.display}=${String(activeKey.bindingAttrs?.desc ?? activeKey.command ?? "")}`)
          .sort()
          .join(",") || "<none>"
      )
    }

    await flush()
    let frame = testSetup.captureCharFrame()
    expect(frame).toContain("Dialog: open")
    expect(getPending()).toBe("<root>")

    testSetup.renderer.root.findDescendantById("dialog")?.focus()
    await flush()

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()
    expect(getPending()).toBe("<leader>")
    expect(getActive()).toBe("d=dialog-delete,r=root-refresh,s=root-save,w=dialog-write")

    testSetup.mockInput.pressKey("r")
    await flush()
    expect(getPending()).toBe("<root>")
    expect(calls).toEqual(["root-refresh"])

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()
    testSetup.mockInput.pressKey("w")
    await flush()
    expect(calls).toEqual(["root-refresh", "dialog-write"])

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()
    testSetup.mockInput.pressKey("d")
    await flush()
    expect(calls).toEqual(["root-refresh", "dialog-write", "dialog-delete"])

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()
    testSetup.mockInput.pressKey("s")
    await flush()
    expect(calls).toEqual(["root-refresh", "dialog-write", "dialog-delete", "root-save"])

    setDialogOpen(false)
    await flush()
    frame = testSetup.captureCharFrame()
    expect(frame).toContain("Dialog: closed")

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()
    expect(getPending()).toBe("<leader>")
    expect(getActive()).toBe("r=root-refresh,s=root-save")

    testSetup.mockInput.pressKey("w")
    await flush()
    expect(calls).toEqual(["root-refresh", "dialog-write", "dialog-delete", "root-save"])
  })

  test("reactiveMatcherFromSignal: coerces accessor value and re-evaluates on signal change", async () => {
    const calls: string[] = []
    let setEnabled!: (value: boolean) => void

    function App() {
      const manager = useKeymap()
      const offCommands = manager.registerLayer({
        commands: [
          {
            name: "guarded",
            run() {
              calls.push("guarded")
            },
          },
        ],
      })
      onCleanup(offCommands)

      const [enabled, setter] = createSignal(false)
      setEnabled = setter

      useBindings(() => ({
        enabled: reactiveMatcherFromSignal(enabled),
        bindings: [{ key: "x", cmd: "guarded" }],
      }))

      return <text>reactive</text>
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6 })

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual([])

    setEnabled(true)
    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["guarded"])

    setEnabled(false)
    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["guarded"])
  })

  test("reactiveMatcherFromSignal: disposes reactive scope on layer unregister", async () => {
    let unmount!: () => void
    let setEnabled!: (value: boolean) => void
    const evaluations: number[] = []

    function Child() {
      const [enabled, setter] = createSignal(false)
      setEnabled = setter

      const matcher = reactiveMatcherFromSignal(() => {
        const value = enabled()
        evaluations.push(evaluations.length)
        return value
      })

      useBindings(() => ({
        enabled: matcher,
        bindings: [{ key: "x", cmd: "probe" }],
      }))

      return <text>child</text>
    }

    function App() {
      const [mounted, setMounted] = createSignal(true)
      unmount = () => setMounted(false)

      const manager = useKeymap()
      const offCommands = manager.registerLayer({ commands: [{ name: "probe", run() {} }] })
      onCleanup(offCommands)

      return <Show when={mounted()}>{() => <Child />}</Show>
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6 })

    setEnabled(true)
    const evaluationsBeforeUnmount = evaluations.length
    expect(evaluationsBeforeUnmount).toBeGreaterThan(0)

    // After unmount, signal changes must not re-evaluate the matcher.
    unmount()

    setEnabled(false)
    setEnabled(true)

    expect(evaluations.length).toBe(evaluationsBeforeUnmount)
  })

  test("reactiveMatcherFromSignal: applies predicate when signal value is not boolean", async () => {
    const calls: string[] = []
    let setMode!: (value: "normal" | "visual") => void

    function App() {
      const manager = useKeymap()
      const offCommands = manager.registerLayer({
        commands: [
          {
            name: "normal-only",
            run() {
              calls.push("normal")
            },
          },
        ],
      })
      onCleanup(offCommands)

      const [mode, setter] = createSignal<"normal" | "visual">("visual")
      setMode = setter

      useBindings(() => ({
        enabled: reactiveMatcherFromSignal(mode, (value) => value === "normal"),
        bindings: [{ key: "x", cmd: "normal-only" }],
      }))

      return <text>mode</text>
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6 })

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual([])

    setMode("normal")
    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["normal"])

    setMode("visual")
    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["normal"])
  })
})
