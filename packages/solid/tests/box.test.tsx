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

  it("sets, updates and clears per-side border props and style keys", async () => {
    const [top, setTop] = createSignal<"double" | "heavy" | undefined>("double")
    const [bottomColor, setBottomColor] = createSignal<string | undefined>("#ff0000")
    testSetup = await testRender(
      () => <box border width={8} height={3} borderTopStyle={top()} style={{ borderBottomColor: bottomColor() }} />,
      { width: 8, height: 3 },
    )
    const rows = () => testSetup.captureCharFrame().split("\n").slice(0, 3)
    const bottomFg = () =>
      testSetup.renderer.currentRenderBuffer.withBuffers(({ fg }) =>
        RGBA.fromArray(fg.slice((2 * 8 + 3) * 4, (2 * 8 + 4) * 4)).toInts(),
      )

    await testSetup.renderOnce()
    expect(rows()).toEqual(["╒══════╕", "│      │", "└──────┘"])
    expect(bottomFg()).toEqual([255, 0, 0, 255])
    setTop("heavy")
    setBottomColor(undefined)
    await testSetup.renderOnce()
    expect(rows()).toEqual(["┍━━━━━━┑", "│      │", "└──────┘"])
    expect(bottomFg()).toEqual([255, 255, 255, 255])
    setTop(undefined)
    await testSetup.renderOnce()
    expect(rows()[0]).toBe("┌──────┐")
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

    testSetup.renderer.currentRenderBuffer.withBuffers((cells) => {
      expect(cells.char[0]).toBe("┃".codePointAt(0))
      expect({
        fg: RGBA.fromArray(cells.fg.slice(0, 4)).toInts(),
        bg: RGBA.fromArray(cells.bg.slice(0, 4)).toInts(),
      }).toEqual({
        fg: panel.toInts(),
        bg: panel.toInts(),
      })
    })
  })
})
