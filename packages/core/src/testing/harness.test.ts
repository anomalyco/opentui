import { expect, test } from "bun:test"
import { NativeSessionRenderStatus } from "../zig.js"
import { assertRendererReleased, forceRenderStatus, processListenerCounts, serviceReadyFrames } from "./harness.js"
import { ManualClock } from "./manual-clock.js"
import { createTestRenderer } from "./test-renderer.js"
import { RecordingWriteStream } from "./test-streams.js"

test("RecordingWriteStream copies writes and parks completions while held", async () => {
  const stream = new RecordingWriteStream()
  const chunk = Buffer.from("ab")
  stream.write(chunk)
  chunk.fill(0)
  stream.hold()
  let completed = false
  stream.write("cd", () => (completed = true))
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect({ text: stream.text(), pending: stream.pendingWrite, completed }).toEqual({
    text: "abcd",
    pending: true,
    completed: false,
  })
  stream.release()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect({ pending: stream.pendingWrite, completed }).toEqual({ pending: false, completed: true })
  stream.clear()
  expect(stream.bytes().length).toBe(0)
})

test("ManualClock counts pending timers until they fire or are cleared", () => {
  const clock = new ManualClock()
  const timeout = clock.setTimeout(() => {}, 10)
  const interval = clock.setInterval(() => {}, 5)
  clock.setTimeout(() => {}, 1)
  expect(clock.pendingTimerCount).toBe(3)
  clock.advance(1)
  clock.clearTimeout(timeout)
  expect(clock.pendingTimerCount).toBe(1)
  clock.advance(20)
  expect(clock.pendingTimerCount).toBe(1)
  clock.clearInterval(interval)
  expect(clock.pendingTimerCount).toBe(0)
})

test("dispose releases the renderer and assertRendererReleased detects a leaked listener", async () => {
  const listeners = processListenerCounts()
  const setup = await createTestRenderer({ clock: new ManualClock() })
  const restore = forceRenderStatus(setup.renderer, () => NativeSessionRenderStatus.Skipped)
  setup.renderer.requestRender()
  await serviceReadyFrames(setup.renderer)
  restore()
  setup.renderer.stdin.on("data", () => {})
  await setup.dispose()
  await expect(assertRendererReleased(setup.renderer, listeners)).rejects.toThrow("stdin data listener leaked")
  setup.renderer.stdin.removeAllListeners("data")
  await assertRendererReleased(setup.renderer, listeners)
})
