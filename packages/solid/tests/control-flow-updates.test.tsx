import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { TextNodeRenderable, TextRenderable } from "@opentui/core"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import { testRender } from "../index.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

function textFragments(textRenderable: TextRenderable): string[] {
  const textChildren = textRenderable.getTextChildren()
  for (const child of textChildren) {
    expect(child).toBeInstanceOf(TextNodeRenderable)
  }
  return textChildren.flatMap((child) => (child as TextNodeRenderable).toChunks().map((chunk) => chunk.text))
}

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

  it.each([
    {
      shape: "single node",
      label: "an empty",
      fallback: "",
      empty: [""],
      fragments: ["Mounted"],
      content: () => <span>Mounted</span>,
    },
    {
      shape: "array nodes",
      label: "an empty",
      fallback: "",
      empty: [""],
      fragments: ["Alpha", "Bravo"],
      content: () => [<span>Alpha</span>, <span>Bravo</span>],
    },
    {
      shape: "array nodes",
      label: "an undefined",
      fallback: undefined,
      empty: [],
      fragments: ["Alpha", "Bravo"],
      content: () => [<span>Alpha</span>, <span>Bravo</span>],
    },
  ])(
    "keeps sibling order while alternating $label <Show> fallback and $shape content repeatedly",
    async ({ fallback, empty, fragments, content }) => {
      const [visible, setVisible] = createSignal(true)

      testSetup = await testRender(
        () => (
          <box id="container">
            <text id="before">Before</text>
            <text id="conditional">
              <Show when={visible()} fallback={fallback}>
                {content()}
              </Show>
            </text>
            <text id="after">After</text>
          </box>
        ),
        { width: 20, height: 5 },
      )

      const expectSiblingOrder = () => {
        const container = testSetup.renderer.root.getChildren()[0]!
        const children = container.getChildren()
        expect(children.map((child) => child.id)).toEqual(["before", "conditional", "after"])
        const conditional = children[1]!
        expect(conditional).toBeInstanceOf(TextRenderable)
        return conditional as TextRenderable
      }

      const expectMounted = () => {
        const conditional = expectSiblingOrder()
        expect(textFragments(conditional)).toEqual(fragments)

        const frame = testSetup.captureCharFrame()
        expect(frame).toContain("Before")
        for (const fragment of fragments) {
          expect(frame).toContain(fragment)
        }
        expect(frame).toContain("After")
        let previousIndex = frame.indexOf("Before")
        for (const fragment of fragments) {
          const fragmentIndex = frame.indexOf(fragment)
          expect(previousIndex).toBeLessThan(fragmentIndex)
          previousIndex = fragmentIndex
        }
        expect(previousIndex).toBeLessThan(frame.indexOf("After"))
      }

      const expectFallback = () => {
        const conditional = expectSiblingOrder()
        expect(textFragments(conditional)).toEqual(empty)

        const frame = testSetup.captureCharFrame()
        expect(frame).toContain("Before")
        for (const fragment of fragments) {
          expect(frame).not.toContain(fragment)
        }
        expect(frame).toContain("After")
        expect(frame.indexOf("Before")).toBeLessThan(frame.indexOf("After"))
      }

      await testSetup.renderOnce()
      expectMounted()

      for (let cycle = 0; cycle < 3; cycle++) {
        setVisible(false)
        await testSetup.renderOnce()
        expectFallback()

        setVisible(true)
        await testSetup.renderOnce()
        expectMounted()
      }
    },
  )
})
