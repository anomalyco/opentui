import {
  BoxRenderable,
  FrameBufferRenderable,
  RGBA,
  TextRenderable,
  bold,
  fg,
  italic,
  t,
  underline,
} from "@opentui/core"
import type { DocVisualFixture } from "./shared"

const foreground = RGBA.defaultForeground()
const muted = RGBA.fromIndex(244)

export const foundationVisuals: DocVisualFixture[] = [
  {
    id: "text-attributes",
    label: "Text attributes applied to bold, italic, and underlined content",
    width: 30,
    height: 3,
    render({ renderer }) {
      for (const content of [
        t`${fg(muted)("bold       ")}${bold("Important message")}`,
        t`${fg(muted)("italic     ")}${italic("Additional context")}`,
        t`${fg(muted)("underline  ")}${underline("Documentation")}`,
      ]) {
        renderer.root.add(new TextRenderable(renderer, { content, fg: foreground }))
      }
    },
  },
  {
    id: "box-title-alignment",
    label: "Box with a centered top title and right-aligned bottom title",
    width: 32,
    height: 3,
    render({ renderer }) {
      const box = new BoxRenderable(renderer, {
        width: 32,
        height: 3,
        border: true,
        borderColor: foreground,
        title: "settings",
        titleAlignment: "center",
        bottomTitle: "close",
        bottomTitleAlignment: "right",
        paddingX: 1,
      })

      box.add(new TextRenderable(renderer, { content: "Top and bottom titles", fg: muted }))
      renderer.root.add(box)
    },
  },
  {
    id: "color-palette",
    label:
      "OpenTUI's 256-color fallback palette: 16 terminal colors, six red-level slices of the RGB cube, and 24 grays. Blue increases rightward and green downward within each slice.",
    width: 38,
    height: 22,
    render({ renderer }) {
      const canvas = new FrameBufferRenderable(renderer, { width: 38, height: 22 })
      renderer.root.add(canvas)
      const buffer = canvas.frameBuffer
      const background = RGBA.defaultBackground()
      buffer.clear(background)

      buffer.drawText("0-15    terminal colors", 0, 0, foreground, background)
      // Freeze the fallback snapshots instead of applying the page's semantic palette overrides.
      for (let index = 0; index < 16; index++) {
        const color = RGBA.fromInts(...RGBA.fromIndex(index).toInts())
        buffer.drawText("\u2588\u2588", index * 2, 1, color, color)
      }

      buffer.drawText("16-231  RGB cube", 0, 3, foreground, background)
      for (let red = 0; red < 6; red++) {
        const left = (red % 3) * 13
        const top = 5 + Math.floor(red / 3) * 8
        const redLevel = RGBA.fromIndex(16 + red * 36).toInts()[0]
        buffer.drawText(`R=${redLevel}`, left, top - 1, muted, background)

        for (let green = 0; green < 6; green++) {
          for (let blue = 0; blue < 6; blue++) {
            const index = 16 + red * 36 + green * 6 + blue
            const color = RGBA.fromInts(...RGBA.fromIndex(index).toInts())
            buffer.drawText("\u2588\u2588", left + blue * 2, top + green, color, color)
          }
        }
      }

      buffer.drawText("232-255 grayscale", 0, 20, foreground, background)
      for (let index = 232; index < 256; index++) {
        const color = RGBA.fromInts(...RGBA.fromIndex(index).toInts())
        buffer.drawText("\u2588", index - 232, 21, color, color)
      }
    },
  },
  {
    id: "color-alpha",
    label:
      "Green #22c55e over a gray checkerboard at alpha 0, 0.25, 0.5, 0.75, and 1. The checkerboard remains visible through translucent tiles and disappears at alpha 1.",
    width: 34,
    height: 4,
    render({ renderer }) {
      const canvas = new FrameBufferRenderable(renderer, { width: 34, height: 4 })
      renderer.root.add(canvas)
      const buffer = canvas.frameBuffer
      const background = RGBA.defaultBackground()
      const checks = [RGBA.fromHex("#e0e0e0"), RGBA.fromHex("#a0a0a0")]
      buffer.clear(background)

      for (const [index, alpha] of [0, 0.25, 0.5, 0.75, 1].entries()) {
        const left = index * 7

        for (let y = 0; y < 3; y++) {
          for (let x = 0; x < 6; x += 2) {
            buffer.fillRect(left + x, y, 2, 1, checks[(x / 2 + y) % 2])
          }
        }

        const overlay = RGBA.fromHex("#22c55e")
        overlay.a = alpha
        buffer.fillRect(left, 0, 6, 3, overlay)
        buffer.drawText(alpha.toFixed(2), left + 1, 3, foreground, background)
      }
    },
  },
]
