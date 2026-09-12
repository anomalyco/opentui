import { BoxRenderable, RGBA, TextRenderable } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import type { DocVisualFixture } from "./shared"

const foreground = RGBA.defaultForeground()
const fill = RGBA.fromIndex(238)

export const layoutVisuals: DocVisualFixture[] = [
  {
    id: "layout-flex-columns",
    label:
      "A 34-column container with a one-cell border and padding, an eight-column fixed child, a two-column gap, and a growing child filling the remaining 20 columns",
    width: 34,
    height: 5,
    render({ renderer }) {
      const row = new BoxRenderable(renderer, {
        width: 34,
        height: 5,
        border: true,
        borderColor: foreground,
        padding: 1,
        flexDirection: "row",
        gap: 2,
      })
      renderer.root.add(row)

      const fixed = new BoxRenderable(renderer, { width: 8, height: 1, backgroundColor: fill })
      row.add(fixed)
      fixed.add(new TextRenderable(renderer, { content: "fixed 8", fg: foreground }))

      const growing = new BoxRenderable(renderer, {
        flexGrow: 1,
        flexBasis: 0,
        height: 1,
        backgroundColor: fill,
      })
      row.add(growing)
      growing.add(new TextRenderable(renderer, { content: "grow 20", fg: foreground }))
    },
  },
  {
    id: "layout-alignment",
    label:
      "Three children distributed horizontally with space-between: one-row A and three-row B share a vertical center, while C overrides alignment to sit at the bottom",
    width: 32,
    height: 7,
    render({ renderer }) {
      const row = new BoxRenderable(renderer, {
        width: 32,
        height: 7,
        border: true,
        borderColor: foreground,
        paddingX: 1,
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
      })
      renderer.root.add(row)

      for (const [label, height] of [
        ["A", 1],
        ["B", 3],
        ["C", 1],
      ] as const) {
        const child = new BoxRenderable(renderer, {
          width: 6,
          height,
          alignSelf: label === "C" ? "flex-end" : "auto",
          backgroundColor: fill,
        })
        row.add(child)
        child.add(new TextRenderable(renderer, { content: label, fg: foreground }))
      }
    },
  },
  {
    id: "layout-cell-rounding",
    label:
      "Three equal grow factors divide 30 inner columns into 10, 10, and 10 cells; adding one terminal column changes the allocation to 10, 11, and 10 cells",
    width: 33,
    height: 8,
    async render({ renderer, renderOnce }) {
      const cells: Array<{ box: BoxRenderable; label: TextRenderable }> = []

      for (const width of [32, 33]) {
        renderer.root.add(
          new TextRenderable(renderer, { content: `${width} columns: ${width - 2} inside`, fg: foreground }),
        )
        const row = new BoxRenderable(renderer, {
          width,
          height: 3,
          border: true,
          borderColor: foreground,
          flexDirection: "row",
        })
        renderer.root.add(row)

        for (let index = 0; index < 3; index++) {
          const box = new BoxRenderable(renderer, {
            flexGrow: 1,
            flexBasis: 0,
            minWidth: 0,
            height: 1,
            alignItems: "center",
            backgroundColor: index === 1 ? RGBA.fromIndex(235) : fill,
          })
          row.add(box)
          const label = new TextRenderable(renderer, { content: "", fg: foreground })
          box.add(label)
          cells.push({ box, label })
        }
      }

      await renderOnce()
      for (const { box, label } of cells) label.content = String(box.width)
    },
  },
  {
    id: "layout-wrap-wide",
    label: "At 32 terminal columns, three eight-column children A, B, and C fit in one row with two-column gaps",
    width: 32,
    height: 4,
    render(setup) {
      return renderWrapping(setup, 32)
    },
  },
  {
    id: "layout-wrap-narrow",
    label:
      "After resizing the same terminal to 22 columns, A and B stay on the first row while C wraps to a second row and the container grows taller",
    width: 22,
    height: 6,
    render(setup) {
      return renderWrapping(setup, 22)
    },
  },
]

async function renderWrapping({ renderer, renderOnce, resize }: TestRendererSetup, columns: number) {
  const height = columns === 32 ? 4 : 6
  resize(32, height)
  const label = new TextRenderable(renderer, { content: "32 columns", fg: foreground })
  renderer.root.add(label)

  const row = new BoxRenderable(renderer, {
    width: "100%",
    border: true,
    borderColor: foreground,
    paddingX: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    columnGap: 2,
    rowGap: 1,
  })
  renderer.root.add(row)

  for (const content of ["A", "B", "C"]) {
    const child = new BoxRenderable(renderer, { width: 8, height: 1, flexShrink: 0, backgroundColor: fill })
    row.add(child)
    child.add(new TextRenderable(renderer, { content, fg: foreground }))
  }

  await renderOnce()
  resize(columns, height)
  label.content = `${columns} columns`
}
