import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { testRender } from "../index.js"
import { createSignal, For } from "solid-js"
import type { ScrollBoxRenderable } from "../../core/src/renderables/index.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

describe("ScrollBox Sticky Scroll Behavior", () => {
  beforeEach(async () => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  it("sticky scroll bottom stays at bottom after scrollBy/scrollTo is called (setter-based)", async () => {
    const [items, setItems] = createSignal<string[]>(["Line 0"])
    let scrollRef: ScrollBoxRenderable | undefined

    testSetup = await testRender(
      () => (
        <scrollbox
          ref={(r) => {
            scrollRef = r
          }}
          width={40}
          height={10}
          stickyScroll={true}
          stickyStart="bottom"
        >
          <For each={items()}>
            {(item) => (
              <box>
                <text>{item}</text>
              </box>
            )}
          </For>
        </scrollbox>
      ),
      {
        width: 80,
        height: 24,
      },
    )

    await testSetup.renderOnce()

    // Call scrollBy and scrollTo - this mimics what happens when content is dynamically added
    if (scrollRef) {
      scrollRef.scrollBy(100000)
      await testSetup.renderOnce()

      scrollRef.scrollTo(scrollRef.scrollHeight)
      await testSetup.renderOnce()
    }

    // Now gradually add content
    for (let i = 1; i < 30; i++) {
      setItems((prev) => [...prev, `Line ${i}`])
      await testSetup.renderOnce()

      const maxScroll = Math.max(0, scrollRef!.scrollHeight - scrollRef!.viewport.height)

      // Check at line 16 (when content definitely overflows)
      if (i === 16) {
        expect(scrollRef!.scrollTop).toBe(maxScroll)
      }
    }

    // Final check - should still be at bottom
    const finalMaxScroll = Math.max(0, scrollRef!.scrollHeight - scrollRef!.viewport.height)
    expect(scrollRef!.scrollTop).toBe(finalMaxScroll)
  })

  it("sticky scroll can still scroll up and down after scrollBy/scrollTo (setter-based)", async () => {
    const [items, setItems] = createSignal<string[]>([])
    let scrollRef: ScrollBoxRenderable | undefined

    testSetup = await testRender(
      () => (
        <scrollbox
          ref={(r) => {
            scrollRef = r
          }}
          width={40}
          height={10}
          stickyScroll={true}
          stickyStart="bottom"
        >
          <For each={items()}>
            {(item) => (
              <box>
                <text>{item}</text>
              </box>
            )}
          </For>
        </scrollbox>
      ),
      {
        width: 80,
        height: 24,
      },
    )

    await testSetup.renderOnce()

    // Add enough content to overflow
    const newItems = Array.from({ length: 50 }, (_, i) => `Line ${i}`)
    setItems(newItems)
    await testSetup.renderOnce()

    if (scrollRef) {
      // Try to scroll to top
      scrollRef.scrollTo(0)
      await testSetup.renderOnce()
      expect(scrollRef.scrollTop).toBe(0)

      // Try to scroll down a bit
      scrollRef.scrollBy(5)
      await testSetup.renderOnce()
      expect(scrollRef.scrollTop).toBe(5)

      // Try to scroll down more
      scrollRef.scrollBy(5)
      await testSetup.renderOnce()
      expect(scrollRef.scrollTop).toBe(10)

      // Scroll back to bottom
      const maxScroll = Math.max(0, scrollRef.scrollHeight - scrollRef.viewport.height)
      scrollRef.scrollTo(maxScroll)
      await testSetup.renderOnce()
      expect(scrollRef.scrollTop).toBe(maxScroll)
    }
  })

  it("re-engages sticky bottom after mouse scrolling back to the bottom", async () => {
    const INITIAL_COUNT = 20
    const [items, setItems] = createSignal<string[]>(Array.from({ length: INITIAL_COUNT }, (_, i) => `Line ${i}`))
    let scrollRef: ScrollBoxRenderable | undefined

    testSetup = await testRender(
      () => (
        <scrollbox
          ref={(r) => {
            scrollRef = r
          }}
          width={40}
          height={8}
          stickyScroll={true}
          stickyStart="bottom"
        >
          <For each={items()}>
            {(item) => (
              <box>
                <text>{item}</text>
              </box>
            )}
          </For>
        </scrollbox>
      ),
      {
        width: 80,
        height: 24,
      },
    )

    await testSetup.renderOnce()

    const wheel = (direction: "up" | "down") => {
      ;(scrollRef as any).onMouseEvent({
        type: "scroll",
        scroll: { direction, delta: 1 },
        modifiers: { shift: false, alt: false, ctrl: false },
        isDragging: false,
      })
    }

    const initialMaxScroll = Math.max(0, scrollRef!.scrollHeight - scrollRef!.viewport.height)
    expect(scrollRef!.scrollTop).toBe(initialMaxScroll)

    wheel("up")
    await testSetup.renderOnce()
    expect(scrollRef!.scrollTop).toBeLessThan(initialMaxScroll)

    wheel("down")
    await testSetup.renderOnce()
    expect(scrollRef!.scrollTop).toBe(initialMaxScroll)

    setItems((prev) => [...prev, ...Array.from({ length: 5 }, (_, i) => `Line ${INITIAL_COUNT + i}`)])
    await testSetup.renderOnce()

    const finalMaxScroll = Math.max(0, scrollRef!.scrollHeight - scrollRef!.viewport.height)
    expect(scrollRef!.scrollTop).toBe(finalMaxScroll)
    expect(testSetup.captureCharFrame()).toContain("Line 24")
  })

  it("accidental scroll when no scrollable content does not disable sticky", async () => {
    const [items, setItems] = createSignal<string[]>([])
    let scrollRef: ScrollBoxRenderable | undefined

    testSetup = await testRender(
      () => (
        <scrollbox
          ref={(r) => {
            scrollRef = r
          }}
          width={40}
          height={10}
          stickyScroll={true}
          stickyStart="bottom"
        >
          <For each={items()}>
            {(item) => (
              <box>
                <text>{item}</text>
              </box>
            )}
          </For>
        </scrollbox>
      ),
      {
        width: 80,
        height: 24,
      },
    )

    await testSetup.renderOnce()

    // Try to scroll when there's no scrollable content (accidental scroll)
    if (scrollRef) {
      // Simulate accidental scroll attempts when there's no meaningful content
      scrollRef.scrollBy(100)
      await testSetup.renderOnce()
      scrollRef.scrollTo(50)
      await testSetup.renderOnce()
      scrollRef.scrollTop = 10
      await testSetup.renderOnce()

      // _hasManualScroll should still be false because there was no meaningful scrollable content
      expect((scrollRef as any)._hasManualScroll).toBe(false)
    }

    // Now add content to make it scrollable
    for (let i = 0; i < 30; i++) {
      setItems((prev) => [...prev, `Line ${i}`])
      await testSetup.renderOnce()

      const maxScroll = Math.max(0, scrollRef!.scrollHeight - scrollRef!.viewport.height)

      // Should still be at bottom due to sticky scroll
      if (i === 16) {
        expect(scrollRef!.scrollTop).toBe(maxScroll)
        expect((scrollRef as any)._hasManualScroll).toBe(false)
      }
    }

    // Final check - should still be at bottom
    const finalMaxScroll = Math.max(0, scrollRef!.scrollHeight - scrollRef!.viewport.height)
    expect(scrollRef!.scrollTop).toBe(finalMaxScroll)
  })

  it("sticky scroll with stickyStart set via setter (not constructor)", async () => {
    const [items, setItems] = createSignal<string[]>(["Line 0"])
    let scrollRef: ScrollBoxRenderable | undefined

    testSetup = await testRender(
      () => {
        const ref = (r: ScrollBoxRenderable) => {
          scrollRef = r
          // Set sticky properties via setters (like SolidJS does)
          if (r && !(r as any).__stickyConfigure) {
            ;(r as any).__stickyConfigure = true
            r.stickyScroll = true
            r.stickyStart = "bottom"
          }
        }

        return (
          <scrollbox ref={ref} width={40} height={10}>
            <For each={items()}>
              {(item) => (
                <box>
                  <text>{item}</text>
                </box>
              )}
            </For>
          </scrollbox>
        )
      },
      {
        width: 80,
        height: 24,
      },
    )

    await testSetup.renderOnce()

    if (scrollRef) {
      scrollRef.scrollBy(100000)
      await testSetup.renderOnce()
    }

    // Add content
    for (let i = 1; i < 30; i++) {
      setItems((prev) => [...prev, `Line ${i}`])
      await testSetup.renderOnce()

      const maxScroll = Math.max(0, scrollRef!.scrollHeight - scrollRef!.viewport.height)

      if (i === 16) {
        expect(scrollRef!.scrollTop).toBe(maxScroll)
      }
    }
  })
})
