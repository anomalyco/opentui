import { test, expect, afterEach, spyOn } from "bun:test"
import { Writable } from "stream"
import { setImmediate } from "node:timers/promises"
import {
  createCliRenderer as createRenderer,
  CliRenderer,
  CliRenderEvents,
  type CliRendererConfig,
} from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { ImageRenderable } from "../renderables/Image.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin, TestWriteStream } from "../testing/test-streams.js"
import { NativeSessionRenderStatus } from "../zig.js"

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==",
    "base64",
  ),
)

// Copy published bytes so assertions remain valid after native output is released.
class CollectingWriteStream extends TestWriteStream {
  public readonly writes: Buffer[] = []
  public holdWrites = false
  public pendingWrite: (() => void) | undefined

  override _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    // The Session reuses its output storage after acknowledgement.
    const buf = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk.slice())
    this.writes.push(buf)
    if (this.holdWrites) {
      this.pendingWrite = callback
    } else {
      callback()
    }
  }

  getWrittenBytes(): Buffer {
    return Buffer.concat(this.writes)
  }

  clearWrites(): void {
    this.writes.length = 0
  }

  releaseWrites(): void {
    this.holdWrites = false
    const callback = this.pendingWrite
    this.pendingWrite = undefined
    callback?.()
  }
}

type CollectingStdout = CollectingWriteStream & NodeJS.WriteStream

function createCollectingStdout(columns = 80, rows = 24): CollectingStdout {
  return new CollectingWriteStream(columns, rows) as CollectingStdout
}

const outputRenderers = new WeakMap<NodeJS.WritableStream, CliRenderer>()
const renderers = new Set<CliRenderer>()

async function createCliRenderer(options: CliRendererConfig): Promise<CliRenderer> {
  const renderer = await createRenderer(options)
  renderers.add(renderer)
  if (options.stdout) outputRenderers.set(options.stdout, renderer)
  await renderer.nativeScene?.driver.idle()
  return renderer
}

async function flushWritable(stdout: NodeJS.WritableStream): Promise<void> {
  await outputRenderers.get(stdout)?.nativeScene?.driver.idle()
  return new Promise<void>((resolve, reject) => {
    stdout.write(Buffer.alloc(0), (error) => (error ? reject(error) : resolve()))
  })
}

function countPixelResolutionQueries(stdout: CollectingStdout): number {
  return (
    stdout
      .getWrittenBytes()
      .toString("binary")
      .match(/\x1b\[14t/g)?.length ?? 0
  )
}

function createPlainStdout(): NodeJS.WriteStream {
  return new Writable({
    write(_c, _e, cb) {
      cb()
    },
  }) as NodeJS.WriteStream
}

function createRetryRenderer(stdoutBacked = false): { renderer: CliRenderer; clock: ManualClock } {
  const clock = new ManualClock()
  const renderer = new CliRenderer(
    createTestStdin(),
    stdoutBacked ? createCollectingStdout() : createPlainStdout(),
    80,
    24,
    {
      consoleMode: "disabled",
      bufferedOutput: stdoutBacked ? undefined : "memory",
      clock,
    },
  )
  clock.runAll()
  destroyFns.push(() => renderer.destroy())
  renderers.add(renderer)
  return { renderer, clock }
}

function mockNativeRender(renderer: CliRenderer, render: () => NativeSessionRenderStatus): void {
  const driver = renderer.nativeScene.driver
  const originalRender = driver.render.bind(driver)
  driver.render = (...args) => {
    const status = render()
    return status === NativeSessionRenderStatus.Presented ? originalRender(...args) : status
  }
  destroyFns.unshift(() => {
    driver.render = originalRender
  })
}

function deferOutputIdle(renderer: CliRenderer): {
  resolve: () => Promise<void>
  hold: () => void
  calls: () => number
} {
  const driver = renderer.nativeScene.driver
  const originalIdle = driver.idle.bind(driver)
  let pending: ReturnType<typeof Promise.withResolvers<void>> | undefined
  let released = false
  let calls = 0
  driver.idle = () => {
    calls++
    if (released) return originalIdle()
    pending ??= Promise.withResolvers<void>()
    return pending.promise
  }
  destroyFns.unshift(() => {
    driver.idle = originalIdle
  })
  return {
    resolve: async () => {
      released = true
      pending?.resolve()
      pending = undefined
      await Promise.resolve()
      await Promise.resolve()
    },
    hold: () => {
      released = false
    },
    calls: () => calls,
  }
}

function forceNativeSplitSkip(renderer: CliRenderer): () => void {
  const render = spyOn(renderer.nativeScene.driver, "renderSplit").mockImplementation(() => ({
    renderOffset: 0,
    status: NativeSessionRenderStatus.Skipped,
  }))
  return () => render.mockRestore()
}

async function finishRender(renderer: CliRenderer): Promise<void> {
  for (let turn = 0; turn < 64; turn++) {
    await setImmediate()
    if (renderer.getSchedulerState().isRendering) await (renderer as any).loop(true)
    if (!(renderer as any).cancelReadyFrame) return
  }
  throw new Error("Renderer did not finish ready work within 64 host turns")
}

async function waitForHeldOutput(stdout: CollectingStdout): Promise<void> {
  for (let turn = 0; turn < 64 && !stdout.pendingWrite; turn++) {
    await setImmediate()
  }
  expect(stdout.pendingWrite).toBeDefined()
}

let destroyFns: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const fn of destroyFns) {
    try {
      await fn()
    } catch (e) {
      console.error("cleanup error:", e)
    }
  }
  destroyFns = []
  for (const renderer of renderers) {
    renderer.destroy()
    await renderer.closed
  }
  renderers.clear()
})

// ---- Byte-routing behavior ----

test("non-process stdout: rendered bytes flow to the custom Writable", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
  })
  destroyFns.push(() => renderer.destroy())

  await flushWritable(stdout)

  const received = stdout.getWrittenBytes()
  expect(received.length).toBeGreaterThan(0)
  // ANSI escape sequences contain ESC (0x1b).
  expect(received.includes(0x1b)).toBe(true)
})

test("auto images use detected Kitty graphics and delete cleared placements", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 4)
  const renderer = await createCliRenderer({ stdin, stdout })
  destroyFns.push(() => renderer.destroy())
  await flushWritable(stdout)
  stdout.clearWrites()

  stdin.emit("data", Buffer.from("\x1b_Gi=31337;OK\x1b\\"))
  const image = new ImageRenderable(renderer, {
    source: PNG_1X1,
    protocol: "auto",
    position: "absolute",
    width: 2,
    height: 1,
  })
  renderer.root.add(image)
  await image.loadPromise
  renderer.requestRender()
  await renderer.idle()
  await flushWritable(stdout)

  expect(renderer.capabilities?.kitty_graphics).toBe(true)
  expect(stdout.getWrittenBytes().toString("binary")).toContain("\x1b_G")

  stdout.clearWrites()
  image.source = undefined
  await renderer.idle()
  await flushWritable(stdout)
  expect(stdout.getWrittenBytes().toString("binary")).toContain("a=d")
})

test("auto images use detected Sixel when pixel resolution is available", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 4)
  const renderer = await createCliRenderer({ stdin, stdout })
  destroyFns.push(() => renderer.destroy())
  await flushWritable(stdout)
  stdout.clearWrites()

  stdin.emit("data", Buffer.from("\x1b[?1;4c\x1b[4;80;80t"))
  const image = new ImageRenderable(renderer, {
    source: PNG_1X1,
    protocol: "auto",
    position: "absolute",
    width: 2,
    height: 1,
  })
  renderer.root.add(image)
  await image.loadPromise
  renderer.requestRender()
  await renderer.idle()
  await flushWritable(stdout)

  expect(renderer.capabilities?.sixel).toBe(true)
  expect(renderer.resolution).toEqual({ width: 80, height: 80 })
  expect(stdout.getWrittenBytes().toString("binary")).toContain("\x1bP0;1;0q")
})

