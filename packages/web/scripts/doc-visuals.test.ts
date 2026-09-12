import { readFile, readdir } from "node:fs/promises"
import { LineNumberRenderable, RGBA, rgbToHex } from "@opentui/core"
import { expect, test } from "bun:test"
import visuals from "../src/data/doc-visuals.json"
import { renderDocVisual } from "./doc-visuals/shared"
import { structuredVisuals } from "./doc-visuals/structured"
import { generateDocVisuals } from "./generate-doc-visuals"

test("documentation visual preserves native terminal geometry and color intent", async () => {
  const generated = await generateDocVisuals()
  const frame = generated["box-borders"]

  expect(JSON.stringify(generated)).toBe(JSON.stringify(visuals))
  expect(frame.cols).toBe(38)
  expect(frame.rows).toBe(7)

  for (const visual of Object.values(generated)) {
    expect(visual.lines).toHaveLength(visual.rows)

    for (const line of visual.lines) {
      expect(line.reduce((width, span) => width + span.width, 0)).toBe(visual.cols)
    }

    if (visual.cursor) {
      expect(visual.cursor.column).toBeGreaterThanOrEqual(0)
      expect(visual.cursor.column).toBeLessThan(visual.cols)
      expect(visual.cursor.row).toBeGreaterThanOrEqual(0)
      expect(visual.cursor.row).toBeLessThan(visual.rows)
    }
  }

  const spans = frame.lines.flat()
  expect(spans.some((span) => span.text.includes("single") && frame.colors[span.foreground].intent === "default")).toBe(
    true,
  )
  expect(spans.every((span) => frame.colors[span.background].intent === "default")).toBe(true)
  expect(spans.some((span) => span.text === "single line" && frame.colors[span.foreground].slot === 244)).toBe(true)

  const embedded = generated["embedded-terminal-vt"]
  const terminalSpans = embedded.lines.flat()
  expect(terminalSpans.every((span) => embedded.colors[span.background].intent === "default")).toBe(true)
  expect(
    terminalSpans.some(
      (span) => span.text.includes("bun test") && embedded.colors[span.foreground].intent === "default",
    ),
  ).toBe(true)
  expect(terminalSpans.some((span) => span.text.includes("$") && embedded.colors[span.foreground].slot === 244)).toBe(
    true,
  )
  expect(generated["frame-buffer-draw"].label).toContain("42 MB/s")
  expect(generated["frame-buffer-draw"].label).toContain("18 MB/s")
  expect(generated["frame-buffer-progress"].label).toContain("70%")
  expect(generated["interaction-selection-focus"].label).toContain("deploy --check")
  expect(generated["text-cell-ruler"].label).toContain("three cells")
  expect(generated["text-cell-ruler"].label).toContain("columns 1 and 2")

  for (const id of ["input-focused", "textarea-selection", "interaction-selection-focus"]) {
    expect(generated[id].cursor).not.toBeNull()
  }

  function backgroundAt(visual: typeof frame, x: number, y: number) {
    let column = 0
    for (const span of visual.lines[y]) {
      column += span.width
      if (column > x) return visual.colors[span.background]
    }
    throw new Error(`Missing cell at ${x}, ${y}`)
  }

  const created = generated["renderable-created"]
  const mutated = generated["renderable-mutated"]
  expect([created.cols, mutated.cols]).toEqual([18, 30])
  expect(created.lines[1].map((span) => span.text).join("")).toContain("Waiting")
  expect(mutated.lines[1].map((span) => span.text).join("")).toContain("Ready")

  const beforeMove = generated["renderable-reparent-before"]
  const afterMove = generated["renderable-reparent-after"]
  expect(backgroundAt(beforeMove, 2, 1).slot).toBe(243)
  expect(backgroundAt(beforeMove, 20, 1).intent).toBe("default")
  expect(backgroundAt(afterMove, 2, 1).intent).toBe("default")
  expect(backgroundAt(afterMove, 20, 1).slot).toBe(243)
  expect(generated["renderable-visibility"].lines[5].map((span) => span.text).join("")).toContain(
    "children: 2  children: 2  children: 1",
  )

  const chunks = generated["text-styled-chunks"].lines.flat()
  expect(chunks.find((span) => span.text === "Status")?.attributes).toBe(1)
  expect(chunks.find((span) => span.text === "Note")?.attributes).toBe(4)
  expect(chunks.find((span) => span.text === "Next")?.attributes).toBe(9)
  const ruler = generated["text-cell-ruler"]
  expect(ruler.lines[1].map((span) => span.text).join("")).toContain("ABC|  3 cells")
  expect(ruler.lines[2].map((span) => span.text).join("")).toContain("A\u754cB|  4 cells")
  expect(ruler.lines[2].find((span) => span.text === "\u754c")?.width).toBe(2)
  expect(ruler.lines[2].find((span) => span.text === "B")?.width).toBe(1)
  expect(backgroundAt(ruler, 11, 2).slot).toBe(235)
  expect(backgroundAt(ruler, 12, 2).intent).toBe("default")
  const offsets = generated["text-line-offsets"]
  expect(backgroundAt(offsets, 0, 3).slot).toBe(238)
  expect(backgroundAt(offsets, 19, 3).slot).toBe(238)
  expect(offsets.lines[4].map((span) => span.text).join("")).toContain("range [3, 4)       range [4, 5)")

  const hits = generated["interaction-hit-bubbling"]
  expect(hits.lines[7].map((span) => span.text).join("")).toContain("target: front")
  expect(hits.lines[8].map((span) => span.text).join("")).toContain("bubble: front -> parent")
  expect(hits.lines[9].map((span) => span.text).join("")).toContain("stopped: front")
  const drag = generated["interaction-drag-selection"]
  expect(drag.lines[3].map((span) => span.text).join("")).toContain('Selected: "the app\\nTest"')
  expect(drag.lines[4].map((span) => span.text).join("")).toContain("Range: [6, 18)")

  const spacing = generated["layout-flex-columns"]
  for (let x = 0; x < spacing.cols; x++) {
    const shaded = (x >= 2 && x < 10) || (x >= 12 && x < 32)
    expect(backgroundAt(spacing, x, 2).slot).toBe(shaded ? 238 : undefined)
  }

  const alignment = generated["layout-alignment"]
  for (const [x, y] of [
    [2, 3],
    [7, 3],
    [13, 2],
    [18, 4],
    [24, 5],
    [29, 5],
  ]) {
    expect(backgroundAt(alignment, x, y).slot).toBe(238)
  }
  for (const [x, y] of [
    [2, 2],
    [13, 1],
    [24, 3],
  ]) {
    expect(backgroundAt(alignment, x, y).intent).toBe("default")
  }

  const rounding = generated["layout-cell-rounding"]
  for (const [row, widths] of [
    [2, [10, 10, 10]],
    [6, [10, 11, 10]],
  ] as const) {
    let left = 1
    for (const [index, width] of widths.entries()) {
      for (let x = left; x < left + width; x++) {
        expect(backgroundAt(rounding, x, row).slot).toBe(index === 1 ? 235 : 238)
      }
      left += width
    }
  }

  const wide = generated["layout-wrap-wide"]
  const narrow = generated["layout-wrap-narrow"]
  expect([wide.cols, wide.rows]).toEqual([32, 4])
  expect([narrow.cols, narrow.rows]).toEqual([22, 6])
  expect(wide.lines[2].map((span) => span.text).join("")).toContain("C")
  expect(narrow.lines[2].map((span) => span.text).join("")).not.toContain("C")
  expect(narrow.lines[4].map((span) => span.text).join("")).toContain("C")
  expect(backgroundAt(wide, 22, 2).slot).toBe(238)
  expect(backgroundAt(narrow, 2, 4).slot).toBe(238)

  const palette = generated["color-palette"]
  for (let index = 0; index < 256; index++) {
    const red = Math.floor((index - 16) / 36)
    const green = Math.floor((index - 16) / 6) % 6
    const blue = (index - 16) % 6
    const x = index < 16 ? index * 2 : index < 232 ? (red % 3) * 13 + blue * 2 : index - 232
    const y = index < 16 ? 1 : index < 232 ? 5 + Math.floor(red / 3) * 8 + green : 21
    const color = backgroundAt(palette, x, y)

    expect(color.intent).toBe("rgb")
    expect(color.value).toBe(rgbToHex(RGBA.fromIndex(index)))
  }

  const alpha = generated["color-alpha"]
  for (const [index, [light, dark]] of [
    ["#e0e0e0", "#a0a0a0"],
    ["#b0d9bf", "#80a98f"],
    ["#81d29f", "#61b37f"],
    ["#52cc7f", "#42bc6f"],
    ["#22c55e", "#22c55e"],
  ].entries()) {
    expect(backgroundAt(alpha, index * 7, 0).value).toBe(light)
    expect(backgroundAt(alpha, index * 7 + 2, 0).value).toBe(dark)
  }

  const directory = new URL("../src/content/docs/", import.meta.url)
  const files = (await readdir(directory, { recursive: true })).filter((path) => path.endsWith(".mdx"))
  const referenced = new Set<string>()

  for (const path of files) {
    const source = await readFile(new URL(path, directory), "utf8")

    for (const match of source.matchAll(/```text terminal=([a-z0-9-]+)(?:[^\S\n]+[^\n]*)?\n([\s\S]*?)\n```/g)) {
      const visual = generated[match[1]]
      expect(visual).toBeDefined()

      const text = visual.lines
        .map((line) =>
          line
            .map((span) => span.text)
            .join("")
            .trimEnd(),
        )
        .join("\n")

      expect(match[2]).toBe(text)
      referenced.add(match[1])
    }
  }

  expect([...referenced].toSorted()).toEqual(Object.keys(generated).toSorted())
})

