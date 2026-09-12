import { afterEach, describe, expect, it } from "bun:test"
import { ImageRenderable } from "@opentui/core"
import { createSignal, Show } from "solid-js"
import { testRender } from "../index.js"

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==",
    "base64",
  ),
)

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

describe("image component", () => {
  it("creates an ImageRenderable and loads encoded bytes", async () => {
    let imageRef: ImageRenderable | undefined
    const loaded: string[] = []

    testSetup = await testRender(
      () => (
        <image
          ref={imageRef}
          source={PNG_1X1}
          onLoad={(image) => loaded.push(image.info().format)}
          style={{ width: 4, height: 2 }}
        />
      ),
      { width: 10, height: 6 },
    )
    await testSetup.renderOnce()

    expect(imageRef).toBeInstanceOf(ImageRenderable)
    await imageRef!.loadPromise
    expect(loaded).toEqual(["png"])
    expect(imageRef!.image?.width).toBe(1)
    expect(imageRef!.loadError).toBeNull()
  })

  it("replaces and clears the image when the source prop changes reactively", async () => {
    let imageRef: ImageRenderable | undefined
    const [source, setSource] = createSignal<Uint8Array | undefined>(PNG_1X1)

    testSetup = await testRender(
      () => <image ref={imageRef} source={source()} protocol="blocks" width={2} height={1} />,
      {
        width: 4,
        height: 2,
      },
    )
    await imageRef!.loadPromise
    await testSetup.renderOnce()
    const firstImage = imageRef!.image!
    expect(testSetup.captureCharFrame()).toContain("█")

    setSource(PNG_1X1.slice())
    await imageRef!.loadPromise
    await testSetup.renderOnce()
    const replacementImage = imageRef!.image!
    expect(replacementImage).not.toBe(firstImage)
    expect(() => firstImage.info()).toThrow("NativeImage is disposed")
    expect(testSetup.captureCharFrame()).toContain("█")

    setSource(undefined)
    await testSetup.renderOnce()
    expect(imageRef!.image).toBeNull()
    expect(() => replacementImage.info()).toThrow("NativeImage is disposed")
    expect(testSetup.captureCharFrame()).not.toContain("█")
  })

  it("restores image defaults when optional props are cleared", async () => {
    let imageRef: ImageRenderable | undefined
    const [fit, setFit] = createSignal<"fill" | undefined>("fill")
    const [protocol, setProtocol] = createSignal<"kitty" | undefined>("kitty")

    testSetup = await testRender(() => <image ref={imageRef} fit={fit()} protocol={protocol()} />, {
      width: 4,
      height: 2,
    })
    expect(imageRef!.fit).toBe("fill")
    expect(imageRef!.protocol).toBe("kitty")

    setFit(undefined)
    setProtocol(undefined)

    expect(imageRef!.fit).toBe("fit")
    expect(imageRef!.protocol).toBe("auto")
    expect(imageRef!.effectiveProtocol).toBe("blocks")
  })

  it("restores image defaults without clearing unrelated style keys", async () => {
    let imageRef: ImageRenderable | undefined
    const [configured, setConfigured] = createSignal(true)

    testSetup = await testRender(
      () => (
        <image
          ref={imageRef}
          style={configured() ? { fit: "fill" as const, protocol: "kitty" as const, visible: true, opacity: 0.5 } : {}}
        />
      ),
      { width: 4, height: 2 },
    )
    expect({
      fit: imageRef!.fit,
      protocol: imageRef!.protocol,
      visible: imageRef!.visible,
      opacity: imageRef!.opacity,
    }).toEqual({ fit: "fill", protocol: "kitty", visible: true, opacity: 0.5 })

    setConfigured(false)

    expect({
      fit: imageRef!.fit,
      protocol: imageRef!.protocol,
      visible: imageRef!.visible,
      opacity: imageRef!.opacity,
    }).toEqual({ fit: "fit", protocol: "auto", visible: true, opacity: 0.5 })
  })

  it("cancels a pending image load when its component unmounts", async () => {
    let imageRef: ImageRenderable | undefined
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
    const [visible, setVisible] = createSignal(true)

    testSetup = await testRender(
      () => (
        <Show when={visible()}>
          <image ref={imageRef} source={response} onLoad={() => loads++} onError={() => errors++} />
        </Show>
      ),
      { width: 4, height: 2 },
    )
    const image = imageRef!
    const pending = image.loadPromise!

    setVisible(false)
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
})
