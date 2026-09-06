import { afterAll, expect, test } from "bun:test"
import { CliRenderEvents, CodeRenderable, DiffRenderable, Renderable, destroyTreeSitterClient } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import * as codeDemo from "./code-demo.js"
import * as diffDemo from "./diff-demo.js"

afterAll(destroyTreeSitterClient)

for (const [name, demo] of [
  ["code", codeDemo],
  ["diff", diffDemo],
] as const) {
  test.each(["explicit", "destroy", "ctrl-c"])(
    `${name} demo releases descendants, themes, and listeners (%s)`,
    async (mode) => {
      const target = await createTestRenderer({ width: 132, height: 44, exitOnCtrlC: true, clock: new ManualClock() })
      const { renderer, mockInput } = target
      const keys = renderer.keyInput.listeners("keypress")
      const release = Promise.withResolvers<void>()
      try {
        await demo.run(renderer)
        const display = renderer.root.findDescendantById(`${name}-display`)
        expect(display instanceof CodeRenderable || display instanceof DiffRenderable).toBe(true)
        const node = display as CodeRenderable | DiffRenderable
        const previous = node.syntaxStyle!
        mockInput.pressKey("t")
        expect(() => previous.getStyleCount()).toThrow("destroyed")
        const style = node.syntaxStyle!
        const owned = [...Renderable.renderablesByNumber.values()].filter(
          (node) => node.ctx === renderer && node !== renderer.root,
        )
        let disposedBeforeRoot = false
        renderer.once(CliRenderEvents.DESTROY, () => {
          disposedBeforeRoot = node.isDestroyed
        })

        if (mode === "explicit") {
          const code = owned.find((node): node is CodeRenderable => node instanceof CodeRenderable)!
          const entered = Promise.withResolvers<void>()
          code.onHighlight = async (highlights) => {
            expect(highlights.length).toBeGreaterThan(0)
            entered.resolve()
            await release.promise
            return highlights
          }
          let transformed = 0
          code.onChunks = () => {
            transformed++
            return undefined
          }
          await target.waitFor(() => !renderer.getSchedulerState().isRendering)
          await target.renderOnce()
          await entered.promise
          const pending = code.highlightingDone
          demo.destroy(renderer)
          release.resolve()
          await pending
          expect(transformed).toBe(0)
          expect(code.isHighlighting).toBe(false)
          expect(renderer.keyInput.listeners("keypress")).toEqual(keys)
          expect(renderer.root.getChildren()).toEqual([])
        } else {
          if (mode === "ctrl-c") mockInput.pressCtrlC()
          else renderer.destroy()
          await renderer.closed
          expect(disposedBeforeRoot).toBe(true)
        }
        expect(owned.every((node) => node.isDestroyed)).toBe(true)
        expect(() => style.getStyleCount()).toThrow("destroyed")
        expect(() => demo.destroy(renderer)).not.toThrow()
      } finally {
        release.resolve()
        try {
          demo.destroy(renderer)
        } finally {
          renderer.destroy()
          await renderer.closed
        }
      }
    },
    30_000,
  )
}