test("failed visual setup restores renderer globals and runs registered cleanup", async () => {
  const originalWindow = globalThis.window
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
  let cleaned = false

  await expect(
    renderDocVisual({
      id: "failed-visual",
      label: "Failed visual",
      width: 8,
      height: 2,
      render(setup, registerCleanup) {
        registerCleanup(() => {
          cleaned = setup.renderer.isDestroyed
        })
        throw new Error("Fixture initialization failed")
      },
    }),
  ).rejects.toThrow("Fixture initialization failed")

  expect(cleaned).toBe(true)
  expect(globalThis.window).toBe(originalWindow)
  expect(globalThis.requestAnimationFrame).toBe(originalRequestAnimationFrame)
  expect(globalThis.cancelAnimationFrame).toBe(originalCancelAnimationFrame)
})

test("every registered visual cleanup runs when another cleanup fails", async () => {
  const calls: string[] = []

  await expect(
    renderDocVisual({
      id: "failed-cleanup",
      label: "Failed cleanup",
      width: 8,
      height: 2,
      render(setup, registerCleanup) {
        registerCleanup(() => {
          calls.push(setup.renderer.isDestroyed ? "first" : "renderer still active")
        })
        registerCleanup(() => {
          calls.push("second")
          throw new Error("Cleanup failed")
        })
        registerCleanup(() => {
          calls.push("third")
        })
      },
    }),
  ).rejects.toThrow("Cleanup failed")

  expect(calls).toEqual(["third", "second", "first"])
})

test("detached line-number visuals destroy their owned children after setup failure", async () => {
  const setLineSign = LineNumberRenderable.prototype.setLineSign
  let gutter: LineNumberRenderable | undefined
  let children: Array<{ isDestroyed: boolean }> = []

  LineNumberRenderable.prototype.setLineSign = function (this: LineNumberRenderable) {
    gutter = this
    children = this.getChildren()
    throw new Error("Line sign initialization failed")
  }

  try {
    const fixture = structuredVisuals.find((visual) => visual.id === "line-number-editor")!
    await expect(renderDocVisual(fixture)).rejects.toThrow("Line sign initialization failed")
  } finally {
    LineNumberRenderable.prototype.setLineSign = setLineSign
  }

  expect(gutter?.isDestroyed).toBe(true)
  expect(children).toHaveLength(2)
  expect(children.every((child) => child.isDestroyed)).toBe(true)
})
