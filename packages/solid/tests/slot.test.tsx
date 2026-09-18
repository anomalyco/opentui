import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { BoxRenderable, Renderable } from "@opentui/core"
import { createTestRenderer, type TestRendererOptions } from "@opentui/core/testing"
import { createContext, createComponent, createSignal, onCleanup, onMount, useContext, type JSX } from "solid-js"
import { createSlot, createSolidSlotRegistry, Slot, type SolidPlugin } from "../src/plugins/slot.js"
import { _render as renderInternal } from "../src/reconciler.js"
import { RendererContext } from "../src/elements/index.js"
import { SlotRenderable } from "../src/elements/slot.js"

interface AppSlots {
  statusbar: { user: string }
  sidebar: { items: string[] }
}

const hostContext = {
  appName: "solid-slot-tests",
  version: "1.0.0",
}

let testSetup: Awaited<ReturnType<typeof createTestRenderer>>

async function setupSlotTest(
  createNode: (registry: ReturnType<typeof createSolidSlotRegistry<AppSlots>>) => JSX.Element,
  options: TestRendererOptions,
) {
  let isDisposed = false
  let dispose: (() => void) | undefined

  const setup = await createTestRenderer({
    ...options,
    onDestroy: () => {
      if (!isDisposed) {
        isDisposed = true
        dispose?.()
      }
      options.onDestroy?.()
    },
  })

  const registry = createSolidSlotRegistry<AppSlots>(setup.renderer, hostContext)

  dispose = renderInternal(
    () =>
      createComponent(RendererContext.Provider, {
        get value() {
          return setup.renderer
        },
        get children() {
          return createNode(registry)
        },
      }),
    setup.renderer.root,
  )

  return { setup, registry }
}

