import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { fileURLToPath } from "node:url"
import { createSignal } from "solid-js"
import { VideoRenderable, resolveRenderLib } from "@opentui/core"
import { testRender } from "../index.js"

const VIDEO_FIXTURE = fileURLToPath(
  new URL("../../core/src/tests/fixtures/video/testsrc-160x90-24fps-2s-video-only.mp4", import.meta.url),
)

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

// Logs native opens with their flags (1: no audio) and play calls, in order.
function logNativeVideo(): { log: string[]; restore: () => void } {
  const symbols = (resolveRenderLib() as any).opentui.symbols
  const log: string[] = []
  const spies = ["ot_video_open", "ot_video_play"].map((name) => {
    const original = symbols[name]
    return spyOn(symbols, name).mockImplementation((...args: any[]) => {
      log.push(name === "ot_video_play" ? "play" : `open:${args[4]}`)
      return original(...args)
    })
  })
  return { log, restore: () => spies.forEach((spy) => spy.mockRestore()) }
}

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

describe("video component", () => {
  it("creates a VideoRenderable and opens real media", async () => {
    let videoRef: VideoRenderable | undefined
    const readies: number[] = []
    const failures: string[] = []

    testSetup = await testRender(
      () => (
        <video
          ref={videoRef}
          source={VIDEO_FIXTURE}
          audio={false}
          maxFps={12}
          crop={{ left: 80, top: 45, width: 80, height: 45 }}
          onReady={(metadata) => readies.push(metadata.width)}
          onError={(error) => failures.push(error.message)}
          style={{ width: 8, height: 4 }}
        />
      ),
      { width: 12, height: 6 },
    )
    await testSetup.renderOnce()

    expect(videoRef).toBeInstanceOf(VideoRenderable)
    expect(failures).toEqual([])
    expect(readies).toEqual([160])
    expect(videoRef!.paused).toBe(true)
    expect(videoRef!.maxFps).toBe(12)
    expect(videoRef!.crop).toEqual({ left: 80, top: 45, width: 80, height: 45 })
  })

  it("clears a crop removed from the style", async () => {
    let videoRef: VideoRenderable | undefined
    const crop = { left: 80, top: 45, width: 80, height: 45 }
    const [styled, setStyled] = createSignal(true)

    testSetup = await testRender(
      () => <video ref={videoRef} source={VIDEO_FIXTURE} style={styled() ? { width: 8, height: 4, crop } : {}} />,
      { width: 12, height: 6 },
    )
    expect(videoRef!.crop).toEqual(crop)
    setStyled(false)
    expect(videoRef!.crop).toBeUndefined()
  })

  it("swaps media when the source signal changes", async () => {
    let videoRef: VideoRenderable | undefined
    const failures: string[] = []
    const [source, setSource] = createSignal("/nonexistent/opentui-missing.mp4")

    testSetup = await testRender(
      () => (
        <video
          ref={videoRef}
          source={source()}
          muted
          onError={(error) => failures.push(error.message)}
          style={{ width: 8, height: 4 }}
        />
      ),
      { width: 12, height: 6 },
    )
    await testSetup.renderOnce()
    expect(failures.length).toBe(1)
    expect(videoRef!.ready).toBe(false)

    setSource(VIDEO_FIXTURE)
    await testSetup.renderOnce()
    expect(videoRef!.ready).toBe(true)
    expect(videoRef!.videoMetadata?.height).toBe(90)
  })

  it("autoplays when autoplay follows source, after an audio prop set later applies", async () => {
    const [audio] = createSignal(false)
    for (const reactive of [false, true]) {
      let videoRef: VideoRenderable | undefined
      let plays = 0
      const native = logNativeVideo()
      try {
        // Static props run in JSX order and before reactive ones, so audio arrives after source and autoplay.
        testSetup = await testRender(
          () =>
            reactive ? (
              <video ref={videoRef} audio={audio()} source={VIDEO_FIXTURE} autoplay onPlay={() => plays++} />
            ) : (
              <video ref={videoRef} source={VIDEO_FIXTURE} autoplay audio={false} onPlay={() => plays++} />
            ),
          { width: 12, height: 6 },
        )
        await testSetup.renderOnce()
      } finally {
        native.restore()
      }
      // The open with audio never plays, so it starts no audio device.
      expect(native.log).toEqual(["open:0", "open:1", "play"])
      expect(videoRef!.playing).toBe(true)
      expect(plays).toBe(1)
      testSetup.renderer.destroy()
      testSetup = undefined
    }
  })
})
