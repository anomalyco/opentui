import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Renderable } from "../Renderable.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { createCoreSlotRegistry, registerCorePlugin, SlotRenderable } from "../plugins/core-slot.js"

type AppSlot = "statusbar"
type AppContext = { appName: string; version: string }
type AppData = { label: string }

class TestRenderable extends Renderable {
  constructor(renderer: TestRenderer, id: string) {
    super(renderer, { id })
  }
}

function expectFirstChildToBe(slot: { getChildren(): Renderable[] }, renderable: TestRenderable | null): void {
  expect(renderable).not.toBeNull()
  expect(slot.getChildren()[0]).toBe(renderable as TestRenderable)
}

function expectRenderableDestroyed(renderable: Renderable | null, expected: boolean): void {
  expect(renderable).not.toBeNull()
  expect(renderable!.isDestroyed).toBe(expected)
}

let renderer: TestRenderer

beforeEach(async () => {
  ;({ renderer } = await createTestRenderer({}))
})

afterEach(() => {
  renderer.destroy()
})

describe("Core slot binding", () => {
  test("creates renderer-scoped registry by default", () => {
    const context = { appName: "core-only", version: "1.0.0" }
    const first = createCoreSlotRegistry<AppSlot, AppContext>(renderer, context)
    const second = createCoreSlotRegistry<AppSlot, AppContext>(renderer, context)

    expect(first).toBe(second)
    expect(first.context.appName).toBe("core-only")

    expect(() => {
      createCoreSlotRegistry<AppSlot, AppContext>(renderer, { appName: "other", version: "2.0.0" })
    }).toThrow("different context")
  })

  test("uses fallback when no plugin is registered", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let fallbackCreateCount = 0

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      fallback: () => {
        fallbackCreateCount++
        return new TestRenderable(renderer, "fallback")
      },
    })
    renderer.root.add(slot)

    expect(fallbackCreateCount).toBe(1)
    expect(slot.getChildren().map((child) => child.id)).toEqual(["fallback"])

    slot.refresh()

    expect(fallbackCreateCount).toBe(1)
    expect(slot.getChildren().map((child) => child.id)).toEqual(["fallback"])

    slot.destroy()
  })

  test("passes slot data to plugin renderers and updates on data change", () => {
    const registry = createCoreSlotRegistry<AppSlot, AppContext, AppData>(renderer, {
      appName: "core-only",
      version: "1.0.0",
    })
    const receivedLabels: string[] = []

    registerCorePlugin(registry, {
      id: "plugin-a",
      slots: {
        statusbar(_ctx, data) {
          receivedLabels.push(data.label)
          return new TestRenderable(renderer, `plugin-${data.label}`)
        },
      },
    })

    const slot = new SlotRenderable<AppSlot, AppContext, AppData>(renderer, {
      registry,
      name: "statusbar",
      data: { label: "initial" },
    })
    renderer.root.add(slot)

    expect(slot.getChildren().map((child) => child.id)).toEqual(["plugin-initial"])
    expect(receivedLabels).toEqual(["initial"])

    slot.data = { label: "updated" }

    expect(slot.getChildren().map((child) => child.id)).toEqual(["plugin-updated"])
    expect(receivedLabels).toEqual(["initial", "updated"])

    slot.destroy()
  })

  test("creates plugin node once and reuses it on refresh", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let pluginCreateCount = 0
    let pluginNode: TestRenderable | null = null

    registerCorePlugin(registry, {
      id: "plugin-a",
      slots: {
        statusbar() {
          pluginCreateCount++
          pluginNode = new TestRenderable(renderer, `plugin-a-${pluginCreateCount}`)
          return pluginNode
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
    })
    renderer.root.add(slot)

    expect(pluginCreateCount).toBe(1)
    expectFirstChildToBe(slot, pluginNode)

    slot.refresh()
    registry.updateOrder("plugin-a", 10)

    expect(pluginCreateCount).toBe(1)
    expectFirstChildToBe(slot, pluginNode)

    slot.destroy()
  })

  test("single_winner mode recreates plugins that re-enter as winner", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let pluginACreateCount = 0
    let pluginBCreateCount = 0

    registerCorePlugin(registry, {
      id: "plugin-a",
      order: 0,
      slots: {
        statusbar() {
          pluginACreateCount++
          return new TestRenderable(renderer, `plugin-a-${pluginACreateCount}`)
        },
      },
    })

    registerCorePlugin(registry, {
      id: "plugin-b",
      order: 10,
      slots: {
        statusbar() {
          pluginBCreateCount++
          return new TestRenderable(renderer, `plugin-b-${pluginBCreateCount}`)
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      mode: "single_winner",
    })
    renderer.root.add(slot)

    expect(pluginACreateCount).toBe(1)
    expect(pluginBCreateCount).toBe(0)
    expect(slot.getChildren().map((child) => child.id)).toEqual(["plugin-a-1"])

    registry.updateOrder("plugin-b", -1)

    expect(pluginACreateCount).toBe(1)
    expect(pluginBCreateCount).toBe(1)
    expect(slot.getChildren().map((child) => child.id)).toEqual(["plugin-b-1"])

    registry.updateOrder("plugin-a", -2)

    expect(pluginACreateCount).toBe(2)
    expect(pluginBCreateCount).toBe(1)
    expect(slot.getChildren().map((child) => child.id)).toEqual(["plugin-a-2"])

    slot.destroy()
  })

  test("single_winner destroys non-winning plugin nodes when winner changes", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let pluginACreateCount = 0
    let pluginBCreateCount = 0
    const pluginANodes: TestRenderable[] = []
    const pluginBNodes: TestRenderable[] = []

    registerCorePlugin(registry, {
      id: "plugin-a",
      order: 0,
      slots: {
        statusbar() {
          pluginACreateCount++
          const node = new TestRenderable(renderer, `plugin-a-${pluginACreateCount}`)
          pluginANodes.push(node)
          return node
        },
      },
    })

    registerCorePlugin(registry, {
      id: "plugin-b",
      order: 10,
      slots: {
        statusbar() {
          pluginBCreateCount++
          const node = new TestRenderable(renderer, `plugin-b-${pluginBCreateCount}`)
          pluginBNodes.push(node)
          return node
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      mode: "single_winner",
    })
    renderer.root.add(slot)

    expect(slot.getChildren().map((child) => child.id)).toEqual(["plugin-a-1"])
    expect(pluginANodes[0]?.isDestroyed).toBe(false)

    registry.updateOrder("plugin-b", -1)

    expect(slot.getChildren().map((child) => child.id)).toEqual(["plugin-b-1"])
    expect(pluginANodes[0]?.isDestroyed).toBe(true)
    expect(pluginBNodes[0]?.isDestroyed).toBe(false)

    registry.updateOrder("plugin-a", -2)

    expect(slot.getChildren().map((child) => child.id)).toEqual(["plugin-a-2"])
    expect(pluginACreateCount).toBe(2)
    expect(pluginBCreateCount).toBe(1)
    expect(pluginANodes[1]?.isDestroyed).toBe(false)
    expect(pluginBNodes[0]?.isDestroyed).toBe(true)

    slot.destroy()

    expect(pluginANodes[1]?.isDestroyed).toBe(true)
    expect(pluginBNodes[0]?.isDestroyed).toBe(true)
  })

  test("single_winner object slots use activate/deactivate lifecycle and are not host-destroyed", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const lifecycleEvents: string[] = []
    let pluginARenderCount = 0
    let pluginBRenderCount = 0
    let pluginANode: TestRenderable | null = null
    let pluginBNode: TestRenderable | null = null

    registerCorePlugin(registry, {
      id: "plugin-a",
      order: 0,
      slots: {
        statusbar: {
          render() {
            pluginARenderCount++
            if (!pluginANode) {
              pluginANode = new TestRenderable(renderer, "plugin-a-object")
            }
            return pluginANode
          },
          onActivate() {
            lifecycleEvents.push("a:activate")
          },
          onDeactivate() {
            lifecycleEvents.push("a:deactivate")
          },
          onDispose() {
            lifecycleEvents.push("a:dispose")
          },
        },
      },
    })

    registerCorePlugin(registry, {
      id: "plugin-b",
      order: 10,
      slots: {
        statusbar: {
          render() {
            pluginBRenderCount++
            if (!pluginBNode) {
              pluginBNode = new TestRenderable(renderer, "plugin-b-object")
            }
            return pluginBNode
          },
          onActivate() {
            lifecycleEvents.push("b:activate")
          },
          onDeactivate() {
            lifecycleEvents.push("b:deactivate")
          },
          onDispose() {
            lifecycleEvents.push("b:dispose")
          },
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      mode: "single_winner",
    })
    renderer.root.add(slot)

    expect(slot.getChildren().map((child) => child.id)).toEqual(["plugin-a-object"])

    registry.updateOrder("plugin-b", -1)

    expect(slot.getChildren().map((child) => child.id)).toEqual(["plugin-b-object"])
    expectRenderableDestroyed(pluginANode, false)

    registry.updateOrder("plugin-a", -2)

    expect(slot.getChildren().map((child) => child.id)).toEqual(["plugin-a-object"])
    expect(pluginARenderCount).toBe(2)
    expect(pluginBRenderCount).toBe(1)

    slot.destroy()

    expectRenderableDestroyed(pluginANode, false)
    expectRenderableDestroyed(pluginBNode, false)
    expect(lifecycleEvents).toEqual([
      "a:activate",
      "a:deactivate",
      "b:activate",
      "b:deactivate",
      "a:activate",
      "a:deactivate",
      "a:dispose",
      "b:dispose",
    ])
  })

  test("single_winner object slot dispose runs on unregister", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const lifecycleEvents: string[] = []
    let pluginNode: TestRenderable | null = null

    registerCorePlugin(registry, {
      id: "plugin-object",
      slots: {
        statusbar: {
          render() {
            if (!pluginNode) {
              pluginNode = new TestRenderable(renderer, "plugin-object")
            }
            return pluginNode
          },
          onActivate() {
            lifecycleEvents.push("activate")
          },
          onDeactivate() {
            lifecycleEvents.push("deactivate")
          },
          onDispose() {
            lifecycleEvents.push("dispose")
          },
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      mode: "single_winner",
    })
    renderer.root.add(slot)

    registry.unregister("plugin-object")

    expect(slot.getChildren()).toEqual([])
    expectRenderableDestroyed(pluginNode, false)
    expect(lifecycleEvents).toEqual(["activate", "deactivate", "dispose"])

    slot.destroy()
  })

  test("reports managed slot lifecycle hook failures without crashing", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const lifecycleErrors: string[] = []

    registry.onPluginError((event) => {
      lifecycleErrors.push(`${event.phase}:${event.error.message}`)
    })

    registerCorePlugin(registry, {
      id: "managed-errors",
      slots: {
        statusbar: {
          render() {
            return new TestRenderable(renderer, "managed-errors")
          },
          onActivate() {
            throw new Error("activate failed")
          },
          onDeactivate() {
            throw new Error("deactivate failed")
          },
          onDispose() {
            throw new Error("dispose failed")
          },
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      mode: "single_winner",
    })
    renderer.root.add(slot)

    registry.unregister("managed-errors")

    expect(slot.getChildren()).toEqual([])
    expect(lifecycleErrors).toEqual(["setup:activate failed", "dispose:deactivate failed", "dispose:dispose failed"])

    slot.destroy()
  })

  test("replace mode hides fallback and renders all ordered plugins", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })

    registerCorePlugin(registry, {
      id: "late",
      order: 10,
      slots: {
        statusbar() {
          return new TestRenderable(renderer, "late-plugin")
        },
      },
    })

    registerCorePlugin(registry, {
      id: "early",
      order: 0,
      slots: {
        statusbar() {
          return new TestRenderable(renderer, "early-plugin")
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      mode: "replace",
      fallback: () => new TestRenderable(renderer, "replace-fallback"),
    })
    renderer.root.add(slot)

    expect(slot.getChildren().map((child) => child.id)).toEqual(["early-plugin", "late-plugin"])

    slot.destroy()
  })

  test("replace mode keeps healthy plugins when one plugin render fails", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })

    registerCorePlugin(registry, {
      id: "broken-plugin",
      order: 0,
      slots: {
        statusbar() {
          throw new Error("broken render")
        },
      },
    })

    registerCorePlugin(registry, {
      id: "healthy-plugin",
      order: 10,
      slots: {
        statusbar() {
          return new TestRenderable(renderer, "healthy-plugin")
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      mode: "replace",
      fallback: () => new TestRenderable(renderer, "replace-fallback"),
    })
    renderer.root.add(slot)

    expect(slot.getChildren().map((child) => child.id)).toEqual(["healthy-plugin"])

    slot.destroy()
  })

  test("single_winner mode falls back when winning plugin fails", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })

    registerCorePlugin(registry, {
      id: "broken-winner",
      order: 0,
      slots: {
        statusbar() {
          throw new Error("winner failed")
        },
      },
    })

    registerCorePlugin(registry, {
      id: "healthy-second",
      order: 10,
      slots: {
        statusbar() {
          return new TestRenderable(renderer, "healthy-second")
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      mode: "single_winner",
      fallback: () => new TestRenderable(renderer, "single-fallback"),
    })
    renderer.root.add(slot)

    expect(slot.getChildren().map((child) => child.id)).toEqual(["single-fallback"])

    slot.destroy()
  })

  test("unregister removes and destroys plugin node while keeping fallback", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let fallbackCreateCount = 0
    let pluginNode: TestRenderable | null = null

    registerCorePlugin(registry, {
      id: "plugin-a",
      slots: {
        statusbar() {
          pluginNode = new TestRenderable(renderer, "plugin-a")
          return pluginNode
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      mode: "append",
      fallback: () => {
        fallbackCreateCount++
        return new TestRenderable(renderer, "fallback")
      },
    })
    renderer.root.add(slot)

    expect(slot.getChildren().map((child) => child.id)).toEqual(["fallback", "plugin-a"])

    registry.unregister("plugin-a")

    expect(fallbackCreateCount).toBe(1)
    expect(slot.getChildren().map((child) => child.id)).toEqual(["fallback"])
    expectRenderableDestroyed(pluginNode, true)

    slot.destroy()
  })

  test("clear removes mounted plugin nodes and restores fallback", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let fallbackCreateCount = 0
    let pluginNode: TestRenderable | null = null

    registerCorePlugin(registry, {
      id: "plugin-a",
      slots: {
        statusbar() {
          pluginNode = new TestRenderable(renderer, "plugin-a")
          return pluginNode
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      mode: "replace",
      fallback: () => {
        fallbackCreateCount++
        return new TestRenderable(renderer, "fallback")
      },
    })
    renderer.root.add(slot)

    expect(slot.getChildren().map((child) => child.id)).toEqual(["plugin-a"])

    registry.clear()

    expect(fallbackCreateCount).toBe(1)
    expect(slot.getChildren().map((child) => child.id)).toEqual(["fallback"])
    expectRenderableDestroyed(pluginNode, true)

    slot.destroy()
  })

  test("mode setter transitions reconcile mounted output", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let pluginACreateCount = 0
    let pluginBCreateCount = 0

    registerCorePlugin(registry, {
      id: "plugin-a",
      order: 0,
      slots: {
        statusbar() {
          pluginACreateCount++
          return new TestRenderable(renderer, `plugin-a-${pluginACreateCount}`)
        },
      },
    })

    registerCorePlugin(registry, {
      id: "plugin-b",
      order: 10,
      slots: {
        statusbar() {
          pluginBCreateCount++
          return new TestRenderable(renderer, `plugin-b-${pluginBCreateCount}`)
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      mode: "append",
      fallback: () => new TestRenderable(renderer, "fallback"),
    })
    renderer.root.add(slot)

    expect(slot.getChildren().map((child) => child.id)).toEqual(["fallback", "plugin-a-1", "plugin-b-1"])

    slot.mode = "replace"
    expect(slot.getChildren().map((child) => child.id)).toEqual(["plugin-a-1", "plugin-b-1"])

    slot.mode = "single_winner"
    expect(slot.getChildren().map((child) => child.id)).toEqual(["plugin-a-1"])

    slot.mode = "replace"
    expect(slot.getChildren().map((child) => child.id)).toEqual(["plugin-a-1", "plugin-b-2"])

    slot.mode = "append"
    expect(slot.getChildren().map((child) => child.id)).toEqual(["fallback", "plugin-a-1", "plugin-b-2"])

    slot.destroy()
  })

  test("destroy clears mounted nodes and unsubscribes from registry updates", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let fallbackNode: TestRenderable | null = null
    let pluginNode: TestRenderable | null = null

    registerCorePlugin(registry, {
      id: "plugin-a",
      slots: {
        statusbar() {
          pluginNode = new TestRenderable(renderer, "plugin-a")
          return pluginNode
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      fallback: () => {
        fallbackNode = new TestRenderable(renderer, "fallback")
        return fallbackNode
      },
    })
    renderer.root.add(slot)

    expect(slot.getChildren().length).toBe(2)

    slot.destroy()

    expectRenderableDestroyed(fallbackNode, true)
    expectRenderableDestroyed(pluginNode, true)

    registerCorePlugin(registry, {
      id: "plugin-b",
      slots: {
        statusbar() {
          return new TestRenderable(renderer, "plugin-b")
        },
      },
    })

    // SlotRenderable is destroyed, so no new children should appear
    // (it's been removed from tree by destroy())
  })

  test("captures async plugin renderer failures without crashing", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const errors: string[] = []
    registry.onPluginError((event) => {
      errors.push(`${event.pluginId}:${event.slot}:${event.phase}:${event.error.message}`)
    })

    registerCorePlugin(registry, {
      id: "plugin-async",
      slots: {
        statusbar() {
          return Promise.resolve(new TestRenderable(renderer, "plugin-async")) as unknown as TestRenderable
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      fallback: () => new TestRenderable(renderer, "fallback"),
    })
    renderer.root.add(slot)

    expect(slot.getChildren().map((child) => child.id)).toEqual(["fallback"])
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("plugin-async:statusbar:render")
    expect(errors[0]).toContain("async value")

    slot.refresh()
    expect(errors.length).toBe(1)

    slot.destroy()
  })

  test("captures non-renderable plugin values without crashing", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const errors: string[] = []
    registry.onPluginError((event) => {
      errors.push(`${event.pluginId}:${event.slot}:${event.phase}:${event.error.message}`)
    })

    registerCorePlugin(registry, {
      id: "plugin-invalid",
      slots: {
        statusbar() {
          return "not-a-renderable" as unknown as TestRenderable
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
    })
    renderer.root.add(slot)

    expect(slot.getChildren()).toEqual([])
    expect(errors).toEqual(['plugin-invalid:statusbar:render:Plugin "plugin-invalid" must return a BaseRenderable'])

    slot.destroy()
  })

  test("captures plugin self-mount failures", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const errors: string[] = []
    registry.onPluginError((event) => {
      errors.push(event.error.message)
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
    })
    renderer.root.add(slot)

    registerCorePlugin(registry, {
      id: "plugin-self",
      slots: {
        statusbar() {
          return slot
        },
      },
    })

    expect(slot.getChildren()).toEqual([])
    expect(errors[0]).toContain("mount container")

    slot.destroy()
  })

  test("captures failures when plugin returns node attached to another parent", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const errors: string[] = []
    registry.onPluginError((event) => {
      errors.push(event.error.message)
    })
    const otherParent = new TestRenderable(renderer, "other-parent")
    const attachedNode = new TestRenderable(renderer, "attached-node")
    renderer.root.add(otherParent)
    otherParent.add(attachedNode)

    registerCorePlugin(registry, {
      id: "plugin-attached",
      slots: {
        statusbar() {
          return attachedNode
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
    })
    renderer.root.add(slot)

    expect(attachedNode.parent).toBe(otherParent)
    expect(slot.getChildren()).toEqual([])
    expect(errors[0]).toContain("already attached to another parent")

    slot.destroy()
  })

  test("renders plugin failure placeholder only when configured", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })

    registerCorePlugin(registry, {
      id: "broken-plugin",
      slots: {
        statusbar() {
          throw new Error("plugin exploded")
        },
      },
    })

    const slotWithoutPlaceholder = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      fallback: () => new TestRenderable(renderer, "fallback"),
    })
    renderer.root.add(slotWithoutPlaceholder)

    expect(slotWithoutPlaceholder.getChildren().map((child) => child.id)).toEqual(["fallback"])
    slotWithoutPlaceholder.destroy()

    const slotWithPlaceholder = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      fallback: () => new TestRenderable(renderer, "fallback"),
      pluginFailurePlaceholder(failure) {
        return new TestRenderable(renderer, `error-${failure.pluginId}`)
      },
    })
    renderer.root.add(slotWithPlaceholder)

    expect(slotWithPlaceholder.getChildren().map((child) => child.id)).toEqual(["fallback", "error-broken-plugin"])
    slotWithPlaceholder.destroy()
  })

  test("replace mode uses fallback when plugin fails and no placeholder is configured", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })

    registerCorePlugin(registry, {
      id: "broken-plugin",
      slots: {
        statusbar() {
          throw new Error("plugin exploded")
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      mode: "replace",
      fallback: () => new TestRenderable(renderer, "fallback"),
    })
    renderer.root.add(slot)

    expect(slot.getChildren().map((child) => child.id)).toEqual(["fallback"])
    slot.destroy()
  })

  test("reports placeholder renderer failures separately", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    const errors: string[] = []
    registry.onPluginError((event) => {
      errors.push(`${event.phase}:${event.error.message}`)
    })

    registerCorePlugin(registry, {
      id: "broken-plugin",
      slots: {
        statusbar() {
          throw new Error("plugin render failed")
        },
      },
    })

    const slot = new SlotRenderable(renderer, {
      registry,
      name: "statusbar",
      fallback: () => new TestRenderable(renderer, "fallback"),
      pluginFailurePlaceholder() {
        throw new Error("placeholder failed")
      },
    })
    renderer.root.add(slot)

    expect(slot.getChildren().map((child) => child.id)).toEqual(["fallback"])
    expect(errors).toEqual(["render:plugin render failed", "error_placeholder:placeholder failed"])

    slot.destroy()
  })

  test("cleans up plugin nodes when fallback renderer fails", () => {
    const registry = createCoreSlotRegistry<AppSlot>(renderer, { appName: "core-only", version: "1.0.0" })
    let pluginNode: TestRenderable | null = null

    registerCorePlugin(registry, {
      id: "plugin-a",
      slots: {
        statusbar() {
          pluginNode = new TestRenderable(renderer, "plugin-a")
          return pluginNode
        },
      },
    })

    expect(() => {
      new SlotRenderable(renderer, {
        registry,
        name: "statusbar",
        mode: "append",
        fallback: () => {
          return Promise.resolve(new TestRenderable(renderer, "fallback")) as unknown as TestRenderable
        },
      })
    }).toThrow("async value")

    expectRenderableDestroyed(pluginNode, true)
  })
})
