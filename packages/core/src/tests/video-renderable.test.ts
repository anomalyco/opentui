import { fileURLToPath } from "node:url"

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { VideoRenderable, type VideoMetadata } from "../renderables/Video.js"
import { createTestRenderer, type TestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const FIXTURE = fileURLToPath(new URL("./fixtures/video/testsrc-160x90-24fps-2s.mp4", import.meta.url))
// Without an audio track, playback never opens an audio device.
const SILENT = fileURLToPath(new URL("./fixtures/video/testsrc-160x90-24fps-2s-video-only.mp4", import.meta.url))
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
    expect(video.live).toBe(false)
    await setup.renderOnce()
    expect(setup.captureCharFrame().trim().length).toBeGreaterThan(0)
  })

  test("play keeps the renderer live and pause holds the position", async () => {
    const video = new VideoRenderable(renderer, { source: SILENT, width: 20, height: 6 })
    renderer.root.add(video)
    let played = 0
    video.onPlay = () => played++
    video.play()
    expect(played).toBe(1)
    expect(video.playing).toBe(true)
    expect(video.live).toBe(true)
    // Adaptive quality only lowers Kitty decode sizes; full size is tier 0.
    expect(video.qualityTier).toBe(0)
    await renderUntil(() => video.currentTime > 0.1)
    video.pause()
    expect(video.playing).toBe(false)
    expect(video.live).toBe(false)
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
    expect(video.live).toBe(false)
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
    expect(video.live).toBe(true)
    video.autoplay = false
    video.source = undefined
    expect(video.ready).toBe(false)
    expect(video.playing).toBe(true)
    expect(video.live).toBe(false)
    video.source = SILENT
    expect(video.playing).toBe(true)
    expect(video.live).toBe(true)
    await setup.renderOnce()
    video.destroy()
    await setup.renderOnce()
  })

  test("autoplay applies to the next source and play before a source carries over", () => {
    const video = new VideoRenderable(renderer, { width: 20, height: 6 })
    renderer.root.add(video)
    expect(video.autoplay).toBe(false)
    video.play()
    expect(video.playing).toBe(true)
    expect(video.live).toBe(false)
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
      await setup.renderOnce()
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
    expect(video.live).toBe(true)
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
