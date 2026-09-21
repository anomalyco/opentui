import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { testRender, Dynamic, Portal } from "../index.js"
import { createSignal, Show } from "solid-js"
import { createSpy } from "@opentui/core/testing"
import type { BoxRenderable } from "@opentui/core"

let testSetup: Awaited<ReturnType<typeof testRender>>

describe("SolidJS Renderer - Dynamic and Portal Components", () => {
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

  describe("<Dynamic> Component", () => {
    it("should handle undefined component gracefully", async () => {
      testSetup = await testRender(
        () => (
          <box>
            <Dynamic component={undefined}>This should not render</Dynamic>
          </box>
        ),
        { width: 20, height: 5 },
      )

      await testSetup.renderOnce()
      const children = testSetup.renderer.root.getChildren()[0]!.getChildren()
      expect(children.length).toBe(0)
    })

    it("should pass props correctly to dynamic components", async () => {
      const [color, setColor] = createSignal("red")
      const [text, setText] = createSignal("Initial text")

      testSetup = await testRender(
        () => (
          <box>
            <Dynamic component="text" style={{ fg: color() }}>
              {text()}
            </Dynamic>
          </box>
        ),
        { width: 20, height: 3 },
      )

      await testSetup.renderOnce()
      let frame = testSetup.captureCharFrame()
      expect(frame).toContain("Initial text")

      setColor("blue")
      setText("Updated text")
      await testSetup.renderOnce()
      frame = testSetup.captureCharFrame()
      expect(frame).toContain("Updated text")
      expect(frame).toMatchSnapshot()
    })

    it("should handle event handlers in dynamic components", async () => {
      const onInputSpy = createSpy()

      testSetup = await testRender(
        () => (
          <box>
            <Dynamic component="input" focused={true} onInput={onInputSpy} />
          </box>
        ),
        { width: 20, height: 5 },
      )

      await testSetup.mockInput.typeText("test")

      expect(onInputSpy.callCount()).toBe(4)
      expect(onInputSpy.calls[0]?.[0]).toBe("t")
      expect(onInputSpy.calls[3]?.[0]).toBe("test")
    })

    it("should handle false Show inside dynamic that switches between text and box", async () => {
      /* Tests for slot renderable being able handle switching between a LayoutSlot and a TextSlot
       * Expected to just run without crash
       */
      const [componentType, setComponentType] = createSignal<"text" | "box">("text")

      testSetup = await testRender(
        () => (
          <box>
            <Dynamic component={componentType()}>
              <Show when={false}>This should never render</Show>
            </Dynamic>
          </box>
        ),
        { width: 20, height: 5 },
      )

      await testSetup.renderOnce()

      setComponentType("box")
      await testSetup.renderOnce()
    })
  })

  describe("<Portal> Component", () => {
    it("should render content to default mount point", async () => {
      testSetup = await testRender(
        () => (
          <box>
            <text>Before portal</text>
            <Portal>
              <text>Portal content</text>
            </Portal>
            <text>After portal</text>
          </box>
        ),
        { width: 25, height: 8 },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toContain("Portal content")
    })

    it("should render content to custom mount point", async () => {
      let customMount!: BoxRenderable

      testSetup = await testRender(
        () => (
          <box>
            <box ref={customMount} />
            <Portal mount={customMount}>
              <box style={{ border: true }} title="Portal Box">
                <text>Portal content</text>
              </box>
            </Portal>
          </box>
        ),
        { width: 25, height: 8 },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toContain("Portal content")
      expect(customMount.getChildren().length).toBe(1)
    })

    it("should handle complex nested content in portal", async () => {
      testSetup = await testRender(
        () => (
          <box>
            <Portal>
              <text>Nested text 1</text>
              <text>Nested text 2</text>
            </Portal>
          </box>
        ),
        { width: 30, height: 10 },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toContain("Nested text 1")
      expect(frame).toContain("Nested text 2")
    })

    it("should handle portal cleanup on unmount", async () => {
      const [showPortal, setShowPortal] = createSignal(true)

      testSetup = await testRender(
        () => (
          <box>
            <Show when={showPortal()}>
              <Portal>
                <text>Portal content</text>
              </Portal>
            </Show>
          </box>
        ),
        { width: 20, height: 5 },
      )

      await testSetup.renderOnce()
      let frame = testSetup.captureCharFrame()
      expect(frame).toContain("Portal content")

      setShowPortal(false)
      await testSetup.renderOnce()
      frame = testSetup.captureCharFrame()
      expect(frame).not.toContain("Portal content")
    })

    it("should handle multiple portals", async () => {
      testSetup = await testRender(
        () => (
          <box>
            <Portal>
              <text>First portal</text>
            </Portal>
            <Portal>
              <text>Second portal</text>
            </Portal>
          </box>
        ),
        { width: 25, height: 8 },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toContain("First portal")
      expect(frame).toContain("Second portal")
      expect(testSetup.renderer.root.getChildren().length).toBe(3)
    })

    it("should release portal child listeners on unmount", async () => {
      const [showPortal, setShowPortal] = createSignal(false)

      testSetup = await testRender(
        () => (
          <box>
            <Show when={showPortal()}>
              <Portal>
                <scrollbox>
                  <text>Portal content</text>
                </scrollbox>
              </Portal>
            </Show>
          </box>
        ),
        { width: 20, height: 5 },
      )

      await testSetup.renderOnce()
      const baseline = testSetup.renderer.listenerCount("selection")

      setShowPortal(true)
      await testSetup.renderOnce()
      expect(testSetup.renderer.listenerCount("selection")).toBe(baseline + 1)

      setShowPortal(false)
      await testSetup.renderOnce()
      await Bun.sleep(0)
      expect(testSetup.renderer.listenerCount("selection")).toBe(baseline)
    })
  })

  describe("<Dynamic> + <Portal> Integration", () => {
    it("should handle Dynamic component inside Portal", async () => {
      const [useComponentA, setUseComponentA] = createSignal(true)

      testSetup = await testRender(
        () => {
          const ComponentA = () => <text>Portal Component A</text>
          const ComponentB = () => <text>Portal Component B</text>

          return (
            <box>
              <Portal>
                <Dynamic component={useComponentA() ? ComponentA : ComponentB} />
              </Portal>
            </box>
          )
        },
        { width: 25, height: 8 },
      )

      await testSetup.renderOnce()
      let frame = testSetup.captureCharFrame()
      expect(frame).toContain("Portal Component A")

      setUseComponentA(false)
      await testSetup.renderOnce()
      frame = testSetup.captureCharFrame()
      expect(frame).toContain("Portal Component B")
    })

    it("should handle Portal with Dynamic mount point", async () => {
      const [useCustomMount, setUseCustomMount] = createSignal(false)

      let ref!: BoxRenderable

      testSetup = await testRender(
        () => (
          <box>
            <box ref={ref}>
              <text>Custom target</text>
            </box>
            <Portal mount={useCustomMount() ? ref : undefined}>
              <text>Dynamic mount content</text>
            </Portal>
            <text>Static content</text>
          </box>
        ),
        { width: 30, height: 10 },
      )

      await testSetup.renderOnce()
      let frame = testSetup.captureCharFrame()
      expect(frame).toContain("Dynamic mount content")
      expect(ref.getChildren().length).toBe(1)

      setUseCustomMount(true)
      await testSetup.renderOnce()
      frame = testSetup.captureCharFrame()
      expect(frame).toContain("Dynamic mount content")
      expect(ref.getChildren().length).toBe(2)

      setUseCustomMount(false)
      frame = testSetup.captureCharFrame()
      expect(frame).toContain("Dynamic mount content")
      expect(ref.getChildren().length).toBe(1)
    })

    it("should handle switching between Portal and non-Portal with Dynamic", async () => {
      const [usePortal, setUsePortal] = createSignal(true)

      let ref!: BoxRenderable

      testSetup = await testRender(
        () => (
          <box ref={ref}>
            <Dynamic component={usePortal() ? Portal : "box"} {...(usePortal() ? {} : { style: { border: true } })}>
              <text>Conditional portal content</text>
            </Dynamic>
          </box>
        ),
        { width: 30, height: 8 },
      )

      await testSetup.renderOnce()
      let frame = testSetup.captureCharFrame()
      expect(frame).toContain("Conditional portal content")
      expect(testSetup.renderer.root.getChildren().length).toBe(2)

      setUsePortal(false)
      await testSetup.renderOnce()
      frame = testSetup.captureCharFrame()
      expect(frame).toContain("Conditional portal content")
      expect(testSetup.renderer.root.getChildren().length).toBe(1)
    })
  })
})
