import { expect, spyOn, test } from "bun:test"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { getTimelineEngine } from "@opentui/core"
import { NativeSession } from "../../core/src/NativeSession.js"
import { createTestStdout } from "../../core/src/testing/test-streams.js"
import { NativeStatus } from "../../core/src/zig.js"
import { run, destroy } from "./timeline-example.js"

test("timeline examples advance once per owner frame and dispose independently", async () => {
  const firstClock = new ManualClock()
  const secondClock = new ManualClock()
  const first = await createTestRenderer({ width: 80, height: 40, clock: firstClock })
  const second = await createTestRenderer({ width: 80, height: 40, clock: secondClock })
  try {
    run(first.renderer)
    run(second.renderer)
    firstClock.advance(1000)
    await first.renderOnce()
    expect(first.captureCharFrame()).toContain("Progress: Main=10% Sub1=12% Sub2=0%")
    getTimelineEngine(first.renderer)
    firstClock.advance(1000)
    await first.renderOnce()
    expect(first.captureCharFrame()).toContain("Progress: Main=20% Sub1=25% Sub2=0%")
    secondClock.advance(500)
    await second.renderOnce()
    expect(second.captureCharFrame()).toContain("Progress: Main=5% Sub1=6% Sub2=0%")
    destroy(first.renderer)
    first.renderer.pause()
    secondClock.advance(500)
    await second.renderOnce()
    expect(second.captureCharFrame()).toContain("Progress: Main=10% Sub1=12% Sub2=0%")
  } finally {
    destroy(first.renderer)
    destroy(second.renderer)
    first.renderer.destroy()
    second.renderer.destroy()
    await Promise.all([first.renderer.closed, second.renderer.closed])
  }
})

test("timeline capacity failure leaves no orphan views or animation", async () => {
  const stdout = createTestStdout(80, 40)
  const nativeSession = new NativeSession(stdout, { context: { objectCapacity: 8, renderCellsMax: 6400 } })
  const clock = new ManualClock()
  const { renderer } = await createTestRenderer({ stdout, nativeSession, clock, bufferedOutput: "stdout" })
  try {
    expect(() => run(renderer)).toThrow(expect.objectContaining({ status: NativeStatus.ObjectLimit }))
    expect(renderer.root.getChildren()).toEqual([])
    expect(() => getTimelineEngine(renderer).update(1000)).not.toThrow()
  } finally {
    renderer.destroy()
    await renderer.closed
    stdout.destroy()
  }
})

test("timeline teardown removes callbacks when a descendant destroy throws", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 80, height: 40, clock: new ManualClock() })
  const keys = renderer.keyInput.listeners("keypress")
  const failure = new Error("timeline descendant destroy failed")
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    run(renderer)
    renderer.root.findDescendantById("box-object")!.once("destroyed", () => {
      throw failure
    })
    expect(() => destroy(renderer)).toThrow(failure)
    expect(renderer.keyInput.listeners("keypress")).toEqual(keys)
    expect(renderer.root.getChildren()).toEqual([])
    await renderOnce()
    expect(errors).not.toHaveBeenCalled()
  } finally {
    errors.mockRestore()
    renderer.destroy()
    await renderer.closed
  }
})
