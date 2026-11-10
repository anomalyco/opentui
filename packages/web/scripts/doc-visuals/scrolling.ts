import {
  BoxRenderable,
  RGBA,
  ScrollBarRenderable,
  ScrollBoxRenderable,
  SliderRenderable,
  SlotRenderable,
  TextRenderable,
  createCoreSlotRegistry,
  registerCorePlugin,
} from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import type { DocVisualFixture } from "./shared"

const foreground = RGBA.defaultForeground()
const background = RGBA.defaultBackground()
const muted = RGBA.fromIndex(244)
const track = RGBA.fromIndex(235)

const entries = [
  "01  src/index.ts",
  "02  src/app.ts",
  "03  src/layout.ts",
  "04  src/theme.ts",
  "05  src/events.ts",
  "06  src/input.ts",
  "07  src/scroll.ts",
  "08  src/render.ts",
  "09  src/state.ts",
  "10  src/config.ts",
  "11  src/logger.ts",
  "12  src/cleanup.ts",
]

async function renderScrollBox(setup: TestRendererSetup, position: number) {
  const { renderer } = setup
  const layout = new BoxRenderable(renderer, { width: 32, height: 8 })
  const status = new TextRenderable(renderer, { content: "", fg: muted, height: 1 })
  const scrollbox = new ScrollBoxRenderable(renderer, {
    width: 32,
    height: 7,
    border: true,
    borderColor: foreground,
    scrollbarOptions: {
      trackOptions: { backgroundColor: track, foregroundColor: foreground },
      arrowOptions: { foregroundColor: foreground, backgroundColor: background },
    },
  })

  for (const entry of entries) {
    scrollbox.add(new TextRenderable(renderer, { content: entry, fg: foreground, height: 1, flexShrink: 0 }))
  }

  layout.add(status)
  layout.add(scrollbox)
  renderer.root.add(layout)

  await setup.renderOnce()
  scrollbox.scrollTo(position)
  status.content = `offset: ${scrollbox.scrollTop} / ${scrollbox.scrollHeight - scrollbox.viewport.height}`
}

