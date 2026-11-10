import { test, expect, describe } from "bun:test"
import { BoxRenderable } from "../renderables/Box.js"
import { createTestRenderer } from "../testing/test-renderer.js"

// NOTE: These tests are not running the mouse activation sequences,
// only verifying that the configuration is applied correctly.
// Tests avoid actually outputting to the terminal during test runs,
// to not mess up the terminal state.
// What actually gets written can be tested properly when
// https://github.com/anomalyco/opentui/pull/238 is merged.
describe("useMouse configuration", () => {
  test("useMouse: true sets renderer.useMouse to true", async () => {
    const { renderer } = await createTestRenderer({
      useMouse: true,
      exitOnCtrlC: false,
    })

    expect(renderer.useMouse).toBe(true)
    renderer.destroy()
  })

  test("useMouse: false disables mouse tracking", async () => {
    const { renderer } = await createTestRenderer({
      useMouse: false,
      exitOnCtrlC: false,
    })

    expect(renderer.useMouse).toBe(false)
    renderer.destroy()
  })

  test("toggling useMouse property updates renderer state", async () => {
    const { renderer } = await createTestRenderer({
      useMouse: false,
      exitOnCtrlC: false,
    })

    expect(renderer.useMouse).toBe(false)

    renderer.useMouse = true
    expect(renderer.useMouse).toBe(true)

    renderer.useMouse = false
    expect(renderer.useMouse).toBe(false)

    renderer.destroy()
  })

  test("re-enabling useMouse rebuilds hit grid on the next scheduled frame", async () => {
    const { renderer, flush } = await createTestRenderer({
      width: 10,
      height: 5,
      useMouse: false,
      exitOnCtrlC: false,
    })

    const box = new BoxRenderable(renderer, { id: "mouse-target", width: 3, height: 2 })
    renderer.root.add(box)
    await flush()

    expect(renderer.hitTest(0, 0)).toBe(0)

    renderer.useMouse = true
    await flush()

    expect(renderer.hitTest(0, 0)).toBe(box.num)
    renderer.destroy()
  })

  test("destroy disables mouse tracking", async () => {
    const { renderer } = await createTestRenderer({
      useMouse: true,
      exitOnCtrlC: false,
      screenMode: "main-screen",
    })

    expect(renderer.useMouse).toBe(true)

    renderer.destroy()

    expect(renderer.useMouse).toBe(false)
  })
})
