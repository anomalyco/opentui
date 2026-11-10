import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { testRender } from "../index.js"
import { createSignal } from "solid-js"
import { decodePasteBytes } from "@opentui/core"
import { createSpy } from "@opentui/core/testing"
import { onBlur, onFocus, usePaste, useKeyboard } from "../src/elements/hooks.js"
import type { PasteEvent } from "@opentui/core"

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

  describe("Event Scenarios", () => {
    it("should handle input onInput events", async () => {
      const onInputSpy = createSpy()
      const [value, setValue] = createSignal("")

      testSetup = await testRender(
        () => (
          <box>
            <input
              focused
              onInput={(val) => {
                onInputSpy(val)
                setValue(val)
              }}
            />
            <text>Value: {value()}</text>
          </box>
        ),
        { width: 20, height: 5 },
      )

      await testSetup.mockInput.typeText("hello")

      expect(onInputSpy.callCount()).toBe(5)
      expect(onInputSpy.calls[0]?.[0]).toBe("h")
      expect(onInputSpy.calls[4]?.[0]).toBe("hello")

      expect(value()).toBe("hello")
    })

    it("should handle input onSubmit events", async () => {
      const onSubmitSpy = createSpy()
      const [submittedValue, setSubmittedValue] = createSignal("")

      testSetup = await testRender(
        () => (
          <box>
            <input focused onInput={(val) => setSubmittedValue(val)} onSubmit={(val) => onSubmitSpy(val)} />
          </box>
        ),
        { width: 20, height: 5 },
      )

      await testSetup.mockInput.typeText("test input")

      testSetup.mockInput.pressEnter()

      expect(onSubmitSpy.callCount()).toBe(1)
      expect(onSubmitSpy.calls[0]?.[0]).toBe("test input")
      expect(submittedValue()).toBe("test input")
    })

    it("should handle select onChange events", async () => {
      const onChangeSpy = createSpy()
      const [selectedIndex, setSelectedIndex] = createSignal(0)

      const options = [
        { name: "Option 1", value: 1, description: "First option" },
        { name: "Option 2", value: 2, description: "Second option" },
        { name: "Option 3", value: 3, description: "Third option" },
      ]

      testSetup = await testRender(
        () => (
          <box>
            <select
              focused
              options={options}
              onChange={(index, option) => {
                onChangeSpy(index, option)
                setSelectedIndex(index)
              }}
            />
            <text>Selected: {selectedIndex()}</text>
          </box>
        ),
        { width: 30, height: 10 },
      )

      testSetup.mockInput.pressArrow("down")

      expect(onChangeSpy.callCount()).toBe(1)
      expect(onChangeSpy.calls[0]?.[0]).toBe(1)
      expect(onChangeSpy.calls[0]?.[1]).toEqual(options[1])

      expect(selectedIndex()).toBe(1)
    })

    it("should handle tab_select onSelect events", async () => {
      const onSelectSpy = createSpy()
      const [activeTab, setActiveTab] = createSignal(0)

      const tabs = [{ title: "Tab 1" }, { title: "Tab 2" }, { title: "Tab 3" }]

      testSetup = await testRender(
        () => (
          <box>
            <tab_select
              focused
              options={tabs.map((tab, index) => ({
                name: tab.title,
                value: index,
                description: "",
              }))}
              onSelect={(index) => {
                onSelectSpy(index)
                setActiveTab(index)
              }}
            />
            <text>Active tab: {activeTab()}</text>
          </box>
        ),
        { width: 40, height: 8 },
      )

      testSetup.mockInput.pressArrow("right")
      testSetup.mockInput.pressArrow("right")

      testSetup.mockInput.pressEnter()

      expect(onSelectSpy.callCount()).toBe(1)
      expect(onSelectSpy.calls[0]?.[0]).toBe(2)

      expect(activeTab()).toBe(2)
    })

    it("should handle focus management", async () => {
      const input1Spy = createSpy()
      const input2Spy = createSpy()
      const [input1Focused, setInput1Focused] = createSignal(true)
      const [input2Focused, setInput2Focused] = createSignal(false)

      testSetup = await testRender(
        () => (
          <box>
            <input focused={input1Focused()} onInput={input1Spy} />
            <input focused={input2Focused()} onInput={input2Spy} />
          </box>
        ),
        { width: 30, height: 8 },
      )

      await testSetup.mockInput.typeText("first")

      expect(input1Spy.callCount()).toBe(5) // "f", "i", "r", "s", "t"
      expect(input2Spy.callCount()).toBe(0)

      // NOTE: Here tabbing would switch focus when it is implemented
      setInput1Focused(false)
      setInput2Focused(true)

      input1Spy.reset()
      input2Spy.reset()

      await testSetup.mockInput.typeText("second")

      expect(input1Spy.callCount()).toBe(0)
      expect(input2Spy.callCount()).toBe(6) // "s", "e", "c", "o", "n", "d"
    })

    it("should handle event handler attachment", async () => {
      const inputSpy = createSpy()

      testSetup = await testRender(
        () => (
          <box>
            <input focused onInput={inputSpy} />
          </box>
        ),
        { width: 20, height: 5 },
      )

      await testSetup.mockInput.typeText("test")

      expect(inputSpy.callCount()).toBe(4)
      expect(inputSpy.calls[0]?.[0]).toBe("t")
      expect(inputSpy.calls[3]?.[0]).toBe("test")
    })

    it("should handle keyboard navigation on select components", async () => {
      const changeSpy = createSpy()
      const [selectedValue, setSelectedValue] = createSignal("")

      testSetup = await testRender(
        () => (
          <box>
            <select
              focused
              options={[
                { name: "Option 1", value: "opt1", description: "First option" },
                { name: "Option 2", value: "opt2", description: "Second option" },
                { name: "Option 3", value: "opt3", description: "Third option" },
              ]}
              onChange={(index, option) => {
                changeSpy(index, option)
                setSelectedValue(option?.value || "")
              }}
            />
            <text>Selected: {selectedValue()}</text>
          </box>
        ),
        { width: 25, height: 10 },
      )

      testSetup.mockInput.pressArrow("down")

      expect(changeSpy.callCount()).toBe(1)
      expect(changeSpy.calls[0]?.[0]).toBe(1)
      expect(changeSpy.calls[0]?.[1]?.value).toBe("opt2")
      expect(selectedValue()).toBe("opt2")

      testSetup.mockInput.pressArrow("down")

      expect(changeSpy.callCount()).toBe(2)
      expect(changeSpy.calls[1]?.[0]).toBe(2)
      expect(changeSpy.calls[1]?.[1]?.value).toBe("opt3")
      expect(selectedValue()).toBe("opt3")
    })

    it("should handle dynamic arrays and list updates", async () => {
      const [items, setItems] = createSignal(["Item 1", "Item 2"])

      testSetup = await testRender(
        () => (
          <box>
            {items().map((item) => (
              <text>{item}</text>
            ))}
          </box>
        ),
        { width: 20, height: 10 },
      )

      let children = testSetup.renderer.root.getChildren()
      expect(children.length).toBe(1)
      let boxChildren = children[0]!.getChildren()
      expect(boxChildren.length).toBe(2)

      setItems(["Item 1", "Item 2", "Item 3"])

      children = testSetup.renderer.root.getChildren()
      boxChildren = children[0]!.getChildren()
      expect(boxChildren.length).toBe(3)

      setItems(["Item 1", "Item 3"])

      children = testSetup.renderer.root.getChildren()
      boxChildren = children[0]!.getChildren()
      expect(boxChildren.length).toBe(2)
    })

    it("should handle text modifier components", async () => {
      testSetup = await testRender(
        () => (
          <box>
            <text>
              <b>Bold text</b> and <i>italic text</i> with <u>underline</u>
            </text>
          </box>
        ),
        { width: 40, height: 5 },
      )

      await testSetup.renderOnce()

      // The text node should contain the styled text content
      // We can verify this by checking the visual output
      const frame = testSetup.captureCharFrame()
      expect(frame).toContain("Bold text")
      expect(frame).toContain("italic text")
      expect(frame).toContain("underline")
    })

    it("should handle dynamic text content", async () => {
      const [dynamicText, setDynamicText] = createSignal("Initial")

      testSetup = await testRender(
        () => (
          <box>
            <text>Static: {dynamicText()}</text>
            <text>Direct content</text>
          </box>
        ),
        { width: 30, height: 8 },
      )

      await testSetup.renderOnce()

      let frame = testSetup.captureCharFrame()
      expect(frame).toContain("Static: Initial")
      expect(frame).toContain("Direct content")

      setDynamicText("Updated")
      await testSetup.renderOnce()

      frame = testSetup.captureCharFrame()
      expect(frame).toContain("Static: Updated")
      expect(frame).toContain("Direct content")
    })

    it("should handle usePaste hook", async () => {
      const pasteSpy = createSpy()
      const [pastedText, setPastedText] = createSignal("")

      const TestComponent = () => {
        usePaste((event) => {
          const text = decodePasteBytes(event.bytes)
          pasteSpy(text)
          setPastedText(text)
        })

        return (
          <box>
            <text>Pasted: {pastedText()}</text>
          </box>
        )
      }

      testSetup = await testRender(() => <TestComponent />, { width: 30, height: 5 })

      await testSetup.mockInput.pasteBracketedText("pasted content")

      expect(pasteSpy.callCount()).toBe(1)
      expect(pasteSpy.calls[0]?.[0]).toBe("pasted content")
      expect(pastedText()).toBe("pasted content")
    })

    it("should handle terminal focus hooks", async () => {
      const focusSpy = createSpy()
      const blurSpy = createSpy()
      const [status, setStatus] = createSignal("idle")

      const TestComponent = () => {
        onFocus(() => {
          focusSpy()
          setStatus("focused")
        })

        onBlur(() => {
          blurSpy()
          setStatus("blurred")
        })

        return (
          <box>
            <text>Status: {status()}</text>
          </box>
        )
      }

      testSetup = await testRender(() => <TestComponent />, { width: 30, height: 5 })

      testSetup.renderer.stdin.emit("data", Buffer.from("\x1b[I"))
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(focusSpy.callCount()).toBe(1)
      expect(blurSpy.callCount()).toBe(0)
      expect(status()).toBe("focused")

      testSetup.renderer.stdin.emit("data", Buffer.from("\x1b[O"))
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(focusSpy.callCount()).toBe(1)
      expect(blurSpy.callCount()).toBe(1)
      expect(status()).toBe("blurred")
    })

    it("should handle global preventDefault for keyboard events", async () => {
      const inputSpy = createSpy()
      const globalHandlerSpy = createSpy()

      testSetup = await testRender(
        () => (
          <box>
            <input focused onInput={inputSpy} />
          </box>
        ),
        { width: 20, height: 5 },
      )

      // Register global handler that prevents 'a' key
      testSetup.renderer.keyInput.on("keypress", (event) => {
        globalHandlerSpy(event.name)
        if (event.name === "a") {
          event.preventDefault()
        }
      })

      await testSetup.mockInput.typeText("abc")

      // Global handler should be called for all keys
      expect(globalHandlerSpy.callCount()).toBe(3)
      expect(globalHandlerSpy.calls[0]?.[0]).toBe("a")
      expect(globalHandlerSpy.calls[1]?.[0]).toBe("b")
      expect(globalHandlerSpy.calls[2]?.[0]).toBe("c")

      // Input should only receive 'b' and 'c' (not 'a')
      expect(inputSpy.callCount()).toBe(2)
      expect(inputSpy.calls[0]?.[0]).toBe("b")
      expect(inputSpy.calls[1]?.[0]).toBe("bc")
    })

    it("should handle global preventDefault for paste events", async () => {
      const pasteSpy = createSpy()
      const globalHandlerSpy = createSpy()
      const [pastedText, setPastedText] = createSignal("")

      const TestComponent = () => {
        return (
          <box>
            <input
              focused
              onPaste={(val) => {
                pasteSpy(val)
                setPastedText(decodePasteBytes(val.bytes))
              }}
            />
          </box>
        )
      }

      testSetup = await testRender(() => <TestComponent />, { width: 30, height: 5 })

      // Register global handler that prevents paste containing "forbidden"
      testSetup.renderer.keyInput.on("paste", (event: PasteEvent) => {
        const text = decodePasteBytes(event.bytes)
        globalHandlerSpy(text)
        if (text.includes("forbidden")) {
          event.preventDefault()
        }
      })

      // First paste should go through
      await testSetup.mockInput.pasteBracketedText("allowed content")
      expect(globalHandlerSpy.callCount()).toBe(1)
      expect(pasteSpy.callCount()).toBe(1)
      expect(pastedText()).toBe("allowed content")

      // Reset spies
      globalHandlerSpy.reset()
      pasteSpy.reset()

      // Second paste should be prevented
      await testSetup.mockInput.pasteBracketedText("forbidden content")
      expect(globalHandlerSpy.callCount()).toBe(1)
      expect(globalHandlerSpy.calls[0]?.[0]).toBe("forbidden content")
      expect(pasteSpy.callCount()).toBe(0)
      expect(pastedText()).toBe("allowed content") // Should remain unchanged
    })

    it("should handle global handler registered after component mount", async () => {
      const inputSpy = createSpy()
      const [value, setValue] = createSignal("")

      testSetup = await testRender(
        () => (
          <box>
            <input
              focused
              onInput={(val) => {
                inputSpy(val)
                setValue(val)
              }}
            />
            <text>Value: {value()}</text>
          </box>
        ),
        { width: 20, height: 5 },
      )

      // Type before global handler exists
      await testSetup.mockInput.typeText("hello")
      expect(inputSpy.callCount()).toBe(5)
      expect(value()).toBe("hello")

      inputSpy.reset()

      testSetup.renderer.keyInput.on("keypress", (event) => {
        if (/^[0-9]$/.test(event.name)) {
          event.preventDefault()
        }
      })

      // Type mixed content
      await testSetup.mockInput.typeText("abc123xyz")

      // Only letters should reach the input
      expect(inputSpy.callCount()).toBe(6) // a, b, c, x, y, z (not 1, 2, 3)
      expect(value()).toBe("helloabcxyz")
    })

    it("should handle dynamic preventDefault conditions", async () => {
      const inputSpy = createSpy()
      let preventNumbers = false

      testSetup = await testRender(
        () => (
          <box>
            <input focused onInput={inputSpy} />
          </box>
        ),
        { width: 20, height: 5 },
      )

      // Register handler with dynamic condition
      testSetup.renderer.keyInput.on("keypress", (event) => {
        if (preventNumbers && /^[0-9]$/.test(event.name)) {
          event.preventDefault()
        }
      })

      // Initially allow numbers
      await testSetup.mockInput.typeText("a1")
      expect(inputSpy.callCount()).toBe(2)
      expect(inputSpy.calls[1]?.[0]).toBe("a1")

      // Enable number prevention
      preventNumbers = true
      inputSpy.reset()

      // Now numbers should be prevented
      await testSetup.mockInput.typeText("b2c3")
      expect(inputSpy.callCount()).toBe(2) // Only 'b' and 'c'
      expect(inputSpy.calls[0]?.[0]).toBe("a1b")
      expect(inputSpy.calls[1]?.[0]).toBe("a1bc")

      // Disable prevention again
      preventNumbers = false
      inputSpy.reset()

      // Numbers should work again
      await testSetup.mockInput.typeText("4")
      expect(inputSpy.callCount()).toBe(1)
      expect(inputSpy.calls[0]?.[0]).toBe("a1bc4")
    })

    it("should handle preventDefault for select components", async () => {
      const changeSpy = createSpy()
      const globalHandlerSpy = createSpy()
      const [selectedIndex, setSelectedIndex] = createSignal(0)

      testSetup = await testRender(
        () => (
          <box>
            <select
              focused
              wrapSelection
              options={[
                { name: "Option 1", value: 1, description: "First" },
                { name: "Option 2", value: 2, description: "Second" },
                { name: "Option 3", value: 3, description: "Third" },
              ]}
              onChange={(index, option) => {
                changeSpy(index, option)
                setSelectedIndex(index)
              }}
            />
            <text>Selected: {selectedIndex()}</text>
          </box>
        ),
        { width: 30, height: 10 },
      )

      // Register global handler that prevents down arrow
      testSetup.renderer.keyInput.on("keypress", (event) => {
        globalHandlerSpy(event.name)
        if (event.name === "down") {
          event.preventDefault()
        }
      })

      // Try to press down arrow - should be prevented
      testSetup.mockInput.pressArrow("down")
      expect(globalHandlerSpy.callCount()).toBe(1)
      expect(changeSpy.callCount()).toBe(0) // Should not change
      expect(selectedIndex()).toBe(0) // Should remain at 0

      // Up arrow should still work
      testSetup.mockInput.pressArrow("up")
      expect(globalHandlerSpy.callCount()).toBe(2)
      expect(changeSpy.callCount()).toBe(1) // Should wrap to last option
      expect(selectedIndex()).toBe(2) // Should be at last option
    })

    it("should handle multiple global handlers with preventDefault", async () => {
      const inputSpy = createSpy()
      const firstHandlerSpy = createSpy()
      const secondHandlerSpy = createSpy()

      testSetup = await testRender(
        () => (
          <box>
            <input focused onInput={inputSpy} />
          </box>
        ),
        { width: 20, height: 5 },
      )

      // First handler prevents 'x'
      testSetup.renderer.keyInput.on("keypress", (event) => {
        firstHandlerSpy(event.name)
        if (event.name === "x") {
          event.preventDefault()
        }
      })

      // Second handler also runs but can't undo preventDefault
      testSetup.renderer.keyInput.on("keypress", (event) => {
        secondHandlerSpy(event.name)
      })

      await testSetup.mockInput.typeText("xyz")

      // Both handlers should be called for all keys
      expect(firstHandlerSpy.callCount()).toBe(3)
      expect(secondHandlerSpy.callCount()).toBe(3)

      // But input should only receive 'y' and 'z'
      expect(inputSpy.callCount()).toBe(2)
      expect(inputSpy.calls[0]?.[0]).toBe("y")
      expect(inputSpy.calls[1]?.[0]).toBe("yz")
    })

    it("should handle textarea onSubmit events", async () => {
      const onSubmitSpy = createSpy()

      testSetup = await testRender(
        () => (
          <box>
            <textarea focused initialValue="test content" onSubmit={() => onSubmitSpy()} />
          </box>
        ),
        { width: 20, height: 5 },
      )

      testSetup.mockInput.pressKey("RETURN", { meta: true })
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(onSubmitSpy.callCount()).toBe(1)
    })

    it("should not trigger textarea onSubmit when return is preventDefault in another component", async () => {
      const textareaSubmitSpy = createSpy()
      const globalReturnHandlerSpy = createSpy()

      const GlobalReturnHandler = () => {
        useKeyboard((event) => {
          if (event.name === "return") {
            globalReturnHandlerSpy()
            event.preventDefault()
          }
        })
        return null
      }

      testSetup = await testRender(
        () => (
          <box>
            <GlobalReturnHandler />
            <textarea focused initialValue="test content" onSubmit={() => textareaSubmitSpy()} />
          </box>
        ),
        { width: 20, height: 5 },
      )

      testSetup.mockInput.pressEnter()
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(globalReturnHandlerSpy.callCount()).toBe(1)
      expect(textareaSubmitSpy.callCount()).toBe(0)
    })
  })
})
