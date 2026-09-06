import { describe, expect, it, spyOn } from "bun:test"
import {
  CodeRenderable,
  destroyTreeSitterClient,
  DiffRenderable,
  RenderableEvents,
  type Renderable,
  SelectRenderable,
  SyntaxStyle,
} from "@opentui/core"
import { ManualClock, MockTreeSitterClient } from "@opentui/core/testing"
import { act, StrictMode } from "react"
import { App as DiffDemo } from "../examples/diff.js"
import { ExamplesIndex } from "../examples/index.js"
import { flushSync } from "../src/reconciler/renderer.js"
import { testRender } from "../src/test-utils.js"

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap((child) => [child, ...descendants(child)])
}

describe("React example theme lifetime | native", () => {
  it.each([
    ["Line Number Demo", false, false],
    ["Diff Demo", false, false],
    ["Line Number Demo", true, false],
    ["Diff Demo", true, false],
    ["Line Number Demo", false, true],
    ["Diff Demo", false, true],
  ] as const)(
    "%s, StrictMode %p, throwing observer %p: Escape outside act retains a pending Code theme until destruction",
    async (name, strict, throwingObserver) => {
      const browser = <ExamplesIndex />
      const setup = await testRender(strict ? <StrictMode>{browser}</StrictMode> : browser, {
        width: 100,
        height: 40,
        kittyKeyboard: true,
        clock: new ManualClock(),
      })
      const client = new MockTreeSitterClient()
      let entered = false
      const release = Promise.withResolvers<undefined>()
      const styles: SyntaxStyle[] = []
      const fromStyles = SyntaxStyle.fromStyles
      const allocations = spyOn(SyntaxStyle, "fromStyles").mockImplementation((...args) => {
        const style = fromStyles(...args)
        styles.push(style)
        return style
      })
      const warnings = spyOn(console, "warn")
      const errors = spyOn(console, "error")
      const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
      let restoreDestroy = () => {}
      let restoreBorrowerDestroy = () => {}
      try {
        const menu = descendants(setup.renderer.root).find((node) => node instanceof SelectRenderable)!
        const index = menu.options.findIndex((option) => option.name === name)
        expect(index).toBeGreaterThanOrEqual(0)
        await act(async () => {
          for (let step = 0; step < index; step++) setup.mockInput.pressArrow("down")
          setup.mockInput.pressEnter()
        })
        if (name === "Diff Demo") await act(async () => setup.mockInput.pressKey("v"))
        const code = descendants(setup.renderer.root)
          .filter((node) => node instanceof CodeRenderable)
          .at(-1)!
        expect(styles).toHaveLength(strict ? 2 : 1)
        expect(code.syntaxStyle).toBe(styles.at(-1)!)
        for (const style of styles.slice(0, -1)) {
          expect(() => style.getStyleCount()).toThrow("NativeSyntaxStyle is destroyed")
        }
        await act(async () => setup.renderOnce())
        await code.highlightingDone
        code.treeSitterClient = client
        code.onHighlight = () => {
          entered = true
          return release.promise
        }
        client.setMockResult({ highlights: [[0, 5, "keyword"]] })
        await act(async () => setup.renderOnce())
        expect(client.isHighlighting()).toBe(true)
        client.resolveHighlightOnce()
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(entered).toBe(true)
        const pending = code.highlightingDone
        if (name === "Diff Demo") {
          await act(async () => setup.mockInput.pressKey("v"))
          expect(descendants(setup.renderer.root)).not.toContain(code)
          expect(code.isDestroyed).toBe(false)
        }
        const style = code.syntaxStyle
        const destroy = style.destroy.bind(style)
        let releasedWhileBorrowed = false
        const destroySpy = spyOn(style, "destroy").mockImplementation(() => {
          releasedWhileBorrowed ||= !code.isDestroyed && code.syntaxStyle === style
          destroy()
          release.resolve(undefined)
        })
        restoreDestroy = () => destroySpy.mockRestore()

        const borrower =
          name === "Diff Demo" ? descendants(setup.renderer.root).find((node) => node instanceof DiffRenderable)! : code
        const failure = new Error("borrower destruction observer failed")
        const cleanupErrors: unknown[] = []
        if (throwingObserver) {
          borrower.once(RenderableEvents.DESTROYED, () => {
            throw failure
          })
          const destroyBorrower = borrower.destroyRecursively.bind(borrower)
          // Isolate the injected Core error from React's passive-cleanup error handling.
          const borrowerDestroySpy = spyOn(borrower, "destroyRecursively").mockImplementation(() => {
            try {
              destroyBorrower()
            } catch (error) {
              cleanupErrors.push(error)
            }
          })
          restoreBorrowerDestroy = () => borrowerDestroySpy.mockRestore()
        }
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false)
        setup.mockInput.pressKey("ESCAPE")
        for (let pass = 0; pass < 50 && destroySpy.mock.calls.length === 0; pass++) {
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        expect(destroySpy).toHaveBeenCalledTimes(1)
        expect(cleanupErrors).toEqual(throwingObserver ? [failure] : [])
        await pending
        expect(releasedWhileBorrowed).toBe(false)
        expect(warnings.mock.calls).toEqual([])
        expect(errors.mock.calls).toEqual([])
        expect(code.isDestroyed).toBe(true)
        expect(setup.renderer.isDestroyed).toBe(false)
        for (const style of styles) expect(() => style.getStyleCount()).toThrow("NativeSyntaxStyle is destroyed")
        await setup.renderOnce()
        expect(setup.captureCharFrame()).toContain("Basic Demo")
        await act(async () => {
          for (let step = 0; step < index; step++) setup.mockInput.pressArrow("down")
          setup.mockInput.pressEnter()
        })
        const remounted = descendants(setup.renderer.root).find((node) => node instanceof CodeRenderable)!
        expect(remounted).not.toBe(code)
        expect(remounted.syntaxStyle).not.toBe(style)
        expect(remounted.syntaxStyle.getStyleCount()).toBeGreaterThan(0)
        for (const call of allocations.mock.calls) expect(call[1]).toBe(setup.renderer.nativeScene!)
      } finally {
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment)
        restoreDestroy()
        restoreBorrowerDestroy()
        allocations.mockRestore()
        warnings.mockRestore()
        errors.mockRestore()
        release.resolve(undefined)
        await client.destroy()
        act(() => setup.renderer.destroy())
        await setup.renderer.closed
        for (const style of styles) style.destroy()
        await destroyTreeSitterClient()
      }
    },
  )

  it("keeps the replaced Diff theme alive until a queued highlight is invalidated", async () => {
    const setup = await testRender(<DiffDemo />, {
      width: 80,
      height: 30,
      clock: new ManualClock(),
    })
    const client = new MockTreeSitterClient()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<undefined>()
    const warnings = spyOn(console, "warn")
    try {
      await act(async () => setup.mockInput.pressKey("v"))
      const diff = descendants(setup.renderer.root).find((node) => node instanceof DiffRenderable)!
      const code = descendants(diff).find((node) => node instanceof CodeRenderable)!
      const style = diff.syntaxStyle!
      code.treeSitterClient = client
      code.onHighlight = () => {
        entered.resolve()
        return release.promise
      }
      client.setMockResult({ highlights: [[0, 5, "keyword"]] })
      await act(async () => setup.renderOnce())
      client.resolveHighlightOnce()
      await entered.promise
      const pending = code.highlightingDone
      act(() => {
        release.resolve(undefined)
        flushSync(() => setup.mockInput.pressKey("t"))
      })
      await pending
      expect(warnings.mock.calls).toEqual([])
      expect(setup.renderer.isDestroyed).toBe(false)
      expect(() => style.getStyleCount()).toThrow("NativeSyntaxStyle is destroyed")
      expect(code.syntaxStyle).toBe(diff.syntaxStyle!)
      expect(code.syntaxStyle.getStyleCount()).toBeGreaterThan(0)
    } finally {
      warnings.mockRestore()
      release.resolve(undefined)
      await client.destroy()
      act(() => setup.renderer.destroy())
      await setup.renderer.closed
      await destroyTreeSitterClient()
    }
  })
})
