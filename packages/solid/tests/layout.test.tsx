import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { testRender } from "../index.js"
import { createSignal, Show } from "solid-js"

let testSetup: Awaited<ReturnType<typeof testRender>>

describe("SolidJS Renderer Integration Tests", () => {
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

  describe("Basic Text Rendering", () => {
    it("should render simple text correctly", async () => {
      testSetup = await testRender(() => <text>Hello World</text>, {
        width: 20,
        height: 5,
      })

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render multiline text correctly", async () => {
      testSetup = await testRender(
        () => (
          <text>
            Line 1
            <br />
            Line 2
            <br />
            Line 3
          </text>
        ),
        {
          width: 15,
          height: 5,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should throw on rendering text without parent <text> element", async () => {
      expect(
        testRender(() => <box>This text is not wrapped in a text element</box>, {
          width: 30,
          height: 5,
        }),
      ).rejects.toThrow()
    })

    it("should throw on rendering span without parent <text> element", async () => {
      expect(
        testRender(
          () => (
            <box>
              <span>This text is not wrapped in a text element</span>
            </box>
          ),
          {
            width: 30,
            height: 5,
          },
        ),
      ).rejects.toThrow()
    })

    it("should render text with dynamic content", async () => {
      const counter = () => 42

      testSetup = await testRender(() => <text>Counter: {counter()}</text>, {
        width: 20,
        height: 3,
      })

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })
  })

  describe("Box Layout Rendering", () => {
    it("should render basic box layout correctly", async () => {
      testSetup = await testRender(
        () => (
          <box style={{ width: 20, height: 5, border: true }}>
            <text>Inside Box</text>
          </box>
        ),
        {
          width: 25,
          height: 8,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render nested boxes correctly", async () => {
      testSetup = await testRender(
        () => (
          <box style={{ width: 30, height: 10, border: true }} title="Parent Box">
            <box style={{ left: 2, top: 2, width: 10, height: 3, border: true }}>
              <text>Nested</text>
            </box>
            <text style={{ left: 15, top: 2 }}>Sibling</text>
          </box>
        ),
        {
          width: 35,
          height: 12,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render absolute positioned boxes", async () => {
      testSetup = await testRender(
        () => (
          <>
            <box
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: 10,
                height: 3,
                border: true,
                backgroundColor: "red",
              }}
            >
              <text>Box 1</text>
            </box>
            <box
              style={{
                position: "absolute",
                left: 12,
                top: 2,
                width: 10,
                height: 3,
                border: true,
                backgroundColor: "blue",
              }}
            >
              <text>Box 2</text>
            </box>
          </>
        ),
        {
          width: 25,
          height: 8,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should auto-enable border when borderStyle is set", async () => {
      testSetup = await testRender(
        () => (
          <box style={{ width: 20, height: 5 }} borderStyle="single">
            <text>With Border</text>
          </box>
        ),
        {
          width: 25,
          height: 8,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should auto-enable border when borderColor is set", async () => {
      testSetup = await testRender(
        () => (
          <box style={{ width: 20, height: 5 }} borderColor="cyan">
            <text>Colored Border</text>
          </box>
        ),
        {
          width: 25,
          height: 8,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should auto-enable border when focusedBorderColor is set", async () => {
      testSetup = await testRender(
        () => (
          <box style={{ width: 20, height: 5 }} focusedBorderColor="yellow">
            <text>Focused Border</text>
          </box>
        ),
        {
          width: 25,
          height: 8,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })
  })

  describe("Reactive Updates", () => {
    it("should handle reactive state changes", async () => {
      const [counter, setCounter] = createSignal(0)

      testSetup = await testRender(() => <text>Counter: {counter()}</text>, {
        width: 15,
        height: 3,
      })

      await testSetup.renderOnce()
      const initialFrame = testSetup.captureCharFrame()

      setCounter(5)
      await testSetup.renderOnce()
      const updatedFrame = testSetup.captureCharFrame()

      expect(initialFrame).toMatchSnapshot()
      expect(updatedFrame).toMatchSnapshot()
      expect(updatedFrame).not.toBe(initialFrame)
    })

    it("should handle conditional rendering", async () => {
      const [showText, setShowText] = createSignal(true)

      testSetup = await testRender(
        () => (
          <text wrapMode="none">
            Always visible
            <Show when={showText()} fallback="">
              {" - Conditional text"}
            </Show>
          </text>
        ),
        {
          width: 30,
          height: 3,
        },
      )

      await testSetup.renderOnce()
      const visibleFrame = testSetup.captureCharFrame()

      setShowText(false)
      await testSetup.renderOnce()
      const hiddenFrame = testSetup.captureCharFrame()

      expect(visibleFrame).toMatchSnapshot()
      expect(hiddenFrame).toMatchSnapshot()
      expect(hiddenFrame).not.toBe(visibleFrame)
    })
  })

  describe("Complex Layouts", () => {
    it("should render complex nested layout correctly", async () => {
      testSetup = await testRender(
        () => (
          <box style={{ width: 40, border: true }} title="Complex Layout">
            <box style={{ left: 2, width: 15, height: 5, border: true, backgroundColor: "#333" }}>
              <text wrapMode="none" style={{ fg: "cyan" }}>
                Header Section
              </text>
              <text wrapMode="none" style={{ fg: "yellow" }}>
                Menu Item 1
              </text>
              <text wrapMode="none" style={{ fg: "yellow" }}>
                Menu Item 2
              </text>
            </box>
            <box style={{ left: 18, width: 18, height: 8, border: true, backgroundColor: "#222" }}>
              <text wrapMode="none" style={{ fg: "green" }}>
                Content Area
              </text>
              <text wrapMode="none" style={{ fg: "white" }}>
                Some content here
              </text>
              <text wrapMode="none" style={{ fg: "white" }}>
                More content
              </text>
              <text wrapMode="none" style={{ fg: "magenta" }}>
                Footer text
              </text>
            </box>
            <text style={{ left: 2, fg: "gray" }}>Status: Ready</text>
          </box>
        ),
        {
          width: 45,
          height: 18,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render text with mixed styling and layout", async () => {
      testSetup = await testRender(
        () => (
          <box style={{ width: 35, height: 8, border: true }}>
            <text>
              <span style={{ fg: "red", bold: true }}>ERROR:</span> Something went wrong
            </text>
            <text>
              <span style={{ fg: "yellow" }}>WARNING:</span> Check your settings
            </text>
            <text>
              <span style={{ fg: "green" }}>SUCCESS:</span> All systems operational
            </text>
          </box>
        ),
        {
          width: 40,
          height: 10,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render scrollbox with sticky scroll and spacer", async () => {
      testSetup = await testRender(
        () => (
          <box maxHeight={"100%"} maxWidth={"100%"}>
            <scrollbox
              scrollbarOptions={{ visible: false }}
              stickyScroll={true}
              stickyStart="bottom"
              paddingTop={1}
              paddingBottom={1}
              title="scroll area"
              rootOptions={{
                flexGrow: 0,
              }}
              border
            >
              <box border height={10} title="hi" />
            </scrollbox>
            <box border height={10} title="spacer" flexShrink={0}>
              <text>spacer</text>
            </box>
          </box>
        ),
        {
          width: 30,
          height: 25,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })
  })

  describe("Empty and Edge Cases", () => {
    it("should handle empty component", async () => {
      testSetup = await testRender(() => <></>, {
        width: 10,
        height: 5,
      })

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should handle component with no children", async () => {
      testSetup = await testRender(() => <box style={{ width: 10, height: 5 }} />, {
        width: 15,
        height: 8,
      })

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should handle very small dimensions", async () => {
      testSetup = await testRender(() => <text>Hi</text>, {
        width: 5,
        height: 3,
      })

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })
  })
})
