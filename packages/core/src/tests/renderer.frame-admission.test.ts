import { afterEach, expect, spyOn, test } from "bun:test"
import { NativeImage } from "../image.js"
import { NativeSession } from "../NativeSession.js"
import { RGBA } from "../lib/RGBA.js"
import { ImageRenderable } from "../renderables/Image.js"
import { TextRenderable } from "../renderables/Text.js"
import { Renderable } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import { CliRenderer, CliRenderEvents, createCliRenderer, type CliRendererConfig } from "../renderer.js"
import { settle, settleUntil } from "../testing/harness.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin, RecordingWriteStream } from "../testing/test-streams.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function createAdmissionRenderer(width = 80, height = 24, config: CliRendererConfig = {}) {
  const clock = new ManualClock()
  const stdout = new RecordingWriteStream(width, height, { highWaterMark: 1 })
  stdout.hold()
  const driver = new NativeSession(stdout, {
    output: { chunkSize: 4096, spanCapacity: 8, maxBytes: 32_768n, controlCapacity: 4096 },
  })
  const renderer = new CliRenderer(createTestStdin(), stdout as unknown as NodeJS.WriteStream, width, height, {
    nativeSession: driver,
    clock,
    consoleMode: "disabled",
    exitSignals: [],
    remote: true,
    ...config,
  })
  cleanups.push(async () => {
    stdout.release()
    renderer.destroy()
    await renderer.closed.catch(() => {})
  })
  return { renderer, stdout, clock, driver }
}

test("frame admission bounds delayed output to one frame and coalesces callback work", async () => {
  const { renderer, stdout, clock, driver } = createAdmissionRenderer()
  const observed: string[] = []
  const deltas: number[] = []
  let state = "A"
  let frames = 0
  renderer.on(CliRenderEvents.FRAME, () => frames++)
  renderer.setFrameCallback(async (delta) => {
    observed.push(state)
    deltas.push(delta)
  })
  const fg = RGBA.fromInts(255, 255, 255)
  const bg = RGBA.fromInts(0, 0, 0)
  renderer.addPostProcessFn((buffer) => {
    buffer.drawText(state.repeat(8), 0, 0, fg, bg)
  })

  renderer.start()
  await settleUntil(() => stdout.pendingWrite)
  expect(observed).toEqual(["A"])

  state = "B"
  for (let attempt = 0; attempt < 32; attempt++) {
    renderer.requestRender()
    clock.advance(100)
    await settle()
  }
  expect(observed).toEqual(["A"])

  state = "C"
  stdout.release()
  await driver.idle()
  for (let turn = 0; turn < 32 && observed.length < 2; turn++) {
    clock.advance(100)
    await settle()
  }
  renderer.pause()
  await renderer.idle()

  expect(observed).toEqual(["A", "C"])
  expect(frames).toBeGreaterThanOrEqual(2)
  const output = stdout.text()
  expect(output).toContain("A".repeat(8))
  expect(output).toContain("C".repeat(8))
  expect(output).not.toContain("B".repeat(8))
})

test("animation requests wait for output credit and remain cancellable", async () => {
  const { renderer, stdout, clock, driver } = createAdmissionRenderer()
  const observed: string[] = []
  renderer.addPostProcessFn((buffer) => buffer.drawText("held-animation", 0, 0, RGBA.fromInts(255, 255, 255)))
  const cancelled = renderer.requestAnimationFrame(() => observed.push("cancelled"))
  const resumed = renderer.requestAnimationFrame(() => observed.push("resumed"))
  renderer.cancelAnimationFrame(cancelled)
  renderer.cancelAnimationFrame(cancelled)
  clock.advance(100)
  await settle()
  expect(observed).toEqual([])

  stdout.release()
  await driver.idle()
  clock.advance(0)
  await settle()
  expect(renderer.liveRequestCount).toBe(0)
  expect(renderer.isRunning).toBe(false)
  await renderer.idle()
  expect(observed).toEqual(["resumed"])

  renderer.requestLive()
  renderer.cancelAnimationFrame(resumed)
  expect(renderer.liveRequestCount).toBe(1)
  renderer.dropLive()
})

