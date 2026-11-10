import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { act } from "react"
import { testRender } from "../src/test-utils.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

describe("Link Rendering Tests", () => {
  beforeEach(async () => {
    if (testSetup) {
      act(() => {
        testSetup.renderer.destroy()
      })
    }
  })

  afterEach(() => {
    if (testSetup) {
      act(() => {
        testSetup.renderer.destroy()
      })
    }
  })

  test("should render link with href correctly", async () => {
    await act(async () => {
      testSetup = await testRender(
        <text>
          Visit <a href="https://opentui.com">opentui.com</a> for more info
        </text>,
        {
          width: 50,
          height: 5,
        },
      )
    })

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("Visit opentui.com for more info")
  })

  test("should render styled link with underline", async () => {
    await act(async () => {
      testSetup = await testRender(
        <text>
          <u>
            <a href="https://opentui.com" fg="blue">
              opentui.com
            </a>
          </u>
        </text>,
        {
          width: 50,
          height: 5,
        },
      )
    })

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("opentui.com")
  })

  test("should render link inside text with other elements", async () => {
    await act(async () => {
      testSetup = await testRender(
        <text>
          Check out <a href="https://github.com/anomalyco/opentui">GitHub</a> and{" "}
          <a href="https://opentui.com">our website</a>
        </text>,
        {
          width: 60,
          height: 5,
        },
      )
    })

    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("GitHub")
    expect(frame).toContain("our website")
  })
})
