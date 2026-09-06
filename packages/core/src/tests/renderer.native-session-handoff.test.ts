import { spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { NativeSession } from "../NativeSession.js"
import { CliRenderer, CliRenderEvents, createCliRenderer, type CliRendererConfig } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { RenderableEvents } from "../Renderable.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin, TestWriteStream } from "../testing/test-streams.js"
import { NativeSessionTerminalPhase } from "../zig.js"

class HeldOutput extends TestWriteStream {
  hold = true
  chunks: Buffer[] = []
  complete?: () => void
  override _write(chunk: Uint8Array, _encoding: BufferEncoding, complete: () => void): void {
    this.chunks.push(Buffer.from(chunk))
    if (this.hold) this.complete = complete
    else complete()
  }
  release(): void {
    this.hold = false
    const complete = this.complete
    this.complete = undefined
    complete?.()
  }
}

const config: CliRendererConfig = {
  screenMode: "main-screen",
  externalOutputMode: "passthrough",
  consoleMode: "disabled",
  remote: true,
}

async function held(stdout: HeldOutput): Promise<void> {
  for (let turn = 0; turn < 64 && !stdout.complete; turn++) await setImmediate()
  assert.ok(stdout.complete, "the real output callback must be held")
}

test("rejected then accepted handoff preserves the driver's held raw output and cleanup owner", async () => {
  const stdout = new HeldOutput(8, 3)
  const stdin = createTestStdin()
  let cleaned = 0
  const driver = new NativeSession(stdout)
  let renderer: CliRenderer | undefined
  try {
    driver.write(Buffer.from("before-attach"))
    await held(stdout)
    const callback = stdout.complete
    assert.throws(
      () =>
        new CliRenderer(stdin, new TestWriteStream() as unknown as NodeJS.WriteStream, 8, 3, {
          ...config,
          nativeSession: driver,
          onDestroy: () => cleaned++,
        }),
    )
    assert.equal(driver.disposed, false)
    assert.equal(cleaned, 0)
    renderer = new CliRenderer(stdin, stdout as unknown as NodeJS.WriteStream, 8, 3, {
      ...config,
      clock: new ManualClock(),
      nativeSession: driver,
      onDestroy: () => cleaned++,
    })
    assert.equal(renderer.nativeScene.driver, driver)
    assert.equal(stdout.complete, callback)
    assert.equal(stdout.listenerCount("error"), 1)
    const setup = renderer.setupTerminal()
    let ready = false
    void setup.then(() => (ready = true))
    await setImmediate()
    assert.equal(ready, false)
    assert.equal(Buffer.concat(stdout.chunks).toString(), "before-attach")
    stdout.release()
    await setup
    renderer.root.add(new BoxRenderable(renderer, { width: 2, height: 1, backgroundColor: "red" }))
    await (renderer as unknown as { loop(): Promise<void> }).loop()
    assert.equal(renderer.getStats().nativeFrameCount, 1)
    renderer.destroy()
    await renderer.closed
    assert.equal(cleaned, 1)
    assert.equal(driver.disposed, true)
    assert.equal(stdout.destroyed, false)
    assert.equal(stdout.writableEnded, false)
  } finally {
    stdout.release()
    renderer?.destroy()
    driver.dispose()
  }
})

test("factory interruption waits for accepted output and restoration instead of cancelling close", async () => {
  const stdout = new HeldOutput(8, 3)
  const stdin = createTestStdin()
  let finalPhase: NativeSessionTerminalPhase | undefined
  const driver = new NativeSession(stdout)
  const lib = driver.renderLib
  const destroyContext = lib.destroyContext
  const destroy = spyOn(lib, "destroyContext").mockImplementation((context) => {
    if (context === driver.context) {
      finalPhase = driver.renderLib.sessionGetTerminalState(driver.context, driver.session)
    }
    destroyContext.call(lib, context)
  })
  const originalError = console.error
  console.error = () => {}
  try {
    driver.write(Buffer.from("before-attach"))
    await held(stdout)
    let settled = false
    const creation = createCliRenderer({
      ...config,
      screenMode: "alternate-screen",
      nativeSession: driver,
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
    }).catch((error) => {
      settled = true
      return error
    })
    const interrupted = driver.setupTerminal().catch((error: unknown) => error)
    const closing = driver.close()
    const error = await interrupted
    assert.ok(driver.isCloseInterruption(error))
    await setImmediate()
    assert.equal(settled, false)
    assert.equal(driver.disposed, false)
    stdout.release()
    await closing
    assert.equal(await creation, error)
    assert.equal(driver.error, null)
    assert.equal(finalPhase, NativeSessionTerminalPhase.Restored)
    assert.ok(Buffer.concat(stdout.chunks).toString().startsWith("before-attach"))
    assert.equal(stdin.listenerCount("data"), 0)
  } finally {
    stdout.release()
    driver.dispose()
    console.error = originalError
    destroy.mockRestore()
  }
})

test("accepted handoff releases input ownership despite setup, attachment cleanup and removal observer failures", async () => {
  const stdout = new HeldOutput(8, 3)
  stdout.release()
  const stdin = createTestStdin()
  const failure = new Error("fixture setup failure")
  const cleanupFailure = new Error("fixture cleanup failure")
  const observerFailure = new Error("fixture removal observer")
  const driver = new NativeSession(stdout)
  const attachRenderer = driver.attachRenderer
  const attachment = spyOn(driver, "attachRenderer").mockImplementation((options, cleanup) => {
    attachRenderer.call(driver, options, () => {
      cleanup?.()
      throw cleanupFailure
    })
  })
  const lib = driver.renderLib
  const setup = lib.sessionSetupTerminal
  const originalError = console.error
  const reported: unknown[][] = []
  console.error = (...args) => {
    reported.push(args)
  }
  const observer = (event: string | symbol) => {
    if (event === "data") throw observerFailure
  }
  stdin.on("removeListener", observer)
  let finalized = 0
  try {
    lib.sessionSetupTerminal = () => {
      throw failure
    }
    await assert.rejects(
      createCliRenderer({
        ...config,
        nativeSession: driver,
        stdin,
        stdout: stdout as unknown as NodeJS.WriteStream,
        onDestroy: () => finalized++,
      }),
      (error) => error === failure,
    )
    await assert.rejects(driver.closed, cleanupFailure)
    assert.equal(driver.disposed, true)
    assert.equal(finalized, 1)
    assert.equal(stdin.listenerCount("data"), 0)
    assert.equal(stdin.isPaused(), true)
    assert.ok(reported.some((args) => args.includes(observerFailure)))
    stdin.off("removeListener", observer)
    lib.sessionSetupTerminal = setup
    const replacement = new CliRenderer(stdin, stdout as unknown as NodeJS.WriteStream, 8, 3, config)
    replacement.destroy()
    await replacement.closed
  } finally {
    stdin.off("removeListener", observer)
    lib.sessionSetupTerminal = setup
    console.error = originalError
    driver.dispose()
    attachment.mockRestore()
  }
})

test.each(["frame", "setup"] as const)("resize publishes only the latest size after held %s", async (phase) => {
  const stdout = new HeldOutput(8, 3)
  stdout.release()
  const clock = new ManualClock()
  const driver = new NativeSession(stdout)
  const renderer = new CliRenderer(createTestStdin(), stdout as unknown as NodeJS.WriteStream, 8, 3, {
    ...config,
    clock,
    nativeSession: driver,
  })
  try {
    renderer.root.add(new BoxRenderable(renderer, { width: "100%", height: "100%", backgroundColor: "red" }))
    stdout.hold = true
    const pending =
      phase === "setup" ? renderer.setupTerminal() : (renderer as unknown as { loop(): Promise<void> }).loop()
    await held(stdout)
    const sizes: number[][] = []
    renderer.on(CliRenderEvents.RESIZE, (width, height) => sizes.push([width, height]))
    renderer.requestResize(12, 5)
    clock.advance(100)
    renderer.requestResize(16, 6)
    clock.advance(100)
    assert.deepEqual(sizes, [])
    assert.deepEqual([renderer.width, renderer.height], [8, 3])
    assert.throws(() => renderer.resize(10, 4))
    stdout.release()
    await pending
    for (let turn = 0; turn < 64 && renderer.width !== 16; turn++) await setImmediate()
    assert.deepEqual(sizes, [[16, 6]])
    renderer.currentRenderBuffer.withBuffers((cells) => assert.deepEqual([cells.width, cells.height], [16, 6]))
  } finally {
    stdout.release()
    renderer.destroy()
    await renderer.closed
  }
})

test("consumed driver retries leased framebuffer cleanup despite a throwing destruction observer", async () => {
  const stdout = new HeldOutput(8, 3)
  stdout.release()
  const driver = new NativeSession(stdout)
  const renderer = new CliRenderer(createTestStdin(), stdout as unknown as NodeJS.WriteStream, 8, 3, {
    ...config,
    nativeSession: driver,
  })
  const box = new BoxRenderable(renderer, { width: 2, height: 1 })
  renderer.root.add(box)
  box.on(RenderableEvents.DESTROYED, () => {
    throw new Error("fixture cleanup failure")
  })
  const originalError = console.error
  console.error = () => {}
  try {
    renderer.currentRenderBuffer.withBuffers((cells) => {
      driver.dispose()
      assert.equal(driver.disposed, false)
      assert.equal(cells.char.length, 24)
    })
    await assert.rejects(renderer.closed)
    assert.equal(driver.disposed, true)
    assert.equal(renderer.root.isDestroyed, true)
    assert.equal(box.isDestroyed, true)
  } finally {
    console.error = originalError
    renderer.destroy()
    driver.dispose()
  }
})
