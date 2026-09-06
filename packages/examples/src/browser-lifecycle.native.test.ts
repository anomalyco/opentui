import { expect, spyOn, test } from "bun:test"
import { CliRenderEvents, Renderable, SyntaxStyle } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { examples } from "./index.js"

test.each(["HAST Syntax Highlighting Demo", "Core Plugin Slots Demo"])(
  "%s releases resources between visits",
  async (name) => {
    const target = await createTestRenderer({ width: 160, height: 55, clock: new ManualClock() })
    const { renderer, mockInput } = target
    const example = examples.find((example) => example.name === name)!
    const plugin = name === "Core Plugin Slots Demo"
    const registered = new Set(Renderable.renderablesByNumber.keys())
    const keys = renderer.keyInput.listeners("keypress")
    const listeners = ["resize", "selection", CliRenderEvents.DESTROY].map((event) => renderer.listenerCount(event))
    const styles = spyOn(SyntaxStyle, "fromStyles")
    const intervals = new ManualClock()
    const pending = new Set<number>()
    const schedule = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number) => {
      const handle = intervals.setInterval(callback, ms)
      pending.add(Number(handle))
      return handle
    }) as typeof setInterval)
    const cancel = spyOn(globalThis, "clearInterval").mockImplementation((handle) => {
      pending.delete(Number(handle))
      intervals.clearInterval(Number(handle))
    })
    try {
      for (let visit = 0; visit < (plugin ? 2 : 1); visit++) {
        await example.run!(renderer)
        if (plugin) expect(pending.size).toBe(2)
        mockInput.pressKey(plugin ? "1" : "r")
        intervals.advance(1000)
        await target.waitFor(() => !renderer.getSchedulerState().isRendering)
        await target.renderOnce()
        const owned = [...Renderable.renderablesByNumber.values()].filter((node) => !registered.has(node.num))
        await example.destroy?.(renderer)
        expect(owned.every((node) => node.isDestroyed)).toBe(true)
        expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
        expect(renderer.keyInput.listeners("keypress")).toEqual(keys)
        expect(renderer.listenerCount("resize")).toBe(listeners[0]!)
        expect(renderer.listenerCount("selection")).toBe(listeners[1]!)
        expect(renderer.listenerCount(CliRenderEvents.DESTROY)).toBe(listeners[2]! + Number(plugin))
        for (const result of styles.mock.results)
          expect(() => (result.value as SyntaxStyle).getStyleCount()).toThrow("destroyed")
        expect(pending.size).toBe(0)
        expect(() => intervals.advance(2000)).not.toThrow()
      }
    } finally {
      try {
        await example.destroy?.(renderer)
      } finally {
        renderer.destroy()
        await renderer.closed
        schedule.mockRestore()
        cancel.mockRestore()
        styles.mockRestore()
      }
    }
  },
)
