import { test, expect, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { settle } from "../testing/harness.js"
import { ManualClock } from "../testing/manual-clock.js"

let renderer: TestRenderer
let clock: ManualClock

beforeEach(async () => {
  clock = new ManualClock()
  ;({ renderer } = await createTestRenderer({ clock }))
})

afterEach(async () => {
  renderer.destroy()
  await renderer.closed
})

// Advances the manual clock until `idle()` resolves; fails if the renderer never becomes idle.
async function idleWithClock(): Promise<void> {
  let resolved = false
  const idle = renderer.idle().then(() => (resolved = true))
  for (let turn = 0; turn < 32 && !resolved; turn++) {
    clock.advance(20)
    await settle()
  }
  await idle
}

const scheduledWork: Record<string, { run: (target: TestRenderer) => void; frames: number; callbacks: number }> = {
  "no work": { run: () => {}, frames: 0, callbacks: 0 },
  "a cancelled start": { run: (target) => (target.start(), target.pause()), frames: 0, callbacks: 0 },
  "one render request": { run: (target) => target.requestRender(), frames: 1, callbacks: 0 },
  "coalesced render requests": { run: (target) => (target.requestRender(), target.requestRender()), frames: 1, callbacks: 0 },
  "a paused render request": { run: (target) => (target.pause(), target.requestRender()), frames: 1, callbacks: 0 },
  "an animation frame": { run: (target) => void target.requestAnimationFrame(() => callbacks++), frames: 1, callbacks: 1 },
  "a nested animation frame": {
    run: (target) =>
      void target.requestAnimationFrame(() => {
        callbacks++
        target.requestAnimationFrame(() => callbacks++)
      }),
    frames: 2,
    callbacks: 2,
  },
}
let callbacks = 0

for (const [name, { run, frames, callbacks: expectedCallbacks }] of Object.entries(scheduledWork)) {
  test(`idle() resolves after ${name} without another frame`, async () => {
    callbacks = 0
    run(renderer)
    await idleWithClock()
    const after = { frames: renderer.frameId, callbacks, running: renderer.isRunning }

    await idleWithClock()

    expect(after).toEqual({ frames, callbacks: expectedCallbacks, running: false })
    expect(renderer.frameId).toBe(frames)
    expect(renderer.getSchedulerState()).toEqual({ isRunning: false, isRendering: false, hasScheduledRender: false })
  })
}

for (const halt of ["pause", "stop", "dropLive", "destroy"] as const) {
  test(`pending idle() calls resolve when ${halt}() ends a running loop`, async () => {
    if (halt === "dropLive") renderer.requestLive()
    else renderer.start()
    clock.advance(100)
    await settle(4)
    expect(renderer.frameId).toBeGreaterThan(0)

    let resolved = 0
    const waits = [renderer.idle(), renderer.idle()].map((wait) => wait.then(() => resolved++))
    clock.advance(100)
    await settle(4)
    expect(resolved).toBe(0)

    renderer[halt]()
    // dropLive() keeps already scheduled frames, so the clock must run them.
    for (let turn = 0; turn < 8 && resolved < 2; turn++) {
      clock.advance(20)
      await settle()
    }
    await Promise.all(waits)
    expect({ resolved, running: renderer.isRunning }).toEqual({ resolved: 2, running: false })
  })
}

test("idle() on a destroyed renderer resolves with closed", async () => {
  renderer.destroy()
  await renderer.idle()
  expect(renderer.isDestroyed).toBe(true)
})
