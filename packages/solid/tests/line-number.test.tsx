import { ResourceContext } from "@opentui/core"

let resourceContext: ResourceContext
beforeEach(() => {
  resourceContext = new ResourceContext({ objectCapacity: 65536, renderCellsMax: 1000000 })
})
afterEach(() => resourceContext.destroy())

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { testRender } from "../index.js"
import { SyntaxStyle } from "@opentui/core"
import { MockTreeSitterClient } from "@opentui/core/testing"
import { createSignal, Show } from "solid-js"

let testSetup: Awaited<ReturnType<typeof testRender>>
let mockTreeSitterClient: MockTreeSitterClient

describe("LineNumberRenderable with SolidJS", () => {
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

  test("renders code with line numbers", async () => {
    const syntaxStyle = SyntaxStyle.fromStyles(
      {
        keyword: { fg: "#C792EA" },
        function: { fg: "#82AAFF" },
        default: { fg: "#FFFFFF" },
      },
      resourceContext,
    )

    const codeContent = `function test() {
  return 42
}
console.log(test())`

    testSetup = await testRender(() => (
      <box id="root" width="100%" height="100%">
        <line_number
          id="line-numbers"
          fg="#888888"
          bg="#000000"
          minWidth={3}
          paddingRight={1}
          width="100%"
          height="100%"
        >
          <code
            id="code-content"
            content={codeContent}
            filetype="javascript"
            syntaxStyle={syntaxStyle}
            treeSitterClient={mockTreeSitterClient}
            width="100%"
            height="100%"
          />
        </line_number>
      </box>
    ))

    await testSetup.renderOnce()

    mockTreeSitterClient.resolveAllHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await testSetup.renderOnce()

    const frame = testSetup.captureCharFrame()

    // Basic checks
    expect(frame).toContain("function test()")
    expect(frame).toContain(" 1 ") // Line number 1
    expect(frame).toContain(" 2 ") // Line number 2
    expect(frame).toContain(" 3 ") // Line number 3
    expect(frame).toContain(" 4 ") // Line number 4
  })

  test("handles conditional removal of line number element", async () => {
    const syntaxStyle = SyntaxStyle.fromStyles(
      {
        keyword: { fg: "#C792EA" },
        function: { fg: "#82AAFF" },
        default: { fg: "#FFFFFF" },
      },
      resourceContext,
    )

    const codeContent = `function test() {
  return 42
}
console.log(test())`

    const [showLineNumbers, setShowLineNumbers] = createSignal(true)

    testSetup = await testRender(() => (
      <box id="root" width="100%" height="100%">
        <Show
          when={showLineNumbers()}
          fallback={
            <code
              id="code-content-no-lines"
              content={codeContent}
              filetype="javascript"
              syntaxStyle={syntaxStyle}
              treeSitterClient={mockTreeSitterClient}
              width="100%"
              height="100%"
            />
          }
        >
          <line_number
            id="line-numbers"
            fg="#888888"
            bg="#000000"
            minWidth={3}
            paddingRight={1}
            width="100%"
            height="100%"
          >
            <code
              id="code-content"
              content={codeContent}
              filetype="javascript"
              syntaxStyle={syntaxStyle}
              treeSitterClient={mockTreeSitterClient}
              width="100%"
              height="100%"
            />
          </line_number>
        </Show>
      </box>
    ))

    await testSetup.renderOnce()
    mockTreeSitterClient.resolveAllHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await testSetup.renderOnce()

    let frame = testSetup.captureCharFrame()

    // Initially shows line numbers
    expect(frame).toContain(" 1 ")
    expect(frame).toContain(" 2 ")

    // Toggle to hide line numbers - this should trigger destruction of LineNumberRenderable
    setShowLineNumbers(false)
    await testSetup.renderOnce()
    mockTreeSitterClient.resolveAllHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await testSetup.renderOnce()

    frame = testSetup.captureCharFrame()

    // Should still show code but without line numbers
    expect(frame).toContain("function test()")
    // Line numbers should not be present
    expect(frame).not.toContain(" 1 function")
  })

  test("updates line number gutter colors when fg/bg props change", async () => {
    const syntaxStyle = SyntaxStyle.create(resourceContext)
    const [lineFg, setLineFg] = createSignal("#ff0000")
    const [lineBg, setLineBg] = createSignal("#112233")

    testSetup = await testRender(
      () => (
        <box id="root" width="100%" height="100%">
          <line_number id="line-numbers" fg={lineFg()} bg={lineBg()} width="100%" height="100%">
            <code id="code-content" content={"alpha\nbeta"} syntaxStyle={syntaxStyle} width="100%" height="100%" />
          </line_number>
        </box>
      ),
      {
        width: 20,
        height: 5,
      },
    )

    await testSetup.renderOnce()

    const findCharX = (char: string, y: number) => {
      const codePoint = char.codePointAt(0)
      if (codePoint === undefined) return -1

      return testSetup.renderer.currentRenderBuffer.withBuffers((cells) => {
        for (let x = 0; x < cells.width; x++) {
          if (cells.char[y * cells.width + x] === codePoint) {
            return x
          }
        }
        return -1
      })
    }

    const getColorAt = (channel: "fg" | "bg", x: number, y: number) => {
      return testSetup.renderer.currentRenderBuffer.withBuffers((cells) => {
        const colorBuffer = cells[channel]
        const offset = (y * cells.width + x) * 4
        return {
          r: (colorBuffer[offset] & 0xff) / 255,
          g: (colorBuffer[offset + 1] & 0xff) / 255,
          b: (colorBuffer[offset + 2] & 0xff) / 255,
          a: (colorBuffer[offset + 3] & 0xff) / 255,
        }
      })
    }

    const expectRgb = (
      actual: { r: number; g: number; b: number; a: number },
      expected: { r: number; g: number; b: number },
    ) => {
      expect(actual.r).toBeCloseTo(expected.r / 255, 2)
      expect(actual.g).toBeCloseTo(expected.g / 255, 2)
      expect(actual.b).toBeCloseTo(expected.b / 255, 2)
      expect(actual.a).toBeCloseTo(1, 2)
    }

    const line1NumberX = findCharX("1", 0)
    expect(line1NumberX).toBeGreaterThanOrEqual(0)

    expectRgb(getColorAt("fg", line1NumberX, 0), { r: 0xff, g: 0x00, b: 0x00 })
    expectRgb(getColorAt("bg", line1NumberX, 0), { r: 0x11, g: 0x22, b: 0x33 })

    setLineFg("#00ff00")
    setLineBg("#334455")
    await testSetup.renderOnce()

    expectRgb(getColorAt("fg", line1NumberX, 0), { r: 0x00, g: 0xff, b: 0x00 })
    expectRgb(getColorAt("bg", line1NumberX, 0), { r: 0x33, g: 0x44, b: 0x55 })
  })
})
