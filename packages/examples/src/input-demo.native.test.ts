import { expect, test } from "bun:test"
import { CliRenderEvents } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { destroy, run } from "./input-demo.js"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

test.each(["explicit", "destroy", "ctrl-c"])(
  "input demo releases a dirty later field and action timers (%s)",
  async (mode) => {
    const clock = new ManualClock()
    const target = await createTestRenderer({ width: 110, height: 40, exitOnCtrlC: mode !== "explicit", clock })
    const { renderer, mockInput } = target
    try {
      run(renderer)
      setupCommonDemoKeys(renderer)
      const parent = renderer.root.getRenderable("parent-container")!
      const owned = [...renderer.root.getChildren(), ...parent.getChildren()]
      const listeners = renderer.keyInput.listenerCount("keypress")
      const destroys = renderer.listenerCount(CliRenderEvents.DESTROY)
      let disposedBeforeRoot = false
      renderer.once(CliRenderEvents.DESTROY, () => {
        disposedBeforeRoot = owned.every((node) => node.isDestroyed)
      })
      mockInput.pressKey("r", { ctrl: true })
      await mockInput.typeText("ada")
      mockInput.pressEnter()
      mockInput.pressTab()
      await mockInput.typeText("unfinished")
      expect(renderer.currentFocusedRenderable?.id).toBe("email-input")
      if (mode === "explicit") {
        destroy(renderer)
        expect(renderer.root.getChildren()).toEqual([])
        expect(renderer.currentFocusedRenderable).toBeNull()
        expect(renderer.keyInput.listenerCount("keypress")).toBe(listeners - 1)
        expect(renderer.listenerCount(CliRenderEvents.DESTROY)).toBe(destroys)
        expect(() => destroy(renderer)).not.toThrow()
        run(renderer)
        await mockInput.typeText("new session")
        await target.renderOnce()
        const frame = target.captureSpans()
        clock.advance(2000)
        await target.waitFor(() => !renderer.getSchedulerState().isRendering)
        await target.renderOnce()
        expect(target.captureSpans()).toEqual(frame)
      } else {
        if (mode === "ctrl-c") mockInput.pressCtrlC()
        else renderer.destroy()
        await renderer.closed
        expect(disposedBeforeRoot).toBe(true)
        expect(() => clock.advance(2000)).not.toThrow()
      }
      expect(owned.every((node) => node.isDestroyed)).toBe(true)
    } finally {
      try {
        destroy(renderer)
      } finally {
        renderer.destroy()
        await renderer.closed
      }
    }
  },
)
