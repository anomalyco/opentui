import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { testRender } from "../index.js"
import { createSignal } from "solid-js"
import { TextAttributes } from "@opentui/core"

let testSetup: Awaited<ReturnType<typeof testRender>>

describe("Textarea Layout Tests", () => {
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

  describe("Basic Textarea Rendering", () => {
    it("should render simple textarea correctly", async () => {
      testSetup = await testRender(
        () => (
          <textarea initialValue="Hello World" width={20} height={5} backgroundColor="#1e1e1e" textColor="#ffffff" />
        ),
        {
          width: 30,
          height: 10,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render multiline textarea content", async () => {
      testSetup = await testRender(
        () => (
          <textarea
            initialValue={"Line 1\nLine 2\nLine 3"}
            width={20}
            height={10}
            backgroundColor="#1e1e1e"
            textColor="#ffffff"
          />
        ),
        {
          width: 30,
          height: 15,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render textarea with word wrapping", async () => {
      testSetup = await testRender(
        () => (
          <textarea
            initialValue="This is a very long line that should wrap to multiple lines when word wrapping is enabled"
            wrapMode="word"
            width={20}
            backgroundColor="#1e1e1e"
            textColor="#ffffff"
          />
        ),
        {
          width: 30,
          height: 15,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render textarea with placeholder", async () => {
      testSetup = await testRender(
        () => (
          <textarea
            initialValue=""
            placeholder="Type something here..."
            placeholderColor="#666666"
            width={30}
            height={5}
            backgroundColor="#1e1e1e"
            textColor="#ffffff"
          />
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
  })

  describe("Prompt-like Layout", () => {
    it("should render textarea in prompt-style layout with indicator", async () => {
      testSetup = await testRender(
        () => (
          <box border borderColor="#444444">
            <box flexDirection="row">
              {/* Indicator box */}
              <box width={3} justifyContent="center" alignItems="center" backgroundColor="#2d2d2d">
                <text attributes={TextAttributes.BOLD} fg="#00ff00">
                  {">"}
                </text>
              </box>

              {/* Textarea container */}
              <box paddingTop={1} paddingBottom={1} backgroundColor="#1e1e1e" flexGrow={1}>
                <textarea
                  initialValue="Hello from the prompt"
                  flexShrink={1}
                  backgroundColor="#1e1e1e"
                  textColor="#ffffff"
                  cursorColor="#00ff00"
                />
              </box>

              {/* Spacer */}
              <box backgroundColor="#1e1e1e" width={1} />
            </box>

            {/* Footer */}
            <box flexDirection="row" justifyContent="space-between">
              <text wrapMode="none">
                <span style={{ fg: "#888888" }}>provider</span> <span style={{ bold: true }}>model-name</span>
              </text>
              <text fg="#888888">ctrl+p commands</text>
            </box>
          </box>
        ),
        {
          width: 60,
          height: 15,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render textarea with long wrapping text in prompt layout", async () => {
      testSetup = await testRender(
        () => (
          <box border borderColor="#444444" width="100%">
            <box flexDirection="row" width="100%">
              <box width={3} justifyContent="center" alignItems="center" backgroundColor="#2d2d2d">
                <text attributes={TextAttributes.BOLD} fg="#00ff00">
                  {">"}
                </text>
              </box>

              <box paddingTop={1} paddingBottom={1} backgroundColor="#1e1e1e" flexGrow={1}>
                <textarea
                  initialValue="This is a very long prompt that will wrap across multiple lines in the textarea. It should maintain proper layout with the indicator on the left."
                  wrapMode="word"
                  flexShrink={1}
                  backgroundColor="#1e1e1e"
                  textColor="#ffffff"
                />
              </box>

              <box backgroundColor="#1e1e1e" width={1} />
            </box>

            <box flexDirection="row">
              <text wrapMode="none">
                <span style={{ fg: "#888888" }}>openai</span> <span style={{ bold: true }}>gpt-4</span>
              </text>
            </box>
          </box>
        ),
        {
          width: 50,
          height: 20,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render textarea in shell mode with different indicator", async () => {
      testSetup = await testRender(
        () => (
          <box border borderColor="#ff9900">
            <box flexDirection="row">
              <box width={3} justifyContent="center" alignItems="center" backgroundColor="#2d2d2d">
                <text attributes={TextAttributes.BOLD} fg="#ff9900">
                  {"!"}
                </text>
              </box>

              <box paddingTop={1} paddingBottom={1} backgroundColor="#1e1e1e" flexGrow={1}>
                <textarea
                  initialValue="ls -la"
                  flexShrink={1}
                  backgroundColor="#1e1e1e"
                  textColor="#ffffff"
                  cursorColor="#ff9900"
                />
              </box>

              <box backgroundColor="#1e1e1e" width={1} />
            </box>

            <box flexDirection="row">
              <text fg="#888888">shell mode</text>
            </box>
          </box>
        ),
        {
          width: 50,
          height: 12,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })
  })

  describe("Complex Layouts with Multiple Textareas", () => {
    it("should render multiple textareas in a column layout", async () => {
      testSetup = await testRender(
        () => (
          <box border title="Chat">
            {/* Message 1 */}
            <box border borderColor="#00ff00" marginBottom={1}>
              <box flexDirection="row">
                <box width={5} backgroundColor="#2d2d2d">
                  <text fg="#00ff00">User</text>
                </box>
                <box paddingLeft={1} backgroundColor="#1e1e1e" flexGrow={1}>
                  <textarea
                    initialValue="What is the weather like today?"
                    wrapMode="word"
                    backgroundColor="#1e1e1e"
                    textColor="#ffffff"
                  />
                </box>
              </box>
            </box>

            {/* Message 2 */}
            <box border borderColor="#0088ff">
              <box flexDirection="row">
                <box width={5} backgroundColor="#2d2d2d">
                  <text fg="#0088ff">AI</text>
                </box>
                <box paddingLeft={1} backgroundColor="#1e1e1e" flexGrow={1}>
                  <textarea
                    initialValue="I don't have access to real-time weather data, but I can help you find that information through various weather services."
                    wrapMode="word"
                    backgroundColor="#1e1e1e"
                    textColor="#ffffff"
                  />
                </box>
              </box>
            </box>
          </box>
        ),
        {
          width: 60,
          height: 25,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should handle nested boxes with textareas at different positions", async () => {
      testSetup = await testRender(
        () => (
          <box style={{ width: 50, border: true }} title="Layout Test">
            <box flexDirection="row" gap={1}>
              {/* Left panel */}
              <box width={20} border borderColor="#00ff00">
                <text fg="#00ff00">Input 1:</text>
                <textarea
                  initialValue="Left panel content"
                  wrapMode="word"
                  backgroundColor="#1e1e1e"
                  textColor="#ffffff"
                  flexShrink={1}
                />
              </box>

              {/* Right panel */}
              <box flexGrow={1} border borderColor="#0088ff">
                <text fg="#0088ff">Input 2:</text>
                <textarea
                  initialValue="Right panel with longer content that may wrap"
                  wrapMode="word"
                  backgroundColor="#1e1e1e"
                  textColor="#ffffff"
                  flexShrink={1}
                />
              </box>
            </box>

            {/* Bottom panel */}
            <box border borderColor="#ff9900" marginTop={1}>
              <text fg="#ff9900">Bottom input:</text>
              <textarea
                initialValue="Bottom panel spanning full width"
                wrapMode="word"
                backgroundColor="#1e1e1e"
                textColor="#ffffff"
                flexShrink={1}
              />
            </box>
          </box>
        ),
        {
          width: 55,
          height: 25,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })
  })

  describe("Text Component Comparison", () => {
    it("should render text in prompt-style layout with indicator", async () => {
      testSetup = await testRender(
        () => (
          <box border borderColor="#444444">
            <box flexDirection="row">
              {/* Indicator box */}
              <box width={3} justifyContent="center" alignItems="center" backgroundColor="#2d2d2d">
                <text attributes={TextAttributes.BOLD} fg="#00ff00">
                  {">"}
                </text>
              </box>

              {/* Text container */}
              <box paddingTop={1} paddingBottom={1} backgroundColor="#1e1e1e" flexGrow={1}>
                <text wrapMode="none" bg="#1e1e1e" fg="#ffffff">
                  Hello from the prompt
                </text>
              </box>

              {/* Spacer */}
              <box backgroundColor="#1e1e1e" width={1} />
            </box>

            {/* Footer */}
            <box flexDirection="row" justifyContent="space-between">
              <text wrapMode="none">
                <span style={{ fg: "#888888" }}>provider</span> <span style={{ bold: true }}>model-name</span>
              </text>
              <text fg="#888888">ctrl+p commands</text>
            </box>
          </box>
        ),
        {
          width: 60,
          height: 15,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render text with long wrapping content in prompt layout", async () => {
      testSetup = await testRender(
        () => (
          <box border borderColor="#444444" width="100%">
            <box flexDirection="row" width="100%">
              <box width={3} justifyContent="center" alignItems="center" backgroundColor="#2d2d2d">
                <text attributes={TextAttributes.BOLD} fg="#00ff00">
                  {">"}
                </text>
              </box>

              <box paddingTop={1} paddingBottom={1} backgroundColor="#1e1e1e" flexGrow={1}>
                <text wrapMode="word" bg="#1e1e1e" fg="#ffffff">
                  This is a very long prompt that will wrap across multiple lines in the text component. It should
                  maintain proper layout with the indicator on the left.
                </text>
              </box>

              <box backgroundColor="#1e1e1e" width={1} />
            </box>

            <box flexDirection="row">
              <text wrapMode="none">
                <span style={{ fg: "#888888" }}>openai</span> <span style={{ bold: true }}>gpt-4</span>
              </text>
            </box>
          </box>
        ),
        {
          width: 50,
          height: 20,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should update text content reactively in prompt layout", async () => {
      const [value, setValue] = createSignal("Initial text")

      testSetup = await testRender(
        () => (
          <box border width="100%">
            <box flexDirection="row" width="100%">
              <box width={3} backgroundColor="#2d2d2d" justifyContent="center" alignItems="center">
                <text fg="#00ff00">{">"}</text>
              </box>
              <box paddingTop={1} paddingBottom={1} backgroundColor="#1e1e1e" flexGrow={1}>
                <text wrapMode="word" bg="#1e1e1e" fg="#ffffff">
                  {value()}
                </text>
              </box>
            </box>
          </box>
        ),
        {
          width: 50,
          height: 12,
        },
      )

      await testSetup.renderOnce()
      const initialFrame = testSetup.captureCharFrame()

      setValue("Updated text that is much longer and should wrap to multiple lines if word wrapping is enabled")
      await testSetup.renderOnce()
      const updatedFrame = testSetup.captureCharFrame()

      expect(initialFrame).toMatchSnapshot()
      expect(updatedFrame).toMatchSnapshot()
      expect(updatedFrame).not.toBe(initialFrame)
    })

    it("should render text in shell mode with different indicator", async () => {
      testSetup = await testRender(
        () => (
          <box border borderColor="#ff9900">
            <box flexDirection="row">
              <box width={3} justifyContent="center" alignItems="center" backgroundColor="#2d2d2d">
                <text attributes={TextAttributes.BOLD} fg="#ff9900">
                  {"!"}
                </text>
              </box>

              <box paddingTop={1} paddingBottom={1} backgroundColor="#1e1e1e" flexGrow={1}>
                <text wrapMode="none" bg="#1e1e1e" fg="#ffffff">
                  ls -la
                </text>
              </box>

              <box backgroundColor="#1e1e1e" width={1} />
            </box>

            <box flexDirection="row">
              <text fg="#888888">shell mode</text>
            </box>
          </box>
        ),
        {
          width: 50,
          height: 12,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render full prompt layout with text component", async () => {
      testSetup = await testRender(
        () => (
          <box>
            {/* Main prompt box */}
            <box border borderColor="#444444">
              <box flexDirection="row">
                {/* Indicator */}
                <box width={3} justifyContent="center" alignItems="center" backgroundColor="#2d2d2d">
                  <text attributes={TextAttributes.BOLD} fg="#00ff00">
                    {">"}
                  </text>
                </box>

                {/* Input area */}
                <box paddingTop={1} paddingBottom={1} backgroundColor="#1e1e1e" flexGrow={1}>
                  <text wrapMode="word" bg="#1e1e1e" fg="#ffffff">
                    Explain how async/await works in JavaScript and provide some examples
                  </text>
                </box>

                {/* Right spacer */}
                <box backgroundColor="#1e1e1e" width={1} justifyContent="center" alignItems="center" />
              </box>

              {/* Status bar */}
              <box flexDirection="row" justifyContent="space-between">
                <text flexShrink={0} wrapMode="none">
                  <span style={{ fg: "#888888" }}>openai</span> <span style={{ bold: true }}>gpt-4-turbo</span>
                </text>
                <text>
                  ctrl+p <span style={{ fg: "#888888" }}>commands</span>
                </text>
              </box>
            </box>

            {/* Helper text below */}
            <box marginTop={1}>
              <text fg="#666666" wrapMode="word">
                Tip: Use arrow keys to navigate through history when cursor is at the start
              </text>
            </box>
          </box>
        ),
        {
          width: 70,
          height: 20,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should handle very long single-line text in prompt layout", async () => {
      testSetup = await testRender(
        () => (
          <box border width="100%">
            <box flexDirection="row" width="100%">
              <box width={3} backgroundColor="#2d2d2d">
                <text>{">"}</text>
              </box>
              <box backgroundColor="#1e1e1e" flexGrow={1} paddingTop={1} paddingBottom={1}>
                <text wrapMode="char" bg="#1e1e1e" fg="#ffffff">
                  ThisIsAVeryLongLineWithNoSpacesThatWillWrapByCharacterWhenCharWrappingIsEnabled
                </text>
              </box>
            </box>
          </box>
        ),
        {
          width: 40,
          height: 15,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render multiline text in prompt layout", async () => {
      testSetup = await testRender(
        () => (
          <box border borderColor="#444444" width="100%">
            <box flexDirection="row" width="100%">
              <box width={3} justifyContent="center" alignItems="center" backgroundColor="#2d2d2d">
                <text attributes={TextAttributes.BOLD} fg="#00ff00">
                  {">"}
                </text>
              </box>

              <box paddingTop={1} paddingBottom={1} backgroundColor="#1e1e1e" flexGrow={1}>
                <text wrapMode="word" bg="#1e1e1e" fg="#ffffff">
                  Line 1: First line of text
                  <br />
                  Line 2: Second line of text
                  <br />
                  Line 3: Third line of text
                </text>
              </box>

              <box backgroundColor="#1e1e1e" width={1} />
            </box>

            <box flexDirection="row">
              <text wrapMode="none">
                <span style={{ fg: "#888888" }}>multiline</span> <span style={{ bold: true }}>example</span>
              </text>
            </box>
          </box>
        ),
        {
          width: 50,
          height: 20,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })
  })

  describe("FlexShrink Regression Tests", () => {
    it("should not shrink box when width is set via setter", async () => {
      const [indicatorWidth, setIndicatorWidth] = createSignal<number | undefined>(undefined)

      testSetup = await testRender(
        () => (
          <box border>
            <box flexDirection="row">
              <box width={indicatorWidth()} backgroundColor="#f00">
                <text>{">"}</text>
              </box>
              <box backgroundColor="#0f0" flexGrow={1}>
                <text>Content that takes up space</text>
              </box>
            </box>
          </box>
        ),
        { width: 30, height: 5 },
      )

      await testSetup.renderOnce()

      setIndicatorWidth(5)
      await testSetup.renderOnce()

      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should not shrink box when height is set via setter in column layout", async () => {
      const [headerHeight, setHeaderHeight] = createSignal<number | undefined>(undefined)

      testSetup = await testRender(
        () => (
          <box border width={25} height={10}>
            <box flexDirection="column" height="100%">
              <box height={headerHeight()} backgroundColor="#f00">
                <text>Header</text>
              </box>
              <box backgroundColor="#0f0" flexGrow={1}>
                <textarea initialValue={"Line1\nLine2\nLine3\nLine4\nLine5\nLine6\nLine7\nLine8"} />
              </box>
              <box height={2} backgroundColor="#00f">
                <text>Footer</text>
              </box>
            </box>
          </box>
        ),
        { width: 30, height: 15 },
      )

      await testSetup.renderOnce()

      setHeaderHeight(3)
      await testSetup.renderOnce()

      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })
  })

  describe("Edge Cases and Styling", () => {
    it("should render textarea with focused colors", async () => {
      testSetup = await testRender(
        () => (
          <box border>
            <box flexDirection="row">
              <box width={3} backgroundColor="#2d2d2d">
                <text>{">"}</text>
              </box>
              <box backgroundColor="#1e1e1e" flexGrow={1} paddingTop={1} paddingBottom={1}>
                <textarea
                  initialValue="Focused textarea"
                  backgroundColor="#1e1e1e"
                  textColor="#888888"
                  focusedBackgroundColor="#2d2d2d"
                  focusedTextColor="#ffffff"
                  flexShrink={1}
                />
              </box>
            </box>
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

    it("should render empty textarea with placeholder in prompt layout", async () => {
      testSetup = await testRender(
        () => (
          <box border borderColor="#444444">
            <box flexDirection="row">
              <box width={3} justifyContent="center" alignItems="center" backgroundColor="#2d2d2d">
                <text attributes={TextAttributes.BOLD} fg="#00ff00">
                  {">"}
                </text>
              </box>

              <box paddingTop={1} paddingBottom={1} backgroundColor="#1e1e1e" flexGrow={1}>
                <textarea
                  initialValue=""
                  placeholder="Enter your prompt here..."
                  placeholderColor="#666666"
                  flexShrink={1}
                  backgroundColor="#1e1e1e"
                  textColor="#ffffff"
                />
              </box>

              <box backgroundColor="#1e1e1e" width={1} />
            </box>

            <box flexDirection="row">
              <text fg="#888888">Ready to chat</text>
            </box>
          </box>
        ),
        {
          width: 50,
          height: 12,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render textarea with very long single line", async () => {
      testSetup = await testRender(
        () => (
          <box border>
            <box flexDirection="row">
              <box width={3} backgroundColor="#2d2d2d">
                <text>{">"}</text>
              </box>
              <box backgroundColor="#1e1e1e" flexGrow={1} paddingTop={1} paddingBottom={1}>
                <textarea
                  initialValue="ThisIsAVeryLongLineWithNoSpacesThatWillWrapByCharacterWhenCharWrappingIsEnabled"
                  wrapMode="char"
                  flexShrink={1}
                  backgroundColor="#1e1e1e"
                  textColor="#ffffff"
                />
              </box>
            </box>
          </box>
        ),
        {
          width: 40,
          height: 15,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render full prompt-like layout with all components", async () => {
      testSetup = await testRender(
        () => (
          <box>
            {/* Main prompt box */}
            <box border borderColor="#444444">
              <box flexDirection="row">
                {/* Indicator */}
                <box width={3} justifyContent="center" alignItems="center" backgroundColor="#2d2d2d">
                  <text attributes={TextAttributes.BOLD} fg="#00ff00">
                    {">"}
                  </text>
                </box>

                {/* Input area */}
                <box paddingTop={1} paddingBottom={1} backgroundColor="#1e1e1e" flexGrow={1}>
                  <textarea
                    initialValue="Explain how async/await works in JavaScript and provide some examples"
                    wrapMode="word"
                    flexShrink={1}
                    backgroundColor="#1e1e1e"
                    textColor="#ffffff"
                    cursorColor="#00ff00"
                  />
                </box>

                {/* Right spacer */}
                <box backgroundColor="#1e1e1e" width={1} justifyContent="center" alignItems="center" />
              </box>

              {/* Status bar */}
              <box flexDirection="row" justifyContent="space-between">
                <text flexShrink={0} wrapMode="none">
                  <span style={{ fg: "#888888" }}>openai</span> <span style={{ bold: true }}>gpt-4-turbo</span>
                </text>
                <text>
                  ctrl+p <span style={{ fg: "#888888" }}>commands</span>
                </text>
              </box>
            </box>

            {/* Helper text below */}
            <box marginTop={1}>
              <text fg="#666666" wrapMode="word">
                Tip: Use arrow keys to navigate through history when cursor is at the start
              </text>
            </box>
          </box>
        ),
        {
          width: 70,
          height: 20,
        },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })
  })

  describe("Measure Cache Edge Cases", () => {
    it("should correctly measure text after content change", async () => {
      const [value, setValue] = createSignal("Short text")

      testSetup = await testRender(
        () => (
          <box border width={40}>
            <text wrapMode="word" bg="#1e1e1e" fg="#ffffff">
              {value()}
            </text>
          </box>
        ),
        { width: 50, height: 15 },
      )

      await testSetup.renderOnce()
      const initialFrame = testSetup.captureCharFrame()

      // Change to longer content that should cause more wrapping
      setValue("This is a much longer text that will definitely wrap to multiple lines when rendered")
      await testSetup.renderOnce()
      const updatedFrame = testSetup.captureCharFrame()

      expect(initialFrame).toMatchSnapshot()
      expect(updatedFrame).toMatchSnapshot()
      expect(updatedFrame).not.toBe(initialFrame)
    })

    it("should handle rapid content updates correctly", async () => {
      const [value, setValue] = createSignal("Initial")

      testSetup = await testRender(
        () => (
          <box border width={30}>
            <text wrapMode="char" bg="#1e1e1e" fg="#ffffff">
              {value()}
            </text>
          </box>
        ),
        { width: 40, height: 10 },
      )

      // Rapid updates to simulate typing
      for (let i = 0; i < 5; i++) {
        setValue(`Update ${i}: some text here`)
        await testSetup.renderOnce()
      }

      const finalFrame = testSetup.captureCharFrame()
      expect(finalFrame).toMatchSnapshot()
    })

    it("should handle width changes with cached measures", async () => {
      const [width, setWidth] = createSignal(30)

      testSetup = await testRender(
        () => (
          <box border width={width()}>
            <text wrapMode="word" bg="#1e1e1e" fg="#ffffff">
              Content that will wrap differently at different widths
            </text>
          </box>
        ),
        { width: 60, height: 15 },
      )

      await testSetup.renderOnce()
      const frame30 = testSetup.captureCharFrame()

      setWidth(50)
      await testSetup.renderOnce()
      const frame50 = testSetup.captureCharFrame()

      setWidth(20)
      await testSetup.renderOnce()
      const frame20 = testSetup.captureCharFrame()

      expect(frame30).toMatchSnapshot()
      expect(frame50).toMatchSnapshot()
      expect(frame20).toMatchSnapshot()
    })

    it("should handle empty to non-empty content transition", async () => {
      const [value, setValue] = createSignal("")

      testSetup = await testRender(
        () => (
          <box border width={40}>
            <text wrapMode="word" bg="#1e1e1e" fg="#ffffff">
              {value() || " "}
            </text>
          </box>
        ),
        { width: 50, height: 10 },
      )

      await testSetup.renderOnce()
      const emptyFrame = testSetup.captureCharFrame()

      setValue("Now with content")
      await testSetup.renderOnce()
      const contentFrame = testSetup.captureCharFrame()

      setValue("")
      await testSetup.renderOnce()
      const emptyAgainFrame = testSetup.captureCharFrame()

      expect(emptyFrame).toMatchSnapshot()
      expect(contentFrame).toMatchSnapshot()
      expect(emptyAgainFrame).toMatchSnapshot()
    })

    it("should correctly measure multiline content with unicode", async () => {
      testSetup = await testRender(
        () => (
          <box border width={30}>
            <text wrapMode="word" bg="#1e1e1e" fg="#ffffff">
              Hello 世界
              <br />
              こんにちは
              <br />🌟 Emoji 🚀
            </text>
          </box>
        ),
        { width: 40, height: 15 },
      )

      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toMatchSnapshot()
    })
  })
})
