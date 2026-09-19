import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { CliRenderEvents } from "../renderer.js"
import { ManualClock } from "./manual-clock.js"
import { createTestRenderer } from "./test-renderer.js"
import { TestWriteStream } from "./test-streams.js"

const stdout = new TestWriteStream(12, 4)
const held = Promise.withResolvers<(error?: Error | null) => void>()
stdout._write = (_chunk, _encoding, callback) => held.resolve(callback)
const { renderer, renderOnce, waitForVisualIdle } = await createTestRenderer({
  clock: new ManualClock(),
  stdout: stdout as unknown as NodeJS.WriteStream,
  bufferedOutput: "stdout",
  openConsoleOnError: false,
})
const failure = new Error("passive wait output failure")
const closed = assert.rejects(renderer.closed, (error) => error === failure)
const unhandled: unknown[] = []
const onUnhandled = (error: unknown) => unhandled.push(error)
process.on("unhandledRejection", onUnhandled)
const rendered = Promise.allSettled([renderOnce()])
let release: ((error?: Error | null) => void) | undefined = await held.promise
const waited = waitForVisualIdle()

try {
  await setImmediate()
  assert.equal(renderer.listenerCount(CliRenderEvents.FRAME), 1)
  release(failure)
  release = undefined
  await Promise.all([waited, closed, rendered])
  assert.equal(renderer.listenerCount(CliRenderEvents.FRAME), 0)
  assert.equal(renderer.listenerCount(CliRenderEvents.DESTROY), 0)
} finally {
  stdout._write = (_chunk, _encoding, callback) => callback()
  release?.()
  renderer.destroy()
  await Promise.allSettled([closed, rendered, waited])
  await setImmediate()
  await setImmediate()
  process.off("unhandledRejection", onUnhandled)
  stdout.destroy()
}

assert.deepEqual(unhandled, [])
process.stdout.write("Passive wait output failure passed\n")
