import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createTestRenderer, MouseButtons, type MockMouse, type TestRenderer } from "../testing.js"
import { Renderable, type RenderableOptions } from "../Renderable.js"
import { link, t } from "../lib/styled-text.js"
import { TextRenderable } from "../renderables/Text.js"
import type { MouseEvent } from "../renderer.js"
import { settleUntil } from "../testing/harness.js"
import { RecordingWriteStream } from "../testing/test-streams.js"
import { TextAttributes, type RenderContext } from "../types.js"
import type { Selection } from "../lib/selection.js"
import { getLinkId } from "../utils.js"

class TestRenderable extends Renderable {
  public selectionActive = false

  constructor(ctx: RenderContext, options: RenderableOptions) {
    super(ctx, options)
  }

  public shouldStartSelection(_x: number, _y: number): boolean {
    return this.selectable
  }

  public onSelectionChanged(selection: Selection | null): boolean {
    this.selectionActive = !!selection?.isActive
    return this.selectionActive
  }
}

describe("renderer getLinkAt", () => {
  let renderer: TestRenderer
  let mockMouse: MockMouse
  let renderOnce: () => Promise<void>

  beforeEach(async () => {
    ;({ renderer, mockMouse, renderOnce } = await createTestRenderer({ width: 12, height: 5, useMouse: true }))
  })

  afterEach(() => renderer.destroy())

  test("resolves rendered and clicked links while rejecting invalid coordinates and destroyed renderers", async () => {
    const url = "https://example.com/rendered"
    const content = t`A ${link(url)("link")} ${link("https://example.com/second")("two")}`
    const text = new TextRenderable(renderer, {
      id: "linked-text",
      position: "absolute",
      left: 2,
      top: 1,
      width: 10,
      height: 1,
      content,
    })
    const clicked: { url: string | null } = { url: null }
    text.onMouseDown = (event) => {
      clicked.url = renderer.getLinkAt(event.x, event.y)
    }
    renderer.root.add(text)
    await renderOnce()

    const linkX = text.x + 2
    const linkId = renderer.getLinkIdAt(linkX, text.y)
    expect(linkId).toBeGreaterThan(0)
    expect(renderer.getLinkIdAt(linkX + 3, text.y)).toBe(linkId)
    expect(renderer.getLinkAt(linkX, text.y)).toBe(url)
    expect(renderer.getLinkAt(linkX + 3, text.y)).toBe(url)
    expect(renderer.getLinkIdAt(text.x, text.y)).toBe(0)
    expect(renderer.getLinkAt(text.x, text.y)).toBeNull()
    expect(renderer.getLinkIdAt(renderer.width - 1, renderer.height - 1)).toBe(0)
    expect(renderer.getLinkAt(renderer.width - 1, renderer.height - 1)).toBeNull()

    const lib = renderer.currentRenderBuffer.lib
    const urlLookups = spyOn(lib, "contextGetLinkUrl")
    const styledTextUpdates = spyOn(lib, "sceneSetStyledText")

    try {
      let hoveredLinkId = 0
      text.onMouseMove = (event) => {
        hoveredLinkId = renderer.getLinkIdAt(event.x, event.y)
        renderer.setMousePointer(hoveredLinkId ? "pointer" : "default")
        renderer.requestRender()
      }
      renderer.addPostProcessFn((buffer) => {
        if (!hoveredLinkId) return
        const attributes = buffer.buffers.attributes
        for (let index = 0; index < attributes.length; index++) {
          if (getLinkId(attributes[index]!) === hoveredLinkId) attributes[index] |= TextAttributes.UNDERLINE
        }
      })

      for (const [x, first, second] of [
        [linkX, true, false],
        [linkX + 5, false, true],
        [linkX + 4, false, false],
      ] as const) {
        await mockMouse.moveTo(x, text.y)
        await renderOnce()
        const start = text.y * renderer.width + text.x
        expect(
          renderer.currentRenderBuffer.withBuffers((cells) =>
            Array.from(cells.attributes.subarray(start, start + text.width), (attributes) =>
              Boolean(attributes & TextAttributes.UNDERLINE),
            ),
          ),
        ).toEqual([false, false, first, first, first, first, false, second, second, second])
      }

      expect(text.content).toBe(content)
      expect(styledTextUpdates).toHaveBeenCalledTimes(0)
      expect(urlLookups).toHaveBeenCalledTimes(0)

      await mockMouse.pressDown(linkX, text.y)
      expect(clicked.url).toBe(url)
      expect(urlLookups).toHaveBeenCalledTimes(1)
    } finally {
      styledTextUpdates.mockRestore()
      urlLookups.mockRestore()
    }

    renderer.useMouse = false
    expect(renderer.getLinkIdAt(linkX, text.y)).toBe(linkId)
    expect(renderer.getLinkAt(linkX, text.y)).toBe(url)

    for (const [x, y] of [
      [-1, 0],
      [0, -1],
      [renderer.width, 0],
      [0, renderer.height],
      [Number.NaN, 0],
      [0, Number.NaN],
      [Number.POSITIVE_INFINITY, 0],
      [0, Number.NEGATIVE_INFINITY],
      [0.5, 0],
      [0, 0.5],
    ]) {
      expect(renderer.getLinkIdAt(x, y)).toBe(0)
      expect(renderer.getLinkAt(x, y)).toBeNull()
    }

    renderer.destroy()
    expect(renderer.getLinkIdAt(0, 0)).toBe(0)
    expect(renderer.getLinkAt(0, 0)).toBeNull()
  })

  test("resolves linked cells after wrapping and across wide-character cells", async () => {
    const url = "https://example.com/wrapped"
    const text = new TextRenderable(renderer, {
      id: "wrapped-link",
      position: "absolute",
      left: 1,
      top: 1,
      width: 4,
      height: 2,
      wrapMode: "char",
      content: t`${link(url)("ab\u754cde")}`,
    })
    renderer.root.add(text)
    await renderOnce()

    const linkId = renderer.getLinkIdAt(text.x, text.y)
    expect(linkId).toBeGreaterThan(0)
    for (const [x, y] of [
      [text.x, text.y],
      [text.x + 2, text.y],
      [text.x + 3, text.y],
      [text.x, text.y + 1],
      [text.x + 1, text.y + 1],
    ]) {
      expect(renderer.getLinkIdAt(x, y)).toBe(linkId)
      expect(renderer.getLinkAt(x, y)).toBe(url)
    }
    // Coordinates outside the i32 cell range, fractions, and NaN never reach native lookup.
    for (const [x, y] of [
      [text.x + 0.5, text.y],
      [-1, text.y],
      [text.x, -1],
      [2 ** 31, text.y],
      [NaN, text.y],
    ]) {
      expect(renderer.getLinkIdAt(x, y)).toBe(0)
      expect(renderer.getLinkAt(x, y)).toBeNull()
    }
    renderer.destroy()
    expect(renderer.getLinkIdAt(text.x, text.y)).toBe(0)
  })
})

