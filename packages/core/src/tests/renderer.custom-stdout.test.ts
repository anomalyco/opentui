import { test, expect, afterEach, spyOn } from "bun:test"
import { Writable } from "stream"
import { setImmediate } from "node:timers/promises"
import {
  createCliRenderer as createRenderer,
  CliRenderer,
  CliRenderEvents,
  type CliRendererConfig,
} from "../renderer.js"
import { NativeSession } from "../NativeSession.js"
import { BoxRenderable } from "../renderables/Box.js"
import { ImageRenderable } from "../renderables/Image.js"
import { MarkdownRenderable } from "../renderables/Markdown.js"
import { TextRenderable } from "../renderables/Text.js"
import { SyntaxStyle } from "../syntax-style.js"
import { forceRenderStatus, holdOutputIdle, settle, settleUntil } from "../testing/harness.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin, RecordingWriteStream } from "../testing/test-streams.js"
import { NativeSessionRenderStatus } from "../zig.js"

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==",
    "base64",
  ),
)

type CollectingStdout = RecordingWriteStream & NodeJS.WriteStream

function createCollectingStdout(columns = 80, rows = 24): CollectingStdout {
  return new RecordingWriteStream(columns, rows) as CollectingStdout
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
      .bytes()
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

/** The next native split commit returns `status` without output; later commits run normally. Returns batch sizes. */
function rejectNextSplit(renderer: CliRenderer, status: NativeSessionRenderStatus): number[] {
  const driver = renderer.nativeScene.driver
  const renderSplit = driver.renderSplit
  const batches: number[] = []
  driver.renderSplit = (...args) => {
    batches.push(args[1].length)
    if (batches.length > 1) return renderSplit.apply(driver, args)
    // A returned status consumes the native draft even when the test bypasses encoding.
    renderer.nativeScene.cancelFrame()
    return { status }
  }
  destroyFns.unshift(() => {
    driver.renderSplit = renderSplit
  })
  return batches
}

async function finishRender(renderer: CliRenderer): Promise<void> {
  for (let turn = 0; turn < 64; turn++) {
    await setImmediate()
    if (renderer.getSchedulerState().isRendering) await (renderer as any).loop(true)
    if (!(renderer as any).cancelReadyFrame) return
  }
  throw new Error("Renderer did not finish ready work within 64 host turns")
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

  const received = stdout.bytes()
  expect(received.length).toBeGreaterThan(0)
  // ANSI escape sequences contain ESC (0x1b).
  expect(received.includes(0x1b)).toBe(true)
})

test("late Ghostty capability detection emits OSC 8 for compact Markdown links", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(100, 8)
  const renderer = await createCliRenderer({ stdin, stdout, useMouse: true })
  destroyFns.push(() => renderer.destroy())

  const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } }, renderer.nativeScene)
  destroyFns.push(() => syntaxStyle.destroy())

  renderer.root.add(
    new MarkdownRenderable(renderer, {
      content: "| Link |\n| --- |\n| [OpenTUI](https://github.com/anomalyco/opentui) |\n| https://example.com/path |",
      syntaxStyle,
      tableOptions: { style: "columns", widthMode: "content" },
    }),
  )
  await renderer.idle()
  await flushWritable(stdout)

  const initialFrame = new TextDecoder().decode(renderer.currentRenderBuffer.getRealCharBytes(true))
  expect(initialFrame).toContain("OpenTUI (https://github.com/anomalyco/opentui)")
  expect(initialFrame.match(/https:\/\/example\.com\/path/g)).toHaveLength(1)
  expect(stdout.bytes().toString("binary")).not.toContain("\x1b]8;id=")

  stdout.clear()
  stdin.emit("data", Buffer.from("\x1bP>|ghostty 1.1.3\x1b\\"))
  await renderer.idle()
  await flushWritable(stdout)

  const finalFrame = new TextDecoder().decode(renderer.currentRenderBuffer.getRealCharBytes(true))
  const output = stdout.bytes().toString("binary")
  expect(renderer.capabilities?.hyperlinks).toBe(true)
  expect(finalFrame).toContain("OpenTUI")
  expect(finalFrame).not.toContain("github.com/anomalyco/opentui")
  expect(finalFrame.match(/https:\/\/example\.com\/path/g)).toHaveLength(1)
  expect(output).toContain(";https://github.com/anomalyco/opentui\x1b\\")
  expect(output).toContain(";https://example.com/path\x1b\\")
  expect(output).toContain("\x1b]8;;\x1b\\")
})