test("oversized pixel resolution replies leave images on block fallback", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 4)
  const renderer = await createCliRenderer({ stdin, stdout })
  destroyFns.push(() => renderer.destroy())
  const image = new ImageRenderable(renderer, {
    source: PNG_1X1,
    protocol: "sixel",
    position: "absolute",
    width: 8,
    height: 4,
    fit: "fill",
  })
  renderer.root.add(image)
  await image.loadPromise

  stdin.emit("data", Buffer.from("\x1b[4;4294967295;4294967295t"))
  await renderer.idle()
  await flushWritable(stdout)

  expect(renderer.resolution).toBeNull()
  expect(image.effectiveProtocol).toBe("blocks")
  expect(stdout.getWrittenBytes().toString("utf8")).toContain("█")
})

test("Sixel placements beyond native image limits use block fallback", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 4)
  const renderer = await createCliRenderer({ stdin, stdout })
  destroyFns.push(() => renderer.destroy())
  const image = new ImageRenderable(renderer, {
    source: PNG_1X1,
    protocol: "sixel",
    position: "absolute",
    width: 8,
    height: 4,
    fit: "fill",
  })
  renderer.root.add(image)
  await image.loadPromise

  stdin.emit("data", Buffer.from("\x1b[4;20000;20000t"))
  await renderer.idle()
  await flushWritable(stdout)

  expect(renderer.resolution).toEqual({ width: 20000, height: 20000 })
  expect(stdout.getWrittenBytes().toString("binary")).not.toContain("\x1bP0;1;0q")
  expect(stdout.getWrittenBytes().toString("utf8")).toContain("█")
})

test("resized images wait for the new pixel resolution before using Sixel", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 4)
  const renderer = await createCliRenderer({ stdin, stdout })
  destroyFns.push(() => renderer.destroy())

  stdin.emit("data", Buffer.from("\x1b[4;80;80t"))
  const image = new ImageRenderable(renderer, {
    source: PNG_1X1,
    protocol: "sixel",
    position: "absolute",
    width: 2,
    height: 1,
    fit: "fill",
  })
  renderer.root.add(image)
  await image.loadPromise
  renderer.requestRender()
  await renderer.idle()
  await flushWritable(stdout)
  expect(image.effectiveProtocol).toBe("sixel")
  expect(stdout.getWrittenBytes().toString("binary")).toContain('0;1;0q"1;1;20;20')

  stdout.clearWrites()
  renderer.resize(16, 4)
  await renderer.idle()
  await flushWritable(stdout)

  const pendingOutput = stdout.getWrittenBytes().toString("binary")
  expect(pendingOutput).toContain("\x1b[14t")
  expect(pendingOutput).not.toContain('0;1;0q"1;1;10;20')
  expect(renderer.resolution).toBeNull()
  expect(image.effectiveProtocol).toBe("blocks")
  expect(pendingOutput).not.toContain("\x1bP0;1;0q")
  expect(stdout.getWrittenBytes().toString("utf8")).toContain("█")

  stdout.clearWrites()
  stdin.emit("data", Buffer.from("\x1b[4;80;160t"))
  await renderer.idle()
  await flushWritable(stdout)

  expect(renderer.resolution).toEqual({ width: 160, height: 80 })
  expect(image.effectiveProtocol).toBe("sixel")
  expect(stdout.getWrittenBytes().toString("binary")).toContain('0;1;0q"1;1;20;20')
})

test("split-footer Kitty scrollback does not rasterize images to terminal pixel dimensions", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 60)
  const renderer = await createCliRenderer({
    stdin,
    stdout,
    screenMode: "split-footer",
    footerHeight: 12,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  destroyFns.push(() => renderer.destroy())

  stdin.emit("data", Buffer.from("\x1b[4;4320;7680t\x1b_Gi=31337;OK\x1b\\\x1b[48;1R"))
  await renderer.idle()
  await flushWritable(stdout)
  stdout.clearWrites()

  const surface = renderer.createScrollbackSurface({ startOnNewLine: true })
  const image = new ImageRenderable(surface.renderContext, {
    source: PNG_1X1,
    protocol: "auto",
    width: 80,
    height: 48,
    fit: "fill",
  })
  surface.root.add(image)
  await image.loadPromise
  surface.render()
  surface.commitRows(0, surface.height)
  surface.destroy()

  stdout.write("after-image\n")
  await renderer.idle()
  await flushWritable(stdout)

  const output = stdout.getWrittenBytes().toString("binary")
  expect(output).toContain("\x1b_Ga=t")
  expect(output).toContain("a=t,f=100")
  expect(output).toContain("c=80,r=48")
  expect(output).toContain("after-image")
})

test("split-footer queues native image scrollback until the footer is pinned", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 6)
  const renderer = await createCliRenderer({
    stdin,
    stdout,
    screenMode: "split-footer",
    footerHeight: 3,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  destroyFns.push(() => renderer.destroy())
  await flushWritable(stdout)
  stdout.clearWrites()

  const surface = renderer.createScrollbackSurface({ startOnNewLine: true })
  const image = new ImageRenderable(surface.renderContext, {
    source: PNG_1X1,
    protocol: "kitty",
    width: 1,
    height: 1,
  })
  surface.root.add(image)
  await image.loadPromise
  surface.render()
  surface.commitRows(0, surface.height)
  surface.destroy()
  await renderer.idle()
  await flushWritable(stdout)

  expect(stdout.getWrittenBytes()).toHaveLength(0)

  stdin.emit("data", Buffer.from("\x1b[3;1R"))
  await renderer.idle()
  await flushWritable(stdout)

  expect(stdout.getWrittenBytes().toString("binary")).toContain("\x1b_Ga=t")
  expect(stdout.getWrittenBytes().toString("utf8")).not.toContain("█")
})

test("split-footer scrollback uses blocks for mixed protocols and overlapping images", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 6)
  const renderer = await createCliRenderer({
    stdin,
    stdout,
    screenMode: "split-footer",
    footerHeight: 3,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  destroyFns.push(() => renderer.destroy())

  stdin.emit("data", Buffer.from("\x1b[?1;4c\x1b[4;6;8t\x1b_Gi=31337;OK\x1b\\\x1b[3;1R"))
  await renderer.idle()
  await flushWritable(stdout)
  stdout.clearWrites()

  const commitImages = async (images: Array<{ protocol: "kitty" | "sixel"; left?: number }>) => {
    const surface = renderer.createScrollbackSurface({ startOnNewLine: true })
    const renderables = images.map(
      ({ protocol, left }) =>
        new ImageRenderable(surface.renderContext, {
          source: PNG_1X1,
          protocol,
          position: "absolute",
          left,
          width: 1,
          height: 1,
        }),
    )
    for (const image of renderables) surface.root.add(image)
    await Promise.all(renderables.map((image) => image.loadPromise))
    surface.render()
    surface.commitRows(0, surface.height)
    surface.destroy()
    await renderer.idle()
    await flushWritable(stdout)
  }

  await commitImages([
    { protocol: "kitty", left: 0 },
    { protocol: "sixel", left: 1 },
  ])

  let output = stdout.getWrittenBytes().toString("binary")
  expect(output).not.toContain("\x1b_G")
  expect(output).not.toContain("\x1bP0;1;0q")
  expect(stdout.getWrittenBytes().toString("utf8")).toContain("█")

  stdout.clearWrites()
  await commitImages([{ protocol: "kitty" }, { protocol: "kitty" }])

  output = stdout.getWrittenBytes().toString("binary")
  expect(output).not.toContain("\x1b_G")
  expect(output).not.toContain("\x1bP0;1;0q")
  expect(stdout.getWrittenBytes().toString("utf8")).toContain("█")
})