for (const queuedWork of ["one-shot", "next-tick"] as const) {
  test(`stop cancels a queued ${queuedWork} without cancelling later requests`, async () => {
    const { renderer, stdout, clock } = createAdmissionRenderer()
    let callbacks = 0
    renderer.setFrameCallback(async () => {
      callbacks++
    })
    stdout.release()
    if (queuedWork === "next-tick") clock.advance(100)
    renderer.requestRender()
    expect(renderer.getSchedulerState().hasScheduledRender).toBe(true)
    renderer.stop()
    clock.advance(100)
    await settle()
    expect(callbacks).toBe(0)
    await renderer.idle()
    renderer.requestRender()
    clock.advance(100)
    await settle()
    expect(callbacks).toBe(1)
    expect(renderer.isRunning).toBe(false)
  })
}

test("same-turn stop and request renders once without asynchronous frame callbacks", async () => {
  const stdout = new RecordingWriteStream()
  const renderer = await createCliRenderer({
    stdin: createTestStdin(),
    stdout: stdout as unknown as NodeJS.WriteStream,
    consoleMode: "disabled",
    exitSignals: [],
    remote: true,
  })
  cleanups.push(async () => {
    renderer.destroy()
    await renderer.closed.catch(() => {})
  })
  let frames = 0
  let postProcesses = 0
  renderer.on(CliRenderEvents.FRAME, () => frames++)
  renderer.addPostProcessFn(() => postProcesses++)

  renderer.requestRender()
  renderer.stop()
  renderer.requestRender()
  await renderer.idle()

  expect({ frames, postProcesses }).toEqual({ frames: 1, postProcesses: 1 })
})

type BusyResize = ReturnType<typeof createAdmissionRenderer> & { sizes: number[][]; inFrame?: boolean }
const busyResizes: Record<string, () => Promise<BusyResize>> = {
  "a pending frame presentation": async () => {
    const target = createAdmissionRenderer(80, 24)
    target.renderer.requestRender()
    target.clock.advance(100)
    await settleUntil(() => target.stdout.pendingWrite)
    return { ...target, sizes: [[100, 30]] }
  },
  // The terminal may reflow cells at the skipped size, so returning to the current size repaints everything.
  "a pending frame presentation, then back to the current size": async () => {
    const target = createAdmissionRenderer(80, 24)
    let text = "A"
    target.renderer.addPostProcessFn((buffer) => buffer.drawText(text, 0, 0, RGBA.fromInts(255, 255, 255)))
    target.stdout.release()
    target.renderer.requestRender()
    target.clock.advance(100)
    await target.renderer.idle()
    target.stdout.hold()
    text = "B"
    target.renderer.requestRender()
    target.clock.advance(100)
    await settleUntil(() => target.stdout.pendingWrite)
    return {
      ...target,
      sizes: [
        [100, 30],
        [80, 24],
      ],
    }
  },
  // A split-footer width change rewrites the screen, which waits for the painted frame.
  "a split-footer frame": async () => {
    const target = createAdmissionRenderer(30, 12, { screenMode: "split-footer", footerHeight: 6 })
    target.stdout.release()
    await target.renderer.setupTerminal()
    return { ...target, sizes: [[20, 12]], inFrame: true }
  },
}

for (const [state, enter] of Object.entries(busyResizes)) {
  test(`resize() during ${state} applies once the Session is ready`, async () => {
    const { renderer, stdout, clock, sizes, inFrame } = await enter()
    const initial = [renderer.terminalWidth, renderer.terminalHeight]
    const resizes: number[][] = []
    const errors: unknown[] = []
    renderer.on(CliRenderEvents.RESIZE, (width: number, height: number) => resizes.push([width, height]))
    renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))

    const resize = () => {
      for (const [width, height] of sizes) expect(() => renderer.resize(width, height)).not.toThrow()
    }
    if (inFrame) {
      let pending = true
      renderer.addPostProcessFn(() => {
        if (pending) resize()
        pending = false
      })
      renderer.requestRender()
    } else resize()
    stdout.release()
    for (let turn = 0; turn < 8; turn++) {
      clock.advance(100)
      await settle()
    }
    await renderer.idle()

    const size = sizes.at(-1)!
    const reverted = size[0] === initial[0] && size[1] === initial[1]
    expect({ size: [renderer.terminalWidth, renderer.terminalHeight], resizes, errors }).toEqual({
      size,
      resizes: reverted ? [] : [[renderer.width, renderer.height]],
      errors: [],
    })
    if (reverted) expect(renderer.getNativeStats().cellsUpdated).toBe(renderer.width * renderer.height)
  })
}

