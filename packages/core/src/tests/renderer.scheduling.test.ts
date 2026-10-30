import { expect, spyOn, test } from "bun:test"
import { Renderable } from "../Renderable.js"
import { CliRenderEvents } from "../renderer.js"
import { settle } from "../testing/harness.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import type { AnimationTickOptions } from "../types.js"

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

// Fractional timers often fire before clock.now() reaches their delay; this clock fires every timer 1 ms early.
class EarlyClock extends ManualClock {
  override setTimeout(fn: () => void, delayMs: number) {
    return super.setTimeout(fn, Math.max(0, delayMs - 1))
  }
}

// Each subscriber requests a frame through its tick, as an animated component does.
async function animate(
  rates: number[],
  offsets: number[],
  options: { tick?: AnimationTickOptions; live?: boolean; content?: number[]; seconds?: number; early?: boolean } = {},
) {
  const clock = options.early ? new EarlyClock() : new ManualClock()
  const { renderer } = await createTestRenderer({ width: 4, height: 1, clock, targetFps: 60, maxFps: 60 })
  const seconds = options.seconds ?? 5
  const content = options.content ?? []
  let frames = 0
  renderer.on(CliRenderEvents.FRAME, () => frames++)
  const ticks = rates.map(() => 0)
  const gaps = rates.map(() => [] as number[])
  const last = rates.map(() => -1)
  for (let ms = 0; ms < (1 + seconds) * 1000; ms++) {
    if (ms === 1000) frames = 0
    rates.forEach((fps, i) => {
      if (ms !== offsets[i]) return
      renderer.onAnimationTick(
        fps,
        (_deltaTime, count, time) => {
          if (time <= 1000) return
          ticks[i] += count
          if (last[i] >= 0) gaps[i].push(time - last[i])
          last[i] = time
          renderer.requestRender()
        },
        options.tick,
      )
    })
    if (options.live && ms === 0) renderer.requestLive()
    while (content.length > 0 && content[0] <= ms) (content.shift(), renderer.requestRender())
    clock.advance(1)
    await settle(4)
  }
  renderer.destroy()
  await renderer.closed
  return { frames: frames / seconds, ticks: ticks.map((count) => count / seconds), gaps }
}

// rates (fps), mount offsets (ms), options → frames/s and ticks/s each. Before the shared clock, each component
// armed its own timer and the renderer drew the union of their steps: 40 frames/s for the issue row.
const frameRows: [string, number[], number[], Parameters<typeof animate>[2], number, number[]][] = [
  ["idle", [], [], {}, 0, []],
  ["one at 20 fps", [20], [0], {}, 20, [20]],
  ["one at 12.5 fps", [12.5], [0], {}, 12.6, [12.6]],
  ["issue 350: 20, 12.5 and 10 fps share the 20 fps frames", [20, 12.5, 10], [0, 17, 31], {}, 20, [20, 12.4, 10]],
  ["10 and 12.5 fps", [10, 12.5], [0, 23], {}, 12.6, [10, 12.6]],
  ["25 and 20 fps", [25, 20], [0, 9], {}, 25, [25, 20]],
  ["equal rates mounted apart tick together", [12.5, 12.5], [0, 30], {}, 12.6, [12.6, 12.6]],
  ["OpenCode's spinners", [25, 12.5, 12.5], [0, 13, 57], {}, 25, [25, 12.4, 12.4]],
  ["tolerance 0 keeps exact due times", [20, 12.5, 10], [0, 17, 31], { tick: { tolerance: 0 } }, 30, [20, 12.6, 10]],
  ["tolerance 0 with timers that fire 1 ms early", [20], [0], { tick: { tolerance: 0 }, early: true }, 20, [20]],
  // Slower subscribers also tick up to their tolerance late, so close rates that never align share frames.
  ["close rates 20, 19 and 18 fps", [20, 19, 18], [0, 7, 13], {}, 20, [20, 19, 18]],
  ["close rates 25, 24 and 23 fps", [25, 24, 23], [0, 7, 13], {}, 25, [25, 24, 23]],
  ["above maxFps, ticks arrive as counts", [100], [0], {}, 62.6, [100.2]],
  ["a live loop adds no frames for ticks", [20], [0], { live: true }, 62.4, [20]],
]

