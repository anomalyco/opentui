import { BoxRenderable, RGBA, TextRenderable, type MouseEvent } from "@opentui/core"
import type { DocVisualFixture } from "./shared"

const foreground = RGBA.defaultForeground()
const background = RGBA.defaultBackground()
const muted = RGBA.fromIndex(244)

export const interactionVisuals: DocVisualFixture[] = [
  {
    id: "interaction-hit-bubbling",
    label: "The overlapping front box receives the hit, bubbles to its parent, then stops a second down event",
    width: 38,
    height: 10,
    async render({ renderer, mockMouse, renderOnce }) {
      const trace: string[] = []
      let target = ""
      let stop = false
      const record = (event: MouseEvent) => {
        target = event.target?.id ?? ""
        trace.push(event.currentTarget!.id)
        if (stop && event.currentTarget!.id === "front") event.stopPropagation()
      }
      const parent = new BoxRenderable(renderer, {
        id: "parent",
        width: 38,
        height: 7,
        border: true,
        borderColor: foreground,
        title: "parent",
        onMouseDown: record,
      })
      renderer.root.add(parent)
      parent.add(
        new BoxRenderable(renderer, {
          id: "back",
          position: "absolute",
          left: 1,
          top: 1,
          width: 24,
          height: 3,
          zIndex: 0,
          border: true,
          borderColor: muted,
          backgroundColor: background,
          title: "back z=0",
          onMouseDown: record,
        }),
      )
      const front = new BoxRenderable(renderer, {
        id: "front",
        position: "absolute",
        left: 10,
        top: 2,
        width: 25,
        height: 3,
        zIndex: 1,
        border: true,
        borderColor: foreground,
        backgroundColor: background,
        title: "front z=1",
        onMouseDown: record,
      })
      parent.add(front)
      const output = new TextRenderable(renderer, { fg: foreground, selectable: false })
      renderer.root.add(output)

      await renderOnce()
      await mockMouse.click(front.x + 2, front.y + 1, undefined, { delayMs: 0 })
      const bubbled = trace.join(" -> ")
      trace.length = 0
      stop = true
      await mockMouse.click(front.x + 2, front.y + 1, undefined, { delayMs: 0 })
      output.content = `target: ${target}\nbubble: ${bubbled}\nstopped: ${trace.join(" -> ")}`
    },
  },
  {
    id: "interaction-drag-selection",
    label: "A drag selects the app on the first line and Test on the second, with text-buffer offsets [6, 18)",
    width: 32,
    height: 5,
    async render({ renderer, mockMouse, renderOnce }) {
      const layout = new BoxRenderable(renderer, { width: 32, height: 5, gap: 1 })
      renderer.root.add(layout)
      const text = new TextRenderable(renderer, {
        content: "Build the app\nTest the input",
        height: 2,
        fg: foreground,
        bg: background,
        selectionBg: RGBA.fromIndex(238),
        selectionFg: foreground,
      })
      layout.add(text)
      const output = new TextRenderable(renderer, { height: 2, fg: muted, selectable: false })
      layout.add(output)

      await renderOnce()
      await mockMouse.drag(text.x + 6, text.y, text.x + 3, text.y + 1, undefined, { delayMs: 0 })
      const selected = renderer.getSelection()?.getSelectedText()
      const range = text.getSelection()
      output.content = `Selected: ${JSON.stringify(selected)}\nRange: [${range?.start}, ${range?.end})`
    },
  },
]