test("ScrollbackSurface rejects stale image geometry after a height-only resize", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 12)
  const renderer = await createCliRenderer({
    stdin,
    stdout,
    screenMode: "split-footer",
    footerHeight: 3,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  destroyFns.push(() => renderer.destroy())

  stdin.emit("data", Buffer.from("\x1b[?1;4c\x1b[4;80;80t\x1b[9;1R"))
  await renderer.idle()

  const surface = renderer.createScrollbackSurface({ startOnNewLine: true })
  const image = new ImageRenderable(surface.renderContext, {
    source: PNG_1X1,
    protocol: "auto",
    width: 1,
    height: 1,
    fit: "fill",
  })
  surface.root.add(image)
  await image.loadPromise
  surface.render()

  renderer.resize(8, 6)
  stdin.emit("data", Buffer.from("\x1b[4;80;80t"))
  expect(() => surface.commitRows(0, surface.height)).toThrow(
    "ScrollbackSurface.commitRows requires render() after renderer geometry changes",
  )

  surface.render()
  surface.commitRows(0, surface.height)
  surface.destroy()
  await renderer.idle()
  await flushWritable(stdout)

  expect(stdout.getWrittenBytes().toString("binary")).toContain('0;1;0q"1;1;10;13')
})

test("ScrollbackSurface rejects stale image geometry after pixel resolution arrives", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 6)
  const renderer = await createCliRenderer({
    stdin,
    stdout,
    screenMode: "split-footer",
    footerHeight: 3,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  destroyFns.push(() => renderer.destroy())

  stdin.emit("data", Buffer.from("\x1b[?1;4c\x1b[3;1R"))
  await renderer.idle()

  const surface = renderer.createScrollbackSurface({ startOnNewLine: true })
  const image = new ImageRenderable(surface.renderContext, {
    source: PNG_1X1,
    protocol: "auto",
    width: 1,
    height: 1,
    fit: "fill",
  })
  surface.root.add(image)
  await image.loadPromise
  surface.render()

  stdin.emit("data", Buffer.from("\x1b[4;80;80t"))
  expect(() => surface.commitRows(0, surface.height)).toThrow(
    "ScrollbackSurface.commitRows requires render() after renderer geometry changes",
  )

  surface.render()
  surface.commitRows(0, surface.height)
  surface.destroy()
  await renderer.idle()
  await flushWritable(stdout)

  expect(stdout.getWrittenBytes().toString("binary")).toContain('0;1;0q"1;1;10;13')
})

test("tall scrollback surfaces composite translucent Sixel images over snapshot backgrounds", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 6)
  const renderer = await createCliRenderer({
    stdin,
    stdout,
    screenMode: "split-footer",
    footerHeight: 3,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  destroyFns.push(() => renderer.destroy())

  stdin.emit("data", Buffer.from("\x1b[?1;4c\x1b[4;6;8t\x1b[3;1R"))
  await renderer.idle()
  await flushWritable(stdout)
  stdout.clearWrites()

  const surface = renderer.createScrollbackSurface({ startOnNewLine: true })
  const background = new BoxRenderable(surface.renderContext, {
    width: 1,
    height: 5,
    backgroundColor: "#0000ff",
  })
  const image = new ImageRenderable(surface.renderContext, {
    source: PNG_1X1,
    protocol: "auto",
    position: "absolute",
    left: 0,
    top: 4,
    width: 1,
    height: 1,
    fit: "fill",
    opacity: 0.5,
  })
  background.add(image)
  surface.root.add(background)
  await image.loadPromise
  surface.render()
  surface.commitRows(0, surface.height)
  surface.destroy()
  await renderer.idle()
  await flushWritable(stdout)

  expect(stdout.getWrittenBytes().toString("binary")).toContain("#0;2;50;0;50")
})

for (const testCase of [
  {
    name: "Kitty",
    capabilities: "\x1b[4;6;8t\x1b_Gi=31337;OK\x1b\\\x1b[3;1R",
    placement: "\x1b_Ga=p",
  },
  {
    name: "Sixel",
    capabilities: "\x1b[?1;4c\x1b[4;6;8t\x1b[3;1R",
    placement: "\x1bP0;1;0q",
  },
]) {
  test(`pinned split-footer appends repaint unchanged live ${testCase.name} images`, async () => {
    const stdin = createTestStdin()
    const stdout = createCollectingStdout(8, 6)
    const renderer = await createCliRenderer({
      stdin,
      stdout,
      screenMode: "split-footer",
      footerHeight: 3,
      externalOutputMode: "capture-stdout",
      consoleMode: "disabled",
    })
    destroyFns.push(() => renderer.destroy())

    stdin.emit("data", Buffer.from(testCase.capabilities))
    const image = new ImageRenderable(renderer, {
      source: PNG_1X1,
      protocol: "auto",
      position: "absolute",
      left: 0,
      top: 0,
      width: 1,
      height: 1,
      fit: "fill",
    })
    renderer.root.add(image)
    await image.loadPromise
    renderer.requestRender()
    await renderer.idle()
    await flushWritable(stdout)
    stdout.clearWrites()

    const appended = `pin${testCase.name[0]}`
    stdout.write(`${appended}\n`)
    renderer.requestRender()
    await renderer.idle()
    await flushWritable(stdout)

    const output = stdout.getWrittenBytes().toString("binary")
    const appendIndex = output.indexOf(appended)
    const placementIndex = output.indexOf(testCase.placement)
    expect(output).toContain(appended)
    expect(placementIndex).toBeGreaterThan(appendIndex)
  })
}

test("split-footer custom stdout: native bytes bypass stdout capture", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    screenMode: "split-footer",
    consoleMode: "disabled",
  })
  destroyFns.push(() => renderer.destroy())

  stdout.clearWrites()

  renderer.setTerminalTitle("split-footer custom stdout")

  // Renderer-owned ANSI must go straight to the sink, not back through the
  // split-footer stdout-capture queue.
  expect((renderer as any).externalOutputQueue.size).toBe(0)

  await flushWritable(stdout)

  expect(stdout.getWrittenBytes().toString("binary")).toContain("\x1b]0;split-footer custom stdout\x07")
})

test("custom stdout resetTerminalBgColor routes through configured stdout", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    consoleMode: "disabled",
  })
  destroyFns.push(() => renderer.destroy())

  stdout.clearWrites()
  renderer.resetTerminalBgColor()

  await flushWritable(stdout)

  expect(stdout.getWrittenBytes().toString("binary")).toContain("\x1b]111\x07")
})

test("resize ignores an outstanding pixel resolution reply", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 4)
  const renderer = await createCliRenderer({ stdin, stdout })
  destroyFns.push(() => renderer.destroy())
  await flushWritable(stdout)
  expect(countPixelResolutionQueries(stdout)).toBe(1)
  stdout.clearWrites()

  renderer.resize(16, 4)
  renderer.resize(24, 4)
  await flushWritable(stdout)
  expect(stdout.getWrittenBytes().toString("binary")).not.toContain("\x1b[14t")

  stdin.emit("data", Buffer.from("\x1b[4;80;80t"))
  expect(renderer.resolution).toBeNull()
  await flushWritable(stdout)
  expect(countPixelResolutionQueries(stdout)).toBe(1)

  stdout.clearWrites()
  stdin.emit("data", Buffer.from("\x1b[4;80;240t"))
  await renderer.idle()

  expect(renderer.resolution).toEqual({ width: 240, height: 80 })
  expect(stdout.getWrittenBytes().toString("binary")).not.toContain("\x1b[14t")
})

test("resize while suspended refreshes pixel resolution after resume", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 4)
  const renderer = await createCliRenderer({ stdin, stdout })
  destroyFns.push(() => renderer.destroy())
  await flushWritable(stdout)
  expect(countPixelResolutionQueries(stdout)).toBe(1)
  stdout.clearWrites()
  stdin.emit("data", Buffer.from("\x1b[4;80;80t"))
  await renderer.idle()
  expect(renderer.resolution).toEqual({ width: 80, height: 80 })

  await renderer.suspend()
  stdout.clearWrites()
  renderer.resize(16, 4)
  renderer.resize(24, 4)
  await flushWritable(stdout)
  expect(stdout.getWrittenBytes().toString("binary")).not.toContain("\x1b[14t")
  stdout.clearWrites()

  await renderer.resume()
  await flushWritable(stdout)
  expect(renderer.resolution).toBeNull()
  expect(countPixelResolutionQueries(stdout)).toBe(1)

  stdin.emit("data", Buffer.from("\x1b[4;80;240t"))
  await renderer.idle()
  expect(renderer.resolution).toEqual({ width: 240, height: 80 })
})

