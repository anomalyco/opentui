import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "../index.js"
import { createSignal } from "solid-js"

let testSetup: Awaited<ReturnType<typeof testRender>>

describe("Box Component", () => {
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

  it("should support focusable prop and controlled focus state", async () => {
    let boxRef: any
    const [focused, setFocused] = createSignal(false)

    testSetup = await testRender(
      () => <box ref={boxRef} focusable focused={focused()} style={{ width: 10, height: 5, border: true }} />,
      { width: 15, height: 8 },
    )

    await testSetup.renderOnce()

    expect(boxRef.focusable).toBe(true)
    expect(boxRef.focused).toBe(false)

    setFocused(true)
    await testSetup.renderOnce()

    expect(boxRef.focused).toBe(true)

    setFocused(false)
    await testSetup.renderOnce()

    expect(boxRef.focused).toBe(false)
  })

  it("should blend transparent border foreground against the box background", async () => {
    const panel = RGBA.fromHex("#123456")

    testSetup = await testRender(
      () => (
        <box
          width={6}
          height={3}
          border={["left"]}
          borderStyle="heavy"
          borderColor={RGBA.fromInts(0, 0, 0, 0)}
          backgroundColor={panel}
        />
      ),
      { width: 8, height: 5 },
    )

    await testSetup.renderOnce()

    const buffer = testSetup.renderer.currentRenderBuffer
    expect(buffer.buffers.char[0]).toBe("┃".codePointAt(0))
    expect({
      fg: RGBA.fromArray(buffer.buffers.fg.slice(0, 4)).toInts(),
      bg: RGBA.fromArray(buffer.buffers.bg.slice(0, 4)).toInts(),
    }).toEqual({
      fg: panel.toInts(),
      bg: panel.toInts(),
    })
  })
})
