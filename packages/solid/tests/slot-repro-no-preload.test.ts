import { describe, expect, it } from "bun:test"
import { type CliRenderer, ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer, type TestRendererOptions } from "@opentui/core/testing"
import { createComponent, onCleanup, onMount, type JSX } from "solid-js"
import {
  RendererContext,
  _render as renderInternal,
  createSlot,
  createSolidSlotRegistry,
  useRenderer,
} from "../index.js"

type AppSlots = {
  statusbar: { user: string }
  sidebar: { items: string[] }
}

const hostContext = {
  appName: "solid-slot-repro",
  version: "1.0.0",
}

let seq = 0
const uid = (prefix: string) => `${prefix}-${++seq}`

const text = (renderer: CliRenderer, value: string) => {
  return new TextRenderable(renderer, {
    id: uid("text"),
    content: value,
  })
}

const scroll = (renderer: CliRenderer, value: string) => {
  const box = new ScrollBoxRenderable(renderer, {
    id: uid("scroll"),
    height: 1,
    scrollbarOptions: { visible: false },
  })
  box.add(text(renderer, value))
  return box
}

async function setupSlotTest(
  createNode: (registry: ReturnType<typeof createSolidSlotRegistry<AppSlots>>) => JSX.Element,
  options: TestRendererOptions,
) {
  let done = false
  let dispose: (() => void) | undefined

  const setup = await createTestRenderer({
    ...options,
    onDestroy: () => {
      if (!done) {
        done = true
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

describe("slot behavior stability without preload", () => {
  it("keeps one fallback ScrollBox while unregistering plugins for other slots", async () => {
    const off: Array<() => void> = []
    const boxes: ScrollBoxRenderable[] = []
    let mounts = 0
    let cleanups = 0

    const { setup } = await setupSlotTest(
      (registry) => {
        off.push(
          registry.register({
            id: "statusbar-owner",
            slots: {
              statusbar(_ctx, props) {
                return text(registry.renderer, `owner:${props.user}`)
              },
            },
          }),
        )

        for (let i = 0; i < 14; i++) {
          off.push(
            registry.register({
              id: `sidebar-${i}`,
              slots: {
                sidebar() {
                  return text(registry.renderer, `sidebar-${i}`)
                },
              },
            }),
          )
        }

        const Slot = createSlot(registry)

        const Fallback = () => {
          onMount(() => {
            mounts += 1
          })

          onCleanup(() => {
            cleanups += 1
          })

          const box = scroll(useRenderer(), "fallback-scrollbox")
          boxes.push(box)
          return box
        }

        const Status = (props: { children?: JSX.Element }) => {
          return createComponent(Slot, {
            name: "statusbar",
            user: "sam",
            mode: "replace",
            get children() {
              return props.children
            },
          })
        }

        return createComponent(Status, {
          get children() {
            return createComponent(Fallback, {})
          },
        })
      },
      { width: 60, height: 8 },
    )

    try {
      await setup.renderOnce()

      const live = () => boxes.filter((box) => !box.isDestroyed).length
      expect(live()).toBe(0)

      const owner = off[0]
      if (!owner) throw new Error("missing owner unregister")
      owner()

      for (const item of off.slice(1)) {
        item()
      }

      await setup.renderOnce()
      await Bun.sleep(0)
      await setup.renderOnce()

      expect(mounts).toBe(1)
      expect(cleanups).toBe(0)
      expect(live()).toBe(1)
    } finally {
      if (!setup.renderer.isDestroyed) {
        setup.renderer.destroy()
      }
    }
  })

  it("does not remount replace fallback for unrelated slot order updates", async () => {
    let mounts = 0
    let cleanups = 0

    const { setup, registry } = await setupSlotTest(
      (slotRegistry) => {
        slotRegistry.register({
          id: "statusbar-owner",
          slots: {
            statusbar(_ctx, props) {
              return text(slotRegistry.renderer, `owner:${props.user}`)
            },
          },
        })

        slotRegistry.register({
          id: "sidebar-only",
          order: 0,
          slots: {
            sidebar() {
              return text(slotRegistry.renderer, "sidebar-only")
            },
          },
        })

        const Slot = createSlot(slotRegistry)

        const FallbackProbe = () => {
          onMount(() => {
            mounts += 1
          })

          onCleanup(() => {
            cleanups += 1
          })

          return text(useRenderer(), "fallback-probe")
        }

        const Status = (props: { children?: JSX.Element }) => {
          return createComponent(Slot, {
            name: "statusbar",
            user: "sam",
            mode: "replace",
            get children() {
              return props.children
            },
          })
        }

        return createComponent(Status, {
          get children() {
            return createComponent(FallbackProbe, {})
          },
        })
      },
      { width: 60, height: 8 },
    )

    try {
      await setup.renderOnce()
      expect(mounts).toBe(0)
      expect(cleanups).toBe(0)

      registry.unregister("statusbar-owner")
      await setup.renderOnce()
      expect(mounts).toBe(1)
      expect(cleanups).toBe(0)

      registry.updateOrder("sidebar-only", 1)
      registry.updateOrder("sidebar-only", 2)
      registry.updateOrder("sidebar-only", 3)
      registry.updateOrder("sidebar-only", 4)
      registry.updateOrder("sidebar-only", 5)

      await setup.renderOnce()
      await Bun.sleep(0)
      await setup.renderOnce()

      expect(mounts).toBe(1)
      expect(cleanups).toBe(0)
    } finally {
      if (!setup.renderer.isDestroyed) {
        setup.renderer.destroy()
      }
    }
  })
})