for (const [name, rates, offsets, options, frames, ticks] of frameRows) {
  test(`animation ticks: ${name}`, async () => {
    const result = await animate(rates, offsets, options)
    expect({ frames: result.frames, ticks: result.ticks }).toEqual({ frames, ticks })
  })
}

test("animation ticks: frames never exceed the fastest rate plus content frames (seeded)", async () => {
  let seed = 350
  const random = () => ((seed = (seed * 48271) % 2147483647) - 1) / 2147483646
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]
  for (let trial = 0; trial < 12; trial++) {
    const base = pick([50, 25, 20, 12.5])
    const rates = Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
      trial % 3 === 2 ? pick([60, 33, 25, 24, 23, 20, 19, 18, 15, 13.3, 12, 11.5, 10, 4]) : base / pick([1, 2, 4]),
    )
    const offsets = rates.map(() => Math.floor(random() * 200))
    const content = Array.from({ length: Math.floor(random() * 40) }, () => 1000 + Math.floor(random() * 2000)).sort(
      (a, b) => a - b,
    )
    const alone = await animate([], [], { content: [...content], seconds: 2 })
    const { frames, ticks, gaps } = await animate(rates, offsets, { content, seconds: 2 })
    const context = JSON.stringify({ trial, rates, offsets, frames, alone: alone.frames })
    const fastest = Math.max(...rates)
    expect(frames, context).toBeLessThanOrEqual(Math.min(60, fastest) + alone.frames)
    rates.forEach((fps, i) => {
      // A tick runs on the first frame from half an interval before its due time; the fastest rate's frames come
      // at least every 1000 / fastest ms, a maxFps gap later at worst.
      const slack = Math.min(1000 / fps, 1000 / fastest) + 1000 / 60 + 1
      expect(Math.abs(ticks[i] - fps), context).toBeLessThanOrEqual(1)
      for (const gap of gaps[i]) expect(Math.abs(gap - 1000 / fps), context).toBeLessThanOrEqual(slack)
    })
  }
})

class Pulse extends Renderable {
  ticks = 0
  protected override onAnimationTick(_deltaTime: number, ticks: number): void {
    this.ticks += ticks
    this.requestRender()
  }
}

test("animation ticks: animationFps ticks only while drawn, and unsubscribes inside a tick", async () => {
  const clock = new ManualClock()
  const { renderer } = await createTestRenderer({ width: 4, height: 1, clock, targetFps: 60, maxFps: 60 })
  let frames = 0
  renderer.on(CliRenderEvents.FRAME, () => frames++)
  const run = async (ms: number) => {
    frames = 0
    for (let i = 0; i < ms; i++) (clock.advance(1), await settle(4))
    return frames
  }
  // A callback that throws, first in tick order, costs neither the others' ticks nor the frame.
  const errors = spyOn(console, "error").mockImplementation(() => {})
  const stopThrowing = renderer.onAnimationTick(20, () => {
    throw new Error("tick")
  })
  const parent = new Pulse(renderer, { width: 2, height: 1 })
  const pulse = new Pulse(renderer, { width: 1, height: 1, animationFps: 20 })
  renderer.root.add(parent)
  parent.add(pulse)
  let late = 0
  const stopFirst = renderer.onAnimationTick(20, () => (stopFirst(), stopLate()))
  const stopLate = renderer.onAnimationTick(20, () => late++)
  const steps: [string, () => void, number, number][] = [
    ["visible", () => {}, 21, 20],
    ["hidden", () => ((pulse.visible = false), stopThrowing()), 1, 0],
    ["shown again", () => (pulse.visible = true), 21, 20],
    // Not drawn: the first tick after a frame without its update stops the clock; the next update resumes it.
    ["parent hidden", () => (parent.visible = false), 2, 0],
    ["parent shown", () => (parent.visible = true), 21, 20],
    ["removed", () => parent.remove(pulse), 2, 0],
    ["added again", () => parent.add(pulse), 21, 20],
    ["animationFps undefined", () => (pulse.animationFps = undefined), 0, 0],
    ["animationFps 0 is rejected", () => expect(() => (pulse.animationFps = 0)).toThrow(RangeError), 0, 0],
    ["animationFps 0 was not stored", () => expect(pulse.animationFps).toBeUndefined(), 0, 0],
    ["animationFps 10", () => (pulse.animationFps = 10), 10, 10],
    ["destroyed", () => pulse.destroy(), 1, 0],
  ]
  const seen: [string, number, number][] = []
  for (const [name, change] of steps) {
    change()
    const before = pulse.ticks
    seen.push([name, await run(1000), pulse.ticks - before])
  }
  expect(seen).toEqual(steps.map(([name, , frames, ticks]) => [name, frames, ticks]))
  expect({ late, errors: errors.mock.calls.length, timers: clock.pendingTimerCount }).toEqual({
    late: 0,
    errors: 20,
    timers: 0,
  })
  errors.mockRestore()
  renderer.destroy()
  await renderer.closed
})

