import { afterEach, describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { ScrollBoxOptions, ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "../index.js"

let setup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
})

describe("scrollbox scrollbar callbacks", () => {
  for (const direction of ["vertical", "horizontal"] as const) {
    test(`${direction} options update the callback without replacing internal scrolling`, async () => {
      const initial: number[] = []
      const updated: number[] = []
      const [options, setOptions] = createSignal<ScrollBoxOptions["verticalScrollbarOptions"]>({
        onChange: (position) => initial.push(position),
      })
      let scrollbox!: ScrollBoxRenderable
      setup = await testRender(
        () => (
          <scrollbox
            ref={(value) => (scrollbox = value)}
            width={20}
            height={8}
            scrollX
            scrollY
            contentOptions={{ width: 80, height: 40, maxWidth: 80 }}
            verticalScrollbarOptions={direction === "vertical" ? options() : undefined}
            horizontalScrollbarOptions={direction === "horizontal" ? options() : undefined}
          >
            <box width={80} height={40} flexShrink={0} />
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )
      await setup.renderOnce()
      const bar = direction === "vertical" ? scrollbox.verticalScrollBar : scrollbox.horizontalScrollBar
      const translation = direction === "vertical" ? "translateY" : "translateX"
      expect(bar.scrollSize).toBeGreaterThan(bar.viewportSize)

      await setup.mockMouse.scroll(3, 3, direction === "vertical" ? "down" : "right")
      await setup.renderOnce()
      expect(initial).toEqual([1])
      expect(scrollbox.content[translation]).toBe(-1)

      setOptions({ onChange: (position) => updated.push(position) })
      await setup.renderOnce()
      bar.scrollBy(1)
      expect(initial).toEqual([1])
      expect(updated).toEqual([2])
      expect(scrollbox.content[translation]).toBe(-2)

      setOptions({ onChange: undefined })
      await setup.renderOnce()
      bar.scrollBy(1)
      expect(updated).toEqual([2])
      expect(scrollbox.content[translation]).toBe(-3)

      setOptions({ onChange: (position) => initial.push(position) })
      await setup.renderOnce()
      bar.scrollBy(1)
      expect(initial).toEqual([1, 4])

      setOptions(undefined)
      await setup.renderOnce()
      bar.scrollBy(1)
      expect(initial).toEqual([1, 4])
      expect(scrollbox.content[translation]).toBe(-5)
    })
  }
})
