import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { destroyTreeSitterClient, MarkdownRenderable, Renderable, RenderableEvents } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { destroy, run } from "./markdown-demo.js"

let target: Awaited<ReturnType<typeof createTestRenderer>>
let markdown: MarkdownRenderable
beforeEach(async () => {
  target = await createTestRenderer({ width: 110, height: 42, clock: new ManualClock() })
  await run(target.renderer)
  markdown = target.renderer.root.findDescendantById("markdown-display") as MarkdownRenderable
})
afterEach(async () => {
  try {
    destroy(target.renderer)
  } finally {
    target.renderer.destroy()
    await target.renderer.closed
  }
})
afterAll(destroyTreeSitterClient)

test.each(["explicit", "event"])("Markdown cleanup completes after descendant observer failures (%s)", async (mode) => {
  const { renderer, mockInput } = target
  const report = spyOn(console, "error").mockImplementation(() => {})
  const styles = [markdown.syntaxStyle]
  const initialFg = markdown.fg?.toInts()
  mockInput.pressKey("t")
  styles.push(markdown.syntaxStyle)
  mockInput.pressKey("c")
  const owned = [...Renderable.renderablesByNumber.values()].filter(
    (node) => node.ctx === renderer && node !== renderer.root,
  )
  const failure = new Error("descendant destroy observer failed")
  renderer.root.findDescendantById("instructions")!.once(RenderableEvents.DESTROYED, () => {
    throw failure
  })
  try {
    if (mode === "explicit") {
      expect(() => destroy(renderer)).toThrow(failure.message)
      expect(report.mock.calls).toEqual([])
    } else {
      renderer.destroy()
      await renderer.closed
      expect(report.mock.calls).toEqual([["Failed to clean up markdown demo:", failure]])
    }
    expect(owned.every((node) => node.isDestroyed)).toBe(true)
    for (const style of styles) expect(() => style.getStyleCount()).toThrow("destroyed")
    expect(renderer.root.getChildren()).toEqual([])
    expect(() => destroy(renderer)).not.toThrow()
    if (mode === "explicit") {
      await run(renderer)
      const next = renderer.root.findDescendantById("markdown-display") as MarkdownRenderable
      expect(next.conceal).toBe(true)
      expect(next.fg?.toInts()).toEqual(initialFg)
      renderer.destroy()
      await renderer.closed
      expect(next.isDestroyed).toBe(true)
      expect(() => next.syntaxStyle.getStyleCount()).toThrow("destroyed")
    }
  } finally {
    report.mockRestore()
  }
})

test("Markdown streaming finalizes its last block and cancels pending chunks", async () => {
  const timeout = globalThis.setTimeout
  const clear = globalThis.clearTimeout
  let next: (() => void) | undefined
  const timer = 123456 as unknown as ReturnType<typeof setTimeout>
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (callback.name !== "streamNextChunk") return timeout(callback, delay, ...args)
    next = callback
    return timer
  }) as typeof setTimeout)
  const cancel = spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    if (handle === timer) next = undefined
    else clear(handle as ReturnType<typeof setTimeout>)
  })
  const random = spyOn(Math, "random").mockReturnValue(0.99)
  const { renderer, mockInput } = target
  try {
    const content = markdown.content
    mockInput.pressKey("s")
    expect(markdown.streaming).toBe(true)
    expect(markdown.content).toBe(content.slice(0, 50))
    for (let pass = 0; next && pass < Math.ceil(content.length / 50); pass++) {
      const callback = next
      next = undefined
      callback()
    }
    expect(next).toBeUndefined()
    expect(markdown.content).toBe(content)
    expect(markdown.streaming).toBe(false)
    mockInput.pressKey("s")
    expect(next).toBeDefined()
    mockInput.pressKey("x")
    expect(next).toBeUndefined()
    expect(markdown.streaming).toBe(false)
    mockInput.pressKey("s")
    const late = next!
    expect(late).toBeDefined()
    renderer.destroy()
    await renderer.closed
    expect(next).toBeUndefined()
    expect(markdown.isDestroyed).toBe(true)
    expect(() => late()).not.toThrow()
  } finally {
    destroy(renderer)
    random.mockRestore()
    cancel.mockRestore()
    schedule.mockRestore()
  }
})
