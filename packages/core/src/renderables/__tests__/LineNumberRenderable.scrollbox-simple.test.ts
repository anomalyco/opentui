import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer } from "../../testing.js"
import { LineNumberRenderable } from "../LineNumberRenderable.js"
import { CodeRenderable } from "../Code.js"
import { ScrollBoxRenderable } from "../ScrollBox.js"
import { SyntaxStyle } from "../../syntax-style.js"
import { RGBA } from "../../lib/RGBA.js"

let currentRenderer: TestRenderer
let syntaxStyle: SyntaxStyle
let renderOnce: () => Promise<void>
let captureCharFrame: () => string

beforeEach(async () => {
  const testRenderer = await createTestRenderer({ width: 50, height: 40 })
  currentRenderer = testRenderer.renderer
  syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromValues(1, 1, 1, 1) } }, currentRenderer.nativeScene)
  renderOnce = testRenderer.renderOnce
  captureCharFrame = testRenderer.captureCharFrame
})

afterEach(async () => {
  if (currentRenderer) {
    currentRenderer.destroy()
    await currentRenderer.closed
  }
  syntaxStyle.destroy()
})

describe("LineNumber in ScrollBox - Simple Core Test", () => {
  test("LineNumber with Code in ScrollBox should wrap content height", async () => {
    const codeContent = `function test() {
  return true;
}`

    const codeRenderable = new CodeRenderable(currentRenderer, {
      id: "code",
      content: codeContent,
      filetype: "javascript",
      syntaxStyle,
    })

    const lineNumberRenderable = new LineNumberRenderable(currentRenderer, {
      id: "line-number",
      target: codeRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#888888",
    })

    const scrollBox = new ScrollBoxRenderable(currentRenderer, {
      id: "scroll",
      width: "100%",
      height: "100%",
      scrollbarOptions: { visible: false },
    })

    scrollBox.add(lineNumberRenderable)
    currentRenderer.root.add(scrollBox)

    await renderOnce()

    const frame = captureCharFrame()
    expect(frame).toMatchSnapshot()

    expect(codeRenderable.lineCount).toBe(3)

    // LineNumber should wrap to content height (3 lines), not fill viewport (40 lines)
    expect(lineNumberRenderable.height).toBe(3)
    expect(codeRenderable.height).toBe(3)

    // Gutter should also be 3 lines
    expect(lineNumberRenderable["gutter"]!.height).toBe(3)

    // Check content is visible
    expect(frame).toContain("function test")
    expect(frame).toContain("return true")
  })

  test("Multiple LineNumber blocks in ScrollBox should each wrap content", async () => {
    const scrollBox = new ScrollBoxRenderable(currentRenderer, {
      id: "scroll-multi",
      width: "100%",
      height: "100%",
      scrollbarOptions: { visible: false },
    })

    currentRenderer.root.add(scrollBox)

    // Add first code block (1 line)
    const code1 = new CodeRenderable(currentRenderer, {
      id: "code1",
      content: "const x = 1;",
      filetype: "javascript",
      syntaxStyle,
    })

    const lineNum1 = new LineNumberRenderable(currentRenderer, {
      id: "linenum1",
      target: code1,
      minWidth: 2,
      paddingRight: 1,
      fg: "#888888",
    })

    scrollBox.add(lineNum1)

    // Add second code block (1 line)
    const code2 = new CodeRenderable(currentRenderer, {
      id: "code2",
      content: "const y = 2;",
      filetype: "javascript",
      syntaxStyle,
    })

    const lineNum2 = new LineNumberRenderable(currentRenderer, {
      id: "linenum2",
      target: code2,
      minWidth: 2,
      paddingRight: 1,
      fg: "#888888",
    })

    scrollBox.add(lineNum2)

    await renderOnce()

    const frame = captureCharFrame()
    expect(frame).toMatchSnapshot()

    expect(lineNum1.height).toBe(1)
    expect(code1.height).toBe(1)
    expect(lineNum2.height).toBe(1)
    expect(code2.height).toBe(1)

    // Both code blocks should be visible
    expect(frame).toContain("const x = 1")
    expect(frame).toContain("const y = 2")
  })
})
