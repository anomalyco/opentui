import { afterEach, describe, expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import { createSignal } from "solid-js"
import { VideoRenderable } from "@opentui/core"
import { testRender } from "../index.js"

const VIDEO_FIXTURE = fileURLToPath(
  new URL("../../core/src/tests/fixtures/video/testsrc-160x90-24fps-2s-video-only.mp4", import.meta.url),
)

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

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
          maxFps={12}
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

  it("autoplays when autoplay follows source", async () => {
    let videoRef: VideoRenderable | undefined
    let plays = 0

    testSetup = await testRender(
      () => (
        <video ref={videoRef} source={VIDEO_FIXTURE} autoplay onPlay={() => plays++} style={{ width: 8, height: 4 }} />
      ),
      { width: 12, height: 6 },
    )
    await testSetup.renderOnce()

    expect(videoRef!.playing).toBe(true)
    expect(plays).toBe(1)
  })
})