test("unidentified truecolor terminals preserve the visible Markdown link fallback", async () => {
  const previousTerm = process.env.TERM
  const previousColorTerm = process.env.COLORTERM
  process.env.TERM = "xterm-256color"
  process.env.COLORTERM = "truecolor"

  try {
    const stdout = createCollectingStdout(80, 6)
    const renderer = await createCliRenderer({
      stdin: createTestStdin(),
      stdout,
      remote: false,
      forwardEnvKeys: ["TERM", "COLORTERM"],
    })
    destroyFns.push(() => renderer.destroy())

    const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } }, renderer.nativeScene)
    destroyFns.push(() => syntaxStyle.destroy())
    renderer.root.add(
      new MarkdownRenderable(renderer, {
        content: "| Link |\n|---|\n| [OpenTUI](https://example.com/docs) |",
        syntaxStyle,
        tableOptions: { style: "columns", widthMode: "content" },
      }),
    )

    await renderer.idle()
    await flushWritable(stdout)

    expect(renderer.capabilities?.rgb).toBe(true)
    expect(renderer.capabilities?.hyperlinks).toBe(false)
    expect(new TextDecoder().decode(renderer.currentRenderBuffer.getRealCharBytes(true))).toContain(
      "OpenTUI (https://example.com/docs)",
    )
    expect(stdout.bytes().toString("binary")).not.toContain("\x1b]8;id=")
  } finally {
    if (previousTerm === undefined) delete process.env.TERM
    else process.env.TERM = previousTerm
    if (previousColorTerm === undefined) delete process.env.COLORTERM
    else process.env.COLORTERM = previousColorTerm
  }
})

test("VS Code receives a wrapped Markdown URL as an OSC 8 hyperlink", async () => {
  const previousTerm = process.env.TERM
  const previousTermProgram = process.env.TERM_PROGRAM
  process.env.TERM = "xterm-256color"
  process.env.TERM_PROGRAM = "vscode"
  const url = "https://example.com/catalog/moparts,2004,dodge,ram+1500,4.7l+v8,1432463,brake+pad"

  try {
    const stdout = createCollectingStdout(32, 8)
    const renderer = await createCliRenderer({
      stdin: createTestStdin(),
      stdout,
      remote: false,
      forwardEnvKeys: ["TERM", "TERM_PROGRAM"],
    })
    destroyFns.push(() => renderer.destroy())

    const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } }, renderer.nativeScene)
    destroyFns.push(() => syntaxStyle.destroy())
    renderer.root.add(new MarkdownRenderable(renderer, { content: `See ${url} now.`, syntaxStyle }))

    const frame = () => new TextDecoder().decode(renderer.currentRenderBuffer.getRealCharBytes(true))
    for (let attempt = 0; attempt < 100 && !frame().replace(/\s/g, "").includes(url); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      await renderer.idle()
    }
    await flushWritable(stdout)

    expect(renderer.capabilities?.hyperlinks).toBe(true)
    expect(frame().replace(/\s/g, "")).toContain(url)
    expect(frame()).not.toContain(url)
    expect(stdout.bytes().toString("binary")).toContain(`;${url}\x1b\\`)
  } finally {
    if (previousTerm === undefined) delete process.env.TERM
    else process.env.TERM = previousTerm
    if (previousTermProgram === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = previousTermProgram
  }
})

test("auto images use detected Kitty graphics and delete cleared placements", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 4)
  const renderer = await createCliRenderer({ stdin, stdout })
  destroyFns.push(() => renderer.destroy())
  await flushWritable(stdout)
  stdout.clear()

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
  expect(stdout.bytes().toString("binary")).toContain("\x1b_G")

  stdout.clear()
  image.source = undefined
  await renderer.idle()
  await flushWritable(stdout)
  expect(stdout.bytes().toString("binary")).toContain("a=d")
})