test("resume rejects a delayed pre-suspend pixel resolution reply", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 4)
  const renderer = await createCliRenderer({ stdin, stdout })
  destroyFns.push(() => renderer.destroy())
  await flushWritable(stdout)
  expect(countPixelResolutionQueries(stdout)).toBe(1)
  stdout.clearWrites()

  await renderer.suspend()
  renderer.resize(16, 4)
  await renderer.resume()
  await flushWritable(stdout)
  expect(stdout.getWrittenBytes().toString("binary")).not.toContain("\x1b[14t")

  stdout.clearWrites()
  stdin.emit("data", Buffer.from("\x1b[4;80;80t"))
  expect(renderer.resolution).toBeNull()
  await flushWritable(stdout)
  expect(countPixelResolutionQueries(stdout)).toBe(1)

  stdout.clearWrites()
  stdin.emit("data", Buffer.from("\x1b[4;80;160t"))
  await renderer.idle()

  expect(renderer.resolution).toEqual({ width: 160, height: 80 })
  expect(stdout.getWrittenBytes().toString("binary")).not.toContain("\x1b[14t")
})

test("resume preserves an outstanding pixel resolution query without requerying", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 4)
  const renderer = await createCliRenderer({ stdin, stdout })
  destroyFns.push(() => renderer.destroy())
  await flushWritable(stdout)
  expect(countPixelResolutionQueries(stdout)).toBe(1)
  stdout.clearWrites()

  await renderer.suspend()
  await renderer.resume()
  await flushWritable(stdout)
  expect(stdout.getWrittenBytes().toString("binary")).not.toContain("\x1b[14t")

  stdin.emit("data", Buffer.from("\x1b[4;80;80t"))
  await renderer.idle()
  expect(renderer.resolution).toEqual({ width: 80, height: 80 })
})

test("resume preserves an incomplete pixel resolution response buffered while suspended", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 4)
  const renderer = await createCliRenderer({ stdin, stdout })
  const keypresses: string[] = []
  renderer.keyInput.on("keypress", (event) => keypresses.push(event.raw))
  destroyFns.push(() => renderer.destroy())
  await flushWritable(stdout)
  expect(countPixelResolutionQueries(stdout)).toBe(1)
  stdout.clearWrites()

  await renderer.suspend()
  renderer.resize(16, 4)
  stdin.push(Buffer.from("\x1b[4;80"))
  await renderer.resume()
  await flushWritable(stdout)
  expect(countPixelResolutionQueries(stdout)).toBe(0)

  stdin.emit("data", Buffer.from(";80t"))
  expect(renderer.resolution).toBeNull()
  await flushWritable(stdout)
  expect(keypresses).toEqual([])
  expect(countPixelResolutionQueries(stdout)).toBe(1)

  stdin.emit("data", Buffer.from("\x1b[4;80;160t"))
  await renderer.idle()
  expect(renderer.resolution).toEqual({ width: 160, height: 80 })
})

test("resume does not join a pre-suspend escape to post-resume input", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 4)
  const renderer = await createCliRenderer({ stdin, stdout })
  const keypresses: Array<{ name: string; raw: string; meta: boolean }> = []
  renderer.keyInput.on("keypress", (event) => {
    keypresses.push({ name: event.name, raw: event.raw, meta: event.meta })
  })
  destroyFns.push(() => renderer.destroy())

  await flushWritable(stdout)
  expect(countPixelResolutionQueries(stdout)).toBe(1)
  stdout.clearWrites()

  stdin.emit("data", Buffer.from("\x1b"))
  await renderer.suspend()
  await renderer.resume()
  stdin.emit("data", Buffer.from("a"))

  expect(keypresses).toEqual([{ name: "a", raw: "a", meta: false }])
  expect(renderer.resolution).toBeNull()
  await flushWritable(stdout)
  expect(countPixelResolutionQueries(stdout)).toBe(0)

  stdin.emit("data", Buffer.from("\x1b[4;80;80t"))
  await renderer.idle()
  expect(keypresses).toEqual([{ name: "a", raw: "a", meta: false }])
  expect(renderer.resolution).toEqual({ width: 80, height: 80 })
})

test("resume does not join a partial pixel response to post-resume input", async () => {
  const response = Buffer.from("\x1b[4;80;80t")

  for (let split = 2; split < response.length; split++) {
    const stdin = createTestStdin()
    const stdout = createCollectingStdout(8, 4)
    const renderer = await createCliRenderer({ stdin, stdout })
    const keypresses: Array<{ name: string; raw: string; meta: boolean }> = []
    renderer.keyInput.on("keypress", (event) => {
      keypresses.push({ name: event.name, raw: event.raw, meta: event.meta })
    })

    try {
      await flushWritable(stdout)
      expect(countPixelResolutionQueries(stdout)).toBe(1)
      stdout.clearWrites()

      stdin.emit("data", response.subarray(0, split))
      await renderer.suspend()
      await renderer.resume()
      stdin.emit("data", Buffer.from("a"))

      expect({ split, keypresses }).toEqual({
        split,
        keypresses: [{ name: "a", raw: "a", meta: false }],
      })
      expect(renderer.resolution).toBeNull()
      await flushWritable(stdout)
      expect(countPixelResolutionQueries(stdout)).toBe(0)

      stdin.emit("data", response)
      await renderer.idle()
      expect(keypresses).toEqual([{ name: "a", raw: "a", meta: false }])
      expect(renderer.resolution).toEqual({ width: 80, height: 80 })
    } finally {
      renderer.destroy()
      await renderer.closed
    }
  }
})

test("resume preserves chunked escape input after a suspended pixel prefix", async () => {
  for (const chunks of [["\x1b[A"], ["\x1b[", "A"]]) {
    const stdin = createTestStdin()
    const stdout = createCollectingStdout(8, 4)
    const renderer = await createCliRenderer({ stdin, stdout })
    const keypresses: Array<{ name: string; raw: string }> = []
    renderer.keyInput.on("keypress", (event) => {
      keypresses.push({ name: event.name, raw: event.raw })
    })

    try {
      await flushWritable(stdout)
      stdin.emit("data", Buffer.from("\x1b"))
      await renderer.suspend()
      await renderer.resume()
      for (const chunk of chunks) stdin.emit("data", Buffer.from(chunk))

      expect({ chunks, keypresses }).toEqual({
        chunks,
        keypresses: [{ name: "up", raw: "\x1b[A" }],
      })

      stdin.emit("data", Buffer.from("\x1b[4;80;80t"))
      await renderer.idle()
      expect(renderer.resolution).toEqual({ width: 80, height: 80 })
    } finally {
      renderer.destroy()
      await renderer.closed
    }
  }
})

test("resume separates suspended escape input from a pixel resolution response", async () => {
  for (const timing of ["before-resume", "after-resume", "after-suspended-escape"] as const) {
    const stdin = createTestStdin()
    const stdout = createCollectingStdout(8, 4)
    const renderer = await createCliRenderer({ stdin, stdout })
    const keypresses: string[] = []
    renderer.keyInput.on("keypress", (event) => keypresses.push(event.raw))

    try {
      await flushWritable(stdout)
      expect(countPixelResolutionQueries(stdout)).toBe(1)
      stdout.clearWrites()

      stdin.emit("data", Buffer.from("\x1b"))
      await renderer.suspend()
      if (timing === "before-resume") stdin.push(Buffer.from("\x1b[4;80;80t"))
      if (timing === "after-suspended-escape") stdin.push(Buffer.from("\x1b"))
      await renderer.resume()
      if (timing === "after-resume") stdin.emit("data", Buffer.from("\x1b[4;80;80t"))
      if (timing === "after-suspended-escape") {
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
        stdin.emit("data", Buffer.from("\x1b[4;80;80t"))
      }
      await renderer.idle()

      expect({
        timing,
        keypresses,
        resolution: renderer.resolution,
        queryCount: countPixelResolutionQueries(stdout),
      }).toEqual({
        timing,
        keypresses: [],
        resolution: { width: 80, height: 80 },
        queryCount: 0,
      })
    } finally {
      renderer.destroy()
      await renderer.closed
    }
  }
})