describe("Solid Slot System", () => {
  beforeEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  it("creates hidden layout placeholders owned by the parent context", async () => {
    testSetup = await createTestRenderer({ width: 20, height: 4 })
    const parent = testSetup.renderer.root
    const slot = new SlotRenderable("factory-slot")
    const child = slot.getSlotChild(parent)
    expect(child).toBeInstanceOf(Renderable)
    expect((child as Renderable).ctx).toBe(parent.ctx)
    expect(child.visible).toBe(false)
    parent.add(child)
    await testSetup.renderOnce()
    expect((child as Renderable).getLayout().height).toBe(0)
    slot.destroy()
    expect(child.parent).toBeNull()
    expect((child as Renderable).isDestroyed).toBe(true)
  })

  it("reuses a detached layout placeholder within its scene", async () => {
    testSetup = await createTestRenderer({ width: 20, height: 4 })
    const parentA = new BoxRenderable(testSetup.renderer, {})
    const parentB = new BoxRenderable(testSetup.renderer, {})
    testSetup.renderer.root.add(parentA)
    testSetup.renderer.root.add(parentB)
    const slot = new SlotRenderable("moving-slot")
    const firstChild = slot.getSlotChild(parentA)
    parentA.add(firstChild)
    parentA.remove(firstChild)
    const secondChild = slot.getSlotChild(parentB)
    expect(secondChild).toBe(firstChild)
    parentB.add(secondChild)
    await testSetup.renderOnce()
    expect(secondChild.parent).toBe(parentB)
    expect(secondChild.visible).toBe(false)
    slot.destroy()
    expect(parentB.getChildren()).toHaveLength(0)
    expect((secondChild as Renderable).isDestroyed).toBe(true)
  })

  it("reuses one registry per renderer and rejects different context", async () => {
    const setup = await createTestRenderer({ width: 20, height: 4 })
    testSetup = setup

    const context = { appName: "solid-slot-tests", version: "1.0.0" }
    const first = createSolidSlotRegistry<AppSlots, typeof context>(setup.renderer, context)
    const second = createSolidSlotRegistry<AppSlots, typeof context>(setup.renderer, context)

    expect(first).toBe(second)

    expect(() => {
      createSolidSlotRegistry<AppSlots, typeof context>(setup.renderer, { appName: "other", version: "2.0.0" })
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

  it("appends plugin output after fallback content by default", async () => {
    const plugin: SolidPlugin<AppSlots, typeof hostContext> = {
      id: "append-plugin",
      slots: {
        statusbar(ctx, props) {
          return <text>{`plugin:${ctx.appName}:${props.user}`}</text>
        },
      },
    }

    const { setup } = await setupSlotTest(
      (registry) => {
        registry.register(plugin)
        const Slot = createSlot(registry)
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
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("base-content")
    expect(frame).toContain("plugin:solid-slot-tests:ava")
  })

  it("replace mode hides fallback and renders all ordered plugins", async () => {
    const { setup } = await setupSlotTest(
      (registry) => {
        registry.register({
          id: "late",
          order: 10,
          slots: {
            statusbar() {
              return <text>late-plugin</text>
            },
          },
        })

        registry.register({
          id: "early",
          order: 0,
          slots: {
            statusbar() {
              return <text>early-plugin</text>
            },
          },
        })

        const Slot = createSlot(registry)
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

    const FallbackProbe = () => {
      fallbackLifecycle.push("render")

      onMount(() => {
        fallbackLifecycle.push("mount")
      })

      onCleanup(() => {
        fallbackLifecycle.push("cleanup")
      })

      return <text>fallback-probe</text>
    }

    const { setup } = await setupSlotTest(
      (registry) => {
        registry.register({
          id: "replace-plugin",
          slots: {
            statusbar() {
              return <text>plugin-only</text>
            },
          },
        })

        const Slot = createSlot(registry)
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

  it("replace mode mounts winning plugin content once", async () => {
    const pluginLifecycle: string[] = []

    const PluginProbe = () => {
      onMount(() => {
        pluginLifecycle.push("mount")
      })

      onCleanup(() => {
        pluginLifecycle.push("cleanup")
      })

      return <text>plugin-probe</text>
    }

    const { setup } = await setupSlotTest(
      (registry) => {
        registry.register({
          id: "replace-plugin-probe",
          slots: {
            statusbar() {
              return <PluginProbe />
            },
          },
        })

        const Slot = createSlot(registry)
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

    expect(frame).toContain("plugin-probe")
    expect(frame).not.toContain("replace-fallback")
    expect(pluginLifecycle).toEqual(["mount"])
  })

  it("single_winner mode renders only the highest-priority plugin", async () => {
    const { setup } = await setupSlotTest(
      (registry) => {
        registry.register({
          id: "late",
          order: 10,
          slots: {
            statusbar() {
              return <text>late-plugin</text>
            },
          },
        })

        registry.register({
          id: "early",
          order: 0,
          slots: {
            statusbar() {
              return <text>early-plugin</text>
            },
          },
        })

        const Slot = createSlot(registry)
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
      (registry) => {
        registry.register({
          id: "broken-plugin",
          order: 0,
          slots: {
            statusbar() {
              throw new Error("broken render")
            },
          },
        })

        registry.register({
          id: "healthy-plugin",
          order: 10,
          slots: {
            statusbar() {
              return <text>healthy-plugin</text>
            },
          },
        })

        const Slot = createSlot(registry)
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
      (registry) => {
        registry.register({
          id: "broken-winner",
          order: 0,
          slots: {
            statusbar() {
              throw new Error("winner failed")
            },
          },
        })

        registry.register({
          id: "healthy-second",
          order: 10,
          slots: {
            statusbar() {
              return <text>healthy-second</text>
            },
          },
        })

        const Slot = createSlot(registry)
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

    const plugin: SolidPlugin<AppSlots> = {
      id: "dynamic-plugin",
      slots: {
        statusbar() {
          return <text>dynamic-plugin</text>
        },
      },
    }

    await testSetup.renderOnce()
    expect(testSetup.captureCharFrame()).toContain("dynamic-fallback")

    registry.register(plugin)
    await testSetup.renderOnce()
    const withPlugin = testSetup.captureCharFrame()
    expect(withPlugin).toContain("dynamic-plugin")
    expect(withPlugin).not.toContain("dynamic-fallback")

    registry.unregister("dynamic-plugin")
    await testSetup.renderOnce()
    const withoutPlugin = testSetup.captureCharFrame()
    expect(withoutPlugin).toContain("dynamic-fallback")
    expect(withoutPlugin).not.toContain("dynamic-plugin")
  })

  it("replace mode restores fallback content after unregistering a shared plugin across multiple slots", async () => {
    const Node = (props: { id: string }) => {
      return (
        <box flexDirection="column">
          <text>{props.id}</text>
          <text>{`${props.id}:detail`}</text>
        </box>
      )
    }

    const plugin: SolidPlugin<AppSlots> = {
      id: "toggle-pair",
      slots: {
        statusbar() {
          return <Node id="plugin-status" />
        },
        sidebar() {
          return <Node id="plugin-sidebar" />
        },
      },
    }

    const { setup, registry } = await setupSlotTest(
      (slotRegistry) => {
        const Slot = createSlot(slotRegistry)

        return (
          <box flexDirection="column">
            <Slot name="statusbar" user="sam" mode="replace">
              <Node id="fallback-status" />
            </Slot>
            <Slot name="sidebar" items={["one"]} mode="replace">
              <Node id="fallback-sidebar" />
            </Slot>
          </box>
        )
      },
      { width: 80, height: 12 },
    )
    testSetup = setup

    const settle = async () => {
      await testSetup.renderOnce()
      await Bun.sleep(0)
      await testSetup.renderOnce()
    }

    await settle()
    let frame = testSetup.captureCharFrame()
    expect(frame).toContain("fallback-status")
    expect(frame).toContain("fallback-sidebar")
    expect(frame).not.toContain("plugin-status")
    expect(frame).not.toContain("plugin-sidebar")

    const off = registry.register(plugin)
    await settle()
    frame = testSetup.captureCharFrame()
    expect(frame).toContain("plugin-status")
    expect(frame).toContain("plugin-sidebar")
    expect(frame).not.toContain("fallback-status")
    expect(frame).not.toContain("fallback-sidebar")

    off()
    await settle()
    frame = testSetup.captureCharFrame()
    expect(frame).toContain("fallback-status")
    expect(frame).toContain("fallback-sidebar")
    expect(frame).not.toContain("plugin-status")
    expect(frame).not.toContain("plugin-sidebar")
  })

  it("switches rendered slot when props.name changes", async () => {
    let switchSlot: (() => void) | null = null

    const DynamicNameHarness = (props: { registry: ReturnType<typeof createSolidSlotRegistry<AppSlots>> }) => {
      const Slot = createSlot(props.registry)
      const [slotName, setSlotName] = createSignal<keyof AppSlots>("statusbar")

      switchSlot = () => {
        setSlotName((current) => (current === "statusbar" ? "sidebar" : "statusbar"))
      }

      const dynamicProps = () =>
        slotName() === "statusbar"
          ? ({ name: "statusbar", user: "sam", mode: "replace" } as const)
          : ({ name: "sidebar", items: ["one"], mode: "replace" } as const)

      return (
        <Slot {...(dynamicProps() as any)}>
          <text>dynamic-name-fallback</text>
        </Slot>
      )
    }

    const { setup } = await setupSlotTest(
      (registry) => {
        registry.register({
          id: "status-plugin",
          slots: {
            statusbar() {
              return <text>status-plugin</text>
            },
          },
        })

        registry.register({
          id: "sidebar-plugin",
          slots: {
            sidebar() {
              return <text>sidebar-plugin</text>
            },
          },
        })

        return <DynamicNameHarness registry={registry} />
      },
      { width: 60, height: 8 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const initialFrame = testSetup.captureCharFrame()
    expect(initialFrame).toContain("status-plugin")
    expect(initialFrame).not.toContain("sidebar-plugin")

    switchSlot?.()

    await testSetup.renderOnce()
    const switchedFrame = testSetup.captureCharFrame()
    expect(switchedFrame).toContain("sidebar-plugin")
    expect(switchedFrame).not.toContain("status-plugin")
    expect(switchedFrame).not.toContain("dynamic-name-fallback")
  })

  it("keeps plugin identity stable when append order changes", async () => {
    const mountLog: string[] = []

    const StatefulPluginNode = (props: { pluginId: string }) => {
      const createdBy = props.pluginId

      onMount(() => {
        mountLog.push(`mount:${props.pluginId}:${createdBy}`)
      })

      onCleanup(() => {
        mountLog.push(`unmount:${props.pluginId}:${createdBy}`)
      })

      return <text>{`${props.pluginId}:${createdBy}`}</text>
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

    registry.updateOrder("beta", -1)

    await testSetup.renderOnce()
    const afterReorder = testSetup.captureCharFrame()

    expect(afterReorder).toContain("beta:beta")
    expect(afterReorder).toContain("alpha:alpha")
    expect(afterReorder).not.toContain("beta:alpha")
    expect(afterReorder).not.toContain("alpha:beta")
    expect(mountLog).toEqual(["mount:alpha:alpha", "mount:beta:beta"])
  })

  it("renders plugin nodes within provider context", async () => {
    const ValueContext = createContext("missing")

    const ContextReader = () => {
      const value = useContext(ValueContext)
      return <text>{`ctx:${value}`}</text>
    }

    const { setup } = await setupSlotTest(
      (registry) => {
        registry.register({
          id: "context-plugin",
          slots: {
            statusbar() {
              return <ContextReader />
            },
          },
        })

        const Slot = createSlot(registry)
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

  it("captures plugin render invocation errors and reports metadata", async () => {
    const errors: string[] = []

    const { setup } = await setupSlotTest(
      (registry) => {
        registry.onPluginError((event) => {
          errors.push(`${event.pluginId}:${event.slot}:${event.phase}:${event.source}:${event.error.message}`)
        })

        registry.register({
          id: "broken-plugin",
          slots: {
            statusbar() {
              throw new Error("render failed")
            },
          },
        })

        const Slot = createSlot(registry)
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
    expect(errors).toEqual(["broken-plugin:statusbar:render:solid:render failed"])
  })

  it("replace mode falls back when plugin fails and no placeholder is configured", async () => {
    const { setup } = await setupSlotTest(
      (registry) => {
        registry.register({
          id: "broken-plugin",
          slots: {
            statusbar() {
              throw new Error("render failed")
            },
          },
        })

        const Slot = createSlot(registry)
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

  it("replace mode falls back when plugin renders empty output", async () => {
    const { setup } = await setupSlotTest(
      (registry) => {
        registry.register({
          id: "empty-plugin",
          slots: {
            statusbar() {
              return <></>
            },
          },
        })

        const Slot = createSlot(registry)
        return (
          <Slot name="statusbar" user="sam" mode="replace">
            <text>replace-fallback-empty</text>
          </Slot>
        )
      },
      { width: 70, height: 6 },
    )
    testSetup = setup

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("replace-fallback-empty")
  })

  it("replace mode falls back when plugin subtree crashes and no placeholder is configured", async () => {
    const errors: string[] = []

    const ExplodingPluginNode = () => {
      throw new Error("replace subtree exploded")
    }

    const { setup } = await setupSlotTest(
      (registry) => {
        registry.onPluginError((event) => {
          errors.push(`${event.pluginId}:${event.slot}:${event.phase}:${event.source}:${event.error.message}`)
        })

        registry.register({
          id: "replace-exploding-plugin",
          slots: {
            statusbar() {
              return <ExplodingPluginNode />
            },
          },
        })

        const Slot = createSlot(registry)
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
    expect(errors).toContain("replace-exploding-plugin:statusbar:render:solid:replace subtree exploded")
  })

  it("reports error_placeholder and keeps fallback when placeholder throws after plugin render error", async () => {
    const errors: string[] = []

    const { setup } = await setupSlotTest(
      (registry) => {
        registry.onPluginError((event) => {
          errors.push(`${event.pluginId}:${event.slot}:${event.phase}:${event.source}:${event.error.message}`)
        })

        registry.register({
          id: "broken-plugin",
          slots: {
            statusbar() {
              throw new Error("render failed")
            },
          },
        })

        const Slot = createSlot(registry, {
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
    expect(errors).toContain("broken-plugin:statusbar:render:solid:render failed")
    expect(errors).toContain("broken-plugin:statusbar:error_placeholder:solid:placeholder failed")
  })

  it("reports error_placeholder and keeps fallback when placeholder throws after subtree crash", async () => {
    const errors: string[] = []

    const ExplodingPluginNode = () => {
      throw new Error("component exploded")
    }

    const { setup } = await setupSlotTest(
      (registry) => {
        registry.onPluginError((event) => {
          errors.push(`${event.pluginId}:${event.slot}:${event.phase}:${event.source}:${event.error.message}`)
        })

        registry.register({
          id: "exploding-plugin",
          slots: {
            statusbar() {
              return <ExplodingPluginNode />
            },
          },
        })

        const Slot = createSlot(registry, {
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
    expect(errors).toContain("exploding-plugin:statusbar:render:solid:component exploded")
    expect(errors).toContain("exploding-plugin:statusbar:error_placeholder:solid:placeholder crashed")
  })

  it("catches plugin subtree errors via per-plugin boundary", async () => {
    const errors: string[] = []

    const ExplodingPluginNode = () => {
      throw new Error("component exploded")
    }

    const { setup } = await setupSlotTest(
      (registry) => {
        registry.onPluginError((event) => {
          errors.push(`${event.pluginId}:${event.slot}:${event.phase}:${event.error.message}`)
        })

        registry.register({
          id: "exploding-component-plugin",
          slots: {
            statusbar() {
              return <ExplodingPluginNode />
            },
          },
        })

        const Slot = createSlot(registry)
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
      (registry) => {
        registry.register({
          id: "broken-plugin",
          slots: {
            statusbar() {
              throw new Error("render failed")
            },
          },
        })

        const Slot = createSlot(registry, {
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
})
