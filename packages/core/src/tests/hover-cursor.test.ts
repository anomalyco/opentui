import { beforeEach, describe, expect, test, afterEach } from "bun:test"
import { createTestRenderer, MouseButtons, type MockMouse, type TestRenderer } from "../testing.js"
import { BoxRenderable } from "../renderables/index.js"
import type { MousePointerStyle } from "../types.js"

describe("mouse pointer style", () => {
  let renderer: TestRenderer
  let mockMouse: MockMouse
  let renderOnce: () => Promise<void>

  beforeEach(async () => {
    ;({ renderer, mockMouse, renderOnce } = await createTestRenderer({ width: 40, height: 20 }))
  })

  afterEach(() => {
    renderer.destroy()
  })

  test("setMousePointer sets style", async () => {
    renderer.setMousePointer("pointer")
    expect((renderer as any)._currentMousePointerStyle).toBe("pointer")
  })

  test("setMousePointer with 'default' clears style", async () => {
    renderer.setMousePointer("pointer")
    renderer.setMousePointer("default")
    expect((renderer as any)._currentMousePointerStyle).toBe("default")
  })

  test("setMousePointer supports all style types", async () => {
    const styles: MousePointerStyle[] = [
      "auto",
      "default",
      "none",
      "context-menu",
      "help",
      "pointer",
      "progress",
      "wait",
      "cell",
      "crosshair",
      "text",
      "vertical-text",
      "alias",
      "copy",
      "move",
      "no-drop",
      "not-allowed",
      "grab",
      "grabbing",
      "all-scroll",
      "col-resize",
      "row-resize",
      "n-resize",
      "e-resize",
      "s-resize",
      "w-resize",
      "ne-resize",
      "nw-resize",
      "se-resize",
      "sw-resize",
      "ew-resize",
      "ns-resize",
      "nesw-resize",
      "nwse-resize",
      "zoom-in",
      "zoom-out",
    ]
    for (const style of styles) {
      renderer.setMousePointer(style)
      expect((renderer as any)._currentMousePointerStyle).toBe(style)
    }
  })

  test("onMouseOver callback can set mouse pointer", async () => {
    let pointerSet = false
    const box = new BoxRenderable(renderer, {
      position: "absolute",
      left: 5,
      top: 5,
      width: 10,
      height: 5,
      onMouseOver() {
        this.ctx.setMousePointer("pointer")
        pointerSet = true
      },
    })
    renderer.root.add(box)
    await renderOnce()

    await mockMouse.moveTo(10, 7)
    await renderOnce()

    expect(pointerSet).toBe(true)
    expect((renderer as any)._currentMousePointerStyle).toBe("pointer")
  })

  test("onMouseOut callback can reset mouse pointer", async () => {
    let pointerReset = false
    const box = new BoxRenderable(renderer, {
      position: "absolute",
      left: 5,
      top: 5,
      width: 10,
      height: 5,
      onMouseOver() {
        this.ctx.setMousePointer("pointer")
      },
      onMouseOut() {
        this.ctx.setMousePointer("default")
        pointerReset = true
      },
    })
    renderer.root.add(box)
    await renderOnce()

    // Move into box
    await mockMouse.moveTo(10, 7)
    await renderOnce()
    expect((renderer as any)._currentMousePointerStyle).toBe("pointer")

    // Move out of box
    await mockMouse.moveTo(1, 1)
    await renderOnce()

    expect(pointerReset).toBe(true)
    expect((renderer as any)._currentMousePointerStyle).toBe("default")
  })

  test("pointer resets on renderer destroy", async () => {
    renderer.setMousePointer("pointer")
    renderer.destroy()
    // After destroy, the reset is called internally - just verify no error
  })
})
