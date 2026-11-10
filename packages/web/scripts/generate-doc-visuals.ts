import { writeFile } from "node:fs/promises"
import { BoxRenderable, RGBA, TextRenderable } from "@opentui/core"
import { foundationVisuals } from "./doc-visuals/foundation"
import { formVisuals } from "./doc-visuals/forms"
import { graphicsVisuals } from "./doc-visuals/graphics"
import { interactionVisuals } from "./doc-visuals/interaction"
import { layoutVisuals } from "./doc-visuals/layout"
import { renderableVisuals } from "./doc-visuals/renderables"
import { scrollingVisuals } from "./doc-visuals/scrolling"
import { renderDocVisual, type DocVisualFixture } from "./doc-visuals/shared"
import { structuredVisuals } from "./doc-visuals/structured"
import { textCellVisuals } from "./doc-visuals/text-cells"

const styles = [
  { border: "single", description: "single line" },
  { border: "double", description: "double lines" },
  { border: "rounded", description: "round corners" },
  { border: "heavy", description: "heavy strokes" },
] as const

const boxBorders: DocVisualFixture = {
  id: "box-borders",
  label: "Four OpenTUI box border styles: single, double, rounded, and heavy",
  width: 38,
  height: 7,
  render({ renderer }) {
    const foreground = RGBA.defaultForeground()
    const muted = RGBA.fromIndex(244)
    const layout = new BoxRenderable(renderer, { width: 38, height: 7, gap: 1 })

    for (let index = 0; index < styles.length; index += 2) {
      const row = new BoxRenderable(renderer, { width: 38, height: 3, flexDirection: "row", gap: 2 })

      for (const style of styles.slice(index, index + 2)) {
        const box = new BoxRenderable(renderer, {
          width: 18,
          height: 3,
          border: true,
          borderStyle: style.border,
          borderColor: foreground,
          title: style.border,
          titleAlignment: "center",
          paddingX: 1,
        })

        box.add(new TextRenderable(renderer, { content: style.description, fg: muted }))
        row.add(box)
      }

      layout.add(row)
    }

    renderer.root.add(layout)
  },
}

export async function generateDocVisuals() {
  const fixtures = [
    boxBorders,
    ...foundationVisuals,
    ...layoutVisuals,
    ...renderableVisuals,
    ...textCellVisuals,
    ...interactionVisuals,
    ...formVisuals,
    ...scrollingVisuals,
    ...structuredVisuals,
    ...graphicsVisuals,
  ]
  const visuals: Record<string, Awaited<ReturnType<typeof renderDocVisual>>> = {}

  for (const fixture of fixtures) {
    if (Object.hasOwn(visuals, fixture.id)) throw new Error(`Duplicate documentation visual "${fixture.id}"`)
    visuals[fixture.id] = await renderDocVisual(fixture)
  }

  return visuals
}

if (import.meta.main) {
  const output = new URL("../src/data/doc-visuals.json", import.meta.url)
  await writeFile(output, `${JSON.stringify(await generateDocVisuals(), null, 2)}\n`)
  console.log("Generated src/data/doc-visuals.json")
}