test("resume preserves every pixel resolution response split across suspension", async () => {
  const staleResponse = Buffer.from("\x1b[4;80;80t")

  for (let split = 1; split < staleResponse.length; split++) {
    const stdin = createTestStdin()
    const stdout = createCollectingStdout(8, 4)
    const renderer = await createCliRenderer({ stdin, stdout })
    const keypresses: string[] = []
    renderer.keyInput.on("keypress", (event) => keypresses.push(event.raw))

    try {
      await flushWritable(stdout)
      expect(countPixelResolutionQueries(stdout)).toBe(1)
      stdout.clearWrites()

      stdin.emit("data", staleResponse.subarray(0, split))
      await renderer.suspend()
      renderer.resize(16, 4)
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
      stdin.push(staleResponse.subarray(split))
      await renderer.resume()
      await flushWritable(stdout)

      expect(keypresses).toEqual([])
      expect(renderer.resolution).toBeNull()
      expect({
        split,
        queryCount: countPixelResolutionQueries(stdout),
      }).toEqual({ split, queryCount: 1 })

      stdout.clearWrites()
      stdin.emit("data", Buffer.from("\x1b[4;80;160t"))
      await renderer.idle()
      expect(renderer.resolution).toEqual({ width: 160, height: 80 })
      expect(stdout.getWrittenBytes().toString("binary")).not.toContain("\x1b[14t")
    } finally {
      renderer.destroy()
      await renderer.closed
    }
  }
})

test("Session-backed renderer retries one skipped frame after Session idle", async () => {
  const { renderer, clock } = createRetryRenderer(true)
  const idle = deferOutputIdle(renderer)
  let calls = 0
  let frames = 0
  mockNativeRender(renderer, () =>
    calls++ === 0 ? NativeSessionRenderStatus.Skipped : NativeSessionRenderStatus.Presented,
  )
  renderer.on(CliRenderEvents.FRAME, () => frames++)

  await (renderer as any).loop()
  expect(calls).toBe(1)
  expect(frames).toBe(0)
  expect(idle.calls()).toBe(1)

  await idle.resolve()
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(true)
  clock.advance(17)
  await finishRender(renderer)

  expect(calls).toBe(2)
  expect(frames).toBe(1)
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
})

test("Session-backed renderer retries immediately when output pressure outlasts the frame interval", async () => {
  const { renderer, clock } = createRetryRenderer(true)
  const idle = deferOutputIdle(renderer)
  let calls = 0
  mockNativeRender(renderer, () =>
    calls++ === 0 ? NativeSessionRenderStatus.Skipped : NativeSessionRenderStatus.Presented,
  )

  await (renderer as any).loop()
  clock.advance(100)
  await idle.resolve()
  clock.advance(0)

  await finishRender(renderer)
  expect(calls).toBe(2)
})

test("Session-backed renderer coalesces requests while waiting for Session idle", async () => {
  const { renderer, clock } = createRetryRenderer(true)
  const idle = deferOutputIdle(renderer)
  const observed: number[] = []
  let state = 1
  let calls = 0
  renderer.setFrameCallback(async () => {
    observed.push(state)
  })
  mockNativeRender(renderer, () =>
    calls++ === 0 ? NativeSessionRenderStatus.Skipped : NativeSessionRenderStatus.Presented,
  )

  await (renderer as any).loop()
  state = 2
  renderer.requestRender()
  renderer.requestRender()
  renderer.requestRender()
  expect(calls).toBe(1)

  await idle.resolve()
  clock.advance(17)
  await finishRender(renderer)

  expect(calls).toBe(2)
  expect(observed).toEqual([1, 2])
})

test("starting a Session-backed renderer waits for a skipped frame's Session idle", async () => {
  const { renderer, clock } = createRetryRenderer(true)
  const idle = deferOutputIdle(renderer)
  let calls = 0
  mockNativeRender(renderer, () =>
    calls++ === 0 ? NativeSessionRenderStatus.Skipped : NativeSessionRenderStatus.Presented,
  )

  await (renderer as any).loop()
  renderer.start()

  expect(renderer.isRunning).toBe(true)
  clock.advance(100)
  expect(calls).toBe(1)

  await idle.resolve()
  clock.advance(0)

  await finishRender(renderer)
  expect(calls).toBe(2)
  expect(renderer.isRunning).toBe(true)
  renderer.pause()
})

test("Session-backed renderer waits for each repeated skip", async () => {
  const { renderer, clock } = createRetryRenderer(true)
  const firstIdle = deferOutputIdle(renderer)
  let calls = 0
  mockNativeRender(renderer, () =>
    calls++ < 2 ? NativeSessionRenderStatus.Skipped : NativeSessionRenderStatus.Presented,
  )

  await (renderer as any).loop()
  await firstIdle.resolve()
  firstIdle.hold()
  clock.advance(17)
  await finishRender(renderer)
  expect(calls).toBe(2)
  expect(firstIdle.calls()).toBe(2)

  await firstIdle.resolve()
  clock.advance(17)
  await finishRender(renderer)
  expect(calls).toBe(3)
})

test("native failure does not retry and recovers on a later render request", async () => {
  const { renderer, clock } = createRetryRenderer()
  const originalError = console.error
  const errors: unknown[][] = []
  console.error = (...args: unknown[]) => errors.push(args)
  destroyFns.unshift(() => {
    console.error = originalError
  })
  let calls = 0
  let frames = 0
  mockNativeRender(renderer, () =>
    calls++ === 0 ? NativeSessionRenderStatus.Failed : NativeSessionRenderStatus.Presented,
  )
  renderer.on(CliRenderEvents.FRAME, () => frames++)

  await (renderer as any).loop()
  clock.advance(1000)
  expect(calls).toBe(1)
  expect(frames).toBe(0)
  expect(errors).toHaveLength(1)
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)

  renderer.intermediateRender()
  await finishRender(renderer)

  expect(calls).toBe(2)
  expect(frames).toBe(1)
})

test("running renderer recovers from native failure on a later render request", async () => {
  const { renderer, clock } = createRetryRenderer()
  const originalError = console.error
  console.error = () => {}
  destroyFns.unshift(() => {
    console.error = originalError
  })
  let calls = 0
  mockNativeRender(renderer, () =>
    calls++ === 0 ? NativeSessionRenderStatus.Failed : NativeSessionRenderStatus.Presented,
  )

  renderer.start()
  await finishRender(renderer)
  expect(calls).toBe(1)
  expect(renderer.isRunning).toBe(true)

  renderer.requestRender()
  clock.advance(17)

  await finishRender(renderer)
  expect(calls).toBe(2)
})

test("Session-backed native failure does not wait for Session idle or retry", async () => {
  const { renderer, clock } = createRetryRenderer(true)
  const idle = deferOutputIdle(renderer)
  const originalError = console.error
  console.error = () => {}
  destroyFns.unshift(() => {
    console.error = originalError
  })
  let calls = 0
  mockNativeRender(renderer, () => {
    calls++
    return NativeSessionRenderStatus.Failed
  })

  await (renderer as any).loop()
  clock.advance(1000)

  expect(calls).toBe(1)
  expect(idle.calls()).toBe(0)
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
})

