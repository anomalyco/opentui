import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { useState } from "react"
import { act } from "react"
import { testRender } from "../src/test-utils.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

describe("React Renderer | Layout Tests", () => {
  let originalConsoleError: (...args: any[]) => void

  beforeAll(() => {
    originalConsoleError = console.error
    console.error = mock(() => {})
  })

  afterAll(() => {
    console.error = originalConsoleError
  })

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
      testSetup = await testRender(<text>Hello World</text>, {
        width: 20,
        height: 5,
      })

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render multiline text correctly", async () => {
      testSetup = await testRender(
        <text>
          Line 1
          <br />
          Line 2
          <br />
          Line 3
        </text>,
        {
          width: 15,
          height: 5,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should catch and display error when rendering text without parent <text> element", async () => {
      testSetup = await testRender(<box>This text is not wrapped in a text element</box>, {
        width: 60,
        height: 15,
      })
      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toContain("Error:")
      expect(frame).toContain("Text must be created inside of a text node")
      expect(frame).not.toContain("This text is not wrapped in a text element")
    })

    it("should catch and display error when rendering span without parent <text> element", async () => {
      testSetup = await testRender(
        <box>
          <span>This text is not wrapped in a text element</span>
        </box>,
        { width: 100, height: 15 },
      )
      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toContain("Error:")
      expect(frame).toContain('Component of type "span" must be created inside of a text node')
      expect(frame).not.toContain("This text is not wrapped in a text element")
    })

    it("should render text with dynamic content", async () => {
      const counter = () => 42

      testSetup = await testRender(<text>Counter: {counter()}</text>, {
        width: 20,
        height: 3,
      })

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })
  })

  describe("Duplicate IDs", () => {
    it("removes the exact duplicate-id child during keyed list reconciliation", async () => {
      let setItems!: (items: number[]) => void

      function TestComponent() {
        const [items, updateItems] = useState([0, 1, 2])
        setItems = updateItems

        return (
          <box id="container">
            {items.map((item) => (
              <box key={item} id="duplicate" height={1} flexShrink={0} />
            ))}
          </box>
        )
      }

      testSetup = await testRender(<TestComponent />, { width: 20, height: 5 })
      await testSetup.renderOnce()

      const container = testSetup.renderer.root.findDescendantById("container")!
      const initialChildren = container.getChildren()
      const removedChild = initialChildren[1]!

      act(() => setItems([0, 2]))
      await testSetup.renderOnce()

      const children = container.getChildren()
      expect(children).toHaveLength(2)
      expect(children[0]).toBe(initialChildren[0])
      expect(children[1]).toBe(initialChildren[2])
      expect(removedChild.parent).toBeNull()
      expect(children.every((child) => child.id === "duplicate" && child.parent === container)).toBe(true)
    })
  })

  describe("Select Rendering", () => {
    it("should restore the selection indicator when the prop resets", async () => {
      let resetIndicator: () => void

      function TestComponent() {
        const [showSelectionIndicator, setShowSelectionIndicator] = useState<boolean | undefined>(false)
        resetIndicator = () => setShowSelectionIndicator(undefined)

        return (
          <select
            width={20}
            height={2}
            showDescription={false}
            showSelectionIndicator={showSelectionIndicator}
            options={[{ name: "Option", description: "" }]}
          />
        )
      }

      testSetup = await testRender(<TestComponent />, { width: 20, height: 2 })
      await testSetup.renderOnce()
      expect(testSetup.captureCharFrame().split("\n")[0]).toStartWith(" Option")

      act(() => resetIndicator())
      await testSetup.renderOnce()
      expect(testSetup.captureCharFrame().split("\n")[0]).toStartWith(" ▶ Option")
    })
  })

  describe("Box Layout Rendering", () => {
    it("should render basic box layout correctly", async () => {
      testSetup = await testRender(
        <box style={{ width: 20, height: 5, border: true }}>
          <text>Inside Box</text>
        </box>,
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
        <box style={{ width: 30, height: 10, border: true }} title="Parent Box">
          <box style={{ left: 2, top: 2, width: 10, height: 3, border: true }}>
            <text>Nested</text>
          </box>
          <text style={{ left: 15, top: 2 }}>Sibling</text>
        </box>,
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
        </>,
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
        <box style={{ width: 20, height: 5 }} borderStyle="single">
          <text>With Border</text>
        </box>,
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
        <box style={{ width: 20, height: 5 }} borderColor="cyan">
          <text>Colored Border</text>
        </box>,
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
        <box style={{ width: 20, height: 5 }} focusedBorderColor="yellow">
          <text>Focused Border</text>
        </box>,
        {
          width: 25,
          height: 8,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should support focusable prop and controlled focus state", async () => {
      let boxRef: any
      let setFocused: (value: boolean) => void

      function TestComponent() {
        const [focused, _setFocused] = useState(false)
        setFocused = _setFocused

        return (
          <box
            ref={(r) => {
              boxRef = r
            }}
            focusable
            focused={focused}
            style={{ width: 10, height: 5, border: true }}
          />
        )
      }

      testSetup = await testRender(<TestComponent />, {
        width: 15,
        height: 8,
      })

      await testSetup.renderOnce()

      expect(boxRef.focusable).toBe(true)
      expect(boxRef.focused).toBe(false)

      act(() => {
        setFocused(true)
      })
      await testSetup.renderOnce()

      expect(boxRef.focused).toBe(true)

      act(() => {
        setFocused(false)
      })
      await testSetup.renderOnce()

      expect(boxRef.focused).toBe(false)
    })
  })

  // describe("Reactive Updates", () => {
  //   it("should handle reactive state changes", async () => {
  //     const [counter, setCounter] = createSignal(0)

  //     testSetup = await testRender(<text>Counter: {counter()}</text>, {
  //       width: 15,
  //       height: 3,
  //     })

  //     await testSetup.renderOnce()
  //     const initialFrame = testSetup.captureCharFrame()

  //     setCounter(5)
  //     await testSetup.renderOnce()
  //     const updatedFrame = testSetup.captureCharFrame()

  //     expect(initialFrame).toMatchSnapshot()
  //     expect(updatedFrame).toMatchSnapshot()
  //     expect(updatedFrame).not.toBe(initialFrame)
  //   })

  //   it("should handle conditional rendering", async () => {
  //     const [showText, setShowText] = createSignal(true)

  //     testSetup = await testRender(
  //       () => (
  //         <text wrapMode="none">
  //           Always visible
  //           <Show when={showText()} fallback="">
  //             {" - Conditional text"}
  //           </Show>
  //         </text>
  //       ),
  //       {
  //         width: 30,
  //         height: 3,
  //       },
  //     )

  //     await testSetup.renderOnce()
  //     const visibleFrame = testSetup.captureCharFrame()

  //     setShowText(false)
  //     await testSetup.renderOnce()
  //     const hiddenFrame = testSetup.captureCharFrame()

  //     expect(visibleFrame).toMatchSnapshot()
  //     expect(hiddenFrame).toMatchSnapshot()
  //     expect(hiddenFrame).not.toBe(visibleFrame)
  //   })
  // })

  describe("Complex Layouts", () => {
    it("should render complex nested layout correctly", async () => {
      testSetup = await testRender(
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
        </box>,
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
        </box>,
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
        </box>,
        {
          width: 30,
          height: 25,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should clip nested scrollbox content (React) [issue #388]", async () => {
      const innerLines = Array.from({ length: 12 }, (_, i) => `LEAK-${i}`)

      testSetup = await testRender(
        <box style={{ width: 50, height: 18, flexDirection: "column", border: true, gap: 0 }}>
          <text>HEADER</text>
          <scrollbox
            id="outer-scroll"
            style={{
              width: 48,
              height: 12,
              border: true,
              overflow: "hidden",
              paddingTop: 0,
              paddingBottom: 0,
              paddingLeft: 0,
              paddingRight: 0,
            }}
            scrollY
          >
            <scrollbox
              id="inner-scroll"
              style={{
                width: 44,
                height: 6,
                border: true,
                overflow: "hidden",
                paddingTop: 0,
                paddingBottom: 0,
                paddingLeft: 0,
                paddingRight: 0,
              }}
              scrollY
            >
              {innerLines.map((line) => (
                <text key={line}>{line}</text>
              ))}
            </scrollbox>
          </scrollbox>
          <text>FOOTER</text>
        </box>,
        {
          width: 52,
          height: 20,
        },
      )

      await testSetup.renderOnce()

      const outer = testSetup.renderer.root.findDescendantById?.("outer-scroll") as any
      const inner = testSetup.renderer.root.findDescendantById?.("inner-scroll") as any
      // Force both scrollboxes to scroll to exercise translation + clipping
      if (inner && typeof inner.scrollTo === "function") {
        inner.scrollTo({ x: 0, y: 100 })
      }
      if (outer && typeof outer.scrollTo === "function") {
        outer.scrollTo({ x: 0, y: 50 })
      }
      await testSetup.renderOnce()

      const frame = testSetup.captureCharFrame()
      const visibleLeakLines = frame.split("\n").filter((line) => line.includes("LEAK-"))

      // The inner viewport height is 4 (6 minus 2 for borders). Currently, the renderer leaks and shows more.
      expect(visibleLeakLines.length).toBeLessThanOrEqual(4)

      // Ensure header/footer are still present for context
      expect(frame).toContain("HEADER")
      expect(frame).toContain("FOOTER")
    })
  })

  describe("Empty and Edge Cases", () => {
    it("should handle empty component", async () => {
      testSetup = await testRender(<></>, {
        width: 10,
        height: 5,
      })

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should handle component with no children", async () => {
      testSetup = await testRender(<box style={{ width: 10, height: 5 }} />, {
        width: 15,
        height: 8,
      })

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should handle very small dimensions", async () => {
      testSetup = await testRender(<text>Hi</text>, {
        width: 5,
        height: 3,
      })

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })
  })

  describe("Layout Property Reset on Component Change (Issue #391)", () => {
    it("should reset alignItems when conditionally switching components", async () => {
      let setToggle: (value: boolean) => void

      function TestComponent() {
        const [toggle, _setToggle] = useState(false)
        setToggle = _setToggle

        if (!toggle) {
          return (
            <box alignItems="center" width={40} height={3}>
              <text>Centered</text>
            </box>
          )
        }
        return (
          <box width={40} height={3}>
            <text>Default</text>
          </box>
        )
      }

      testSetup = await testRender(<TestComponent />, { width: 40, height: 5 })

      await testSetup.renderOnce()
      const centeredFrame = testSetup.captureCharFrame()
      const centeredLines = centeredFrame.split("\n")
      const centeredTextLine = centeredLines.find((line) => line.includes("Centered"))
      expect(centeredTextLine).toBeDefined()
      expect(centeredTextLine!.trimStart()).not.toBe(centeredTextLine)

      act(() => {
        setToggle(true)
      })
      await testSetup.renderOnce()
      const defaultFrame = testSetup.captureCharFrame()
      const defaultLines = defaultFrame.split("\n")
      const defaultTextLine = defaultLines.find((line) => line.includes("Default"))
      expect(defaultTextLine).toBeDefined()
      expect(defaultTextLine!.indexOf("Default")).toBe(0)
    })

    it("should use default alignment when alignItems is not specified", async () => {
      testSetup = await testRender(
        <box width={40} height={3}>
          <text>Left aligned</text>
        </box>,
        {
          width: 40,
          height: 5,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      const lines = frame.split("\n")
      const textLine = lines.find((line) => line.includes("Left aligned"))
      expect(textLine).toBeDefined()
      expect(textLine!.indexOf("Left aligned")).toBe(0)
    })

    it("should reset alignItems when removed from style prop", async () => {
      let setStyle: (style: Record<string, string>) => void

      function TestComponent() {
        const [style, _setStyle] = useState<Record<string, string>>({ alignItems: "center" })
        setStyle = _setStyle

        return (
          <box style={style} width={40} height={3}>
            <text>Test</text>
          </box>
        )
      }

      testSetup = await testRender(<TestComponent />, { width: 40, height: 5 })

      await testSetup.renderOnce()
      const centeredFrame = testSetup.captureCharFrame()
      const centeredLines = centeredFrame.split("\n")
      const centeredTextLine = centeredLines.find((line) => line.includes("Test"))
      expect(centeredTextLine).toBeDefined()
      expect(centeredTextLine!.trimStart()).not.toBe(centeredTextLine)

      act(() => {
        setStyle({})
      })
      await testSetup.renderOnce()
      const defaultFrame = testSetup.captureCharFrame()
      const defaultLines = defaultFrame.split("\n")
      const defaultTextLine = defaultLines.find((line) => line.includes("Test"))
      expect(defaultTextLine).toBeDefined()
      expect(defaultTextLine!.indexOf("Test")).toBe(0)
    })
  })
})
