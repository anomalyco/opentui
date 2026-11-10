import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { createTestRenderer, type TestRendererOptions } from "@opentui/core/testing"
import { createContext, useContext, useEffect, useMemo, useState } from "react"
import { act, type ReactNode } from "react"
import { createReactSlotRegistry, createSlot, Slot, type ReactPlugin } from "../src/plugins/slot.js"
import { useKeyboard } from "../src/hooks/use-keyboard.js"
import { createRoot, type Root } from "../src/reconciler/renderer.js"

interface AppSlots {
  statusbar: { user: string }
  sidebar: { items: string[] }
}

const hostContext = {
  appName: "react-slot-tests",
  version: "1.0.0",
}

let testSetup: Awaited<ReturnType<typeof createTestRenderer>>

function setIsReactActEnvironment(isReactActEnvironment: boolean) {
  // @ts-expect-error - this is a test environment
  globalThis.IS_REACT_ACT_ENVIRONMENT = isReactActEnvironment
}

async function setupSlotTest(
  createNode: (registry: ReturnType<typeof createReactSlotRegistry<AppSlots>>) => ReactNode,
  options: TestRendererOptions,
) {
  let root: Root | null = null
  setIsReactActEnvironment(true)

  let setup!: Awaited<ReturnType<typeof createTestRenderer>>
  let registry!: ReturnType<typeof createReactSlotRegistry<AppSlots>>

  await act(async () => {
    setup = await createTestRenderer({
      ...options,
      onDestroy() {
        act(() => {
          if (root) {
            root.unmount()
            root = null
          }
        })
        options.onDestroy?.()
        setIsReactActEnvironment(false)
      },
    })

    registry = createReactSlotRegistry<AppSlots>(setup.renderer, hostContext)
    root = createRoot(setup.renderer)
    root.render(createNode(registry))
  })

  return { setup, registry }
}

