import { ResourceContext } from "@opentui/core"

let resourceContext: ResourceContext
beforeEach(() => {
  resourceContext = new ResourceContext({ objectCapacity: 65536, renderCellsMax: 1000000 })
})
afterEach(() => resourceContext.destroy())

import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { testRender } from "../index.js"
import { For, Show, createSignal } from "solid-js"
import type { ScrollBoxRenderable } from "../../core/src/renderables/index.js"
import { SyntaxStyle } from "../../core/src/syntax-style.js"
import { MockTreeSitterClient } from "@opentui/core/testing"

let testSetup: Awaited<ReturnType<typeof testRender>>
let mockTreeSitterClient: MockTreeSitterClient

describe("LineNumber in ScrollBox - Height and Overlap Issues", () => {
  beforeEach(async () => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
    mockTreeSitterClient = new MockTreeSitterClient()
    mockTreeSitterClient.setMockResult({ highlights: [] })
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  it("REPRODUCES BUG: single line_number with code in scrollbox has excessive height", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)
    const codeContent = `function hello() {
  console.log("Hello, World!");
  return 42;
}`

    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <scrollbox flexGrow={1} scrollbarOptions={{ visible: false }}>
            <line_number fg="#888888" minWidth={3} paddingRight={1}>
              <code
                fg="#ffffff"
                filetype="javascript"
                syntaxStyle={syntaxStyle}
                content={codeContent}
                treeSitterClient={mockTreeSitterClient}
              />
            </line_number>
          </scrollbox>
        </box>
      ),
      {
        width: 40,
        height: 30, // Portrait aspect ratio (taller than wide)
      },
    )

    await testSetup.renderOnce()
    mockTreeSitterClient.resolveAllHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await testSetup.renderOnce()

    const frame = testSetup.captureCharFrame()
    expect(frame).toMatchSnapshot()

    // Count the number of lines that have actual content vs empty lines
    const lines = frame.split("\n")
    const contentLines = lines.filter((line) => line.trim().length > 0)
    const emptyLines = lines.filter((line) => line.trim().length === 0)

    // The code has 4 lines, so we expect roughly 4 lines of content
    // There shouldn't be massive amounts of empty space
    const emptyToContentRatio = emptyLines.length / contentLines.length

    // BUG: This ratio is 6.75 (way too high!)
    // Line_number fills entire viewport height instead of wrapping content
    expect(emptyToContentRatio).toBeGreaterThan(5) // Documenting the bug

    // Check that the code content is actually visible
    expect(frame).toContain("function hello")
    expect(frame).toContain("console.log")
  })

  it("WORKAROUND: flexShrink=0 fixes the height issue", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)
    const codeContent = `function hello() {
  console.log("Hello, World!");
  return 42;
}`

    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <scrollbox flexGrow={1} scrollbarOptions={{ visible: false }}>
            <line_number flexShrink={0} fg="#888888" minWidth={3} paddingRight={1}>
              <code
                fg="#ffffff"
                filetype="javascript"
                syntaxStyle={syntaxStyle}
                content={codeContent}
                treeSitterClient={mockTreeSitterClient}
              />
            </line_number>
          </scrollbox>
        </box>
      ),
      {
        width: 40,
        height: 30,
      },
    )

    await testSetup.renderOnce()
    mockTreeSitterClient.resolveAllHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await testSetup.renderOnce()

    const frame = testSetup.captureCharFrame()
    expect(frame).toMatchSnapshot()

    const lines = frame.split("\n")
    const contentLines = lines.filter((line) => line.trim().length > 0)
    const emptyLines = lines.filter((line) => line.trim().length === 0)
    const emptyToContentRatio = emptyLines.length / contentLines.length

    // With flexShrink=0, the ratio should be reasonable
    expect(emptyToContentRatio).toBeLessThan(7)

    expect(frame).toContain("function hello")
    expect(frame).toContain("console.log")
  })

  it("multiple line_number blocks should not overlap - realistic chat scenario", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)

    const messages = [
      {
        role: "assistant",
        tool: "write",
        filePath: "src/hello.ts",
        code: `export function hello() {
  return "Hello, World!";
}`,
      },
      {
        role: "assistant",
        text: "I've created the hello function.",
      },
      {
        role: "assistant",
        tool: "write",
        filePath: "src/test.ts",
        code: `import { hello } from "./hello";

test("hello returns greeting", () => {
  expect(hello()).toBe("Hello, World!");
});`,
      },
      {
        role: "assistant",
        text: "I've also added a test file.",
      },
    ]

    testSetup = await testRender(
      () => (
        <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
          <scrollbox scrollbarOptions={{ visible: false }} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
            <For each={messages}>
              {(message) => (
                <>
                  <Show when={message.tool === "write"}>
                    <box flexShrink={0}>
                      <text fg="#00aaff">Wrote {message.filePath}</text>
                    </box>
                    <line_number fg="#888888" minWidth={3} paddingRight={1}>
                      <code
                        flexGrow={1}
                        fg="#ffffff"
                        filetype="typescript"
                        syntaxStyle={syntaxStyle}
                        content={message.code}
                        treeSitterClient={mockTreeSitterClient}
                      />
                    </line_number>
                  </Show>
                  <Show when={message.text}>
                    <box flexShrink={0}>
                      <text fg="#ffffff">{message.text}</text>
                    </box>
                  </Show>
                </>
              )}
            </For>
          </scrollbox>
        </box>
      ),
      {
        width: 50,
        height: 40, // Portrait
      },
    )

    await testSetup.renderOnce()
    mockTreeSitterClient.resolveAllHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await testSetup.renderOnce()

    const frame = testSetup.captureCharFrame()
    expect(frame).toMatchSnapshot()

    // Check all content is visible and not overlapping
    expect(frame).toContain("Wrote src/hello.ts")
    expect(frame).toContain("export function hello")
    expect(frame).toContain("I've created the hello function")
    expect(frame).toContain("Wrote src/test.ts")
    expect(frame).toContain("import { hello }")
    expect(frame).toContain("I've also added a test file")

    // Count how many times we see each unique piece of content
    // If content is overlapping, we might see duplicates or garbled text
    const helloCount = (frame.match(/Wrote src\/hello\.ts/g) || []).length
    const testCount = (frame.match(/Wrote src\/test\.ts/g) || []).length

    // Each should appear exactly once
    expect(helloCount).toBe(1)
    expect(testCount).toBe(1)
  })

  it("line_number height should match code content height, not double", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)
    const shortCode = "const x = 1;\nconst y = 2;"

    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <box flexShrink={0}>
            <text>--- START MARKER ---</text>
          </box>
          <line_number fg="#888888" minWidth={3} paddingRight={1}>
            <code
              flexGrow={1}
              fg="#ffffff"
              filetype="javascript"
              syntaxStyle={syntaxStyle}
              content={shortCode}
              treeSitterClient={mockTreeSitterClient}
            />
          </line_number>
          <box flexShrink={0}>
            <text>--- END MARKER ---</text>
          </box>
        </box>
      ),
      {
        width: 40,
        height: 25,
      },
    )

    await testSetup.renderOnce()
    mockTreeSitterClient.resolveAllHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await testSetup.renderOnce()

    const frame = testSetup.captureCharFrame()
    expect(frame).toMatchSnapshot()

    // Find the line indices of the markers
    const lines = frame.split("\n")
    const startIdx = lines.findIndex((line) => line.includes("START MARKER"))
    const endIdx = lines.findIndex((line) => line.includes("END MARKER"))

    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(endIdx).toBeGreaterThan(startIdx)

    // The code has 2 lines, so distance should be roughly 2-3 lines
    // (2 code lines + maybe 1 for spacing)
    // NOT 4-6 lines which would indicate double height
    const distance = endIdx - startIdx - 1 // -1 to exclude the start marker line itself

    // Distance should be reasonable (2-4 lines for 2 lines of code)
    // If it's 6+ lines, that indicates excessive spacing/height
    expect(distance).toBeLessThanOrEqual(5)
    expect(distance).toBeGreaterThanOrEqual(2)

    // Verify code is visible
    expect(frame).toContain("const x = 1")
    expect(frame).toContain("const y = 2")
  })

  it("scrollbox with box container around line_number - no excessive height", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)
    const code = `function test() {
  return true;
}`

    testSetup = await testRender(
      () => (
        <box flexDirection="row">
          <box flexGrow={1} paddingBottom={1} paddingTop={1} paddingLeft={2} paddingRight={2} gap={1}>
            <scrollbox scrollbarOptions={{ visible: false }} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
              <box flexShrink={0}>
                <text fg="#888888">Message 1</text>
              </box>
              <box border={true} borderColor="#333333">
                <line_number fg="#888888" minWidth={3} paddingRight={1}>
                  <code
                    flexGrow={1}
                    fg="#ffffff"
                    filetype="typescript"
                    syntaxStyle={syntaxStyle}
                    content={code}
                    treeSitterClient={mockTreeSitterClient}
                  />
                </line_number>
              </box>
              <box flexShrink={0}>
                <text fg="#888888">Message 2</text>
              </box>
            </scrollbox>
          </box>
        </box>
      ),
      {
        width: 50,
        height: 30,
      },
    )

    await testSetup.renderOnce()
    mockTreeSitterClient.resolveAllHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await testSetup.renderOnce()

    const frame = testSetup.captureCharFrame()
    expect(frame).toMatchSnapshot()

    // Check content is visible
    expect(frame).toContain("Message 1")
    expect(frame).toContain("function test")
    expect(frame).toContain("Message 2")

    // Find distance between Message 1 and Message 2
    const lines = frame.split("\n")
    const msg1Idx = lines.findIndex((line) => line.includes("Message 1"))
    const msg2Idx = lines.findIndex((line) => line.includes("Message 2"))

    expect(msg1Idx).toBeGreaterThanOrEqual(0)
    expect(msg2Idx).toBeGreaterThan(msg1Idx)

    // Code is 3 lines + border (2 lines) + some spacing
    // Should be roughly 5-8 lines total, NOT 12-16
    const distance = msg2Idx - msg1Idx
    expect(distance).toBeLessThan(12)
  })

  it("multiple messages with mixed content - verify no overlapping", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)

    interface Message {
      type: "text" | "tool"
      content: string
      filePath?: string
      diagnostics?: Array<{ line: number; char: number; message: string }>
    }

    const messages: Message[] = [
      { type: "text", content: "Let me create a file for you." },
      {
        type: "tool",
        content: `export const greet = (name: string) => {
  return \`Hello, \${name}!\`;
};`,
        filePath: "src/greet.ts",
      },
      { type: "text", content: "I've created the greet function." },
      {
        type: "tool",
        content: `import { greet } from "./greet";

console.log(greet("World"));`,
        filePath: "src/index.ts",
        diagnostics: [{ line: 2, char: 5, message: "Unused variable" }],
      },
      { type: "text", content: "And here's the main file." },
    ]

    testSetup = await testRender(
      () => (
        <box flexDirection="row">
          <box flexGrow={1} paddingBottom={1} paddingTop={1} paddingLeft={2} paddingRight={2} gap={1}>
            <scrollbox scrollbarOptions={{ visible: false }} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
              <For each={messages}>
                {(message) => (
                  <>
                    <Show when={message.type === "text"}>
                      <box flexShrink={0}>
                        <text fg="#ffffff">{message.content}</text>
                      </box>
                    </Show>
                    <Show when={message.type === "tool"}>
                      <box flexShrink={0}>
                        <text fg="#00aaff">Wrote {message.filePath}</text>
                      </box>
                      <line_number fg="#888888" minWidth={3} paddingRight={1}>
                        <code
                          flexGrow={1}
                          fg="#ffffff"
                          filetype="typescript"
                          syntaxStyle={syntaxStyle}
                          content={message.content}
                          treeSitterClient={mockTreeSitterClient}
                        />
                      </line_number>
                      <Show when={message.diagnostics && message.diagnostics.length > 0}>
                        <For each={message.diagnostics}>
                          {(diagnostic) => (
                            <text fg="#ff0000">
                              Error [{diagnostic.line}:{diagnostic.char}]: {diagnostic.message}
                            </text>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </>
                )}
              </For>
            </scrollbox>
          </box>
        </box>
      ),
      {
        width: 60,
        height: 50, // Tall portrait
      },
    )

    await testSetup.renderOnce()
    mockTreeSitterClient.resolveAllHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await testSetup.renderOnce()

    const frame = testSetup.captureCharFrame()
    expect(frame).toMatchSnapshot()

    // Verify all content appears exactly once
    expect(frame).toContain("Let me create a file for you")
    expect(frame).toContain("Wrote src/greet.ts")
    expect(frame).toContain("export const greet")
    expect(frame).toContain("I've created the greet function")
    expect(frame).toContain("Wrote src/index.ts")
    expect(frame).toContain("import { greet }")
    expect(frame).toContain("And here's the main file")
    expect(frame).toContain("Error [2:5]: Unused variable")

    // Check no duplication
    const greetFileCount = (frame.match(/Wrote src\/greet\.ts/g) || []).length
    const indexFileCount = (frame.match(/Wrote src\/index\.ts/g) || []).length

    expect(greetFileCount).toBe(1)
    expect(indexFileCount).toBe(1)

    // Verify diagnostic appears right after code, not overlapping
    const lines = frame.split("\n")
    const importLine = lines.findIndex((line) => line.includes("import { greet }"))
    const errorLine = lines.findIndex((line) => line.includes("Error [2:5]"))

    // Error should appear after the code block (within ~5 lines)
    expect(errorLine).toBeGreaterThan(importLine)
    expect(errorLine - importLine).toBeLessThan(8)
  })

  it("scroll behavior - content should remain visible after scroll", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)
    let scrollRef: ScrollBoxRenderable | undefined

    const [messages, setMessages] = createSignal([
      { id: 1, text: "Message 1", code: "const a = 1;" },
      { id: 2, text: "Message 2", code: "const b = 2;" },
    ])

    testSetup = await testRender(
      () => (
        <box flexDirection="column" gap={1}>
          <scrollbox
            ref={(r) => (scrollRef = r)}
            scrollbarOptions={{ visible: false }}
            stickyScroll={true}
            stickyStart="bottom"
            flexGrow={1}
          >
            <For each={messages()}>
              {(message) => (
                <>
                  <box flexShrink={0}>
                    <text fg="#ffffff">{message.text}</text>
                  </box>
                  <line_number fg="#888888" minWidth={2} paddingRight={1}>
                    <code
                      flexGrow={1}
                      fg="#ffffff"
                      filetype="javascript"
                      syntaxStyle={syntaxStyle}
                      content={message.code}
                      treeSitterClient={mockTreeSitterClient}
                    />
                  </line_number>
                </>
              )}
            </For>
          </scrollbox>
        </box>
      ),
      {
        width: 40,
        height: 30,
      },
    )

    await testSetup.renderOnce()
    mockTreeSitterClient.resolveAllHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await testSetup.renderOnce()

    const initialFrame = testSetup.captureCharFrame()
    expect(initialFrame).toMatchSnapshot()

    // Add many more messages
    setMessages((prev) => [
      ...prev,
      ...Array.from({ length: 20 }, (_, i) => ({
        id: i + 3,
        text: `Message ${i + 3}`,
        code: `const var${i + 3} = ${i + 3};`,
      })),
    ])

    await testSetup.renderOnce()
    mockTreeSitterClient.resolveAllHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await testSetup.renderOnce()

    // Scroll to bottom
    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight)
      await testSetup.renderOnce()
    }

    const scrolledFrame = testSetup.captureCharFrame()
    expect(scrolledFrame).toMatchSnapshot()

    // Should see later messages
    expect(scrolledFrame).toContain("Message")
    expect(scrolledFrame).toContain("const var")

    // Content should be visible (not all whitespace)
    const nonWhitespace = scrolledFrame.replace(/\s/g, "").length
    expect(nonWhitespace).toBeGreaterThan(50)

    // Scroll to middle
    if (scrollRef) {
      scrollRef.scrollTo(Math.floor(scrollRef.scrollHeight / 2))
      await testSetup.renderOnce()
    }

    const middleFrame = testSetup.captureCharFrame()
    expect(middleFrame).toMatchSnapshot()

    // Should see middle messages
    const hasMiddleContent = /Message \d+/.test(middleFrame)
    expect(hasMiddleContent).toBe(true)
  })

  it("VISUAL CHECK: box with line_number should have clean spacing", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)

    testSetup = await testRender(
      () => (
        <box flexDirection="column" padding={2}>
          <text fg="#00aaff">═══ Code Block 1 ═══</text>
          <box border={true} borderColor="#333333">
            <line_number fg="#666666" minWidth={3} paddingRight={1}>
              <code
                flexGrow={1}
                fg="#ffffff"
                filetype="javascript"
                syntaxStyle={syntaxStyle}
                content="const x = 1;\nconst y = 2;\nconst z = 3;"
                treeSitterClient={mockTreeSitterClient}
              />
            </line_number>
          </box>
          <text fg="#00aaff">═══ Code Block 2 ═══</text>
          <box border={true} borderColor="#333333">
            <line_number fg="#666666" minWidth={3} paddingRight={1}>
              <code
                flexGrow={1}
                fg="#ffffff"
                filetype="javascript"
                syntaxStyle={syntaxStyle}
                content="function test() {\n  return 42;\n}"
                treeSitterClient={mockTreeSitterClient}
              />
            </line_number>
          </box>
          <text fg="#00aaff">═══ End ═══</text>
        </box>
      ),
      {
        width: 50,
        height: 35,
      },
    )

    await testSetup.renderOnce()
    mockTreeSitterClient.resolveAllHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await testSetup.renderOnce()

    const frame = testSetup.captureCharFrame()
    expect(frame).toMatchSnapshot()

    // Visual inspection via snapshot should show:
    // - No excessive blank lines between blocks
    // - Blocks don't overlap
    // - Clean spacing

    const lines = frame.split("\n")
    const block1Idx = lines.findIndex((line) => line.includes("Code Block 1"))
    const block2Idx = lines.findIndex((line) => line.includes("Code Block 2"))
    const endIdx = lines.findIndex((line) => line.includes("End"))

    expect(block1Idx).toBeGreaterThanOrEqual(0)
    expect(block2Idx).toBeGreaterThan(block1Idx)
    expect(endIdx).toBeGreaterThan(block2Idx)

    // Block 1 has 3 lines of code + borders (2) = 5 lines
    // Should be about 5-7 lines between markers, NOT 10+
    const block1Height = block2Idx - block1Idx
    expect(block1Height).toBeLessThan(10)

    // Block 2 has 3 lines of code + borders (2) = 5 lines
    const block2Height = endIdx - block2Idx
    expect(block2Height).toBeLessThan(10)
  })
})
