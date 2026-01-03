import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Renderable } from "@opentui/core"
import { For, createSignal } from "solid-js"
import { testRender } from "../index"

let testSetup: Awaited<ReturnType<typeof testRender>>

describe("SolidJS Renderer - Cleanup", () => {
  beforeEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  it("destroys renderables when list items are removed", async () => {
    const [items, setItems] = createSignal<number[]>([])

    testSetup = await testRender(
      () => (
        <box>
          <For each={items()}>
            {(id) => (
              <box>
                <text>Item {id}</text>
              </box>
            )}
          </For>
        </box>
      ),
      { width: 20, height: 10 },
    )

    await testSetup.renderOnce()
    const baseline = Renderable.renderablesByNumber.size

    setItems([0])
    await testSetup.renderOnce()
    const perItem = Renderable.renderablesByNumber.size - baseline
    expect(perItem).toBeGreaterThan(0)

    setItems(Array.from({ length: 10 }, (_, i) => i))
    await testSetup.renderOnce()
    expect(Renderable.renderablesByNumber.size).toBe(baseline + perItem * 10)

    setItems([8, 9])
    await testSetup.renderOnce()
    expect(Renderable.renderablesByNumber.size).toBe(baseline + perItem * 2)
  })
})
