import { expect, spyOn, test } from "bun:test"
import { setTimeout as delay } from "node:timers/promises"
import { Renderable, SelectRenderable } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { ExampleSelector } from "./index.js"

test("native browser returns from a shell that ignores TERM and HUP", async () => {
  const clock = new ManualClock()
  const target = await createTestRenderer({ width: 100, height: 30, clock })
  const { renderer, mockInput } = target
  const shell = process.env.SHELL
  process.env.SHELL = "/bin/sh"
  const spawn = spyOn(Bun, "spawn")
  const errors = spyOn(console, "error")
  let child: ReturnType<typeof Bun.spawn> | undefined
  let browser: ExampleSelector | undefined
  async function frame() {
    renderer.pause()
    for (let attempt = 0; attempt < 100 && renderer.getSchedulerState().isRendering; attempt++) await delay(5)
    expect(renderer.getSchedulerState().isRendering).toBe(false)
    await target.renderOnce()
  }
  try {
    await renderer.setupTerminal()
    browser = new ExampleSelector(renderer)
    await frame()
    const registered = new Set(Renderable.renderablesByNumber.keys())
    const select = renderer.root.findDescendantById("example-selector") as SelectRenderable
    select.selectedIndex = select.options.findIndex((option) => option.value.example?.name === "Embedded Terminal Demo")
    mockInput.pressEnter()
    child = spawn.mock.results.at(-1)?.value as ReturnType<typeof Bun.spawn>
    expect(child?.pid).toBeGreaterThan(0)
    await mockInput.typeText("trap '' HUP TERM; printf '\\122EADY_TO_EXIT\\n'; exec sleep 600")
    mockInput.pressEnter()
    for (let attempt = 0; attempt < 100; attempt++) {
      await delay(10)
      await frame()
      if (target.captureCharFrame().includes("READY_TO_EXIT")) break
    }
    expect(target.captureCharFrame()).toContain("READY_TO_EXIT")
    mockInput.pressEscape()
    clock.advance(20)
    for (let attempt = 0; attempt < 100 && !browser["inMenu"]; attempt++) await delay(10)
    expect(browser["inMenu"]).toBe(true)
    expect(child.signalCode).not.toBeNull()
    await frame()
    expect(target.captureCharFrame()).toContain("Filter examples...")
    expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
    expect(errors.mock.calls).toEqual([])
  } finally {
    child?.kill("SIGKILL")
    await child?.exited
    for (let attempt = 0; attempt < 100 && browser?.["transitioning"]; attempt++) await delay(10)
    renderer.destroy()
    await renderer.closed
    spawn.mockRestore()
    errors.mockRestore()
    if (shell === undefined) delete process.env.SHELL
    else process.env.SHELL = shell
  }
})