for (const control of ["pause", "stop", "suspend", "destroy"] as const) {
  test(`${control} cancels an output-idle retry`, async () => {
    const { renderer, clock } = createRetryRenderer(true)
    if (control === "suspend") await renderer.setupTerminal()
    const idle = deferOutputIdle(renderer)
    let calls = 0
    mockNativeRender(renderer, () => {
      calls++
      return NativeSessionRenderStatus.Skipped
    })

    await (renderer as any).loop()
    await renderer[control]()
    await idle.resolve()
    clock.advance(17)

    await finishRender(renderer)
    expect(calls).toBe(1)
  })
}

for (const [control, state] of [
  ["pause", "paused"],
  ["stop", "stopped"],
] as const) {
  test(`one-shot render requested while ${state} retries after Session idle`, async () => {
    const { renderer, clock } = createRetryRenderer(true)
    const idle = deferOutputIdle(renderer)
    let calls = 0
    mockNativeRender(renderer, () =>
      calls++ === 0 ? NativeSessionRenderStatus.Skipped : NativeSessionRenderStatus.Presented,
    )

    renderer[control]()
    renderer.requestRender()
    clock.advance(17)
    await finishRender(renderer)
    expect(calls).toBe(1)

    await idle.resolve()
    clock.advance(17)

    await finishRender(renderer)
    expect(calls).toBe(2)
  })
}

test.each(["pause", "stop"] as const)(
  "a fresh request after %s() replaces a cancelled output-idle retry",
  async (control) => {
    const { renderer, clock } = createRetryRenderer(true)
    const idle = deferOutputIdle(renderer)
    let calls = 0
    mockNativeRender(renderer, () =>
      calls++ === 0 ? NativeSessionRenderStatus.Skipped : NativeSessionRenderStatus.Presented,
    )
    renderer.start()
    await finishRender(renderer)
    expect(calls).toBe(1)
    renderer[control]()
    renderer.requestRender()
    await idle.resolve()
    clock.advance(17)
    await finishRender(renderer)
    expect(calls).toBe(2)
    expect(renderer.isRunning).toBe(false)
  },
)

test.each(["pause", "stop"] as const)(
  "an older output-idle wait cannot cancel a newer %s() one-shot",
  async (control) => {
    const { renderer, clock } = createRetryRenderer(true)
    const idle = deferOutputIdle(renderer)
    const callback = Promise.withResolvers<void>()
    let calls = 0
    let callbacks = 0
    mockNativeRender(renderer, () =>
      calls++ < 2 ? NativeSessionRenderStatus.Skipped : NativeSessionRenderStatus.Presented,
    )
    renderer[control]()
    renderer.setFrameCallback(async () => {
      if (++callbacks === 2) await callback.promise
    })
    renderer.intermediateRender()
    await finishRender(renderer)
    expect(calls).toBe(1)
    renderer.intermediateRender()
    expect(callbacks).toBe(2)
    await idle.resolve()
    clock.advance(17)
    idle.hold()
    callback.resolve()
    await finishRender(renderer)
    expect(calls).toBe(2)
    await idle.resolve()
    clock.advance(17)
    await finishRender(renderer)
    expect(calls).toBe(3)
    expect(renderer.getStats().nativeFrameCount).toBe(1)
  },
)

test("cancelling a skipped frame with an immediate rerender request resolves idle", async () => {
  const { renderer } = createRetryRenderer(true)
  const idle = deferOutputIdle(renderer)
  renderer.setFrameCallback(async () => {
    renderer.requestRender()
  })
  mockNativeRender(renderer, () => NativeSessionRenderStatus.Skipped)

  await (renderer as any).loop()
  renderer.pause()
  const idlePromise = renderer.idle()

  await idle.resolve()
  await idlePromise
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
})

test("running renderer resumes after Session idle", async () => {
  const { renderer, clock } = createRetryRenderer(true)
  const idle = deferOutputIdle(renderer)
  let calls = 0
  mockNativeRender(renderer, () =>
    calls++ === 0 ? NativeSessionRenderStatus.Skipped : NativeSessionRenderStatus.Presented,
  )

  renderer.start()
  await finishRender(renderer)
  expect(calls).toBe(1)
  await idle.resolve()
  clock.advance(17)

  await finishRender(renderer)
  expect(calls).toBe(2)
  expect(renderer.isRunning).toBe(true)
  renderer.pause()
})

test("omitting stdin/stdout uses process streams", async () => {
  const renderer = await createCliRenderer({
    bufferedOutput: "memory",
  })
  expect(renderer.stdin).toBe(process.stdin)
  destroyFns.push(() => renderer.destroy())
})

test("custom stdout defaults to remote env behavior", async () => {
  const previous = process.env.OPENTUI_FORCE_WCWIDTH
  process.env.OPENTUI_FORCE_WCWIDTH = "1"

  try {
    const defaultRemoteRenderer = await createCliRenderer({
      stdin: createTestStdin(),
      stdout: createCollectingStdout(80, 24),
    })
    destroyFns.push(() => defaultRemoteRenderer.destroy())

    expect(defaultRemoteRenderer.widthMethod).toBe("unicode")

    const localRenderer = await createCliRenderer({
      stdin: createTestStdin(),
      stdout: createCollectingStdout(80, 24),
      remote: false,
    })
    destroyFns.push(() => localRenderer.destroy())

    expect(localRenderer.widthMethod).toBe("wcwidth")
  } finally {
    if (previous === undefined) {
      delete process.env.OPENTUI_FORCE_WCWIDTH
    } else {
      process.env.OPENTUI_FORCE_WCWIDTH = previous
    }
  }
})

test("Ghostty width profile reaches renderer-owned buffers", async () => {
  const previousTermProgram = process.env.TERM_PROGRAM
  const previousTermProgramVersion = process.env.TERM_PROGRAM_VERSION
  process.env.TERM_PROGRAM = "ghostty"
  process.env.TERM_PROGRAM_VERSION = "1.3.1"

  try {
    const renderer = new CliRenderer(createTestStdin(), createCollectingStdout(80, 24), 80, 24, {
      remote: false,
      forwardEnvKeys: ["TERM_PROGRAM", "TERM_PROGRAM_VERSION"],
    })
    destroyFns.push(() => renderer.destroy())
    renderers.add(renderer)

    await renderer.setupTerminal()
    expect(renderer.widthMethod).toBe("unicode-wide")
    expect(renderer.currentRenderBuffer.widthMethod).toBe("unicode-wide")
    expect(renderer.nextRenderBuffer.widthMethod).toBe("unicode-wide")
    const encoded = renderer.nextRenderBuffer.encodeUnicode("OpenCode search configuration പരിശോധിക്കൽ")
    expect(encoded).not.toBeNull()
    try {
      expect(encoded!.data.reduce((width, cell) => width + cell.width, 0)).toBe(40)
    } finally {
      if (encoded) renderer.nextRenderBuffer.freeUnicode(encoded)
    }

    await renderer.nativeScene!.driver.idle()
    renderer.resize(81, 24)
    expect(renderer.currentRenderBuffer.widthMethod).toBe("unicode-wide")
    expect(renderer.nextRenderBuffer.widthMethod).toBe("unicode-wide")
  } finally {
    if (previousTermProgram === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = previousTermProgram
    if (previousTermProgramVersion === undefined) delete process.env.TERM_PROGRAM_VERSION
    else process.env.TERM_PROGRAM_VERSION = previousTermProgramVersion
  }
})

// ---- Shutdown bytes reach the remote Writable (F1 regression test) ----

test("destroy emits shutdown ANSI sequence through the custom Writable", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
  })

  await flushWritable(stdout)
  stdout.clearWrites()

  renderer.destroy()

  await renderer.closed

  const shutdownBytes = stdout.getWrittenBytes().toString("binary")

  // Shutdown must reach the custom sink before the Session releases output.
  expect(shutdownBytes.length).toBeGreaterThan(0)
  expect(shutdownBytes).toContain("\x1b[?25h") // showCursor
})