test("auto images use detected Sixel when pixel resolution is available", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 4)
  const renderer = await createCliRenderer({ stdin, stdout })
  destroyFns.push(() => renderer.destroy())
  await flushWritable(stdout)
  stdout.clear()

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
  expect(stdout.bytes().toString("binary")).toContain("\x1bP0;1;0q")
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
  expect(stdout.bytes().toString("utf8")).toContain("█")
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
  expect(stdout.bytes().toString("binary")).not.toContain("\x1bP0;1;0q")
  expect(stdout.bytes().toString("utf8")).toContain("█")
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
  expect(stdout.bytes().toString("binary")).toContain('0;1;0q"1;1;20;20')

  stdout.clear()
  renderer.resize(16, 4)
  await renderer.idle()
  await flushWritable(stdout)

  const pendingOutput = stdout.bytes().toString("binary")
  expect(pendingOutput).toContain("\x1b[14t")
  expect(pendingOutput).not.toContain('0;1;0q"1;1;10;20')
  expect(renderer.resolution).toBeNull()
  expect(image.effectiveProtocol).toBe("blocks")
  expect(pendingOutput).not.toContain("\x1bP0;1;0q")
  expect(stdout.bytes().toString("utf8")).toContain("█")

  stdout.clear()
  stdin.emit("data", Buffer.from("\x1b[4;80;160t"))
  await renderer.idle()
  await flushWritable(stdout)

  expect(renderer.resolution).toEqual({ width: 160, height: 80 })
  expect(image.effectiveProtocol).toBe("sixel")
  expect(stdout.bytes().toString("binary")).toContain('0;1;0q"1;1;20;20')
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
  stdout.clear()

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

  const output = stdout.bytes().toString("binary")
  expect(output).toContain("\x1b_Ga=t")
  expect(output).toContain("a=t,f=100")
  expect(output).toContain("c=80,r=48")
  expect(output).toContain("after-image")
})

test.each([
  { name: "Kitty", response: "\x1b_Gi=31337;OK\x1b\\", placement: "\x1b_Ga=p" },
  { name: "Sixel", response: "\x1b[?1;4c", placement: "\x1bP0;1;0q" },
])("split-footer preserves $name images after resize replay resets", async ({ response, placement }) => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)
  const renderer = await createCliRenderer({
    stdin,
    stdout,
    screenMode: "split-footer",
    footerHeight: 3,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  destroyFns.push(() => renderer.destroy())
  stdin.emit("data", Buffer.from(response + "\x1b[4;480;800t\x1b[21;1R"))
  await renderer.idle()

  for (const size of [undefined, { width: 90, height: 28 }, { width: 20, height: 8 }]) {
    if (size) {
      renderer.resize(size.width, size.height)
      stdin.emit("data", Buffer.from(`\x1b[4;${size.height * 20};${size.width * 10}t`))
      renderer.resetSplitFooterForReplay({ clearSavedLines: true })
      await renderer.idle()
    }
    await flushWritable(stdout)
    stdout.clear()

    const surface = renderer.createScrollbackSurface({ startOnNewLine: true })
    try {
      const image = new ImageRenderable(surface.renderContext, {
        source: PNG_1X1,
        width: 2,
        height: 5,
        fit: "fill",
      })
      surface.root.add(image)
      await image.loadPromise
      surface.render()
      surface.commitRows(0, surface.height, { trailingNewline: true })
    } finally {
      surface.destroy()
    }
    await renderer.idle()
    await flushWritable(stdout)

    const output = stdout.bytes().toString("utf8")
    expect(output).toContain(placement)
    expect(output).toContain("\x1b[4A\r")
    expect(output).not.toContain("\u2588")
  }
})

test("split-footer queues native image scrollback until the startup cursor reply", async () => {
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
  stdout.clear()

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

  expect(stdout.bytes()).toHaveLength(0)

  stdin.emit("data", Buffer.from("\x1b[3;1R"))
  await renderer.idle()
  await flushWritable(stdout)

  expect(stdout.bytes().toString("binary")).toContain("\x1b_Ga=t")
  expect(stdout.bytes().toString("utf8")).not.toContain("█")
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
  stdout.clear()

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

  let output = stdout.bytes().toString("binary")
  expect(output).not.toContain("\x1b_G")
  expect(output).not.toContain("\x1bP0;1;0q")
  expect(stdout.bytes().toString("utf8")).toContain("█")

  stdout.clear()
  await commitImages([{ protocol: "kitty" }, { protocol: "kitty" }])

  output = stdout.bytes().toString("binary")
  expect(output).not.toContain("\x1b_G")
  expect(output).not.toContain("\x1bP0;1;0q")
  expect(stdout.bytes().toString("utf8")).toContain("█")
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

  expect(stdout.bytes().toString("binary")).toContain('0;1;0q"1;1;10;13')
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

  expect(stdout.bytes().toString("binary")).toContain('0;1;0q"1;1;10;13')
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
  stdout.clear()

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

  expect(stdout.bytes().toString("binary")).toContain("#0;2;50;0;50")
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
    stdout.clear()

    const appended = `pin${testCase.name[0]}`
    stdout.write(`${appended}\n`)
    renderer.requestRender()
    await renderer.idle()
    await flushWritable(stdout)

    const output = stdout.bytes().toString("binary")
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

  stdout.clear()

  renderer.setTerminalTitle("split-footer custom stdout")

  // Renderer-owned ANSI must go straight to the sink, not back through the
  // split-footer stdout-capture queue.
  expect((renderer as any).externalOutputQueue.size).toBe(0)

  await flushWritable(stdout)

  expect(stdout.bytes().toString("binary")).toContain("\x1b]0;split-footer custom stdout\x07")
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

  stdout.clear()
  renderer.resetTerminalBgColor()

  await flushWritable(stdout)

  expect(stdout.bytes().toString("binary")).toContain("\x1b]111\x07")
})