describe("renderer getLinkAt during presentation", () => {
  test("resolves a link click while frame output is still pending", async () => {
    const stdout = new RecordingWriteStream(12, 5)
    const { renderer, mockMouse, renderOnce } = await createTestRenderer({
      width: 12,
      height: 5,
      useMouse: true,
      stdout: stdout as unknown as NodeJS.WriteStream,
      bufferedOutput: "stdout",
    })
    let pendingFrame: Promise<void> | undefined
    try {
      const url = "https://example.com/pending"
      const clicked: { url: string | null } = { url: null }
      const text = new TextRenderable(renderer, {
        id: "pending-link",
        position: "absolute",
        left: 0,
        top: 0,
        width: 12,
        height: 1,
        content: t`${link(url)("link")}`,
        onMouseDown: (event) => {
          clicked.url = renderer.getLinkAt(event.x, event.y)
        },
      })
      renderer.root.add(text)
      await renderOnce()

      stdout.hold()
      renderer.setBackgroundColor("#111111")
      pendingFrame = renderOnce()
      await settleUntil(() => stdout.pendingWrite)

      let linkX = -1
      let linkY = -1
      for (let y = 0; y < renderer.height && linkX < 0; y++) {
        for (let x = 0; x < renderer.width; x++) {
          if (renderer.getLinkIdAt(x, y) !== 0) {
            linkX = x
            linkY = y
            break
          }
        }
      }
      expect(linkX).toBeGreaterThanOrEqual(0)
      expect(renderer.getLinkAt(linkX, linkY)).toBe(url)

      await mockMouse.pressDown(linkX, linkY)
      expect(clicked.url).toBe(url)
    } finally {
      stdout.release()
      await pendingFrame?.catch(() => {})
      renderer.destroy()
      await renderer.closed.catch(() => {})
    }
  })
})

