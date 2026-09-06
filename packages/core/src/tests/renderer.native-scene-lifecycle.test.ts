import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { CliRenderEvents } from "../renderer.js"
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
  const clock = new ManualClock()
  const stdout = new TestWriteStream(8, 3)
  let finalized = 0
  const target = await createTestRenderer({
    width: 8,
    height: 3,
    clock,
    stdout: stdout as unknown as NodeJS.WriteStream,
    onDestroy: () => finalized++,
  })
  targets.push(target)
  return { ...target, clock, stdout, finalized: () => finalized }
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

test("suspended terminal resize coalesces to the latest size and a reverted resize settles idle", async () => {
  const { renderer, renderOnce, clock, stdout } = await setup()
  const terminalResize = (width: number, height: number) => {
    Object.assign(stdout, { columns: width, rows: height })
    renderer["sigwinchHandler"]()
  }
  const box = new BoxRenderable(renderer, { width: "100%", height: "100%", backgroundColor: "red" })
  renderer.root.add(box)
  await renderer.setupTerminal()
  await renderOnce()
  await renderer.suspend()
  const resizes: number[][] = []
  renderer.on(CliRenderEvents.RESIZE, (width, height) => resizes.push([width, height]))
  for (const [width, height] of [
    [12, 5],
    [16, 6],
  ]) {
    terminalResize(width, height)
    clock.advance(100)
  }
  await renderer.resume()
  for (let turn = 0; turn < 32; turn++) {
    clock.advance(100)
    await setImmediate()
    if (renderer.width === 16 && renderer.height === 6 && !renderer.getSchedulerState().isRendering) break
  }
  await renderOnce()
  assert.deepEqual([renderer.terminalWidth, renderer.terminalHeight, box.width, box.height], [16, 6, 16, 6])
  assert.deepEqual(resizes.at(-1), [16, 6])
  clock.runAll()
  await renderer.idle()
  const frameId = renderer.frameId
  terminalResize(12, 5)
  terminalResize(16, 6)
  let settled = false
  const idle = renderer.idle().then(() => {
    settled = true
  })
  await setImmediate()
  assert.equal(settled, false)
  clock.advance(100)
  await idle
  assert.equal(renderer.frameId, frameId)
  assert.equal(renderer.getSchedulerState().hasScheduledRender, false)
})

test("pending terminal setup rejects preferences that would diverge from accepted options", async () => {
  const stdout = new TestWriteStream(8, 3)
  let complete: (() => void) | undefined
  stdout._write = (_chunk, _encoding, callback) => {
    complete = callback
  }
  const target = await createTestRenderer({ stdout: stdout as unknown as NodeJS.WriteStream, bufferedOutput: "stdout" })
  targets.push(target)
  const { renderer } = target
  const before = [renderer.screenMode, renderer.useMouse, renderer.useKittyKeyboard]
  const pending = renderer.setupTerminal()
  try {
    for (let turn = 0; turn < 32 && !complete; turn++) await setImmediate()
    assert.ok(complete)
    assert.throws(() => {
      renderer.screenMode = "alternate-screen"
    })
    assert.throws(() => {
      renderer.useMouse = !renderer.useMouse
    })
    assert.throws(() => {
      renderer.useKittyKeyboard = !renderer.useKittyKeyboard
    })
    assert.deepEqual([renderer.screenMode, renderer.useMouse, renderer.useKittyKeyboard], before)
  } finally {
    stdout._write = (_chunk, _encoding, callback) => callback()
    complete?.()
    await pending
  }
})