test("resize ignores an outstanding pixel resolution reply", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 4)
  const renderer = await createCliRenderer({ stdin, stdout })
  destroyFns.push(() => renderer.destroy())
  await flushWritable(stdout)
  expect(countPixelResolutionQueries(stdout)).toBe(1)
  stdout.clear()

  renderer.resize(16, 4)
  renderer.resize(24, 4)
  await flushWritable(stdout)
  expect(stdout.bytes().toString("binary")).not.toContain("\x1b[14t")

  stdin.emit("data", Buffer.from("\x1b[4;80;80t"))
  expect(renderer.resolution).toBeNull()
  await flushWritable(stdout)
  expect(countPixelResolutionQueries(stdout)).toBe(1)

  stdout.clear()
  stdin.emit("data", Buffer.from("\x1b[4;80;240t"))
  await renderer.idle()

  expect(renderer.resolution).toEqual({ width: 240, height: 80 })
  expect(stdout.bytes().toString("binary")).not.toContain("\x1b[14t")
})

test("resize while suspended refreshes pixel resolution after resume", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 4)
  const renderer = await createCliRenderer({ stdin, stdout })
  destroyFns.push(() => renderer.destroy())
  await flushWritable(stdout)
  expect(countPixelResolutionQueries(stdout)).toBe(1)
  stdout.clear()
  stdin.emit("data", Buffer.from("\x1b[4;80;80t"))
  await renderer.idle()
  expect(renderer.resolution).toEqual({ width: 80, height: 80 })

  await renderer.suspend()
  stdout.clear()
  renderer.resize(16, 4)
  renderer.resize(24, 4)
  await flushWritable(stdout)
  expect(stdout.bytes().toString("binary")).not.toContain("\x1b[14t")
  stdout.clear()

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
  stdout.clear()

  await renderer.suspend()
  renderer.resize(16, 4)
  await renderer.resume()
  await flushWritable(stdout)
  expect(stdout.bytes().toString("binary")).not.toContain("\x1b[14t")

  stdout.clear()
  stdin.emit("data", Buffer.from("\x1b[4;80;80t"))
  expect(renderer.resolution).toBeNull()
  await flushWritable(stdout)
  expect(countPixelResolutionQueries(stdout)).toBe(1)

  stdout.clear()
  stdin.emit("data", Buffer.from("\x1b[4;80;160t"))
  await renderer.idle()

  expect(renderer.resolution).toEqual({ width: 160, height: 80 })
  expect(stdout.bytes().toString("binary")).not.toContain("\x1b[14t")
})

test("resume preserves an outstanding pixel resolution query without requerying", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(8, 4)
  const renderer = await createCliRenderer({ stdin, stdout })
  destroyFns.push(() => renderer.destroy())
  await flushWritable(stdout)
  expect(countPixelResolutionQueries(stdout)).toBe(1)
  stdout.clear()

  await renderer.suspend()
  await renderer.resume()
  await flushWritable(stdout)
  expect(stdout.bytes().toString("binary")).not.toContain("\x1b[14t")

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
  stdout.clear()

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
  stdout.clear()

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
      stdout.clear()

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
      stdout.clear()

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
      stdout.clear()

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

      stdout.clear()
      stdin.emit("data", Buffer.from("\x1b[4;80;160t"))
      await renderer.idle()
      expect(renderer.resolution).toEqual({ width: 160, height: 80 })
      expect(stdout.bytes().toString("binary")).not.toContain("\x1b[14t")
    } finally {
      renderer.destroy()
      await renderer.closed
    }
  }
})

type RetryCheck = Partial<
  Record<"calls" | "frames" | "idleCalls" | "errors", number> & Record<"scheduled" | "running", boolean>
>
type RetryStep =
  | "loop"
  | "start"
  | "pause"
  | "stop"
  | "suspend"
  | "destroy"
  | "request"
  | "intermediate"
  | "release"
  | "hold"
  | "finish"
  | number
  | RetryCheck

interface RetryCase {
  name: string
  statuses: string
  memory?: boolean
  steps: readonly RetryStep[]
  end: RetryCheck
}