describe("renderer handleMouseData", () => {
  let renderer: TestRenderer
  let mockMouse: MockMouse
  let renderOnce: () => Promise<void>

  beforeEach(async () => {
    ;({ renderer, mockMouse, renderOnce } = await createTestRenderer({ width: 40, height: 20 }))
  })
  test("non-mouse input falls through to input handlers", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "input-target",
        position: "absolute",
        left: 1,
        top: 1,
        width: 6,
        height: 4,
      })
      renderer.root.add(target)
      await renderOnce()

      const sequences: string[] = []
      renderer.prependInputHandler((sequence) => {
        sequences.push(sequence)
        return true
      })

      let mouseDown = false
      target.onMouseDown = () => {
        mouseDown = true
      }

      renderer.stdin.emit("data", Buffer.from("x"))
      await Promise.resolve()

      expect(sequences).toContain("x")
      expect(mouseDown).toBe(false)
    } finally {
      renderer.destroy()
    }
  })

  test("non-mouse buffers are routed to input handlers", async () => {
    try {
      const sequences: string[] = []
      renderer.prependInputHandler((sequence) => {
        sequences.push(sequence)
        return true
      })

      renderer.stdin.emit("data", Buffer.from("x"))
      await Promise.resolve()

      expect(sequences).toContain("x")
    } finally {
      renderer.destroy()
    }
  })

  test("dispatches mouse down/up to hit-tested renderable", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "target",
        position: "absolute",
        left: 2,
        top: 3,
        width: 6,
        height: 4,
      })
      renderer.root.add(target)
      await renderOnce()

      const events: Array<{ type: string; x: number; y: number; button: number }> = []
      target.onMouseDown = (event) => {
        events.push({ type: event.type, x: event.x, y: event.y, button: event.button })
      }
      target.onMouseUp = (event) => {
        events.push({ type: event.type, x: event.x, y: event.y, button: event.button })
      }

      const clickX = target.x + 1
      const clickY = target.y + 1
      await mockMouse.click(clickX, clickY)

      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({ type: "down", x: clickX, y: clickY, button: 0 })
      expect(events[1]).toMatchObject({ type: "up", x: clickX, y: clickY, button: 0 })
    } finally {
      renderer.destroy()
    }
  })

  test("emits over/out only when hover target changes", async () => {
    try {
      const left = new TestRenderable(renderer, {
        id: "left",
        position: "absolute",
        left: 1,
        top: 1,
        width: 6,
        height: 4,
      })
      const right = new TestRenderable(renderer, {
        id: "right",
        position: "absolute",
        left: 10,
        top: 1,
        width: 6,
        height: 4,
      })
      renderer.root.add(left)
      renderer.root.add(right)
      await renderOnce()

      const hoverEvents: string[] = []
      left.onMouseOver = () => hoverEvents.push("over:left")
      left.onMouseOut = () => hoverEvents.push("out:left")
      right.onMouseOver = () => hoverEvents.push("over:right")
      right.onMouseOut = () => hoverEvents.push("out:right")

      await mockMouse.moveTo(left.x + 1, left.y + 1)
      await mockMouse.moveTo(right.x + 1, right.y + 1)
      await mockMouse.moveTo(right.x + 2, right.y + 1)

      expect(hoverEvents).toEqual(["over:left", "out:left", "over:right"])
    } finally {
      renderer.destroy()
    }
  })

  test("moving off a renderable emits out without a new target", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "hover-target",
        position: "absolute",
        left: 1,
        top: 1,
        width: 6,
        height: 4,
      })
      renderer.root.add(target)
      await renderOnce()

      const hoverEvents: string[] = []
      target.onMouseOver = () => hoverEvents.push("over")
      target.onMouseOut = () => hoverEvents.push("out")

      await mockMouse.moveTo(target.x + 1, target.y + 1)
      await mockMouse.moveTo(renderer.width - 1, renderer.height - 1)

      expect(hoverEvents).toEqual(["over", "out"])
    } finally {
      renderer.destroy()
    }
  })

  test("scroll events are delivered to the hit-tested renderable", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "scroll-target",
        position: "absolute",
        left: 4,
        top: 2,
        width: 8,
        height: 4,
      })
      renderer.root.add(target)
      await renderOnce()

      let scrollEvent: MouseEvent | null = null
      target.onMouseScroll = (event) => {
        scrollEvent = event
      }

      await mockMouse.scroll(target.x + 1, target.y + 1, "down")

      expect(scrollEvent).not.toBeNull()
      expect(scrollEvent!.type).toBe("scroll")
      expect(scrollEvent!.scroll?.direction).toBe("down")
      expect(scrollEvent!.scroll?.delta).toBe(1)
    } finally {
      renderer.destroy()
    }
  })

  test("scroll outside renderables does not dispatch events when nothing is focused", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "scroll-target",
        position: "absolute",
        left: 1,
        top: 1,
        width: 5,
        height: 4,
      })
      renderer.root.add(target)
      await renderOnce()

      let scrollCount = 0
      target.onMouseScroll = () => {
        scrollCount++
      }

      await mockMouse.scroll(renderer.width - 1, renderer.height - 1, "down")
      expect(scrollCount).toBe(0)
    } finally {
      renderer.destroy()
    }
  })

  test("scroll outside hit target falls back to focused renderable", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "focused-scroll-target",
        position: "absolute",
        left: 1,
        top: 1,
        width: 5,
        height: 4,
      })
      renderer.root.add(target)
      await renderOnce()

      let scrollCount = 0
      let lastDirection: string | undefined
      target.onMouseScroll = (event) => {
        scrollCount++
        lastDirection = event.scroll?.direction
      }

      target.focusable = true
      target.focus()
      await mockMouse.scroll(renderer.width - 1, renderer.height - 1, "down")

      expect(scrollCount).toBe(1)
      expect(lastDirection).toBe("down")
    } finally {
      renderer.destroy()
    }
  })

  test("console mouse handling consumes events inside console bounds", async () => {
    try {
      renderer.consoleMode = "console-overlay"
      renderer.console.show()

      const target = new TestRenderable(renderer, {
        id: "background",
        position: "absolute",
        left: 0,
        top: 0,
        width: renderer.width,
        height: renderer.height,
      })
      renderer.root.add(target)
      await renderOnce()

      let clicks = 0
      target.onMouseDown = () => {
        clicks++
      }

      const bounds = renderer.console.bounds
      const insideX = Math.min(bounds.x + 1, renderer.width - 1)
      const insideY = Math.min(bounds.y + 1, renderer.height - 1)
      await mockMouse.click(insideX, insideY)
      expect(clicks).toBe(0)

      const outsideY = bounds.y > 0 ? bounds.y - 1 : Math.min(bounds.y + bounds.height, renderer.height - 1)
      await mockMouse.click(insideX, outsideY)
      expect(clicks).toBe(1)
    } finally {
      renderer.destroy()
    }
  })

  test("console mouse handling falls through when not handled", async () => {
    try {
      renderer.consoleMode = "console-overlay"
      renderer.console.show()

      const target = new TestRenderable(renderer, {
        id: "background",
        position: "absolute",
        left: 0,
        top: 0,
        width: renderer.width,
        height: renderer.height,
      })
      renderer.root.add(target)
      await renderOnce()

      const originalHandle = renderer.console.handleMouse.bind(renderer.console)
      let consoleCalls = 0
      renderer.console.handleMouse = () => {
        consoleCalls++
        return false
      }

      let clicks = 0
      target.onMouseDown = () => {
        clicks++
      }

      const bounds = renderer.console.bounds
      const insideX = Math.min(bounds.x + 1, renderer.width - 1)
      const insideY = Math.min(bounds.y + 1, renderer.height - 1)
      await mockMouse.pressDown(insideX, insideY)

      const outsideY = bounds.y > 0 ? bounds.y - 1 : Math.min(bounds.y + bounds.height, renderer.height - 1)
      await mockMouse.release(insideX, outsideY)

      expect(consoleCalls).toBe(1)
      expect(clicks).toBe(1)

      renderer.console.handleMouse = originalHandle
    } finally {
      renderer.destroy()
    }
  })

  test("selection drag ignores right-button release and ends on left mouse up", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "selectable",
        position: "absolute",
        left: 2,
        top: 2,
        width: 12,
        height: 6,
      })
      target.selectable = true
      renderer.root.add(target)
      await renderOnce()

      let dragEvent: MouseEvent | null = null
      let upEvent: MouseEvent | null = null
      target.onMouseDrag = (event) => {
        dragEvent = event
      }
      target.onMouseUp = (event) => {
        upEvent = event
      }

      const startX = target.x + 1
      const startY = target.y + 1
      const endX = target.x + 6
      const endY = target.y + 3

      await mockMouse.pressDown(startX, startY)
      await mockMouse.click(startX, startY, MouseButtons.RIGHT)
      expect(renderer.getSelection()?.isDragging).toBe(true)

      await mockMouse.moveTo(endX, endY)
      expect(renderer.getSelection()?.focus).toEqual({ x: endX, y: endY })
      await mockMouse.release(endX, endY)

      expect(renderer.hasSelection).toBe(true)
      expect(dragEvent).not.toBeNull()
      expect(upEvent).not.toBeNull()
      expect(dragEvent!.isDragging).toBe(true)
      expect(upEvent!.isDragging).toBe(true)
      expect(renderer.getSelection()?.isDragging).toBe(false)
    } finally {
      renderer.destroy()
    }
  })

  test("selection drag updates focus even when pointer leaves renderables", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "selectable",
        position: "absolute",
        left: 1,
        top: 1,
        width: 6,
        height: 4,
      })
      target.selectable = true
      renderer.root.add(target)
      await renderOnce()

      let dragCount = 0
      let upCount = 0
      target.onMouseDrag = () => {
        dragCount++
      }
      target.onMouseUp = () => {
        upCount++
      }

      const startX = target.x + 1
      const startY = target.y + 1
      const endX = renderer.width - 1
      const endY = renderer.height - 1

      await mockMouse.pressDown(startX, startY)
      await mockMouse.moveTo(endX, endY)
      await mockMouse.release(endX, endY)

      const selection = renderer.getSelection()
      expect(selection).not.toBeNull()
      expect(selection?.focus).toEqual({ x: endX, y: endY })
      expect(dragCount).toBe(0)
      expect(upCount).toBe(0)
    } finally {
      renderer.destroy()
    }
  })

  test("ctrl+click extends selection instead of clearing", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "selectable-ctrl",
        position: "absolute",
        left: 2,
        top: 2,
        width: 12,
        height: 6,
      })
      target.selectable = true
      renderer.root.add(target)
      await renderOnce()

      await mockMouse.drag(target.x + 1, target.y + 1, target.x + 4, target.y + 1)
      const selectionBefore = renderer.getSelection()
      expect(selectionBefore).not.toBeNull()

      const nextX = target.x + 2
      const nextY = target.y + 4
      await mockMouse.pressDown(nextX, nextY, MouseButtons.LEFT, { modifiers: { ctrl: true } })
      await mockMouse.release(nextX, nextY, MouseButtons.LEFT, { modifiers: { ctrl: true } })

      const selectionAfter = renderer.getSelection()
      expect(selectionAfter).not.toBeNull()
      expect(selectionAfter?.focus).toEqual({ x: nextX, y: nextY })
      expect(renderer.hasSelection).toBe(true)
    } finally {
      renderer.destroy()
    }
  })

  test("ctrl+click with selection updates focus without mouse down", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "selectable-ctrl-branch",
        position: "absolute",
        left: 2,
        top: 2,
        width: 12,
        height: 6,
      })
      target.selectable = true
      renderer.root.add(target)
      await renderOnce()

      await mockMouse.drag(target.x + 1, target.y + 1, target.x + 4, target.y + 1)
      expect(renderer.getSelection()).not.toBeNull()

      let downCount = 0
      target.onMouseDown = () => {
        downCount++
      }

      const nextX = target.x + 2
      const nextY = target.y + 4
      await mockMouse.pressDown(nextX, nextY, MouseButtons.LEFT, { modifiers: { ctrl: true } })

      expect(renderer.getSelection()?.isDragging).toBe(true)
      expect(downCount).toBe(0)

      await mockMouse.release(nextX, nextY, MouseButtons.LEFT, { modifiers: { ctrl: true } })
    } finally {
      renderer.destroy()
    }
  })

  test("ctrl+click with selection does not auto-focus", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "selectable-ctrl-focus",
        position: "absolute",
        left: 2,
        top: 2,
        width: 12,
        height: 6,
      })
      target.selectable = true
      renderer.root.add(target)
      await renderOnce()

      await mockMouse.drag(target.x + 1, target.y + 1, target.x + 4, target.y + 1)
      expect(renderer.getSelection()).not.toBeNull()

      target.focusable = true
      expect(target.focused).toBe(false)

      const nextX = target.x + 2
      const nextY = target.y + 4
      await mockMouse.pressDown(nextX, nextY, MouseButtons.LEFT, { modifiers: { ctrl: true } })
      await mockMouse.release(nextX, nextY, MouseButtons.LEFT, { modifiers: { ctrl: true } })

      expect(target.focused).toBe(false)
    } finally {
      renderer.destroy()
    }
  })

  test("right click does not start selection", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "right-click",
        position: "absolute",
        left: 2,
        top: 2,
        width: 8,
        height: 4,
      })
      target.selectable = true
      renderer.root.add(target)
      await renderOnce()

      await mockMouse.click(target.x + 1, target.y + 1, MouseButtons.RIGHT)
      expect(renderer.hasSelection).toBe(false)
    } finally {
      renderer.destroy()
    }
  })

  test("preventDefault keeps selection while empty click clears it", async () => {
    try {
      const selectable = new TestRenderable(renderer, {
        id: "selectable-main",
        position: "absolute",
        left: 2,
        top: 2,
        width: 12,
        height: 6,
      })
      selectable.selectable = true
      renderer.root.add(selectable)

      const blocker = new TestRenderable(renderer, {
        id: "blocker",
        position: "absolute",
        left: 20,
        top: 2,
        width: 8,
        height: 4,
      })
      renderer.root.add(blocker)
      await renderOnce()

      await mockMouse.drag(selectable.x + 1, selectable.y + 1, selectable.x + 4, selectable.y + 1)
      expect(renderer.hasSelection).toBe(true)

      blocker.onMouseDown = (event) => {
        event.preventDefault()
      }
      await mockMouse.click(blocker.x + 1, blocker.y + 1)
      expect(renderer.hasSelection).toBe(true)

      await mockMouse.click(renderer.width - 1, renderer.height - 1)
      expect(renderer.hasSelection).toBe(false)
    } finally {
      renderer.destroy()
    }
  })

  test("clicking another renderable clears selection when not prevented", async () => {
    try {
      const selectable = new TestRenderable(renderer, {
        id: "selectable-clear",
        position: "absolute",
        left: 2,
        top: 2,
        width: 10,
        height: 5,
      })
      selectable.selectable = true
      renderer.root.add(selectable)

      const other = new TestRenderable(renderer, {
        id: "other",
        position: "absolute",
        left: 20,
        top: 2,
        width: 6,
        height: 4,
      })
      renderer.root.add(other)
      await renderOnce()

      await mockMouse.drag(selectable.x + 1, selectable.y + 1, selectable.x + 4, selectable.y + 1)
      expect(renderer.hasSelection).toBe(true)

      await mockMouse.click(other.x + 1, other.y + 1)
      expect(renderer.hasSelection).toBe(false)
    } finally {
      renderer.destroy()
    }
  })

  // Steps: `move|down|drag|up|scroll:x,y[:right|:ctrl]`, `frame` (render once), `kill:id` (destroy), `clear`
  // (clearSelection), `console` (show it), `hide:id`, or `quit` (the next drag-end destroys the renderer). A spans x 1-6
  // above D at x 1-3, B x 12-17, and selectable S x 20-25, all y 1-4; B clips its child C at x 16-19, y 1-2, which
  // prevents its presses. Each node logs `id:type`, `/x` for a drag-end, then `@target` when the event bubbled and
  // `(source id)` when it names a drag source.
  const pointerPaths: [string, string, string][] = [
    [
      "left drag captures the source until release",
      "move:2,2 down:2,2 drag:3,2 drag:13,2 drag:14,2 up:14,2",
      "A:over A:move A:down A:drag B:over(A) A:drag A:drag A:drag-end/14 A:up B:drop(A) B:up",
    ],
    [
      "right drag routes by hit test",
      "move:2,2 down:2,2:right drag:13,2 drag:3,2 up:3,2:right",
      "A:over A:move A:down A:out B:over B:drag B:out A:over A:drag A:up",
    ],
    [
      "release on empty space skips drop",
      "down:2,2 drag:3,2 drag:39,19 up:39,19",
      "A:down A:drag A:drag A:drag-end/39 A:up",
    ],
    [
      "first drag report off the pressed node",
      "down:2,2 scroll:13,2 drag:13,2 frame drag:14,2 up:14,2",
      "A:down B:scroll B:over A:drag A:drag A:drag-end/14 A:up B:drop(A) B:up",
    ],
    [
      "destroyed pressed node falls back to the hit",
      "down:2,2 kill:A drag:13,2 drag:14,2 up:14,2",
      "A:down B:over B:drag B:drag B:drag-end/14 B:up",
    ],
    ["release off the pressed node without a drag report", "down:2,2 up:13,2", "A:down B:up"],
    [
      "left drag after a right release",
      "down:2,2 up:2,2:right drag:13,2 up:13,2",
      "A:down A:up B:over A:drag A:drag-end/13 A:up B:drop(A) B:up",
    ],
    [
      "right press during a left press",
      "down:2,2 down:13,2:right drag:14,2 up:14,2 up:14,2:right",
      "A:down B:down A:drag A:drag-end/14 A:up B:drop(A) B:up B:up",
    ],
    [
      "press that starts a selection",
      "down:2,2 down:21,2 clear drag:13,2 up:13,2",
      "A:down S:down B:over B:drag B:drag-end/13 B:up",
    ],
    [
      "ctrl press that extends a selection",
      "down:21,2 drag:22,2 up:22,2 down:2,2:ctrl clear drag:13,2 up:13,2",
      "S:down S:drag S:up B:over B:drag B:drag-end/13 B:up",
    ],
    [
      "release in the console ends the press",
      "down:2,2 console drag:2,17 up:2,17 down:3,17 drag:13,2 up:13,2",
      "A:down B:over B:drag B:drag-end/13 B:up",
    ],
    [
      "release over a child of the source",
      "down:13,2 drag:14,2 frame drag:16,1 up:16,1",
      "B:down B:drag C:over(B) B:over@C(B) B:drag B:drag-end/16 B:up",
    ],
    // A left press while a gesture is held means its release was lost: the press ends that gesture as a release at the
    // last drag point would, without a drop, and goes to the node the presented frame shows under the pointer.
    [
      "press on a covering source after a lost release and a frame",
      "down:5,2 drag:4,2 frame down:2,2 up:2,2",
      "A:down A:drag A:drag-end/4 A:up A:down A:up",
    ],
    [
      "press where a hidden source was after a lost release",
      "down:5,2 drag:4,2 hide:A frame down:5,2",
      "A:down A:drag A:drag-end/4 A:up",
    ],
    [
      "press outside a clipped source after a lost release",
      "down:16,1 drag:17,1 frame down:18,1",
      "C:down B:down@C C:drag B:drag@C C:drag-end/17 B:drag-end/17@C C:up B:up@C",
    ],
    [
      "press on a child, then on the child source, after lost releases",
      "down:13,2 drag:14,2 down:16,1 drag:17,1 frame down:16,1",
      "B:down B:drag B:drag-end/14 B:up C:down B:down@C C:drag B:drag@C C:drag-end/17 B:drag-end/17@C C:up B:up@C C:down B:down@C",
    ],
    [
      "ctrl press after a lost release",
      "down:2,2 drag:3,2 down:13,2:ctrl up:13,2",
      "A:down A:drag A:drag-end/3 A:up B:down B:up",
    ],
    [
      "press that starts a selection after a lost selection release",
      "down:21,2 drag:22,2 down:23,2 drag:24,2 up:24,2",
      "S:down S:drag S:down S:drag S:up",
    ],
    [
      "prevented press after a lost selection release",
      "down:21,2 drag:22,2 down:16,1 drag:17,1 up:17,1",
      "S:down S:drag C:down B:down@C C:drag B:drag@C C:drag-end/17 B:drag-end/17@C C:up B:up@C",
    ],
    [
      "press after a lost release whose drag-end quits",
      "down:2,2 drag:3,2 quit down:13,2",
      "A:down A:drag A:drag-end/3",
    ],
  ]

  test.each(pointerPaths)("pointer path: %s", async (_, steps, expected) => {
    try {
      const log: string[] = []
      let quit = false
      const nodes = new Map<string, TestRenderable>()
      for (const [id, left, top, width, parent] of [
        ["D", 1, 1, 3, ""],
        ["A", 1, 1, 6, ""],
        ["B", 12, 1, 6, ""],
        ["S", 20, 1, 6, ""],
        ["C", 4, 0, 4, "B"],
      ] as const) {
        const node = new TestRenderable(renderer, {
          id,
          position: "absolute",
          left,
          top,
          width,
          height: id === "C" ? 2 : 4,
          overflow: id === "B" ? "hidden" : "visible",
        })
        node.selectable = id === "S"
        node.onMouse = (event) => {
          if (id === "C" && event.type === "down") event.preventDefault()
          log.push(
            `${id}:${event.type}${event.type === "drag-end" ? `/${event.x}` : ""}${event.target === node ? "" : `@${event.target?.id}`}${event.source ? `(${event.source.id})` : ""}`,
          )
          if (quit && event.type === "drag-end") renderer.destroy()
        }
        ;(nodes.get(parent) ?? renderer.root).add(node)
        nodes.set(id, node)
      }
      await renderOnce()
      for (const step of steps.split(" ")) {
        const [kind, at, button] = step.split(":")
        const [x, y] = (at ?? "").split(",").map(Number)
        const pressed = button === "right" ? MouseButtons.RIGHT : MouseButtons.LEFT
        if (kind === "frame") await renderOnce()
        else if (kind === "kill") nodes.get(at)!.destroy()
        else if (kind === "hide") nodes.get(at)!.visible = false
        else if (kind === "clear") renderer.clearSelection()
        else if (kind === "console") renderer.console.show()
        else if (kind === "quit") quit = true
        else if (kind === "scroll") await mockMouse.scroll(x, y, "up")
        else if (kind === "move" || kind === "drag") await mockMouse.moveTo(x, y)
        else if (kind === "down") await mockMouse.pressDown(x, y, pressed, { modifiers: { ctrl: button === "ctrl" } })
        else await mockMouse.release(x, y, pressed)
      }
      expect(log.join(" ")).toBe(expected)
      expect(renderer["hasLoggedStdinParserError"]).toBe(false)
    } finally {
      renderer.destroy()
    }
  })

  // The pointer moves between rows 0 and 1. A press while another is held means its release was lost. CI: every
  // trace of MOUSE_MODEL_DEPTH (6) events, then MOUSE_MODEL_SEEDS (24) traces of 24 events.
  test("each press owns its gesture, also after a lost release", async () => {
    const log: string[] = []
    const nodes = [0, 1].map((y) => {
      const node = new TestRenderable(renderer, { id: `${y}`, position: "absolute", top: y, width: 4, height: 1 })
      node.onMouse = (event) => !["over", "out", "move"].includes(event.type) && log.push(`${event.type}:${y}`)
      renderer.root.add(node)
      return node
    })
    await renderOnce()
    const check = async (trace: string[]) => {
      await mockMouse.release(0, 0)
      let [y, owner, dragging] = [0, -1, false]
      const [actual, model]: string[][] = [[], []]
      for (const step of trace) {
        const expected: string[] = []
        log.length = 0
        if (step === "press") {
          if (dragging) expected.push(`drag-end:${owner}`, `up:${owner}`)
          expected.push(`down:${y}`)
          await mockMouse.pressDown(0, y)
          ;[owner, dragging] = [y, false]
        } else if (step === "release") {
          if (!dragging) expected.push(`up:${y}`)
          else expected.push(`drag-end:${owner}`, `up:${owner}`, ...(y === owner ? [] : [`drop:${y}`, `up:${y}`]))
          await mockMouse.release(0, y)
          ;[owner, dragging] = [-1, false]
        } else if (step === "wheel") {
          expected.push(`scroll:${y}`)
          await mockMouse.scroll(0, y, "down")
        } else {
          y = 1 - y
          if (owner >= 0) expected.push(`drag:${owner}`)
          dragging = owner >= 0
          await mockMouse.moveTo(0, y)
        }
        const held = `pressed ${renderer["pressedRenderable"]?.id} captured ${renderer["capturedRenderable"]?.id}`
        actual.push(`${step}: ${log.join(" ")}; ${held}`)
        const [pressed, captured] = [nodes[owner]?.id, dragging ? nodes[owner]!.id : undefined]
        model.push(`${step}: ${expected.join(" ")}; pressed ${pressed} captured ${captured}`)
      }
      expect(actual).toEqual(model)
    }
    const events = ["press", "cross", "wheel", "release"]
    const depth = Number(process.env.MOUSE_MODEL_DEPTH ?? 6)
    try {
      for (let n = 0; n < events.length ** depth; n++) {
        await check(
          Array.from({ length: depth }, (_, i) => events[Math.floor(n / events.length ** i) % events.length]!),
        )
      }
      for (let seed = 1; seed <= Number(process.env.MOUSE_MODEL_SEEDS ?? 24); seed++) {
        let state = seed
        await check(Array.from({ length: 24 }, () => events[(state = (48271 * state) % 2147483647) % events.length]!))
      }
    } finally {
      renderer.destroy()
    }
  })

  test("move events include modifier flags", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "modifiers",
        position: "absolute",
        left: 2,
        top: 2,
        width: 6,
        height: 4,
      })
      renderer.root.add(target)
      await renderOnce()

      let modifiers: MouseEvent["modifiers"] | null = null
      target.onMouseMove = (event) => {
        modifiers = event.modifiers
      }

      await mockMouse.moveTo(target.x + 1, target.y + 1, {
        modifiers: { shift: true, alt: true },
      })

      expect(modifiers!).toEqual({ shift: true, alt: true, ctrl: false })
    } finally {
      renderer.destroy()
    }
  })

  test("basic mouse mode sequences are parsed and dispatched", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "basic-mode",
        position: "absolute",
        left: 2,
        top: 2,
        width: 6,
        height: 4,
      })
      renderer.root.add(target)
      await renderOnce()

      let downCount = 0
      let upCount = 0
      target.onMouseDown = () => {
        downCount++
      }
      target.onMouseUp = () => {
        upCount++
      }

      const clickX = target.x + 1
      const clickY = target.y + 1
      const encodeBasic = (buttonByte: number, x: number, y: number) => {
        return (
          "\x1b[M" + String.fromCharCode(buttonByte + 32) + String.fromCharCode(x + 33) + String.fromCharCode(y + 33)
        )
      }

      renderer.stdin.emit("data", Buffer.from(encodeBasic(0, clickX, clickY)))
      renderer.stdin.emit("data", Buffer.from(encodeBasic(3, clickX, clickY)))

      expect(downCount).toBe(1)
      expect(upCount).toBe(1)
    } finally {
      renderer.destroy()
    }
  })

  test("overflow hidden clips hit grid for mouse events", async () => {
    try {
      const container = new TestRenderable(renderer, {
        id: "container",
        position: "absolute",
        left: 2,
        top: 2,
        width: 6,
        height: 4,
        overflow: "hidden",
      })
      const child = new TestRenderable(renderer, {
        id: "child",
        position: "absolute",
        left: 0,
        top: 0,
        width: 10,
        height: 4,
      })
      container.add(child)
      renderer.root.add(container)
      await renderOnce()

      let clicks = 0
      child.onMouseDown = () => {
        clicks++
      }

      await mockMouse.click(container.x + 1, container.y + 1)
      expect(clicks).toBe(1)

      const outsideX = container.x + container.width + 1
      await mockMouse.click(outsideX, container.y + 1)
      expect(clicks).toBe(1)
    } finally {
      renderer.destroy()
    }
  })

  test("shouldStartSelection false does not start selection", async () => {
    try {
      class NoSelectionStartRenderable extends TestRenderable {
        public shouldStartSelection(): boolean {
          return false
        }
      }

      const target = new NoSelectionStartRenderable(renderer, {
        id: "no-selection-start",
        position: "absolute",
        left: 2,
        top: 2,
        width: 6,
        height: 4,
      })
      target.selectable = true
      renderer.root.add(target)
      await renderOnce()

      let downCount = 0
      target.onMouseDown = () => {
        downCount++
      }

      await mockMouse.click(target.x + 1, target.y + 1)

      expect(downCount).toBe(1)
      expect(renderer.hasSelection).toBe(false)
    } finally {
      renderer.destroy()
    }
  })

  test("destroyed renderable does not start selection", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "destroyed-selectable",
        position: "absolute",
        left: 2,
        top: 2,
        width: 6,
        height: 4,
      })
      target.selectable = true
      renderer.root.add(target)
      await renderOnce()

      let downCount = 0
      target.onMouseDown = () => {
        downCount++
      }

      target.destroy()
      await renderOnce()

      await mockMouse.click(target.x + 1, target.y + 1)

      expect(downCount).toBe(0)
      expect(renderer.hasSelection).toBe(false)
    } finally {
      renderer.destroy()
    }
  })

  test("ctrl+click without selection does not start selection", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "ctrl-no-selection",
        position: "absolute",
        left: 2,
        top: 2,
        width: 6,
        height: 4,
      })
      target.selectable = true
      renderer.root.add(target)
      await renderOnce()

      let downCount = 0
      target.onMouseDown = () => {
        downCount++
      }

      await mockMouse.click(target.x + 1, target.y + 1, MouseButtons.LEFT, { modifiers: { ctrl: true } })

      expect(downCount).toBe(1)
      expect(renderer.hasSelection).toBe(false)
    } finally {
      renderer.destroy()
    }
  })

  test("mouse out is not fired on a destroyed renderable", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "destroyed-hover",
        position: "absolute",
        left: 1,
        top: 1,
        width: 4,
        height: 4,
      })
      renderer.root.add(target)
      await renderOnce()

      let overCount = 0
      let outCount = 0
      target.onMouseOver = () => {
        overCount++
      }
      target.onMouseOut = () => {
        outCount++
      }

      await mockMouse.moveTo(target.x + 1, target.y + 1)
      expect(overCount).toBe(1)

      target.destroy()
      await renderOnce()

      await mockMouse.moveTo(renderer.width - 1, renderer.height - 1)
      expect(outCount).toBe(0)
    } finally {
      renderer.destroy()
    }
  })

  test("mouse out is not fired on a destroyed renderable before render", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "destroyed-hover-before-render",
        position: "absolute",
        left: 1,
        top: 1,
        width: 4,
        height: 4,
      })
      renderer.root.add(target)
      await renderOnce()

      let overCount = 0
      let outCount = 0
      target.onMouseOver = () => {
        overCount++
      }
      target.onMouseOut = () => {
        outCount++
      }

      await mockMouse.moveTo(target.x + 1, target.y + 1)
      expect(overCount).toBe(1)

      // Destroy without rendering — the hit grid still has the old state,
      // so the next mouse move hits handleMouseData's "out" path directly
      target.destroy()

      await mockMouse.moveTo(renderer.width - 1, renderer.height - 1)
      expect(outCount).toBe(0)
    } finally {
      renderer.destroy()
    }
  })
})

