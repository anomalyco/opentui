import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { BoxRenderable } from "../renderables/Box.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { TestWriteStream } from "../testing/test-streams.js"

const targets: TestRendererSetup[] = []
afterEach(async () => {
  for (const { renderer } of targets.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const stdout = new TestWriteStream(8, 3)
  let finalized = 0
  const target = await createTestRenderer({
    width: 8,
    height: 3,
    clock: new ManualClock(),
    stdout: stdout as unknown as NodeJS.WriteStream,
    onDestroy: () => finalized++,
  })
  targets.push(target)
  return { ...target, stdout, finalized: () => finalized }
}

test("frame callback can destroy and await renderer.closed including finalization", async () => {
  const { renderer, renderOnce, finalized } = await setup()
  let resumed = false
  renderer.setFrameCallback(async () => {
    renderer.destroy()
    await renderer.closed
    assert.equal(finalized(), 1)
    resumed = true
  })
  const frame = renderOnce()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      frame,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("close deadlocked its frame callback")), 2000)
      }),
    ])
    assert.equal(resumed, true)
    assert.equal(renderer.root.isDestroyed, true)
  } finally {
    clearTimeout(timeout)
    renderer.nativeScene.driver.dispose()
    await frame
  }
})

test("reentrant input failure during destruction still releases nodes and stream ownership", async () => {
  const { renderer, renderOnce, finalized, stdout } = await setup()
  const logged = spyOn(console, "error").mockImplementation(() => {})
  const failure = new Error("input cleanup failure")
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  renderer.setFrameCallback(async () => {
    entered.resolve()
    await gate.promise
  })
  const box = new BoxRenderable(renderer, { width: 2, height: 1 })
  renderer.root.add(box)
  const sequences: string[] = []
  renderer.prependInputHandler((sequence) => {
    sequences.push(sequence)
    if (sequence === "a") renderer.destroy()
    if (sequence === "b") throw failure
    return true
  })
  const frame = renderOnce()
  try {
    await entered.promise
    assert.doesNotThrow(() => renderer.stdin.emit("data", Buffer.from("ab")))
    assert.deepEqual(sequences, ["a", "b"])
    gate.resolve()
    await frame
    await renderer.closed
    assert.equal(finalized(), 1)
    assert.equal(box.isDestroyed, true)
    assert.equal(renderer.nativeScene.driver.disposed, true)
    assert.equal(renderer.stdin.listenerCount("data"), 0)
    const replacement = await createTestRenderer({
      stdin: renderer.stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      width: 8,
      height: 3,
    })
    targets.push(replacement)
    await replacement.renderOnce()
    assert.equal(replacement.renderer.getStats().nativeFrameCount, 1)
  } finally {
    gate.resolve()
    await frame
    logged.mockRestore()
  }
})