describe("React Slot System", () => {
  beforeEach(() => {
    if (testSetup) {
      act(() => {
        testSetup.renderer.destroy()
      })
    }
  })

  afterEach(() => {
    if (testSetup) {
      act(() => {
        testSetup.renderer.destroy()
      })
    }
  })

  it("reuses one registry per renderer and rejects different context", async () => {
    const setup = await createTestRenderer({ width: 20, height: 4 })
    testSetup = setup

    const context = { appName: "react-slot-tests", version: "1.0.0" }
    const first = createReactSlotRegistry<AppSlots, typeof context>(setup.renderer, context)
    const second = createReactSlotRegistry<AppSlots, typeof context>(setup.renderer, context)

    expect(first).toBe(second)

    expect(() => {
      createReactSlotRegistry<AppSlots, typeof context>(setup.renderer, { appName: "other", version: "2.0.0" })
    }).toThrow("different context")
  })

  it("renders fallback content when no plugin matches", async () => {
    const { setup } = await setupSlotTest(
      (registry) => {
        const AppSlot = Slot<AppSlots, typeof hostContext>
        return (
          <AppSlot registry={registry} name="statusbar" user="sam">
            <text>fallback-only</text>
          </AppSlot>
        )
      },
      { width: 50, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("fallback-only")
  })

  it("coordinated teardown does not re-remove nodes the renderer already destroyed", async () => {
    // renderer.destroy() destroys the renderable tree and then triggers
    // root.unmount() via onDestroy. React's deletion effects run against
    // already-detached nodes; the host config must treat that as a no-op
    // instead of asking the container to remove non-children.
    const { setup } = await setupSlotTest(
      (registry) => {
        const AppSlot = Slot<AppSlots, typeof hostContext>
        return (
          <AppSlot registry={registry} name="statusbar" user="sam">
            <text>fallback-only</text>
          </AppSlot>
        )
      },
      { width: 50, height: 6 },
    )
    testSetup = setup
    await testSetup.renderOnce()

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      act(() => {
        testSetup.renderer.destroy()
      })
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("appends plugin output after fallback content by default", async () => {
    const plugin: ReactPlugin<AppSlots, typeof hostContext> = {
      id: "append-plugin",
      slots: {
        statusbar(ctx, props) {
          return <text>{`plugin:${ctx.appName}:${props.user}`}</text>
        },
      },
    }

    const { setup, registry } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register(plugin)
        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="ava">
            <text>base-content</text>
          </Slot>
        )
      },
      { width: 60, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("base-content")
    expect(frame).toContain("plugin:react-slot-tests:ava")
  })

  it("replace mode hides fallback and renders all ordered plugins", async () => {
    const { setup, registry } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "late",
          order: 10,
          slots: {
            statusbar() {
              return <text>late-plugin</text>
            },
          },
        })

        slotRegistry.register({
          id: "early",
          order: 0,
          slots: {
            statusbar() {
              return <text>early-plugin</text>
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="lee" mode="replace">
            <text>replace-fallback</text>
          </Slot>
        )
      },
      { width: 40, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("early-plugin")
    expect(frame).toContain("late-plugin")
    expect(frame).not.toContain("replace-fallback")
  })

  it("replace mode does not invoke fallback components when plugin content wins", async () => {
    const fallbackLifecycle: string[] = []

    function FallbackProbe() {
      fallbackLifecycle.push("render")

      useEffect(() => {
        fallbackLifecycle.push("mount")

        return () => {
          fallbackLifecycle.push("cleanup")
        }
      }, [])

      return <text>fallback-probe</text>
    }

    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "replace-plugin",
          slots: {
            statusbar() {
              return <text>plugin-only</text>
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="lee" mode="replace">
            <FallbackProbe />
          </Slot>
        )
      },
      { width: 40, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("plugin-only")
    expect(frame).not.toContain("fallback-probe")
    expect(fallbackLifecycle).toEqual([])
  })

  it("single_winner mode renders only the highest-priority plugin", async () => {
    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "late",
          order: 10,
          slots: {
            statusbar() {
              return <text>late-plugin</text>
            },
          },
        })

        slotRegistry.register({
          id: "early",
          order: 0,
          slots: {
            statusbar() {
              return <text>early-plugin</text>
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="lee" mode="single_winner">
            <text>single-fallback</text>
          </Slot>
        )
      },
      { width: 40, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("early-plugin")
    expect(frame).not.toContain("late-plugin")
    expect(frame).not.toContain("single-fallback")
  })

  it("replace mode keeps healthy plugin output when another plugin fails", async () => {
    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "broken-plugin",
          order: 0,
          slots: {
            statusbar() {
              throw new Error("broken render")
            },
          },
        })

        slotRegistry.register({
          id: "healthy-plugin",
          order: 10,
          slots: {
            statusbar() {
              return <text>healthy-plugin</text>
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="lee" mode="replace">
            <text>replace-fallback</text>
          </Slot>
        )
      },
      { width: 50, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("healthy-plugin")
    expect(frame).not.toContain("replace-fallback")
  })

  it("single_winner mode falls back when highest-priority plugin fails", async () => {
    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "broken-winner",
          order: 0,
          slots: {
            statusbar() {
              throw new Error("winner failed")
            },
          },
        })

        slotRegistry.register({
          id: "healthy-second",
          order: 10,
          slots: {
            statusbar() {
              return <text>healthy-second</text>
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="lee" mode="single_winner">
            <text>single-fallback</text>
          </Slot>
        )
      },
      { width: 50, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("single-fallback")
    expect(frame).not.toContain("healthy-second")
  })

  it("reacts to plugin registration and unregistering", async () => {
    const { setup, registry } = await setupSlotTest(
      (slotRegistry) => {
        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="kai" mode="replace">
            <text>dynamic-fallback</text>
          </Slot>
        )
      },
      { width: 40, height: 6 },
    )
    testSetup = setup

    const plugin: ReactPlugin<AppSlots> = {
      id: "dynamic-plugin",
      slots: {
        statusbar() {
          return <text>dynamic-plugin</text>
        },
      },
    }

    await testSetup.renderOnce()
    expect(testSetup.captureCharFrame()).toContain("dynamic-fallback")

    act(() => {
      registry.register(plugin)
    })
    await testSetup.renderOnce()
    const withPlugin = testSetup.captureCharFrame()
    expect(withPlugin).toContain("dynamic-plugin")
    expect(withPlugin).not.toContain("dynamic-fallback")

    act(() => {
      registry.unregister("dynamic-plugin")
    })
    await testSetup.renderOnce()
    const withoutPlugin = testSetup.captureCharFrame()
    expect(withoutPlugin).toContain("dynamic-fallback")
    expect(withoutPlugin).not.toContain("dynamic-plugin")
  })

  it("switches rendered slot when props.name changes", async () => {
    function DynamicNameHarness({ registry }: { registry: ReturnType<typeof createReactSlotRegistry<AppSlots>> }) {
      const Slot = useMemo(() => createSlot(registry), [registry])
      const [slotName, setSlotName] = useState<keyof AppSlots>("statusbar")

      useKeyboard((key) => {
        if (key.name === "tab") {
          setSlotName((current) => (current === "statusbar" ? "sidebar" : "statusbar"))
        }
      })

      const dynamicProps =
        slotName === "statusbar"
          ? ({ name: "statusbar", user: "sam", mode: "replace" } as const)
          : ({ name: "sidebar", items: ["one"], mode: "replace" } as const)

      return (
        <Slot {...(dynamicProps as any)}>
          <text>dynamic-name-fallback</text>
        </Slot>
      )
    }

    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "status-plugin",
          slots: {
            statusbar() {
              return <text>status-plugin</text>
            },
          },
        })

        slotRegistry.register({
          id: "sidebar-plugin",
          slots: {
            sidebar() {
              return <text>sidebar-plugin</text>
            },
          },
        })

        return <DynamicNameHarness registry={slotRegistry} />
      },
      { width: 60, height: 8 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const initialFrame = testSetup.captureCharFrame()
    expect(initialFrame).toContain("status-plugin")
    expect(initialFrame).not.toContain("sidebar-plugin")

    act(() => {
      testSetup.renderer.keyInput.emit("keypress", { name: "tab" } as any)
    })

    await testSetup.renderOnce()
    const switchedFrame = testSetup.captureCharFrame()
    expect(switchedFrame).toContain("sidebar-plugin")
    expect(switchedFrame).not.toContain("status-plugin")
    expect(switchedFrame).not.toContain("dynamic-name-fallback")
  })

  it("renders plugin nodes within provider context", async () => {
    const ValueContext = createContext("missing")

    function ContextReader() {
      const value = useContext(ValueContext)
      return <text>{`ctx:${value}`}</text>
    }

    const { setup, registry } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "context-plugin",
          slots: {
            statusbar() {
              return <ContextReader />
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <ValueContext.Provider value="inside-provider">
            <Slot name="statusbar" user="max" />
          </ValueContext.Provider>
        )
      },
      { width: 60, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("ctx:inside-provider")
  })

  it("keeps plugin identity stable when append order changes", async () => {
    const mountLog: string[] = []

    function StatefulPluginNode({ pluginId }: { pluginId: string }) {
      const [createdBy] = useState(pluginId)

      useEffect(() => {
        mountLog.push(`mount:${pluginId}:${createdBy}`)
        return () => {
          mountLog.push(`unmount:${pluginId}:${createdBy}`)
        }
      }, [pluginId, createdBy])

      return <text>{`${pluginId}:${createdBy}`}</text>
    }

    const { setup, registry } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "alpha",
          order: 0,
          slots: {
            statusbar() {
              return <StatefulPluginNode pluginId="alpha" />
            },
          },
        })

        slotRegistry.register({
          id: "beta",
          order: 10,
          slots: {
            statusbar() {
              return <StatefulPluginNode pluginId="beta" />
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return <Slot name="statusbar" user="sam" />
      },
      { width: 80, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const beforeReorder = testSetup.captureCharFrame()

    expect(beforeReorder).toContain("alpha:alpha")
    expect(beforeReorder).toContain("beta:beta")

    act(() => {
      registry.updateOrder("beta", -1)
    })

    await testSetup.renderOnce()
    const afterReorder = testSetup.captureCharFrame()

    expect(afterReorder).toContain("beta:beta")
    expect(afterReorder).toContain("alpha:alpha")
    expect(afterReorder).not.toContain("beta:alpha")
    expect(afterReorder).not.toContain("alpha:beta")
    expect(mountLog).toEqual(["mount:alpha:alpha", "mount:beta:beta"])
  })

  it("captures plugin render invocation errors and reports plugin metadata", async () => {
    const errors: string[] = []

    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.onPluginError((event) => {
          errors.push(`${event.pluginId}:${event.slot}:${event.phase}:${event.source}:${event.error.message}`)
        })

        slotRegistry.register({
          id: "broken-plugin",
          slots: {
            statusbar() {
              throw new Error("render failed")
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="sam">
            <text>fallback-visible</text>
          </Slot>
        )
      },
      { width: 70, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("fallback-visible")
    expect(errors).toEqual(["broken-plugin:statusbar:render:react:render failed"])
  })

  it("replace mode falls back when plugin fails and no placeholder is configured", async () => {
    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "broken-plugin",
          slots: {
            statusbar() {
              throw new Error("render failed")
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="sam" mode="replace">
            <text>replace-fallback-visible</text>
          </Slot>
        )
      },
      { width: 70, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("replace-fallback-visible")
  })

  it("replace mode falls back when plugin subtree crashes and no placeholder is configured", async () => {
    const errors: string[] = []

    function ExplodingPluginNode() {
      throw new Error("replace subtree exploded")
    }

    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.onPluginError((event) => {
          errors.push(`${event.pluginId}:${event.slot}:${event.phase}:${event.source}:${event.error.message}`)
        })

        slotRegistry.register({
          id: "replace-exploding-plugin",
          slots: {
            statusbar() {
              return <ExplodingPluginNode />
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="sam" mode="replace">
            <text>replace-safe-fallback</text>
          </Slot>
        )
      },
      { width: 80, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("replace-safe-fallback")
    expect(errors).toContain("replace-exploding-plugin:statusbar:render:react:replace subtree exploded")
  })

  it("reports error_placeholder and keeps fallback when placeholder throws after plugin render error", async () => {
    const errors: string[] = []

    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.onPluginError((event) => {
          errors.push(`${event.pluginId}:${event.slot}:${event.phase}:${event.source}:${event.error.message}`)
        })

        slotRegistry.register({
          id: "broken-plugin",
          slots: {
            statusbar() {
              throw new Error("render failed")
            },
          },
        })

        const Slot = createSlot(slotRegistry, {
          pluginFailurePlaceholder() {
            throw new Error("placeholder failed")
          },
        })

        return (
          <Slot name="statusbar" user="sam">
            <text>fallback-visible</text>
          </Slot>
        )
      },
      { width: 80, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("fallback-visible")
    expect(errors).toContain("broken-plugin:statusbar:render:react:render failed")
    expect(errors).toContain("broken-plugin:statusbar:error_placeholder:react:placeholder failed")
  })

  it("reports error_placeholder and keeps fallback when placeholder throws after subtree crash", async () => {
    const errors: string[] = []

    function ExplodingPluginNode() {
      throw new Error("component exploded")
    }

    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.onPluginError((event) => {
          errors.push(`${event.pluginId}:${event.slot}:${event.phase}:${event.source}:${event.error.message}`)
        })

        slotRegistry.register({
          id: "exploding-plugin",
          slots: {
            statusbar() {
              return <ExplodingPluginNode />
            },
          },
        })

        const Slot = createSlot(slotRegistry, {
          pluginFailurePlaceholder() {
            throw new Error("placeholder crashed")
          },
        })

        return (
          <Slot name="statusbar" user="sam">
            <text>safe-host-content</text>
          </Slot>
        )
      },
      { width: 80, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("safe-host-content")
    expect(errors).toContain("exploding-plugin:statusbar:render:react:component exploded")
    expect(errors).toContain("exploding-plugin:statusbar:error_placeholder:react:placeholder crashed")
  })

  it("catches plugin subtree errors via per-plugin boundary", async () => {
    const errors: string[] = []

    function ExplodingPluginNode() {
      throw new Error("component exploded")
    }

    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.onPluginError((event) => {
          errors.push(`${event.pluginId}:${event.slot}:${event.phase}:${event.error.message}`)
        })

        slotRegistry.register({
          id: "exploding-component-plugin",
          slots: {
            statusbar() {
              return <ExplodingPluginNode />
            },
          },
        })

        const Slot = createSlot(slotRegistry)
        return (
          <Slot name="statusbar" user="sam">
            <text>safe-host-content</text>
          </Slot>
        )
      },
      { width: 80, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("safe-host-content")
    expect(errors).toEqual(["exploding-component-plugin:statusbar:render:component exploded"])
  })

  it("renders optional plugin failure placeholder when configured", async () => {
    const { setup } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "broken-plugin",
          slots: {
            statusbar() {
              throw new Error("render failed")
            },
          },
        })

        const Slot = createSlot(slotRegistry, {
          pluginFailurePlaceholder(failure) {
            return <text>{`plugin-error:${failure.pluginId}:${failure.slot}`}</text>
          },
        })

        return (
          <Slot name="statusbar" user="sam">
            <text>fallback-visible</text>
          </Slot>
        )
      },
      { width: 80, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("fallback-visible")
    expect(frame).toContain("plugin-error:broken-plugin:statusbar")
  })

  it("does not continuously emit plugin errors after pressing e then d", async () => {
    const debugEvents: string[] = []
    let pluginErrorEventCount = 0
    let listenerStateUpdates = 0
    const maxListenerStateUpdates = 20

    function ClockCrashNode() {
      throw new Error("Forced subtree crash in clock-plugin")
    }

    function createClockPlugin(crash: boolean): ReactPlugin<AppSlots, typeof hostContext> {
      return {
        id: "clock-plugin",
        order: 0,
        slots: {
          statusbar() {
            if (crash) {
              return <ClockCrashNode />
            }

            return <text>clock-ok</text>
          },
          sidebar() {
            return <text>clock-sidebar-ok</text>
          },
        },
      }
    }

    function createActivityPlugin(crash: boolean): ReactPlugin<AppSlots, typeof hostContext> {
      return {
        id: "activity-plugin",
        order: 10,
        slots: {
          statusbar() {
            if (crash) {
              throw new Error("Forced activity render failure")
            }

            return <text>activity-ok</text>
          },
        },
      }
    }

    function ErrorSequenceHarness({ registry }: { registry: ReturnType<typeof createReactSlotRegistry<AppSlots>> }) {
      const Slot = useMemo(
        () =>
          createSlot(registry, {
            pluginFailurePlaceholder(failure) {
              return <text>{`placeholder:${failure.pluginId}:${failure.phase}`}</text>
            },
          }),
        [registry],
      )

      const [clockCrashEnabled, setClockCrashEnabled] = useState(false)
      const [activityCrashEnabled, setActivityCrashEnabled] = useState(false)
      const [errorLines, setErrorLines] = useState<string[]>([])

      useEffect(() => {
        return registry.onPluginError((event) => {
          pluginErrorEventCount++
          const line = `${event.pluginId}:${event.phase}:${event.source}:${event.error.message}`

          if (debugEvents.length < 40) {
            debugEvents.push(`event#${pluginErrorEventCount} ${line}`)
          }

          if (listenerStateUpdates < maxListenerStateUpdates) {
            listenerStateUpdates++
            setErrorLines((current) => [line, ...current].slice(0, 6))
          }
        })
      }, [registry])

      useEffect(() => {
        const unregisterCallbacks: Array<() => void> = []

        unregisterCallbacks.push(registry.register(createClockPlugin(clockCrashEnabled)))
        unregisterCallbacks.push(registry.register(createActivityPlugin(activityCrashEnabled)))

        return () => {
          for (const unregister of unregisterCallbacks.reverse()) {
            unregister()
          }
        }
      }, [registry, clockCrashEnabled, activityCrashEnabled])

      useKeyboard((key) => {
        if (key.name === "e") {
          setClockCrashEnabled((current) => !current)
          return
        }

        if (key.name === "d") {
          setActivityCrashEnabled((current) => !current)
        }
      })

      return (
        <>
          <Slot name="statusbar" user="sam" mode="append">
            <text>fallback-statusbar</text>
          </Slot>
          <Slot name="sidebar" items={["x"]} mode="replace">
            <text>fallback-sidebar</text>
          </Slot>
          <text>{`errors:${errorLines.length}`}</text>
        </>
      )
    }

    const { setup } = await setupSlotTest((registry) => <ErrorSequenceHarness registry={registry} />, {
      width: 80,
      height: 10,
    })
    testSetup = setup

    await testSetup.renderOnce()

    act(() => {
      testSetup.renderer.keyInput.emit("keypress", { name: "e" } as any)
    })
    await testSetup.renderOnce()

    act(() => {
      testSetup.renderer.keyInput.emit("keypress", { name: "d" } as any)
    })

    for (let index = 0; index < 5; index++) {
      await testSetup.renderOnce()
    }

    const frame = testSetup.captureCharFrame()
    if (pluginErrorEventCount > 4 || listenerStateUpdates > 4) {
      console.log("[react-slot-debug] frame after e,d:\n" + frame)
      console.log("[react-slot-debug] plugin error events:", pluginErrorEventCount)
      console.log("[react-slot-debug] listener state updates:", listenerStateUpdates)
      console.log("[react-slot-debug] sample events:\n" + debugEvents.join("\n"))
    }

    expect(pluginErrorEventCount).toBeLessThanOrEqual(4)
    expect(listenerStateUpdates).toBeLessThanOrEqual(4)
  })
})