test("destroy preserves accepted controls before terminal shutdown while a write is held", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)
  const renderer = await createCliRenderer({ stdin, stdout })
  destroyFns.push(() => stdout.releaseWrites())
  stdout.clearWrites()

  stdout.holdWrites = true
  renderer.setTerminalTitle("held-control-1")
  renderer.setTerminalTitle("held-control-2")
  await waitForHeldOutput(stdout)
  renderer.destroy()

  expect(renderer.nativeScene.driver.disposed).toBe(false)
  stdout.releaseWrites()
  await renderer.closed
  const output = stdout.getWrittenBytes().toString("binary")
  expect(output).toContain("\x1b]0;held-control-1\x07")
  expect(output.indexOf("held-control-2")).toBeGreaterThan(output.indexOf("held-control-1"))
  expect(output).toContain("\x1b[?25h")
  expect(output.lastIndexOf("\x1b[?25h")).toBeGreaterThan(output.indexOf("held-control-2"))
})

// ---- Backpressure ----

test("Session idle waits until the Writable callback settles", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
  })
  destroyFns.push(() => {
    stdout.releaseWrites()
    renderer.destroy()
    return renderer.closed
  })

  const driver = renderer.nativeScene.driver
  stdout.holdWrites = true
  renderer.setTerminalTitle("slow-write")
  let settled = false
  const idle = driver.idle().then(() => {
    settled = true
  })
  await waitForHeldOutput(stdout)
  expect(settled).toBe(false)
  stdout.releaseWrites()
  await idle
  expect(settled).toBe(true)
})

test("split-footer custom stdout publishes captured commits after in-flight controls", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
  })
  destroyFns.push(() => {
    stdout.releaseWrites()
    renderer.destroy()
    return renderer.closed
  })

  const driver = renderer.nativeScene.driver
  await renderer.setupTerminal()
  renderer.stdin.emit("data", Buffer.from("\x1b[1;1R"))
  await renderer.idle()
  stdout.clearWrites()
  stdout.holdWrites = true
  renderer.setTerminalTitle("held-control")
  await waitForHeldOutput(stdout)

  stdout.write("captured\n")
  const rendering = (renderer as any).loop()
  expect((renderer as any).externalOutputQueue.size).toBe(1)

  stdout.releaseWrites()
  await rendering
  await renderer.idle()
  await driver.idle()
  expect((renderer as any).externalOutputQueue.size).toBe(0)
  const output = stdout.getWrittenBytes().toString("binary")
  expect(output).toContain("held-control")
  expect(output.indexOf("captured")).toBeGreaterThan(output.indexOf("held-control"))
})

test("split-footer custom stdout retains captured commits when native skips", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
  })
  destroyFns.push(() => renderer.destroy())
  renderers.add(renderer)

  const restoreNative = forceNativeSplitSkip(renderer)

  stdout.write("captured-while-native-skipped\n")
  const rendererAny = renderer as any
  expect(rendererAny.externalOutputQueue.size).toBeGreaterThan(0)

  try {
    await rendererAny.loop()
    expect(rendererAny.externalOutputQueue.size).toBeGreaterThan(0)
  } finally {
    restoreNative()
  }
})

test("split-footer coalesces render requests while waiting for Session idle", async () => {
  const clock = new ManualClock()
  const stdout = createCollectingStdout(80, 24)
  const renderer = new CliRenderer(createTestStdin(), stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
    clock,
  })
  clock.runAll()
  destroyFns.push(() => renderer.destroy())
  renderers.add(renderer)

  const idle = deferOutputIdle(renderer)
  const rendererAny = renderer as any
  const driver = renderer.nativeScene.driver
  const originalCommit = driver.renderSplit.bind(driver)
  let calls = 0
  driver.renderSplit = (...args) => {
    calls++
    return calls === 1 ? { renderOffset: 0, status: NativeSessionRenderStatus.Skipped } : originalCommit(...args)
  }
  destroyFns.unshift(() => {
    driver.renderSplit = originalCommit
  })

  stdout.write("first\n")
  clock.advance(17)
  await finishRender(renderer)
  expect(calls).toBe(1)

  stdout.write("second\n")
  renderer.requestRender()
  clock.advance(100)
  await finishRender(renderer)

  expect(calls).toBe(1)
  expect(idle.calls()).toBe(1)
  expect(rendererAny.externalOutputQueue.size).toBe(2)

  await idle.resolve()
  clock.advance(0)
  await finishRender(renderer)

  expect(calls).toBe(2)
  expect(rendererAny.externalOutputQueue.size).toBe(0)
  expect(
    stdout
      .getWrittenBytes()
      .toString()
      .match(/first|second/g),
  ).toEqual(["first", "second"])
})

test("split-footer custom stdout retains captured commits when native fails and retries", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
  })
  destroyFns.push(() => renderer.destroy())
  renderers.add(renderer)

  const rendererAny = renderer as any
  const commit = spyOn(renderer.nativeScene.driver, "renderSplit").mockImplementation(() => ({
    renderOffset: 0,
    status: NativeSessionRenderStatus.Failed,
  }))

  stdout.write("captured-while-native-failed\n")
  expect(rendererAny.externalOutputQueue.size).toBeGreaterThan(0)

  try {
    await rendererAny.loop()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(rendererAny.externalOutputQueue.size).toBeGreaterThan(0)
  } finally {
    commit.mockRestore()
  }

  await rendererAny.loop()
  await renderer.nativeScene.driver.idle()

  expect(rendererAny.externalOutputQueue.size).toBe(0)
  expect(stdout.getWrittenBytes().toString("binary")).toContain("captured-while-native-failed")
})

test("split-footer retains the whole batch when native publication fails", async () => {
  const clock = new ManualClock()
  const stdout = createCollectingStdout(80, 24)
  const renderer = new CliRenderer(createTestStdin(), stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
    clock,
  })
  clock.runAll()
  destroyFns.push(() => renderer.destroy())
  renderers.add(renderer)

  const rendererAny = renderer as any
  const commit = spyOn(renderer.nativeScene.driver, "renderSplit").mockImplementation(() => ({
    renderOffset: 0,
    status: NativeSessionRenderStatus.Failed,
  }))

  stdout.write("first\nsecond\n")
  expect(rendererAny.externalOutputQueue.size).toBe(2)

  try {
    await rendererAny.loop()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0][1]).toHaveLength(2)
    expect(rendererAny.externalOutputQueue.size).toBe(2)
    expect(stdout.getWrittenBytes()).toHaveLength(0)
  } finally {
    commit.mockRestore()
  }

  await rendererAny.loop()
  await renderer.nativeScene.driver.idle()
  const output = stdout.getWrittenBytes().toString("binary")
  expect(output.match(/first|second/g)).toEqual(["first", "second"])
})

test("split-footer native failure in memory output does not schedule automatic retries", async () => {
  const clock = new ManualClock()
  const stdout = createPlainStdout()
  const renderer = new CliRenderer(createTestStdin(), stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
    bufferedOutput: "memory",
    clock,
  })
  clock.runAll()
  destroyFns.push(() => renderer.destroy())
  renderers.add(renderer)

  const rendererAny = renderer as any
  const originalError = console.error
  const commit = spyOn(renderer.nativeScene.driver, "renderSplit").mockImplementation(() => ({
    renderOffset: 0,
    status: NativeSessionRenderStatus.Failed,
  }))
  console.error = () => {}
  destroyFns.unshift(() => {
    commit.mockRestore()
    console.error = originalError
  })

  stdout.write("captured-while-native-failed\n")
  await rendererAny.loop()
  expect(commit).toHaveBeenCalledTimes(1)

  clock.advance(1000)

  expect(commit).toHaveBeenCalledTimes(1)
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
})

