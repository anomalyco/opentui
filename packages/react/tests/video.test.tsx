import { afterEach, describe, expect, it } from "bun:test"
import { act, useState } from "react"
import { fileURLToPath } from "node:url"
import { VideoRenderable } from "@opentui/core"
import { testRender } from "../src/test-utils.js"

const VIDEO_FIXTURE = fileURLToPath(
  new URL("../../core/src/tests/fixtures/video/testsrc-160x90-24fps-2s-video-only.mp4", import.meta.url),
)

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

describe("React Renderer | video element", () => {
  it("creates a VideoRenderable and opens real media", async () => {
    let videoRef: VideoRenderable | null = null
    const readies: number[] = []
    const failures: string[] = []

    testSetup = await testRender(
      <video
        ref={(renderable: VideoRenderable | null) => {
          videoRef = renderable
        }}
        source={VIDEO_FIXTURE}
        maxFps={12}
        onReady={(metadata) => readies.push(metadata.width)}
        onError={(error) => failures.push(error.message)}
        style={{ width: 8, height: 4 }}
      />,
      { width: 12, height: 6 },
    )
    await testSetup.renderOnce()

    expect(videoRef).toBeInstanceOf(VideoRenderable)
    expect(failures).toEqual([])
    expect(readies).toEqual([160])
    expect(videoRef!.videoMetadata?.fps).toBe(24)
    expect(videoRef!.paused).toBe(true)
    expect(videoRef!.maxFps).toBe(12)
  })

  it("swaps media when the source prop changes", async () => {
    let videoRef: VideoRenderable | null = null
    const failures: string[] = []
    let updateSource: (value: string) => void = () => {}

    function App() {
      const [source, setSource] = useState("/nonexistent/opentui-missing.mp4")
      updateSource = setSource
      return (
        <video
          ref={(renderable: VideoRenderable | null) => {
            videoRef = renderable
          }}
          source={source}
          muted
          onError={(error) => failures.push(error.message)}
          style={{ width: 8, height: 4 }}
        />
      )
    }

    testSetup = await testRender(<App />, { width: 12, height: 6 })
    await testSetup.renderOnce()
    expect(failures.length).toBe(1)
    expect(videoRef!.ready).toBe(false)

    await act(async () => {
      updateSource(VIDEO_FIXTURE)
    })
    await testSetup.renderOnce()
    expect(videoRef!.ready).toBe(true)
    expect(videoRef!.videoMetadata?.height).toBe(90)
  })
})
