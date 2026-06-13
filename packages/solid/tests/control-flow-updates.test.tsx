import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import { testRender } from "../index.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

describe("SolidJS Renderer - Control Flow Updates", () => {
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

  it("updates <For> collections reactively", async () => {
    const [items, setItems] = createSignal(["A", "B"])

    testSetup = await testRender(
      () => (
        <box>
          <For each={items()}>{(item) => <text>Item: {item}</text>}</For>
        </box>
      ),
      { width: 20, height: 10 },
    )

    await testSetup.renderOnce()
    expect(testSetup.captureCharFrame()).toContain("Item: B")

    setItems(["A", "B", "C"])
    await testSetup.renderOnce()

    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("Item: A")
    expect(frame).toContain("Item: C")
    expect(testSetup.renderer.root.getChildren()[0]!.getChildren().length).toBe(3)
  })

  it("switches between <Show> content and fallback reactively", async () => {
    const [visible, setVisible] = createSignal(true)

    testSetup = await testRender(
      () => (
        <box>
          <Show when={visible()} fallback={<text>Fallback</text>}>
            <text>Main</text>
          </Show>
        </box>
      ),
      { width: 20, height: 5 },
    )

    await testSetup.renderOnce()
    expect(testSetup.captureCharFrame()).toContain("Main")

    setVisible(false)
    await testSetup.renderOnce()

    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("Fallback")
    expect(frame).not.toContain("Main")
  })

  it("re-evaluates <Switch> matches reactively", async () => {
    const [selected, setSelected] = createSignal(1)

    testSetup = await testRender(
      () => (
        <box>
          <Switch fallback={<text>Other</text>}>
            <Match when={selected() === 1}>
              <text>One</text>
            </Match>
            <Match when={selected() === 2}>
              <text>Two</text>
            </Match>
          </Switch>
        </box>
      ),
      { width: 20, height: 5 },
    )

    await testSetup.renderOnce()
    expect(testSetup.captureCharFrame()).toContain("One")

    setSelected(2)
    await testSetup.renderOnce()

    let frame = testSetup.captureCharFrame()
    expect(frame).toContain("Two")
    expect(frame).not.toContain("One")

    setSelected(3)
    await testSetup.renderOnce()

    frame = testSetup.captureCharFrame()
    expect(frame).toContain("Other")
    expect(frame).not.toContain("Two")
  })
})
