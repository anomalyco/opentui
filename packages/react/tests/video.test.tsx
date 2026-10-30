import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { act, useState } from "react"
import { fileURLToPath } from "node:url"
import { VideoRenderable, resolveRenderLib } from "@opentui/core"
import { testRender } from "../src/test-utils.js"

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

  it("swaps media when the source prop changes, and starts it after audio changed with it", async () => {
    let videoRef: VideoRenderable | null = null
    const failures: string[] = []
    let update: () => void = () => {}

    function App() {
      const [props, setProps] = useState({ source: "/nonexistent/opentui-missing.mp4", audio: true })
      update = () => setProps({ source: VIDEO_FIXTURE, audio: false })
      return (
        <video
          ref={(renderable: VideoRenderable | null) => {
            videoRef = renderable
          }}
          source={props.source}
          audio={props.audio}
          autoplay
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

    const native = logNativeVideo()
    try {
      await act(async () => update())
    } finally {
      native.restore()
    }
    // React sets source before audio; the open with audio never plays, so it starts no audio device.
    expect(native.log).toEqual(["open:0", "open:1", "play"])
    await testSetup.renderOnce()
    expect(videoRef!.ready).toBe(true)
    expect(videoRef!.videoMetadata?.height).toBe(90)
  })
})
