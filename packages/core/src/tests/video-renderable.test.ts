import { fileURLToPath } from "node:url"

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { BoxRenderable } from "../renderables/Box.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { VideoRenderable, type VideoMetadata } from "../renderables/Video.js"
import { createTestRenderer, type TestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const FIXTURE = fileURLToPath(new URL("./fixtures/video/testsrc-160x90-24fps-2s.mp4", import.meta.url))
// Without an audio track, playback never opens an audio device.
const SILENT = fileURLToPath(new URL("./fixtures/video/testsrc-160x90-24fps-2s-video-only.mp4", import.meta.url))
const SWITCH = fileURLToPath(new URL("./fixtures/video/resolution-switch-160x90-to-6000x5000.mp4", import.meta.url))
const MISSING = fileURLToPath(new URL("./fixtures/video/missing.mp4", import.meta.url))

describe("VideoRenderable", () => {
  let setup: TestRendererSetup
  let renderer: TestRenderer

  // Renders until the condition holds; playback follows the wall clock.
  async function renderUntil(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 500 && !condition(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      await setup.renderOnce()
    }
    expect(condition()).toBe(true)
  }

  // A playing video polls its state on the renderer's animation clock.
  const ticking = () => (renderer as any).animationTickers.size > 0

  beforeEach(async () => {
    setup = await createTestRenderer({ width: 20, height: 6 })
    renderer = setup.renderer
  })

  afterEach(() => {
    renderer.destroy()
  })

  test("opens metadata and paints the first frame natively while paused", async () => {
    let ready: VideoMetadata | undefined
    const video = new VideoRenderable(renderer, {
      source: FIXTURE,
      width: 20,
      height: 6,
      onReady: (metadata) => (ready = metadata),
    })
    renderer.root.add(video)
    expect(video.ready).toBe(true)
    expect(ready).toBeUndefined()
    await Promise.resolve()
    expect(ready).toEqual({ width: 160, height: 90, fps: 24, duration: expect.any(Number), hasAudio: true })
    expect(video.duration).toBeGreaterThan(1.9)
    expect(video.paused).toBe(true)
    expect(ticking()).toBe(false)
    await setup.renderOnce()
    expect(setup.captureCharFrame().trim().length).toBeGreaterThan(0)
    video.destroy()
    renderer.root.add(new VideoRenderable(renderer, { source: SILENT, width: 20, height: 6, buffered: true }))
    await setup.renderOnce()
    expect(setup.captureCharFrame().trim().length).toBeGreaterThan(0)
  })

  test("play ticks the animation clock and pause holds the position", async () => {
    const video = new VideoRenderable(renderer, { source: SILENT, width: 20, height: 6 })
    renderer.root.add(video)
    let played = 0
    video.onPlay = () => played++
    video.play()
    expect(played).toBe(1)
    expect(video.playing).toBe(true)
    expect(ticking()).toBe(true)
    // Adaptive quality only lowers Kitty decode sizes; full size is tier 0.
    expect(video.qualityTier).toBe(0)
    await renderUntil(() => video.currentTime > 0.1)
    video.pause()
    expect(video.playing).toBe(false)
    expect(ticking()).toBe(false)
    const position = video.currentTime
    await new Promise((resolve) => setTimeout(resolve, 40))
    await setup.renderOnce()
    expect(video.currentTime).toBe(position)
  })

  test("seek reports the target and reaching the end fires onEnd", async () => {
    const seeks: number[] = []
    let ended = 0
    const video = new VideoRenderable(renderer, {
      source: SILENT,
      width: 20,
      height: 6,
      onSeek: (time) => seeks.push(time),
      onEnd: () => ended++,
    })
    renderer.root.add(video)
    video.seek(1)
    expect(seeks).toEqual([1])
    expect(video.currentTime).toBe(1)
    video.seek(video.duration - 0.01)
    video.play()
    await renderUntil(() => ended > 0)
    expect(ended).toBe(1)
    expect(video.ended).toBe(true)
    expect(video.playing).toBe(false)
    expect(ticking()).toBe(false)
  })

  test("seeking past either end clamps without wrapping a looping video", async () => {
    const video = new VideoRenderable(renderer, { source: SILENT, width: 20, height: 6, loop: true })
    renderer.root.add(video)
    video.seek(1)
    video.seekBy(video.duration)
    expect(video.currentTime).toBe(video.duration)
    await setup.renderOnce()
    expect(video.currentTime).toBe(video.duration)
    video.seekBy(-video.duration * 2)
    expect(video.currentTime).toBe(0)
    expect(() => video.seek(-Infinity)).toThrow(RangeError)
  })

  test("open failures report the native detail", async () => {
    const errors: Error[] = []
    const video = new VideoRenderable(renderer, { source: MISSING, onError: (error) => errors.push(error) })
    expect(video.ready).toBe(false)
    await Promise.resolve()
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("ot_video_open")
    expect(errors[0].message).toContain(": ")
    expect(errors[0].message.length).toBeGreaterThan("ot_video_open failed: VideoFailed".length)
  })

  test("an empty source and a failed setup leave no source open", async () => {
    const errors: string[] = []
    const video = new VideoRenderable(renderer, { source: "", onError: (error) => errors.push(error.message) })
    expect([video.ready, video.playing, video.currentTime]).toEqual([false, false, 0])
    await Promise.resolve()
    expect(errors).toEqual([])
    const lib = renderer.nativeScene.videoNode(video).lib
    const setLoop = spyOn(lib, "videoSetLoop").mockImplementation(() => {
      throw new Error("loop failed")
    })
    try {
      video.source = SILENT
    } finally {
      setLoop.mockRestore()
    }
    expect([video.ready, video.playing, video.currentTime]).toEqual([false, false, 0])
    await Promise.resolve()
    expect(errors).toEqual(["loop failed"])
  })

  test("play retries a failed open and reports its failure again", async () => {
    const errors: Error[] = []
    const video = new VideoRenderable(renderer, {
      source: MISSING,
      muted: true,
      onError: (error) => errors.push(error),
    })
    renderer.root.add(video)
    await Promise.resolve()
    expect(errors).toHaveLength(1)
    // play() after a failed open opens again and reports the failure instead of staying silent.
    video.play()
    await Promise.resolve()
    expect(errors).toHaveLength(2)
    expect(video.playing).toBe(false)
    expect(video.ready).toBe(false)
  })

  test("replacing the source keeps playback intent and destroy releases the player", async () => {
    const video = new VideoRenderable(renderer, { source: SILENT, autoplay: true })
    renderer.root.add(video)
    expect(ticking()).toBe(true)
    video.autoplay = false
    video.source = undefined
    expect(video.ready).toBe(false)
    expect(video.playing).toBe(true)
    expect(ticking()).toBe(false)
    video.source = SILENT
    expect(video.playing).toBe(true)
    expect(ticking()).toBe(true)
    await setup.renderOnce()
    video.destroy()
    expect(ticking()).toBe(false)
    await setup.renderOnce()
  })

  test("autoplay applies to the next source and play before a source carries over", () => {
    const video = new VideoRenderable(renderer, { width: 20, height: 6 })
    renderer.root.add(video)
    expect(video.autoplay).toBe(false)
    video.play()
    expect(video.playing).toBe(true)
    expect(ticking()).toBe(false)
    video.source = SILENT
    expect(video.playing).toBe(true)
    video.pause()
    video.autoplay = true
    video.source = undefined
    video.source = SILENT
    expect(video.playing).toBe(true)
  })

  test("maxFps defaults to 30, validates its range, and survives source changes", () => {
    expect(() => new VideoRenderable(renderer, { maxFps: 0 })).toThrow(RangeError)
    const video = new VideoRenderable(renderer, { source: SILENT, maxFps: 12 })
    expect(video.maxFps).toBe(12)
    expect(() => (video.maxFps = 121)).toThrow(RangeError)
    expect(() => (video.maxFps = 2.5)).toThrow(RangeError)
    expect(video.maxFps).toBe(12)
    video.maxFps = undefined
    expect(video.maxFps).toBe(30)
    video.maxFps = 120
    video.source = FIXTURE
    expect(video.maxFps).toBe(120)
  })

  test("playback reports its end and failures, drawn or not", async () => {
    for (const kind of ["scrolled out", "hidden", "failed"]) {
      const events: string[] = []
      const video = new VideoRenderable(renderer, {
        source: kind === "failed" ? SWITCH : SILENT,
        width: 20,
        height: 6,
        visible: kind !== "hidden",
        onEnd: () => events.push("end"),
        onError: (error) => events.push(error.message),
      })
      const scroll = new ScrollBoxRenderable(renderer, { width: 20, height: 6 })
      // From 16 children on, a ScrollBox culls the ones outside its viewport.
      if (kind === "failed") scroll.add(video)
      for (let row = 0; row < 19; row++) scroll.add(new BoxRenderable(renderer, { height: 1 }))
      if (kind !== "failed") scroll.add(video)
      renderer.root.add(scroll)
      video.seek(kind === "failed" ? 0.95 : video.duration - 0.03)
      video.play()
      await renderUntil(() => events.length > 0)
      expect(events).toEqual([kind === "failed" ? "video frame 6000x5000 exceeds the image limits" : "end"])
      expect(video.playing).toBe(false)
      scroll.destroyRecursively()
    }
  })

  test("a native state failure during update reports through onError", async () => {
    const errors: Error[] = []
    const video = new VideoRenderable(renderer, {
      source: SILENT,
      width: 20,
      height: 6,
      autoplay: true,
      onError: (error) => errors.push(error),
    })
    renderer.root.add(video)
    const lib = renderer.nativeScene.videoNode(video).lib
    const read = spyOn(lib, "videoGetState").mockImplementation(() => {
      throw new Error("state unavailable")
    })
    try {
      await renderUntil(() => errors.length > 0)
    } finally {
      read.mockRestore()
    }
    expect(errors.map((error) => error.message)).toEqual(["state unavailable"])
  })

  test("play and pause report a native state failure through onError", () => {
    const errors: Error[] = []
    const video = new VideoRenderable(renderer, { source: SILENT, onError: (error) => errors.push(error) })
    renderer.root.add(video)
    const lib = renderer.nativeScene.videoNode(video).lib
    const read = spyOn(lib, "videoGetState").mockImplementation(() => {
      throw new Error("state unavailable")
    })
    try {
      video.play()
      video.pause()
    } finally {
      read.mockRestore()
    }
    expect(errors.map((error) => error.message)).toEqual(["state unavailable", "state unavailable"])
  })

  test("autoplay set after the source starts it", () => {
    const video = new VideoRenderable(renderer, { width: 20, height: 6 })
    renderer.root.add(video)
    video.source = SILENT
    expect(video.playing).toBe(false)
    video.autoplay = true
    expect(video.playing).toBe(true)
    expect(ticking()).toBe(true)
  })

  test("playback options set before a source apply when it opens", () => {
    const errors: Error[] = []
    const video = new VideoRenderable(renderer, { onError: (error) => errors.push(error) })
    const lib = renderer.nativeScene.videoNode(video).lib
    const setters = [
      ["loop", true, "videoSetLoop", true],
      ["muted", true, "videoSetMuted", true],
      ["volume", 0.5, "videoSetVolume", 0.5],
      ["avSyncOffsetMs", 250, "videoSetAvSyncOffset", 250_000n],
      ["maxFps", 12, "videoSetMaxFps", 12],
    ] as const
    const spies = setters.map(([, , method]) => spyOn(lib, method))
    try {
      for (const [option, value] of setters) (video as any)[option] = value
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
      video.source = SILENT
      setters.forEach(([option, value, , applied], index) => {
        expect((video as any)[option]).toBe(value)
        expect(spies[index]).toHaveBeenCalledTimes(1)
        expect(spies[index].mock.calls[0][2]).toBe(applied)
      })
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(errors).toEqual([])
  })

  test("rejected volume and sync offsets keep the previous value", () => {
    const errors: Error[] = []
    const video = new VideoRenderable(renderer, { source: SILENT, onError: (error) => errors.push(error) })
    for (const [option, rejected, accepted] of [
      ["avSyncOffsetMs", 60_001, 60_000],
      ["avSyncOffsetMs", -60_001, -60_000],
      ["volume", Number.MAX_VALUE, 3],
    ] as const) {
      expect(() => ((video as any)[option] = rejected)).toThrow(RangeError)
      expect(() => new VideoRenderable(renderer, { [option]: rejected })).toThrow(RangeError)
      ;(video as any)[option] = accepted
      expect((video as any)[option]).toBe(accepted)
    }
    video.source = undefined
    video.source = SILENT
    expect(errors).toEqual([])
    expect(video.ready).toBe(true)
  })

  test("pausing before a deferred autoplay report drops its onPlay", async () => {
    const events: string[] = []
    const video = new VideoRenderable(renderer, {
      source: SILENT,
      autoplay: true,
      onPlay: () => events.push("play"),
      onPause: () => events.push("pause"),
      onReady: () => events.push("ready"),
    })
    video.pause()
    await Promise.resolve()
    expect(events).toEqual(["pause", "ready"])
    expect(video.playing).toBe(false)
  })

  test("a looping video wraps at the end without ending", async () => {
    let ended = 0
    const video = new VideoRenderable(renderer, {
      source: SILENT,
      width: 20,
      height: 6,
      loop: true,
      onEnd: () => ended++,
    })
    renderer.root.add(video)
    video.seek(video.duration - 0.05)
    video.play()
    await renderUntil(() => video.currentTime < 1)
    expect(ended).toBe(0)
    expect(video.playing).toBe(true)
  })

  test("maxFps caps how many frames native presents", async () => {
    const video = new VideoRenderable(renderer, { source: SILENT, width: 20, height: 6, maxFps: 1 })
    renderer.root.add(video)
    const native = renderer.nativeScene.videoNode(video)
    const frames = new Set<bigint>()
    video.play()
    await renderUntil(() => {
      frames.add(native.lib.videoGetState(native.context, native.node).framePtsUs)
      return video.currentTime >= 1.2
    })
    // 1 fps over 1.2 s shows at most 2 or 3 source frames; 24 fps would show about 29.
    expect(frames.size).toBeLessThanOrEqual(3)
    // A new rate retimes the clock: 5 updates take 5 s at 1 fps.
    let updates = 0
    video.onTimeUpdate = () => updates++
    video.maxFps = 30
    await renderUntil(() => updates >= 5)
  })

  test("onPlay reports autoplay and playback requested before the source", async () => {
    let plays = 0
    new VideoRenderable(renderer, { source: SILENT, autoplay: true, onPlay: () => plays++ })
    const video = new VideoRenderable(renderer, { onPlay: () => plays++ })
    video.play()
    video.source = SILENT
    await Promise.resolve()
    expect(plays).toBe(2)
  })
})