test("capture-to-passthrough flushes queued split-footer commits after held Session output", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
  })
  destroyFns.push(() => {
    stdout.releaseWrites()
    renderer.destroy()
    return renderer.closed
  })

  await renderer.setupTerminal()
  renderer.stdin.emit("data", Buffer.from("\x1b[1;1R"))
  await renderer.idle()
  stdout.holdWrites = true
  renderer.setTerminalTitle("held-before-mode-switch")
  await waitForHeldOutput(stdout)

  stdout.write("captured-before-mode-switch\n")
  expect((renderer as any).externalOutputQueue.size).toBeGreaterThan(0)

  renderer.externalOutputMode = "passthrough"
  stdout.releaseWrites()
  await renderer.idle()
  await renderer.nativeScene.driver.idle()

  expect(stdout.getWrittenBytes().toString("binary")).toContain("captured-before-mode-switch")
  expect((renderer as any).externalOutputQueue.size).toBe(0)
  expect(renderer.externalOutputMode).toBe("passthrough")
})

test("destroy resolves idle waiters when an output-idle render was scheduled", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
  })
  destroyFns.push(() => {
    stdout.releaseWrites()
    renderer.destroy()
    return renderer.closed
  })

  await renderer.setupTerminal()
  renderer.stdin.emit("data", Buffer.from("\x1b[1;1R"))
  await renderer.idle()
  stdout.holdWrites = true
  renderer.setTerminalTitle("held-before-idle")
  await waitForHeldOutput(stdout)

  const restoreNative = forceNativeSplitSkip(renderer)
  stdout.write("captured-before-idle-destroy\n")
  try {
    await (renderer as any).loop()
    expect((renderer as any).outputIdleRenderScheduled).toBe(true)
  } finally {
    restoreNative()
  }

  let idleResolved = false
  const idlePromise = renderer.idle().then(() => {
    idleResolved = true
  })

  renderer.destroy()
  stdout.releaseWrites()
  await idlePromise
  expect(idleResolved).toBe(true)

  await renderer.closed
  expect(stdout.getWrittenBytes().toString("binary")).toContain("captured-before-idle-destroy")
  expect((renderer as any).externalOutputQueue.size).toBe(0)
})

test("suspend resolves idle waiters when an output-idle render was scheduled", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
  })
  destroyFns.push(() => {
    stdout.releaseWrites()
    renderer.destroy()
    return renderer.closed
  })

  await renderer.setupTerminal()
  renderer.stdin.emit("data", Buffer.from("\x1b[1;1R"))
  await renderer.idle()
  await renderer.nativeScene.driver.idle()
  stdout.holdWrites = true
  renderer.setTerminalTitle("held-before-suspend")
  await waitForHeldOutput(stdout)

  const restoreNative = forceNativeSplitSkip(renderer)
  stdout.write("captured-before-suspend\n")
  try {
    await (renderer as any).loop()
    expect((renderer as any).outputIdleRenderScheduled).toBe(true)
  } finally {
    restoreNative()
  }

  let idleResolved = false
  const idlePromise = renderer.idle().then(() => {
    idleResolved = true
  })

  const suspension = renderer.suspend()
  stdout.releaseWrites()
  await suspension
  await idlePromise
  expect(idleResolved).toBe(true)
  const output = stdout.getWrittenBytes().toString("binary")
  expect(output.lastIndexOf("\x1b[?25h")).toBeGreaterThan(output.indexOf("captured-before-suspend"))
})

// ---- Dimension fallback ----

test("dimensions: stdout.columns wins over config.width", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(120, 30)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    width: 40,
    height: 10,
    bufferedOutput: "memory",
  })
  destroyFns.push(() => renderer.destroy())

  expect(renderer.width).toBe(120)
  expect(renderer.height).toBe(30)
})

test("dimensions: config.width used when stdout lacks columns", async () => {
  const stdin = createTestStdin()
  const stdout = createPlainStdout()

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    width: 100,
    height: 50,
    bufferedOutput: "memory",
  })
  destroyFns.push(() => renderer.destroy())

  expect(renderer.width).toBe(100)
  expect(renderer.height).toBe(50)
})

test("dimensions: config.width used when stdout reports zero columns", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(0, 0)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    width: 100,
    height: 50,
    bufferedOutput: "memory",
  })
  destroyFns.push(() => renderer.destroy())

  expect(renderer.width).toBe(100)
  expect(renderer.height).toBe(50)
})

test("dimensions: defaults 80x24 when no stdout columns and no config", async () => {
  const stdin = createTestStdin()
  const stdout = createPlainStdout()

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    bufferedOutput: "memory",
  })
  destroyFns.push(() => renderer.destroy())

  expect(renderer.width).toBe(80)
  expect(renderer.height).toBe(24)
})

test("dimensions: defaults 80x24 when stdout reports zero columns and no config", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(0, 0)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    bufferedOutput: "memory",
  })
  destroyFns.push(() => renderer.destroy())

  expect(renderer.width).toBe(80)
  expect(renderer.height).toBe(24)
})

// ---- Duck-typed stream capabilities ----

test("stdin without setRawMode: start/suspend/resume/destroy all succeed", async () => {
  const stdin = createTestStdin() // Readable has no setRawMode
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    bufferedOutput: "memory",
  })

  await renderer.suspend()
  await renderer.resume()
  expect(() => renderer.destroy()).not.toThrow()
  await renderer.closed
})

// ---- Public resize API ----

test("resize(w, h) updates dimensions and fires RESIZE event", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    bufferedOutput: "memory",
  })
  destroyFns.push(() => renderer.destroy())

  let eventFired = false
  let eventW = 0
  let eventH = 0
  renderer.on(CliRenderEvents.RESIZE, (w: number, h: number) => {
    eventFired = true
    eventW = w
    eventH = h
  })

  renderer.resize(120, 40)

  expect(eventFired).toBe(true)
  expect(eventW).toBe(120)
  expect(eventH).toBe(40)
  expect(renderer.width).toBe(120)
  expect(renderer.height).toBe(40)
})

test("resize() after destroy is a no-op", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    bufferedOutput: "memory",
  })

  renderer.destroy()
  expect(() => renderer.resize(100, 50)).not.toThrow()
})

// ---- Session teardown ----

test("Session teardown after successful setup releases listeners without closing borrowed streams", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
  })
  expect(() => renderer.destroy()).not.toThrow()
  await renderer.closed
  expect(renderer.nativeScene.driver.disposed).toBe(true)
  expect(stdin.listenerCount("data")).toBe(0)
  for (const event of ["error", "close", "finish", "drain"]) expect(stdout.listenerCount(event)).toBe(0)
  expect(stdout.destroyed).toBe(false)
  expect(stdout.writableEnded).toBe(false)
})

// ---- Destroy resilience ----

test("constructor cleans up listeners when input setup fails", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)
  const calls: boolean[] = []
  const processEvents = ["warning", "uncaughtException", "unhandledRejection", "beforeExit"] as const
  const listenerCounts = new Map(processEvents.map((event) => [event, process.listenerCount(event)]))

  stdin.setRawMode = (enabled) => {
    calls.push(enabled)
    if (enabled) {
      throw new Error("raw mode setup failed")
    }
    return stdin
  }

  await expect(
    createCliRenderer({
      stdin,
      stdout,
      exitSignals: [],
    }),
  ).rejects.toThrow("raw mode setup failed")

  expect(calls).toEqual([true, false])
  expect(stdin.listenerCount("data")).toBe(0)
  for (const event of processEvents) {
    expect(process.listenerCount(event)).toBe(listenerCounts.get(event) ?? 0)
  }
})

test("destroy releases resources when the Session output pump throws", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
  })

  const driver = renderer.nativeScene.driver
  const failure = new Error("simulated output pump failure")
  const pump = spyOn(driver.renderLib, "sessionPump").mockImplementation(() => {
    throw failure
  })
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    expect(() => renderer.destroy()).not.toThrow()
    await expect(renderer.closed).rejects.toThrow(failure)
    expect(pump).toHaveBeenCalled()
    expect(driver.disposed).toBe(true)
    expect(renderer.root.isDestroyed).toBe(true)
    expect(stdin.listenerCount("data")).toBe(0)
    for (const event of ["error", "close", "finish", "drain"]) expect(stdout.listenerCount(event)).toBe(0)
  } finally {
    pump.mockRestore()
    errors.mockRestore()
    renderers.delete(renderer)
  }
})