// resize() is immediate: it replaces a debounced requestResize instead of waiting for its timer.
for (const size of [
  [90, 28],
  [80, 24],
]) {
  test(`resize(${size}) after a debounced requestResize applies at once`, async () => {
    const { renderer, stdout, clock } = createAdmissionRenderer(80, 24)
    stdout.release()
    renderer.requestRender()
    clock.advance(100)
    await renderer.idle()
    const resizes: number[][] = []
    renderer.on(CliRenderEvents.RESIZE, (width: number, height: number) => resizes.push([width, height]))

    renderer.requestResize(100, 30)
    renderer.resize(size[0], size[1])
    const applied = [renderer.terminalWidth, renderer.terminalHeight]
    clock.advance(100)
    await renderer.idle()

    const reverted = size[0] === 80 && size[1] === 24
    expect({ applied, resizes }).toEqual({ applied: size, resizes: reverted ? [] : [size] })
    if (reverted) expect(renderer.getNativeStats().cellsUpdated).toBe(renderer.width * renderer.height)
  })
}

/** Bytes that zlib and base64 cannot shrink. */
function noise(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  let x = 0x9e3779b9 + seed
  for (let index = 0; index < length; index++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    bytes[index] = x & 0xff
  }
  return bytes
}

// 413: three 12 KB Kitty uploads exceed one frame of this Session (28,672 bytes). The frame sends two and the
// renderer asks for the next frame, which sends the third; no frame fails.
test("Kitty uploads that do not fit one frame go out in the next frames", async () => {
  const { renderer, stdout, clock } = createAdmissionRenderer()
  stdout.release()
  for (let index = 0; index < 3; index++) {
    const source = NativeImage.fromRgba(noise(index, 48 * 48 * 4), 48, 48)
    renderer.root.add(
      new ImageRenderable(renderer, {
        source,
        protocol: "kitty",
        position: "absolute",
        left: index * 10,
        width: 8,
        height: 4,
      }),
    )
  }
  for (let turn = 0; turn < 8; turn++) {
    clock.advance(100)
    await settle()
  }
  await renderer.idle()
  expect(stdout.text().split("\x1b_Ga=t").length - 1).toBe(3)
})

/** Cells with their own colors, about 40 bytes each on the wire. */
function paintNoise(buffer: OptimizedBuffer, seed: number, x = 0, y = 0, width = buffer.width, height = buffer.height) {
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const shade = (column * 7 + row * 31 + seed) & 255
      buffer.setCell(
        x + column,
        y + row,
        "x",
        RGBA.fromInts(shade, 255 - shade, 9),
        RGBA.fromInts(9, shade, 255 - shade),
      )
    }
  }
}

class Noise extends Renderable {
  protected override renderSelf(buffer: OptimizedBuffer): void {
    paintNoise(buffer, 0, this.x, this.y, this.width, this.height)
  }
}

// 413: a full screen of noise (about 77 KB) is larger than one frame of this Session. It is reported once per
// content and never logged; continuous rendering keeps its cadence, and a changed content is tried again.
for (const mode of ["demand", "continuous"] as const) {
  test(`a frame too large for the output is reported once per content (${mode})`, async () => {
    const { renderer, stdout, clock } = createAdmissionRenderer()
    const errors = spyOn(console, "error").mockImplementation(() => {})
    const dropped: { bytes: number; limit: number }[] = []
    renderer.on(CliRenderEvents.FRAME_DROPPED, (event) => dropped.push(event))
    let seed = 0
    let paints = 0
    renderer.addPostProcessFn((buffer) => {
      paints++
      paintNoise(buffer, seed)
    })
    stdout.release()
    const frames = async () => {
      for (let turn = 0; turn < 5; turn++) {
        if (mode === "demand") renderer.requestRender()
        clock.advance(100)
        await settle()
      }
    }
    if (mode === "continuous") renderer.start()
    await frames()
    seed = 1
    await frames()
    renderer.pause()
    const logged = errors.mock.calls.length
    errors.mockRestore()
    expect({ events: dropped.length, logged }).toEqual({ events: 2, logged: 0 })
    // Each content was painted again on later frames, so the cadence went on after the drops.
    expect(paints).toBeGreaterThanOrEqual(8)
    expect(dropped[0]!.bytes).toBeGreaterThan(dropped[0]!.limit)
    expect(dropped[0]!.limit).toBe(28_672)
  })
}