const RENDER_STATUS = {
  S: NativeSessionRenderStatus.Skipped,
  P: NativeSessionRenderStatus.Presented,
  F: NativeSessionRenderStatus.Failed,
} as const

/**
 * Drives a renderer whose native commits return `statuses` in order (the last one repeats) while every Session
 * `idle()` wait is held until "release". A number advances the clock; an object checks the observed state.
 */
async function runRetryScenario({ statuses, memory = false, steps, end }: RetryCase): Promise<void> {
  const { renderer, clock } = createRetryRenderer(!memory)
  if (steps.includes("suspend")) await renderer.setupTerminal()
  const idle = holdOutputIdle(renderer)
  const errors = spyOn(console, "error").mockImplementation(() => {})
  let calls = 0
  let failures = 0
  let frames = 0
  const restore = forceRenderStatus(renderer, () => {
    const status = RENDER_STATUS[statuses[Math.min(calls++, statuses.length - 1)] as keyof typeof RENDER_STATUS]
    if (status === NativeSessionRenderStatus.Failed) failures++
    return status
  })
  destroyFns.unshift(() => {
    restore()
    idle.restore()
    errors.mockRestore()
  })
  renderer.on(CliRenderEvents.FRAME, () => frames++)

  for (const step of [...steps, end]) {
    if (typeof step === "number") clock.advance(step)
    else if (typeof step === "object") {
      const observed: Required<RetryCheck> = {
        calls,
        frames,
        idleCalls: idle.calls(),
        errors: errors.mock.calls.length,
        scheduled: renderer.getSchedulerState().hasScheduledRender,
        running: renderer.isRunning,
      }
      const keys = Object.keys(step) as (keyof RetryCheck)[]
      expect(Object.fromEntries(keys.map((key) => [key, observed[key]]))).toEqual(step)
    } else if (step === "loop") await (renderer as any).loop()
    else if (step === "start") renderer.start()
    else if (step === "request") renderer.requestRender()
    else if (step === "intermediate") renderer.intermediateRender()
    else if (step === "release") await idle.release()
    else if (step === "hold") idle.hold()
    else if (step === "finish") await finishRender(renderer)
    else await renderer[step]()
  }
  // Each native failure logs once; skips and retries log nothing.
  expect(errors.mock.calls.length).toBe(failures)
}

test.each<RetryCase>([
  {
    name: "retries one skipped frame after Session idle",
    statuses: "SP",
    steps: ["loop", { calls: 1, frames: 0, idleCalls: 1 }, "release", { scheduled: true }, 17, "finish"],
    end: { calls: 2, frames: 1, scheduled: false },
  },
  {
    name: "retries immediately when output pressure outlasts the frame interval",
    statuses: "SP",
    steps: ["loop", 100, "release", 0, "finish"],
    end: { calls: 2 },
  },
  {
    name: "coalesces requests while waiting for Session idle",
    statuses: "SP",
    steps: ["loop", "request", "request", "request", { calls: 1 }, "release", 17, "finish"],
    end: { calls: 2, frames: 1 },
  },
  {
    name: "starts running while a skipped frame waits for Session idle",
    statuses: "SP",
    steps: ["loop", "start", { running: true }, 100, { calls: 1 }, "release", 0, "finish"],
    end: { calls: 2, running: true },
  },
  {
    name: "waits for each repeated skip",
    statuses: "SSP",
    steps: ["loop", "release", "hold", 17, "finish", { calls: 2, idleCalls: 2 }, "release", 17, "finish"],
    end: { calls: 3 },
  },
  {
    name: "does not wait for Session idle or retry after a native failure",
    statuses: "F",
    steps: ["loop", 1000],
    end: { calls: 1, idleCalls: 0, scheduled: false },
  },
  {
    name: "recovers from native failure on a later render request",
    statuses: "FP",
    memory: true,
    steps: ["loop", 1000, { calls: 1, frames: 0, errors: 1, scheduled: false }, "intermediate", "finish"],
    end: { calls: 2, frames: 1 },
  },
  {
    name: "keeps running after a native failure and renders a later request",
    statuses: "FP",
    memory: true,
    steps: ["start", "finish", { calls: 1, running: true }, "request", 17, "finish"],
    end: { calls: 2 },
  },
  {
    name: "resumes running after Session idle",
    statuses: "SP",
    steps: ["start", "finish", { calls: 1 }, "release", 17, "finish"],
    end: { calls: 2, running: true },
  },
  ...(["pause", "stop", "suspend", "destroy"] as const).map(
    (control): RetryCase => ({
      name: `${control}() cancels an output-idle retry`,
      statuses: "S",
      steps: ["loop", control, "release", 17, "finish"],
      end: { calls: 1 },
    }),
  ),
  ...(["pause", "stop"] as const).flatMap((control): RetryCase[] => [
    {
      name: `retries a one-shot request after ${control}() once Session idle resolves`,
      statuses: "SP",
      steps: [control, "request", 17, "finish", { calls: 1 }, "release", 17, "finish"],
      end: { calls: 2 },
    },
    {
      name: `replaces a cancelled output-idle retry with a fresh request after ${control}()`,
      statuses: "SP",
      steps: ["start", "finish", { calls: 1 }, control, "request", "release", 17, "finish"],
      end: { calls: 2, running: false },
    },
  ]),
])("Session-backed renderer $name", runRetryScenario)