describe("renderer handleMouseData split height", () => {
  const baseHeight = 20
  const splitHeight = 6

  let renderer: TestRenderer
  let mockMouse: MockMouse
  let renderOnce: () => Promise<void>

  beforeEach(async () => {
    ;({ renderer, mockMouse, renderOnce } = await createTestRenderer({
      width: 40,
      height: baseHeight,
      screenMode: "split-footer",
      footerHeight: splitHeight,
    }))
  })

  test("split height offsets mouse coordinates and ignores events above render area", async () => {
    try {
      const target = new TestRenderable(renderer, {
        id: "split-target",
        position: "absolute",
        left: 2,
        top: 1,
        width: 6,
        height: 3,
      })
      renderer.root.add(target)
      await renderOnce()

      let downEvent: MouseEvent | null = null
      target.onMouseDown = (event) => {
        downEvent = event
      }

      const renderOffset = baseHeight - splitHeight
      await mockMouse.click(target.x + 1, Math.max(0, renderOffset - 1))
      expect(downEvent).toBeNull()

      const screenY = renderOffset + target.y + 1
      await mockMouse.click(target.x + 1, screenY)
      expect(downEvent).not.toBeNull()
      expect(downEvent!.y).toBe(target.y + 1)
    } finally {
      renderer.destroy()
    }
  })

  test("split-footer mouse handlers resolve links using renderer-relative coordinates", async () => {
    try {
      const url = "https://example.com/split-footer"
      const text = new TextRenderable(renderer, {
        id: "split-footer-link",
        position: "absolute",
        left: 2,
        top: 1,
        width: 6,
        height: 1,
        content: t`${link(url)("click")}`,
      })
      const clicked: { url: string | null } = { url: null }
      text.onMouseDown = (event) => {
        clicked.url = renderer.getLinkAt(event.x, event.y)
      }
      renderer.root.add(text)
      await renderOnce()

      const screenY = baseHeight - splitHeight + text.y
      await mockMouse.pressDown(text.x + 1, screenY)

      expect(clicked.url).toBe(url)
      expect(renderer.getLinkAt(text.x + 1, screenY)).toBeNull()
    } finally {
      renderer.destroy()
    }
  })

  test("split height clamps to terminal height before applying mouse offsets", async () => {
    const requestedFooterHeight = 8
    const terminalHeight = 5
    const setup = await createTestRenderer({
      width: 40,
      height: terminalHeight,
      screenMode: "split-footer",
      footerHeight: requestedFooterHeight,
    })

    const clampedRenderer = setup.renderer
    const clampedMouse = setup.mockMouse

    try {
      const target = new TestRenderable(clampedRenderer, {
        id: "split-clamped-target",
        position: "absolute",
        left: 2,
        top: 1,
        width: 6,
        height: 3,
      })
      clampedRenderer.root.add(target)
      await setup.renderOnce()

      let downEvent: MouseEvent | null = null
      target.onMouseDown = (event) => {
        downEvent = event
      }

      await clampedMouse.click(target.x + 1, target.y + 1)

      expect((clampedRenderer as any)._splitHeight).toBe(terminalHeight)
      expect((clampedRenderer as any).renderOffset).toBe(0)
      expect(downEvent).not.toBeNull()
      expect(downEvent!.y).toBe(target.y + 1)
    } finally {
      clampedRenderer.destroy()
    }
  })

  test("split height returns false for input above render area", async () => {
    try {
      const sequences: string[] = []
      renderer.addInputHandler((sequence) => {
        sequences.push(sequence)
        return true
      })

      await renderOnce()

      const renderOffset = baseHeight - splitHeight
      const beforeSequences = sequences.length
      await mockMouse.click(1, Math.max(0, renderOffset - 1))
      await Promise.resolve()

      expect(sequences.length).toBeGreaterThan(beforeSequences)
    } finally {
      renderer.destroy()
    }
  })
})
