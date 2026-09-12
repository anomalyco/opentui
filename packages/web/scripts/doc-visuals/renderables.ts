import { BoxRenderable, RGBA, TextRenderable } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import type { DocVisualFixture } from "./shared"

const foreground = RGBA.defaultForeground()
const muted = RGBA.fromIndex(244)
const fill = RGBA.fromIndex(243)

export const renderableVisuals: DocVisualFixture[] = [
  {
    id: "renderable-created",
    label: "An 18-column shaded panel containing a status that says Waiting",
    width: 18,
    height: 3,
    render(setup) {
      return renderMutation(setup, false)
    },
  },
  {
    id: "renderable-mutated",
    label:
      "After changing content and width, the same shaded panel is 30 columns wide and its retained status says Ready",
    width: 30,
    height: 3,
    render(setup) {
      return renderMutation(setup, true)
    },
  },
  {
    id: "renderable-reparent-before",
    label: "Before reparenting, the shaded Message subtree is a child of first; second is empty",
    width: 34,
    height: 3,
    render(setup) {
      return renderReparenting(setup, false)
    },
  },
  {
    id: "renderable-reparent-after",
    label: "After second.add(message), the same shaded Message subtree is a child of second; first is empty",
    width: 34,
    height: 3,
    render(setup) {
      return renderReparenting(setup, true)
    },
  },
  {
    id: "renderable-visibility",
    label:
      "Visible: the panel contains Detail above Next. Hidden: Next moves up, but Detail stays attached and the panel still has two children. Detached: Next moves up, Detail has no parent, and the panel has one child. Neither operation destroys Detail.",
    width: 38,
    height: 7,
    async render({ renderer, renderOnce }, registerCleanup) {
      const row = new BoxRenderable(renderer, { width: 38, flexDirection: "row", gap: 1 })
      renderer.root.add(row)

      for (const state of ["visible", "hidden", "detached"]) {
        const column = new BoxRenderable(renderer, { width: 12 })
        row.add(column)
        column.add(new TextRenderable(renderer, { content: state, fg: foreground }))

        const panel = new BoxRenderable(renderer, {
          width: 12,
          height: 4,
          border: true,
          borderColor: foreground,
        })
        column.add(panel)
        const detail = new BoxRenderable(renderer, { height: 1, backgroundColor: fill })
        registerCleanup(() => detail.destroyRecursively())
        panel.add(detail)
        detail.add(new TextRenderable(renderer, { content: "Detail", fg: foreground }))
        panel.add(new TextRenderable(renderer, { content: "Next", fg: foreground }))

        await renderOnce()
        if (state !== "visible") detail.visible = false
        if (state === "detached") {
          detail.visible = true
          panel.remove(detail)
        }

        column.add(new TextRenderable(renderer, { content: `children: ${panel.getChildrenCount()}`, fg: muted }))
        column.add(new TextRenderable(renderer, { content: `parent: ${detail.parent ? "yes" : "no"}`, fg: muted }))
      }
    },
  },
]

async function renderMutation({ renderer, renderOnce }: TestRendererSetup, updated: boolean) {
  const panel = new BoxRenderable(renderer, {
    id: "panel",
    width: 18,
    height: 3,
    paddingX: 1,
    border: true,
    borderColor: foreground,
    backgroundColor: fill,
  })
  renderer.root.add(panel)
  const status = new TextRenderable(renderer, { id: "status", content: "Waiting", fg: foreground })
  panel.add(status)

  await renderOnce()
  if (updated) {
    status.content = "Ready"
    panel.width = 30
  }
}

async function renderReparenting({ renderer, renderOnce }: TestRendererSetup, moved: boolean) {
  const row = new BoxRenderable(renderer, { width: 34, flexDirection: "row", gap: 2 })
  renderer.root.add(row)

  const [first, second] = ["first", "second"].map((id) => {
    const panel = new BoxRenderable(renderer, {
      id,
      title: id,
      width: 16,
      height: 3,
      paddingX: 1,
      border: true,
      borderColor: foreground,
    })
    row.add(panel)
    return panel
  })
  const message = new BoxRenderable(renderer, { id: "message", width: 10, height: 1, backgroundColor: fill })
  first.add(message)
  message.add(new TextRenderable(renderer, { content: "Message", fg: foreground }))

  await renderOnce()
  if (moved) second.add(message)
}