test.each(["pause", "stop"] as const)(
  "an older output-idle wait cannot cancel a newer %s() one-shot",
  async (control) => {
    const { renderer, clock } = createRetryRenderer(true)
    const idle = holdOutputIdle(renderer)
    const callback = Promise.withResolvers<void>()
    let calls = 0
    let callbacks = 0
    const restore = forceRenderStatus(renderer, () =>
      calls++ < 2 ? NativeSessionRenderStatus.Skipped : NativeSessionRenderStatus.Presented,
    )
    destroyFns.unshift(restore, idle.restore)
    renderer[control]()
    renderer.setFrameCallback(async () => {
      if (++callbacks === 2) await callback.promise
    })
    renderer.intermediateRender()
    await finishRender(renderer)
    expect(calls).toBe(1)
    renderer.intermediateRender()
    expect(callbacks).toBe(2)
    await idle.release()
    clock.advance(17)
    idle.hold()
    callback.resolve()
    await finishRender(renderer)
    expect(calls).toBe(2)
    await idle.release()
    clock.advance(17)
    await finishRender(renderer)
    expect(calls).toBe(3)
    expect(renderer.getStats().nativeFrameCount).toBe(1)
  },
)

test("cancelling a skipped frame with an immediate rerender request resolves idle", async () => {
  const { renderer } = createRetryRenderer(true)
  const idle = holdOutputIdle(renderer)
  renderer.setFrameCallback(async () => {
    renderer.requestRender()
  })
  destroyFns.unshift(
    forceRenderStatus(renderer, () => NativeSessionRenderStatus.Skipped),
    idle.restore,
  )

  await (renderer as any).loop()
  renderer.pause()
  const idlePromise = renderer.idle()

  await idle.release()
  await idlePromise
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
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
  stdout.clear()

  renderer.destroy()

  await renderer.closed

  const shutdownBytes = stdout.bytes().toString("binary")

  // Shutdown must reach the custom sink before the Session releases output.
  expect(shutdownBytes.length).toBeGreaterThan(0)
  expect(shutdownBytes).toContain("\x1b[?25h") // showCursor
})

test("destroy preserves accepted controls before terminal shutdown while a write is held", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)
  const renderer = await createCliRenderer({ stdin, stdout })
  destroyFns.push(() => stdout.release())
  stdout.clear()

  stdout.hold()
  renderer.setTerminalTitle("held-control-1")
  renderer.setTerminalTitle("held-control-2")
  await settleUntil(() => stdout.pendingWrite)
  renderer.destroy()

  expect(renderer.nativeScene.driver.disposed).toBe(false)
  stdout.release()
  await renderer.closed
  const output = stdout.bytes().toString("binary")
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
    stdout.release()
    renderer.destroy()
    return renderer.closed
  })

  const driver = renderer.nativeScene.driver
  stdout.hold()
  renderer.setTerminalTitle("slow-write")
  let settled = false
  const idle = driver.idle().then(() => {
    settled = true
  })
  await settleUntil(() => stdout.pendingWrite)
  expect(settled).toBe(false)
  stdout.release()
  await idle
  expect(settled).toBe(true)
})

