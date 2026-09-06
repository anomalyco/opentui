import { expect, it, spyOn } from "bun:test"
import { ManualClock } from "@opentui/core/testing"
import { act } from "react"
import { App } from "../examples/flush-sync.js"
import { testRender } from "../src/test-utils.js"

it("Flush Sync q destroys its renderer without forcing process exit", async () => {
  const setup = await testRender(<App />, { width: 80, height: 24, clock: new ManualClock() })
  const exit = spyOn(process, "exit").mockImplementation(() => undefined as never)
  const errors = spyOn(console, "error")
  const nodes = setup.renderer.root.getChildren()
  try {
    act(() => setup.mockInput.pressKey("q"))
    await setup.renderer.closed
    expect(setup.renderer.isDestroyed).toBe(true)
    expect(nodes.every((node) => node.isDestroyed)).toBe(true)
    expect(setup.renderer.root.getChildren()).toEqual([])
    expect(exit).not.toHaveBeenCalled()
    expect(errors.mock.calls).toEqual([])
  } finally {
    act(() => setup.renderer.destroy())
    await setup.renderer.closed
    exit.mockRestore()
    errors.mockRestore()
  }
})