export const scrollingVisuals: DocVisualFixture[] = [
  {
    id: "slider-horizontal",
    label: "Horizontal slider with its thumb positioned at 25 out of 100",
    width: 30,
    height: 3,
    render({ renderer }) {
      const layout = new BoxRenderable(renderer, { width: 30, height: 3 })
      const limits = new BoxRenderable(renderer, {
        width: 30,
        height: 1,
        flexDirection: "row",
        justifyContent: "space-between",
      })

      layout.add(new TextRenderable(renderer, { content: "value: 25", fg: foreground }))
      layout.add(
        new SliderRenderable(renderer, {
          orientation: "horizontal",
          width: 30,
          height: 1,
          min: 0,
          max: 100,
          value: 25,
          backgroundColor: track,
          foregroundColor: foreground,
        }),
      )
      limits.add(new TextRenderable(renderer, { content: "0", fg: muted }))
      limits.add(new TextRenderable(renderer, { content: "100", fg: muted }))
      layout.add(limits)
      renderer.root.add(layout)
    },
  },
  {
    id: "slider-vertical",
    label: "Vertical slider with its thumb positioned at 0.5 out of 1",
    width: 13,
    height: 10,
    render({ renderer }) {
      const layout = new BoxRenderable(renderer, { width: 13, height: 10, flexDirection: "row", gap: 2 })
      const labels = new BoxRenderable(renderer, { width: 9, height: 10, justifyContent: "space-between" })

      labels.add(new TextRenderable(renderer, { content: "min 0", fg: muted }))
      labels.add(new TextRenderable(renderer, { content: "value 0.5", fg: foreground }))
      labels.add(new TextRenderable(renderer, { content: "max 1", fg: muted }))
      layout.add(labels)
      layout.add(
        new SliderRenderable(renderer, {
          orientation: "vertical",
          width: 2,
          height: 10,
          min: 0,
          max: 1,
          value: 0.5,
          backgroundColor: track,
          foregroundColor: foreground,
        }),
      )
      renderer.root.add(layout)
    },
  },
  {
    id: "scrollbar-arrows",
    label: "Standalone vertical scrollbar with arrows at position 0, showing 20 of 200 rows",
    width: 20,
    height: 10,
    render({ renderer }) {
      const layout = new BoxRenderable(renderer, { width: 20, height: 10, flexDirection: "row", gap: 1 })
      const status = new BoxRenderable(renderer, { width: 18, height: 10, justifyContent: "space-between" })
      const scrollbar = new ScrollBarRenderable(renderer, {
        orientation: "vertical",
        width: 1,
        height: 10,
        showArrows: true,
        arrowOptions: { foregroundColor: foreground, backgroundColor: background },
        trackOptions: { backgroundColor: track, foregroundColor: foreground },
      })

      scrollbar.scrollSize = 200
      scrollbar.viewportSize = 20
      scrollbar.scrollPosition = 0

      status.add(
        new TextRenderable(renderer, {
          content: `position: ${scrollbar.scrollPosition} / ${scrollbar.scrollSize - scrollbar.viewportSize}`,
          fg: foreground,
        }),
      )
      status.add(
        new TextRenderable(renderer, {
          content: `viewport: ${scrollbar.viewportSize} / ${scrollbar.scrollSize}`,
          fg: muted,
        }),
      )
      layout.add(status)
      layout.add(scrollbar)
      renderer.root.add(layout)
    },
  },
  {
    id: "scrollbox-top",
    label: "ScrollBox at offset 0 showing index.ts, app.ts, layout.ts, theme.ts, and events.ts",
    width: 32,
    height: 8,
    render(setup) {
      return renderScrollBox(setup, 0)
    },
  },
  {
    id: "scrollbox-scrolled",
    label: "ScrollBox at offset 5 showing input.ts, scroll.ts, render.ts, state.ts, and config.ts",
    width: 32,
    height: 8,
    render(setup) {
      return renderScrollBox(setup, 5)
    },
  },
  {
    id: "plugin-slot-modes",
    label: "Plugin slots: append shows host, clock, and sync; replace shows clock and sync; single winner shows clock",
    width: 32,
    height: 3,
    render({ renderer }) {
      const registry = createCoreSlotRegistry<"statusbar">(renderer, {})
      const layout = new BoxRenderable(renderer, { width: 32, height: 3 })

      for (const name of ["clock", "sync"]) {
        registerCorePlugin(registry, {
          id: name,
          slots: {
            statusbar: () => new TextRenderable(renderer, { content: name, fg: foreground, marginRight: 1 }),
          },
        })
      }

      for (const mode of ["append", "replace", "single_winner"] as const) {
        const row = new BoxRenderable(renderer, { width: 32, height: 1, flexDirection: "row", gap: 2 })

        row.add(new TextRenderable(renderer, { content: mode, fg: muted, width: 13 }))
        row.add(
          new SlotRenderable(renderer, {
            registry,
            name: "statusbar",
            mode,
            flexDirection: "row",
            fallback: () => new TextRenderable(renderer, { content: "host", fg: muted, marginRight: 1 }),
          }),
        )
        layout.add(row)
      }

      renderer.root.add(layout)
    },
  },
  {
    id: "keymap-active-keys",
    label: "Active key bindings: Ctrl+S saves the file; Q quits the application",
    width: 18,
    height: 2,
    render({ renderer }) {
      const keymap = createDefaultOpenTuiKeymap(renderer)

      keymap.registerLayer({
        commands: [
          { name: "file.save", run() {} },
          { name: "app.quit", run() {} },
        ],
        bindings: [
          { key: "ctrl+s", cmd: "file.save" },
          { key: "q", cmd: "app.quit" },
        ],
      })

      const layout = new BoxRenderable(renderer, { width: 18, height: 2 })

      for (const binding of keymap.getActiveKeys()) {
        const row = new BoxRenderable(renderer, { width: 18, height: 1, flexDirection: "row", gap: 2 })

        row.add(new TextRenderable(renderer, { content: binding.display, fg: foreground, width: 6 }))
        row.add(new TextRenderable(renderer, { content: String(binding.command), fg: muted }))
        layout.add(row)
      }

      renderer.root.add(layout)
    },
  },
]