test("raw output pressure delays a running renderer until the Session drains", async () => {
  const stdout = new RecordingWriteStream(40, 4)
  const clock = new ManualClock()
  const driver = new NativeSession(stdout, {
    output: { chunkSize: 64, spanCapacity: 8, maxBytes: 512n, controlCapacity: 0 },
  })
  const renderer = new CliRenderer(createTestStdin(), stdout as unknown as NodeJS.WriteStream, 40, 4, {
    nativeSession: driver,
    clock,
    remote: true,
    screenMode: "main-screen",
    consoleMode: "disabled",
    exitSignals: [],
  })
  renderers.add(renderer)
  const errors = spyOn(console, "error").mockImplementation(() => {})
  destroyFns.push(() => {
    errors.mockRestore()
    stdout.release()
  })
  let frames = 0
  renderer.on(CliRenderEvents.FRAME, () => frames++)

  // Raw output leaves less free capacity than the frame needs, but the frame fits an empty queue.
  stdout.hold()
  expect(driver.write(new Uint8Array(400).fill(0x41))).toBe(true)
  await settleUntil(() => stdout.pendingWrite)
  renderer.root.add(new TextRenderable(renderer, { content: `${"x".repeat(40)}\n${"y".repeat(40)}` }))
  renderer.start()
  clock.advance(40)
  await settle(16)
  expect(frames).toBe(0)

  stdout.release()
  for (let frame = 0; frame < 4; frame++) {
    await settle(16)
    clock.advance(40)
  }
  await settle(16)
  expect(frames).toBeGreaterThanOrEqual(3)
  expect(renderer.isRunning).toBe(true)
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(true)
  expect(errors).not.toHaveBeenCalled()
})

test("split-footer custom stdout publishes captured commits after in-flight controls", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
  })
  destroyFns.push(() => {
    stdout.release()
    renderer.destroy()
    return renderer.closed
  })

  const driver = renderer.nativeScene.driver
  await renderer.setupTerminal()
  renderer.stdin.emit("data", Buffer.from("\x1b[1;1R"))
  await renderer.idle()
  stdout.clear()
  stdout.hold()
  renderer.setTerminalTitle("held-control")
  await settleUntil(() => stdout.pendingWrite)

  stdout.write("captured\n")
  const rendering = (renderer as any).loop()
  expect((renderer as any).externalOutputQueue.size).toBe(1)

  stdout.release()
  await rendering
  await renderer.idle()
  await driver.idle()
  expect((renderer as any).externalOutputQueue.size).toBe(0)
  const output = stdout.bytes().toString("binary")
  expect(output).toContain("held-control")
  expect(output.indexOf("captured")).toBeGreaterThan(output.indexOf("held-control"))
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

  const idle = holdOutputIdle(renderer)
  destroyFns.unshift(idle.restore)
  const rendererAny = renderer as any
  const batches = rejectNextSplit(renderer, NativeSessionRenderStatus.Skipped)

  stdout.write("first\n")
  clock.advance(17)
  await finishRender(renderer)
  expect(batches).toHaveLength(1)

  stdout.write("second\n")
  renderer.requestRender()
  clock.advance(100)
  await finishRender(renderer)

  expect(batches).toHaveLength(1)
  expect(idle.calls()).toBe(1)
  expect(rendererAny.externalOutputQueue.size).toBe(2)

  await idle.release()
  clock.advance(0)
  await finishRender(renderer)

  expect(batches).toHaveLength(2)
  expect(rendererAny.externalOutputQueue.size).toBe(0)
  expect(
    stdout
      .bytes()
      .toString()
      .match(/first|second/g),
  ).toEqual(["first", "second"])
})

test.each(
  (["Skipped", "Failed"] as const).flatMap((status) =>
    [1, 2].flatMap((lines) => [false, true].map((memory) => ({ status, lines, memory }))),
  ),
)(
  "split-footer retains captured commits when native returns $status ($lines lines, memory $memory)",
  async ({ status, lines, memory }) => {
    const clock = new ManualClock()
    const stdout = memory ? createPlainStdout() : createCollectingStdout(80, 24)
    const renderer = new CliRenderer(createTestStdin(), stdout, 80, 24, {
      screenMode: "split-footer",
      consoleMode: "disabled",
      bufferedOutput: memory ? "memory" : undefined,
      clock,
    })
    clock.runAll()
    renderers.add(renderer)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    destroyFns.unshift(() => errors.mockRestore())
    const batches = rejectNextSplit(renderer, NativeSessionRenderStatus[status])
    const queue = (renderer as any).externalOutputQueue
    const captured = Array.from({ length: lines }, (_, line) => `captured-${line}`)

    stdout.write(captured.map((line) => `${line}\n`).join(""))
    expect(queue.size).toBe(lines)
    await (renderer as any).loop()
    // The whole batch stays queued, and nothing reaches the terminal.
    expect(batches).toEqual([lines])
    expect(queue.size).toBe(lines)
    if (!memory) expect((stdout as CollectingStdout).bytes()).toHaveLength(0)

    // A skip retries after Session idle; a failure waits for a later render request.
    await renderer.nativeScene.driver.idle()
    await settle()
    clock.advance(1000)
    await finishRender(renderer)
    if (status === "Failed") {
      expect(batches).toEqual([lines])
      expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
      await (renderer as any).loop()
    }
    await renderer.nativeScene.driver.idle()
    expect(batches).toEqual([lines, lines])
    expect(queue.size).toBe(0)
    if (!memory) expect((stdout as CollectingStdout).text().match(/captured-\d/g)).toEqual(captured)
    expect(errors).toHaveBeenCalledTimes(status === "Failed" ? 1 : 0)
  },
)

