import { test, expect, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { serviceReadyFrames } from "../testing/harness.js"
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

const scheduledWork: Record<string, { run: (target: TestRenderer) => void; frames: number; callbacks: number }> = {
  "no work": { run: () => {}, frames: 0, callbacks: 0 },
  "a cancelled start": { run: (target) => (target.start(), target.pause()), frames: 0, callbacks: 0 },
  "one render request": { run: (target) => target.requestRender(), frames: 1, callbacks: 0 },
  "coalesced render requests": {
    run: (target) => (target.requestRender(), target.requestRender()),
    frames: 1,
    callbacks: 0,
  },
  "a paused render request": { run: (target) => (target.pause(), target.requestRender()), frames: 1, callbacks: 0 },
  "an animation frame": {
    run: (target) => void target.requestAnimationFrame(() => callbacks++),
    frames: 1,
    callbacks: 1,
  },
  // An animation tick subscription is not scheduled work; idle() resolves between its ticks.
  "an animation tick subscription": {
    run: (target) => void target.onAnimationTick(10, () => callbacks++),
    frames: 0,
    callbacks: 0,
  },
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
    const after = renderer.idle().then(() => ({ frames: renderer.frameId, callbacks, running: renderer.isRunning }))
    await serviceReadyFrames(renderer)
    for (let frame = 0; frame < frames; frame++) {
      clock.advance(20)
      await serviceReadyFrames(renderer)
    }

    expect(await after).toEqual({ frames, callbacks: expectedCallbacks, running: false })
    clock.advance(20)
    await renderer.idle()
    expect(renderer.frameId).toBe(frames)
    expect(renderer.getSchedulerState()).toEqual({ isRunning: false, isRendering: false, hasScheduledRender: false })
  })
}

for (const halt of ["pause", "stop", "dropLive", "destroy"] as const) {
  test(`pending idle() calls resolve when ${halt}() ends a running loop`, async () => {
    if (halt === "dropLive") renderer.requestLive()
    else renderer.start()
    clock.advance(100)
    await serviceReadyFrames(renderer)
    expect(renderer.frameId).toBeGreaterThan(0)

    let resolved = 0
    const waits = [renderer.idle(), renderer.idle()].map((wait) => wait.then(() => resolved++))
    clock.advance(100)
    await serviceReadyFrames(renderer)
    expect(resolved).toBe(0)

    renderer[halt]()
    // dropLive() keeps already scheduled frames, so the clock must run them.
    clock.advance(100)
    await Promise.all(waits)
    expect({ resolved, running: renderer.isRunning }).toEqual({ resolved: 2, running: false })
  })
}

test("idle() on a destroyed renderer resolves with closed", async () => {
  renderer.destroy()
  await renderer.idle()
  expect(renderer.isDestroyed).toBe(true)
})
