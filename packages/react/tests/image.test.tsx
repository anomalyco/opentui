import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { ImageRenderable } from "@opentui/core"
import { act, useState } from "react"
import { testRender } from "../src/test-utils.js"

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==",
    "base64",
  ),
)

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined
let consoleError: ReturnType<typeof spyOn>

beforeEach(() => {
  consoleError = spyOn(console, "error")
})

afterEach(() => {
  try {
    act(() => testSetup?.renderer.destroy())
    expect(consoleError).not.toHaveBeenCalled()
  } finally {
    testSetup = undefined
    consoleError.mockRestore()
  }
})

describe("React Renderer | image element", () => {
  it("creates an ImageRenderable and loads encoded bytes", async () => {
    let imageRef: ImageRenderable | null = null
    const loaded: string[] = []

    testSetup = await testRender(
      <image
        ref={(renderable: ImageRenderable | null) => {
          imageRef = renderable
        }}
        source={PNG_1X1}
        onLoad={(image) => loaded.push(image.info().format)}
        style={{ width: 4, height: 2 }}
      />,
      { width: 10, height: 6 },
    )
    await testSetup.renderOnce()

    expect(imageRef).toBeInstanceOf(ImageRenderable)
    await imageRef!.loadPromise
    expect(loaded).toEqual(["png"])
    expect(imageRef!.image?.width).toBe(1)
    expect(imageRef!.loadError).toBeNull()
  })

  it("keeps the loaded image across parent rerenders", async () => {
    let imageRef: ImageRenderable | null = null
    let rerender!: () => void
    let loads = 0

    function App() {
      const [revision, setRevision] = useState(0)
      rerender = () => setRevision((value) => value + 1)
      return (
        <image
          ref={(renderable: ImageRenderable | null) => {
            imageRef = renderable
          }}
          source={PNG_1X1}
          onLoad={() => loads++}
          style={{ width: 4, height: 2, left: revision }}
        />
      )
    }

    testSetup = await testRender(<App />, { width: 10, height: 6 })
    await imageRef!.loadPromise
    const loadedImage = imageRef!.image

    act(() => rerender())
    await testSetup.renderOnce()

    expect(imageRef!.image).toBe(loadedImage)
    expect(loads).toBe(1)
  })

  it("clears the image when the source prop is removed", async () => {
    let imageRef: ImageRenderable | null = null
    let setVisible!: (visible: boolean) => void

    function App() {
      const [visible, setImageVisible] = useState(true)
      setVisible = setImageVisible
      return (
        <image
          ref={(renderable: ImageRenderable | null) => {
            imageRef = renderable
          }}
          {...(visible ? { source: PNG_1X1 } : {})}
          protocol="blocks"
          style={{ width: 2, height: 1 }}
        />
      )
    }

    testSetup = await testRender(<App />, { width: 4, height: 2 })
    await imageRef!.loadPromise
    await testSetup.renderOnce()
    expect(testSetup.captureCharFrame()).toContain("█")

    act(() => setVisible(false))
    if (imageRef!.loadPromise) await imageRef!.loadPromise
    await testSetup.renderOnce()

    expect(imageRef!.source).toBeUndefined()
    expect(imageRef!.image).toBeNull()
    expect(imageRef!.loadError).toBeNull()
    expect(testSetup.captureCharFrame()).not.toContain("█")
  })

  it("restores image defaults when optional props are removed", async () => {
    let imageRef: ImageRenderable | null = null
    let setConfigured!: (configured: boolean) => void

    function App() {
      const [configured, setImageConfigured] = useState(true)
      setConfigured = setImageConfigured
      return (
        <image
          ref={(renderable: ImageRenderable | null) => {
            imageRef = renderable
          }}
          {...(configured ? { fit: "fill" as const, protocol: "kitty" as const } : {})}
        />
      )
    }

    testSetup = await testRender(<App />, { width: 4, height: 2 })
    expect(imageRef!.fit).toBe("fill")
    expect(imageRef!.protocol).toBe("kitty")

    act(() => setConfigured(false))

    expect(imageRef!.fit).toBe("fit")
    expect(imageRef!.protocol).toBe("auto")
    expect(imageRef!.effectiveProtocol).toBe("blocks")
  })

  it("cancels a pending image load when its component unmounts", async () => {
    let imageRef: ImageRenderable | null = null
    let setVisible!: (visible: boolean) => void
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    let cancelled = false
    let loads = 0
    let errors = 0
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller
        },
        cancel() {
          cancelled = true
        },
      }),
    )

    function App() {
      const [visible, setImageVisible] = useState(true)
      setVisible = setImageVisible
      return visible ? (
        <image
          ref={(renderable: ImageRenderable | null) => {
            imageRef = renderable
          }}
          source={response}
          onLoad={() => loads++}
          onError={() => errors++}
        />
      ) : null
    }

    testSetup = await testRender(<App />, { width: 4, height: 2 })
    const image = imageRef!
    const pending = image.loadPromise!

    act(() => setVisible(false))
    if (!cancelled) {
      streamController.enqueue(PNG_1X1)
      streamController.close()
    }
    await pending

    expect(cancelled).toBe(true)
    expect(loads).toBe(0)
    expect(errors).toBe(0)
    expect(image.image).toBeNull()
    expect(image.loading).toBe(false)
  })

  it("does not start an image load for an abandoned render", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({}))

    function BrokenSibling(): never {
      throw new Error("abandon image render")
    }

    testSetup = await testRender(
      <>
        <image source={response} />
        <BrokenSibling />
      </>,
      { width: 4, height: 2 },
    )
    expect(consoleError).toHaveBeenCalledTimes(1)
    consoleError.mockClear()

    act(() => testSetup!.renderer.destroy())

    expect(response.bodyUsed).toBe(false)
  })
})
