import { expect, test } from "bun:test"
import { Renderable } from "../Renderable.js"
import { CliRenderEvents, type CliRendererHandlerErrorEvent } from "../renderer.js"
import { createTestRenderer } from "../testing.js"

test("emits mouse handler errors without resetting input", async () => {
  const { renderer, mockMouse, renderOnce } = await createTestRenderer({ width: 20, height: 10 })
  const target = new Renderable(renderer, {
    position: "absolute",
    left: 1,
    top: 1,
    width: 4,
    height: 2,
  })
  const child = new Renderable(renderer, { width: 2, height: 1 })
  const error = new Error("handler failed")
  const errors: CliRendererHandlerErrorEvent[] = []
  const sequences: string[] = []
  let handled = false

  try {
    renderer.root.add(target)
    target.add(child)
    await renderOnce()
    renderer.on(CliRenderEvents.HANDLER_ERROR, (value) => errors.push(value))
    renderer.prependInputHandler((sequence) => {
      sequences.push(sequence)
      return true
    })
    target.onMouseUp = () => {
      throw error
    }

    renderer.stdin.emit("data", Buffer.from(`\x1b[<0;${child.x + 1};${child.y + 1}m\x1b[`))
    renderer.stdin.emit("data", Buffer.from("A"))

    target.onMouseUp = () => {
      handled = true
    }
    await mockMouse.click(child.x, child.y)

    expect(errors).toHaveLength(1)
    expect(errors[0].error).toBe(error)
    expect(errors[0].event.target).toBe(child)
    expect(errors[0].event.currentTarget).toBe(target)
    expect(sequences).toContain("\x1b[A")
    expect(handled).toBe(true)
  } finally {
    renderer.destroy()
  }
})