// 413: in demand mode, one update that changes all but row 0 and is too large as a diff gets its full repaint
// without another request: noise stays too large and is reported once; a checkerboard of characters fits as a
// full repaint and is drawn.
for (const content of ["noise", "checkerboard"] as const) {
  test(`one oversize update in demand mode is retried as a full repaint (${content})`, async () => {
    const { renderer, stdout, clock } = createAdmissionRenderer()
    const dropped: unknown[] = []
    renderer.on(CliRenderEvents.FRAME_DROPPED, (event) => dropped.push(event))
    let update = false
    const fg = RGBA.fromInts(200, 200, 200)
    const bg = RGBA.fromInts(9, 9, 9)
    renderer.addPostProcessFn((buffer) => {
      buffer.drawText("header", 0, 0, fg, bg)
      if (update && content === "noise") paintNoise(buffer, 0, 0, 1, buffer.width, buffer.height - 1)
      for (let row = 1; row < buffer.height; row++) {
        for (let column = 0; column < buffer.width && content === "checkerboard"; column++) {
          buffer.setCell(column, row, update && (row + column) % 2 === 0 ? "o" : "x", fg, bg)
        }
      }
    })
    stdout.release()
    renderer.requestRender()
    clock.advance(100)
    await renderer.idle()
    const before = stdout.text().length
    update = true
    renderer.requestRender()
    for (let turn = 0; turn < 8; turn++) {
      clock.advance(100)
      await settle()
    }
    await renderer.idle()
    const drawn = stdout.text().slice(before)
    expect({ events: dropped.length, drawn: drawn.includes("oxox") }).toEqual(
      content === "noise" ? { events: 1, drawn: false } : { events: 0, drawn: true },
    )
  })
}

// 413: a scrollback commit larger than one frame goes again alone and is then dropped and reported; the commits
// around it and the footer still draw, and closing restores the terminal.
test("a scrollback commit too large for the output is dropped", async () => {
  const { renderer, stdout, clock } = createAdmissionRenderer(80, 24, { screenMode: "split-footer", footerHeight: 4 })
  const dropped: unknown[] = []
  renderer.on(CliRenderEvents.FRAME_DROPPED, (event) => dropped.push(event))
  const footer = new TextRenderable(renderer, { content: "footer-a" })
  renderer.root.add(footer)
  const writeNoise = (width = 80, trailingNewline = true) =>
    renderer.writeToScrollback((ctx) => ({
      root: new Noise(ctx.renderContext, { position: "absolute", left: 0, top: 0, width, height: 17 }),
      width,
      height: 17,
      startOnNewLine: true,
      trailingNewline,
    }))
  stdout.release()
  await renderer.setupTerminal()
  stdout.write("before\n")
  // The dropped commit ends mid-row at column 70; the next line continues "ab", not that column.
  writeNoise(70, false)
  stdout.write("ab")
  renderer.once(CliRenderEvents.FRAME_DROPPED, () => stdout.write("1234567890\n"))
  for (let turn = 0; turn < 40; turn++) {
    clock.advance(100)
    await settle()
  }
  footer.content = "ZZZZZZZZ"
  // Later commits batch again.
  for (const line of ["one", "two", "three"]) stdout.write(`${line}\n`)
  for (let turn = 0; turn < 40; turn++) {
    clock.advance(100)
    await settle()
  }
  const output = stdout.text()
  expect({ events: dropped.length, before: output.includes("before"), after: output.includes("1234567890") }).toEqual({
    events: 1,
    before: true,
    after: true,
  })
  expect(output).toContain("ZZZZZZZZ")
  expect(output).toContain("three")
  expect(output.slice(output.indexOf("one"), output.indexOf("three"))).not.toContain("\x1b[?2026l")
  // The close flush drops a commit too large for one frame as well, then restores the terminal.
  const closing = output.length
  writeNoise()
  renderer.destroy()
  await renderer.closed
  expect(dropped.length).toBe(2)
  expect(stdout.text().slice(closing)).toContain("\x1b[?25h")
})
