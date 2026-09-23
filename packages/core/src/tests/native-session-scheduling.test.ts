import { expect, test } from "bun:test"
import { Writable } from "node:stream"
import { setImmediate } from "node:timers/promises"
import { NativeSession, type NativeSessionScheduler } from "../NativeSession.js"
import { CliRenderer } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin } from "../testing/test-streams.js"

class Scheduler implements NativeSessionScheduler {
  time = 0n
  tasks = new Set<{ at: bigint; callback: () => void }>()
  now() {
    return this.time
  }
  schedule(callback: () => void, delayMs = 0) {
    const task = { at: this.time + BigInt(delayMs) * 1_000_000n, callback }
    this.tasks.add(task)
    return () => {
      this.tasks.delete(task)
    }
  }
  turn() {
    this.time += 1_000_000n
    for (const task of [...this.tasks]) {
      if (task.at <= this.time && this.tasks.delete(task)) task.callback()
    }
  }
  async run(turns = 8) {
    for (let turn = 0; turn < turns; turn++) {
      this.turn()
      await setImmediate()
    }
  }
}

function rendererFor(scheduler: Scheduler, stdout: Writable, clock = new ManualClock()) {
  return new CliRenderer(createTestStdin(), stdout as NodeJS.WriteStream, 2, 1, {
    nativeSession: new NativeSession(stdout, { scheduler }),
    clock,
    remote: true,
    screenMode: "main-screen",
    consoleMode: "disabled",
    exitSignals: [],
    debounceDelay: 1,
  })
}

test("blocked output and host promises do not hold other renderers' input, resize or shutdown", async () => {
  const scheduler = new Scheduler()
  const clock = new ManualClock()
  const host = Promise.withResolvers<void>()
  let release: (() => void) | undefined
  let hold = true
  const animation: number[] = []
  const inputs: number[] = []
  const resizes: number[] = []
  const closed: number[] = []
  const renderers = Array.from({ length: 3 }, (_, index) =>
    rendererFor(
      scheduler,
      new Writable({
        highWaterMark: 1,
        write(_bytes, _encoding, done) {
          if (index === 0 && hold) release = done
          else done()
        },
      }),
      clock,
    ),
  )
  try {
    for (const [index, renderer] of renderers.entries()) {
      renderer.keyInput.on("keypress", () => inputs.push(index))
      renderer.on("resize", () => resizes.push(index))
      renderer.pause()
      for (let call = 0; call < 2; call++) renderer.requestAnimationFrame(() => animation.push(index))
      if (index === 2) renderer.setFrameCallback(() => host.promise)
      renderer.start()
    }
    await scheduler.run(24)
    expect(animation).toEqual([0, 1, 2, 0, 1, 2])
    expect(release).toBeDefined()
    for (const renderer of renderers) {
      renderer.stdin.emit("data", Buffer.from("a"))
      renderer.requestResize(4, 2)
      renderer.requestResize(3, 1)
    }
    expect(inputs).toEqual([0, 1, 2])
    clock.advance(2)
    await scheduler.run(24)
    expect(resizes).toEqual([1])
    expect(renderers.map((renderer) => renderer.width)).toEqual([2, 3, 2])
    for (const [index, renderer] of renderers.entries()) {
      renderer.destroy()
      void renderer.closed.then(() => closed.push(index))
    }
    await scheduler.run(24)
    expect(closed.sort()).toEqual([1, 2])
    hold = false
    release?.()
    release = undefined
    await scheduler.run(24)
    await Promise.all(renderers.map((renderer) => renderer.closed))
    expect(animation).toHaveLength(6)
  } finally {
    host.resolve()
    hold = false
    release?.()
    for (const renderer of renderers) {
      renderer.destroy()
      renderer.nativeScene.driver.dispose()
    }
    await scheduler.run()
    await Promise.allSettled(renderers.map((renderer) => renderer.closed))
  }
})
