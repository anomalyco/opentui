import { beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, MouseButtons, type MockMouse, type TestRenderer } from "../testing.js"
import { Renderable, type RenderableOptions } from "../Renderable.js"
import type { MouseEvent } from "../renderer.js"
import type { RenderContext } from "../types.js"
import type { Selection } from "../lib/selection.js"

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

  test("selection drag marks events as dragging and ends on mouse up", async () => {
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
      await mockMouse.moveTo(endX, endY)
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

  test("drag capture delivers drag-end and drop with source", async () => {
    try {
      const source = new TestRenderable(renderer, {
        id: "source",
        position: "absolute",
        left: 1,
        top: 1,
        width: 6,
        height: 4,
      })
      const target = new TestRenderable(renderer, {
        id: "target",
        position: "absolute",
        left: 12,
        top: 1,
        width: 6,
        height: 4,
      })
      renderer.root.add(source)
      renderer.root.add(target)
      await renderOnce()

      const events: string[] = []
      let dropSource: Renderable | undefined
      let overSource: Renderable | undefined
      let targetDragged = false

      source.onMouseDrag = () => {
        events.push("drag:source")
      }
      source.onMouseDragEnd = () => {
        events.push("drag-end:source")
      }
      source.onMouseUp = () => {
        events.push("up:source")
      }
      target.onMouseDrop = (event) => {
        events.push("drop:target")
        dropSource = event.source
      }
      target.onMouseOver = (event) => {
        overSource = event.source
      }
      target.onMouseDrag = () => {
        targetDragged = true
      }

      await mockMouse.drag(source.x + 1, source.y + 1, target.x + 1, target.y + 1)

      expect(events).toContain("drag-end:source")
      expect(events).toContain("up:source")
      expect(events).toContain("drop:target")
      expect(dropSource).toBe(source)
      expect(overSource).toBe(source)
      expect(targetDragged).toBe(false)
    } finally {
      renderer.destroy()
    }
  })

  test("captured drag release fires drop then mouse up on target", async () => {
    try {
      const source = new TestRenderable(renderer, {
        id: "source-drop-order",
        position: "absolute",
        left: 1,
        top: 1,
        width: 6,
        height: 4,
      })
      const target = new TestRenderable(renderer, {
        id: "target-drop-order",
        position: "absolute",
        left: 12,
        top: 1,
        width: 6,
        height: 4,
      })
      renderer.root.add(source)
      renderer.root.add(target)
      await renderOnce()

      const events: string[] = []
      target.onMouseDrop = () => {
        events.push("drop")
      }
      target.onMouseUp = () => {
        events.push("up")
      }

      await mockMouse.drag(source.x + 1, source.y + 1, target.x + 1, target.y + 1)

      expect(events).toEqual(["drop", "up"])
    } finally {
      renderer.destroy()
    }
  })

  test("captured drag keeps routing drag events to source", async () => {
    try {
      const source = new TestRenderable(renderer, {
        id: "source-capture",
        position: "absolute",
        left: 1,
        top: 1,
        width: 6,
        height: 4,
      })
      const target = new TestRenderable(renderer, {
        id: "target-capture",
        position: "absolute",
        left: 12,
        top: 1,
        width: 6,
        height: 4,
      })
      renderer.root.add(source)
      renderer.root.add(target)
      await renderOnce()

      let sourceDragCount = 0
      let targetDragCount = 0
      source.onMouseDrag = () => {
        sourceDragCount++
      }
      target.onMouseDrag = () => {
        targetDragCount++
      }

      await mockMouse.pressDown(source.x + 1, source.y + 1)
      await mockMouse.moveTo(source.x + 2, source.y + 1)
      await mockMouse.moveTo(target.x + 1, target.y + 1)
      await mockMouse.moveTo(target.x + 2, target.y + 1)
      await mockMouse.release(target.x + 2, target.y + 1)

      expect(sourceDragCount).toBeGreaterThan(1)
      expect(targetDragCount).toBe(0)
    } finally {
      renderer.destroy()
    }
  })

  test("captured drag does not emit out on the captured renderable", async () => {
    try {
      const source = new TestRenderable(renderer, {
        id: "source",
        position: "absolute",
        left: 1,
        top: 1,
        width: 6,
        height: 4,
      })
      const target = new TestRenderable(renderer, {
        id: "target",
        position: "absolute",
        left: 12,
        top: 1,
        width: 6,
        height: 4,
      })
      renderer.root.add(source)
      renderer.root.add(target)
      await renderOnce()

      let outCount = 0
      source.onMouseOut = () => {
        outCount++
      }

      await mockMouse.drag(source.x + 1, source.y + 1, target.x + 1, target.y + 1)

      expect(outCount).toBe(0)
    } finally {
      renderer.destroy()
    }
  })

  test("non-left drag does not capture and routes by hit test", async () => {
    try {
      const source = new TestRenderable(renderer, {
        id: "source-right-drag",
        position: "absolute",
        left: 1,
        top: 1,
        width: 6,
        height: 4,
      })
      const target = new TestRenderable(renderer, {
        id: "target-right-drag",
        position: "absolute",
        left: 12,
        top: 1,
        width: 6,
        height: 4,
      })
      renderer.root.add(source)
      renderer.root.add(target)
      await renderOnce()

      let sourceDragCount = 0
      let targetDragCount = 0
      source.onMouseDrag = () => {
        sourceDragCount++
      }
      target.onMouseDrag = () => {
        targetDragCount++
      }

      await mockMouse.drag(source.x + 1, source.y + 1, target.x + 1, target.y + 1, MouseButtons.RIGHT)

      expect(sourceDragCount).toBeGreaterThan(0)
      expect(targetDragCount).toBeGreaterThan(0)
    } finally {
      renderer.destroy()
    }
  })

  test("non-captured drag emits over/out transitions", async () => {
    try {
      const source = new TestRenderable(renderer, {
        id: "source-drag-hover",
        position: "absolute",
        left: 1,
        top: 1,
        width: 6,
        height: 4,
      })
      const target = new TestRenderable(renderer, {
        id: "target-drag-hover",
        position: "absolute",
        left: 12,
        top: 1,
        width: 6,
        height: 4,
      })
      renderer.root.add(source)
      renderer.root.add(target)
      await renderOnce()

      const events: string[] = []
      source.onMouseOver = () => events.push("over:source")
      source.onMouseOut = () => events.push("out:source")
      target.onMouseOver = () => events.push("over:target")

      await mockMouse.moveTo(source.x + 1, source.y + 1)
      await mockMouse.drag(source.x + 1, source.y + 1, target.x + 1, target.y + 1, MouseButtons.RIGHT)

      expect(events).toContain("over:source")
      expect(events).toContain("out:source")
      expect(events).toContain("over:target")
      expect(events.indexOf("out:source")).toBeGreaterThan(events.indexOf("over:source"))
      expect(events.indexOf("over:target")).toBeGreaterThan(events.indexOf("out:source"))
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

  test("captured drag release on empty space skips drop", async () => {
    try {
      const source = new TestRenderable(renderer, {
        id: "source-empty-drop",
        position: "absolute",
        left: 1,
        top: 1,
        width: 6,
        height: 4,
      })
      const target = new TestRenderable(renderer, {
        id: "target-empty-drop",
        position: "absolute",
        left: 15,
        top: 1,
        width: 6,
        height: 4,
      })
      renderer.root.add(source)
      renderer.root.add(target)
      await renderOnce()

      let dragEndCount = 0
      let upCount = 0
      let dropCount = 0
      source.onMouseDragEnd = () => {
        dragEndCount++
      }
      source.onMouseUp = () => {
        upCount++
      }
      target.onMouseDrop = () => {
        dropCount++
      }

      const startX = source.x + 1
      const startY = source.y + 1
      const endX = renderer.width - 1
      const endY = renderer.height - 1

      await mockMouse.pressDown(startX, startY)
      await mockMouse.moveTo(source.x + 2, startY)
      await mockMouse.moveTo(endX, endY)
      await mockMouse.release(endX, endY)

      expect(dragEndCount).toBe(1)
      expect(upCount).toBe(1)
      expect(dropCount).toBe(0)
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
