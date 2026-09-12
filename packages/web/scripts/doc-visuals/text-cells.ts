import {
  BoxRenderable,
  FrameBufferRenderable,
  RGBA,
  TextBuffer,
  TextBufferView,
  TextRenderable,
  bg,
  bold,
  italic,
  t,
  underline,
} from "@opentui/core"
import type { DocVisualFixture } from "./shared"

const foreground = RGBA.defaultForeground()
const background = RGBA.defaultBackground()
const muted = RGBA.fromIndex(244)
const surface = RGBA.fromIndex(235)
const selection = RGBA.fromIndex(238)

export const textCellVisuals: DocVisualFixture[] = [
  {
    id: "text-styled-chunks",
    label: "Styled chunks: Status is bold, Note is italic, and Next combines bold and underline",
    width: 22,
    height: 3,
    render({ renderer }) {
      const content = t`${bold("Status")}: ready\n${italic("Note")}: saved locally\n${bold(underline("Next"))}: review changes`
      renderer.root.add(new TextRenderable(renderer, { content, fg: foreground, bg: background }))
    },
  },
  {
    id: "text-cell-ruler",
    label:
      "Zero-based display columns: ASCII ABC occupies three cells; A\u754cB occupies four, with \u754c shaded across columns 1 and 2. Each marker follows the text immediately.",
    width: 22,
    height: 3,
    render({ renderer }) {
      renderer.root.add(new TextRenderable(renderer, { content: "column  01234", fg: muted, bg: background }))

      for (const [label, content] of [
        ["ASCII", "ABC"],
        ["wide", t`A${bg(RGBA.fromIndex(238))("\u754c")}B`],
      ]) {
        const row = new BoxRenderable(renderer, { flexDirection: "row", height: 1 })
        renderer.root.add(row)
        row.add(new TextRenderable(renderer, { content: label, width: 8, fg: muted, bg: background }))

        const text = new TextRenderable(renderer, { content, wrapMode: "none", fg: foreground, bg: surface })
        row.add(text)
        row.add(
          new TextRenderable(renderer, { content: `|  ${text.textLength} cells`, fg: foreground, bg: background }),
        )
      }
    },
  },
  {
    id: "text-wide-wrap",
    label:
      "Character wrapping of A\u754cB at widths 2, 3, and 4: the two shaded cells occupied by \u754c move intact to the next row when only one cell remains",
    width: 34,
    height: 5,
    render({ renderer }) {
      const row = new BoxRenderable(renderer, { flexDirection: "row", gap: 2 })
      renderer.root.add(row)

      for (const width of [2, 3, 4]) {
        const column = new BoxRenderable(renderer, { width: 10 })
        row.add(column)
        column.add(new TextRenderable(renderer, { content: `${width} columns`, fg: foreground, bg: background }))
        column.add(new TextRenderable(renderer, { content: "0123".slice(0, width), fg: muted, bg: background }))

        const viewport = new BoxRenderable(renderer, { width, height: 3, backgroundColor: surface })
        column.add(viewport)
        viewport.add(
          new TextRenderable(renderer, {
            content: t`A${bg(RGBA.fromIndex(238))("\u754c")}B`,
            width,
            wrapMode: "char",
            fg: foreground,
            bg: surface,
          }),
        )
      }
    },
  },
  {
    id: "text-line-offsets",
    label:
      "Both three-column views select B: soft-wrapped A\u754cB uses display offsets [3, 4), while A\u754c followed by a newline and B uses [4, 5)",
    width: 35,
    height: 5,
    render({ renderer }, registerCleanup) {
      const row = new BoxRenderable(renderer, { flexDirection: "row", gap: 3 })
      renderer.root.add(row)

      for (const [label, content, start] of [
        ["soft wrap", "A\u754cB", 3],
        ["newline", "A\u754c\nB", 4],
      ] as const) {
        const column = new BoxRenderable(renderer, { width: 16 })
        row.add(column)
        column.add(new TextRenderable(renderer, { content: label, fg: foreground, bg: background }))
        column.add(new TextRenderable(renderer, { content: "012", fg: muted, bg: background }))

        const text = TextBuffer.create(renderer.widthMethod)
        registerCleanup(() => text.destroy())
        const view = TextBufferView.create(text)
        registerCleanup(() => view.destroy())
        text.setText(content)
        text.setDefaultFg(foreground)
        text.setDefaultBg(surface)
        view.setWrapMode("char")
        view.setViewport(0, 0, 3, 2)
        view.setSelection(start, start + 1, selection, foreground)

        const canvas = new FrameBufferRenderable(renderer, { width: 3, height: 2 })
        column.add(canvas)
        canvas.frameBuffer.clear(surface)
        canvas.frameBuffer.drawTextBuffer(view, 0, 0)

        const range = view.getSelection()!
        column.add(
          new TextRenderable(renderer, {
            content: `range [${range.start}, ${range.end})`,
            fg: muted,
            bg: background,
          }),
        )
      }
    },
  },
]