test("animation ticks reject bad rates and tolerances, catch up after a late frame, and stop with the renderer", async () => {
  const clock = new ManualClock()
  const { renderer } = await createTestRenderer({ width: 1, height: 1, clock })
  const noop = () => {}
  for (const fps of [0, -1, NaN, Infinity]) expect(() => renderer.onAnimationTick(fps, noop)).toThrow(RangeError)
  for (const tolerance of [-1, 100, NaN]) {
    expect(() => renderer.onAnimationTick(10, noop, { tolerance })).toThrow(RangeError)
  }
  // A new subscriber skips the frame it joins: at 50 ms its first due time is 160 ms, beyond the 40 ms tolerance.
  // A late frame at 360 ms covers the passed due times 160, 240 and 320 ms, and 400 ms, which is within reach.
  // The next tick, at its due time of 480 ms, is ordinary: deltaTime is the time since the previous tick.
  const counts: number[][] = []
  clock.advance(50)
  const stop = renderer.onAnimationTick(12.5, (deltaTime, ticks) => counts.push([deltaTime, ticks]))
  renderer.requestRender()
  await settle(4)
  clock.advance(310)
  await settle(4)
  for (let ms = 0; ms < 120; ms++) (clock.advance(1), await settle(4))
  stop()
  expect(counts).toEqual([
    [310, 4],
    [120, 1],
  ])
  renderer.onAnimationTick(10, noop)
  expect(clock.pendingTimerCount).toBe(1)
  renderer.destroy()
  expect(clock.pendingTimerCount).toBe(0)
  renderer.onAnimationTick(10, noop)()
  expect(clock.pendingTimerCount).toBe(0)
  await renderer.closed
})

// fps, the time of a late frame → the due times it covers (every one up to time + tolerance, counted exactly), and
// whether a subscriber added in that frame, or just before it, ticks in it (it must not).
const boundaryRows: [number, number, number][] = [
  [18, 13_750, 248],
  [23, 2_500, 58],
  [33, 612_500, 20_213],
]

for (const [fps, time, due] of boundaryRows) {
  test(`animation ticks: a late frame at ${time} ms covers ${due} due times at ${fps} fps`, async () => {
    const clock = new ManualClock()
    const { renderer } = await createTestRenderer({ width: 1, height: 1, clock })
    const calls: string[] = []
    renderer.onAnimationTick(fps, (_deltaTime, ticks) => {
      calls.push(`first ${ticks}`)
      renderer.onAnimationTick(fps, () => calls.push("added in the frame"))
    })
    clock.advance(time)
    renderer.onAnimationTick(fps, () => calls.push("added before the frame"))
    await settle(4)
    expect(calls).toEqual([`first ${due}`])
    renderer.destroy()
    await renderer.closed
  })
}
