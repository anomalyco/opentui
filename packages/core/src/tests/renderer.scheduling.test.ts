import { expect, test } from "bun:test"
import { createTestRenderer } from "../testing/test-renderer.js"

test("destroy cancels queued animation and frame continuations, including reentrant requests", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 2, height: 1 })
  const calls: string[] = []
  renderer.pause()
  renderer.requestAnimationFrame(() => {
    calls.push("destroy")
    renderer.destroy()
    renderer.requestAnimationFrame(() => calls.push("reentrant"))
  })
  renderer.requestAnimationFrame(() => calls.push("later"))
  renderer.setFrameCallback(async () => {
    calls.push("frame")
  })
  await renderOnce()
  await renderer.closed
  expect(calls).toEqual(["destroy"])
  expect(renderer.isRunning).toBe(false)
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
})