test("capture-to-passthrough flushes queued split-footer commits after held Session output", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
  })
  destroyFns.push(() => {
    stdout.release()
    renderer.destroy()
    return renderer.closed
  })

  await renderer.setupTerminal()
  renderer.stdin.emit("data", Buffer.from("\x1b[1;1R"))
  await renderer.idle()
  stdout.hold()
  renderer.setTerminalTitle("held-before-mode-switch")
  await settleUntil(() => stdout.pendingWrite)

  stdout.write("captured-before-mode-switch\n")
  expect((renderer as any).externalOutputQueue.size).toBeGreaterThan(0)

  renderer.externalOutputMode = "passthrough"
  stdout.release()
  await renderer.idle()
  await renderer.nativeScene.driver.idle()

  expect(stdout.bytes().toString("binary")).toContain("captured-before-mode-switch")
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
    stdout.release()
    renderer.destroy()
    return renderer.closed
  })

  await renderer.setupTerminal()
  renderer.stdin.emit("data", Buffer.from("\x1b[1;1R"))
  await renderer.idle()
  stdout.hold()
  renderer.setTerminalTitle("held-before-idle")
  await settleUntil(() => stdout.pendingWrite)

  rejectNextSplit(renderer, NativeSessionRenderStatus.Skipped)
  stdout.write("captured-before-idle-destroy\n")
  await (renderer as any).loop()
  expect((renderer as any).outputIdleRenderScheduled).toBe(true)

  let idleResolved = false
  const idlePromise = renderer.idle().then(() => {
    idleResolved = true
  })

  renderer.destroy()
  stdout.release()
  await idlePromise
  expect(idleResolved).toBe(true)

  await renderer.closed
  expect(stdout.bytes().toString("binary")).toContain("captured-before-idle-destroy")
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
    stdout.release()
    renderer.destroy()
    return renderer.closed
  })

  await renderer.setupTerminal()
  renderer.stdin.emit("data", Buffer.from("\x1b[1;1R"))
  await renderer.idle()
  await renderer.nativeScene.driver.idle()
  stdout.hold()
  renderer.setTerminalTitle("held-before-suspend")
  await settleUntil(() => stdout.pendingWrite)

  rejectNextSplit(renderer, NativeSessionRenderStatus.Skipped)
  stdout.write("captured-before-suspend\n")
  await (renderer as any).loop()
  expect((renderer as any).outputIdleRenderScheduled).toBe(true)

  let idleResolved = false
  const idlePromise = renderer.idle().then(() => {
    idleResolved = true
  })

  const suspension = renderer.suspend()
  stdout.release()
  await suspension
  await idlePromise
  expect(idleResolved).toBe(true)
  const output = stdout.bytes().toString("binary")
  expect(output.lastIndexOf("\x1b[?25h")).toBeGreaterThan(output.indexOf("captured-before-suspend"))
})

// ---- Dimension fallback ----

test.each([
  { name: "stdout.columns wins over config.width", columns: [120, 30], config: [40, 10], expected: [120, 30] },
  { name: "config.width used when stdout lacks columns", columns: null, config: [100, 50], expected: [100, 50] },
  {
    name: "config.width used when stdout reports zero columns",
    columns: [0, 0],
    config: [100, 50],
    expected: [100, 50],
  },
  { name: "defaults 80x24 when no stdout columns and no config", columns: null, config: null, expected: [80, 24] },
  {
    name: "defaults 80x24 when stdout reports zero columns and no config",
    columns: [0, 0],
    config: null,
    expected: [80, 24],
  },
])("dimensions: $name", async ({ columns, config, expected }) => {
  const renderer = await createCliRenderer({
    stdin: createTestStdin(),
    stdout: columns ? createCollectingStdout(columns[0], columns[1]) : createPlainStdout(),
    ...(config && { width: config[0], height: config[1] }),
    bufferedOutput: "memory",
  })
  destroyFns.push(() => renderer.destroy())
  expect([renderer.width, renderer.height]).toEqual(expected)
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
