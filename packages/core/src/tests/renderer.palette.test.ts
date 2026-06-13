import { test, expect, describe, spyOn } from "bun:test"
import { createTestRenderer, type TestRendererOptions } from "../testing/test-renderer.js"
import { EventEmitter } from "events"
import { Buffer } from "node:buffer"
import { Readable } from "node:stream"
import tty from "tty"
import { ManualClock } from "../testing/manual-clock.js"
import type { GetPaletteOptions, TerminalColors } from "../lib/terminal-palette.js"
import { clearEnvCache } from "../lib/env.js"
import { CliRenderEvents } from "../renderer.js"
import { createTerminalCapabilities, setRendererCapabilities } from "../testing/terminal-capabilities.js"

const OSC_SUPPORT_TIMEOUT_MS = 300

function flushAsync(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve())
}

async function flushPaletteDetection(): Promise<void> {
  await flushAsync()
  await flushAsync()
}

function schedule(clock: ManualClock | undefined, fn: () => void): void {
  if (clock) {
    clock.setTimeout(fn, 0)
    return
  }

  process.nextTick(fn)
}

function createMockStreams(clock?: ManualClock, options: { emitSpecialColors?: boolean } = {}) {
  const emitSpecialColors = options.emitSpecialColors ?? true
  const mockStdin = new Readable({ read() {} }) as tty.ReadStream
  mockStdin.isTTY = true
  mockStdin.setRawMode = () => mockStdin
  mockStdin.resume = () => mockStdin
  mockStdin.pause = () => mockStdin
  mockStdin.setEncoding = () => mockStdin

  const writes: string[] = []
  const mockStdout = {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: (data: string | Buffer) => {
      writes.push(data.toString())
      const dataStr = data.toString()
      if (dataStr === "\x1b]4;0;?\x07") {
        schedule(clock, () => {
          mockStdin.emit("data", Buffer.from("\x1b]4;0;rgb:0000/0000/0000\x07"))
        })
      } else if (dataStr.includes("\x1b]4;")) {
        schedule(clock, () => {
          for (let i = 0; i < 16; i++) {
            mockStdin.emit("data", Buffer.from(`\x1b]4;${i};rgb:1000/2000/3000\x07`))
          }
        })
      } else if (emitSpecialColors && dataStr.includes("\x1b]10;?")) {
        schedule(clock, () => {
          mockStdin.emit("data", Buffer.from("\x1b]10;#ffffff\x07"))
          mockStdin.emit("data", Buffer.from("\x1b]11;#000000\x07"))
          mockStdin.emit("data", Buffer.from("\x1b]12;#00ff00\x07"))
          mockStdin.emit("data", Buffer.from("\x1b]13;#ffffff\x07"))
          mockStdin.emit("data", Buffer.from("\x1b]14;#000000\x07"))
          mockStdin.emit("data", Buffer.from("\x1b]15;#ffffff\x07"))
          mockStdin.emit("data", Buffer.from("\x1b]16;#000000\x07"))
          mockStdin.emit("data", Buffer.from("\x1b]17;#333333\x07"))
          mockStdin.emit("data", Buffer.from("\x1b]19;#cccccc\x07"))
        })
      }
      return true
    },
  } as any

  return { mockStdin, mockStdout, writes }
}

async function advancePaletteClock(clock: ManualClock, ms: number): Promise<void> {
  await flushAsync()
  // Flush queued 0ms mock terminal responses before advancing the real timeout window.
  clock.advance(0)
  await flushAsync()
  clock.advance(ms)
  await flushAsync()
}

async function detectPaletteAndAdvanceClock(
  renderer: {
    getPalette(options?: GetPaletteOptions): Promise<TerminalColors>
    paletteDetectionStatus: "idle" | "detecting" | "cached"
  },
  clock: ManualClock,
  options?: GetPaletteOptions,
): Promise<TerminalColors> {
  const palettePromise = renderer.getPalette(options)

  if (renderer.paletteDetectionStatus === "detecting") {
    const detectionTimeoutMs = Math.max(options?.timeout ?? 5000, OSC_SUPPORT_TIMEOUT_MS)
    await advancePaletteClock(clock, detectionTimeoutMs)
  } else {
    await flushAsync()
  }

  return palettePromise
}

async function createPaletteRenderer(options: Partial<TestRendererOptions> & { emitSpecialColors?: boolean } = {}) {
  const clock = options.clock instanceof ManualClock ? options.clock : new ManualClock()
  const { mockStdin, mockStdout, writes } = createMockStreams(clock, { emitSpecialColors: options.emitSpecialColors })
  const { emitSpecialColors, ...rendererOptions } = options
  const { renderer } = await createTestRenderer({
    stdin: mockStdin,
    stdout: mockStdout,
    ...rendererOptions,
    clock,
  })

  return { renderer, mockStdin, mockStdout, writes, clock }
}

async function createSilentFollowUpPaletteRenderer(clock = new ManualClock()) {
  const mockStdin = new EventEmitter() as any
  mockStdin.isTTY = true
  mockStdin.setRawMode = () => {}
  mockStdin.resume = () => {}
  mockStdin.pause = () => {}
  mockStdin.setEncoding = () => {}

  const writes: string[] = []
  const mockStdout = {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: (data: string | Buffer) => {
      const dataStr = data.toString()
      writes.push(dataStr)

      if (dataStr === "\x1b]4;0;?\x07") {
        clock.setTimeout(() => {
          mockStdin.emit("data", Buffer.from("\x1b]4;0;rgb:0000/0000/0000\x07"))
        }, 0)
      }

      return true
    },
  } as any

  const { renderer } = await createTestRenderer({
    stdin: mockStdin,
    stdout: mockStdout,
    clock,
    useThread: false,
  })

  setRendererCapabilities(renderer, {
    multiplexer: "none",
    terminal: { name: "", version: "", from_xtversion: false },
  })

  return { renderer, writes, clock }
}

function startCapabilityDetectionWindow(renderer: any, clock: ManualClock): void {
  renderer._terminalIsSetup = true
  renderer.capabilityTimeoutId = clock.setTimeout(() => {
    renderer.capabilityTimeoutId = null
    renderer.resolveXtVersionWaiters()
  }, 5000)
}

function setNativePaletteRequired(renderer: any): void {
  renderer._terminalIsSetup = true
  setRendererCapabilities(renderer, {
    ...renderer._capabilities,
    rgb: false,
    ansi256: true,
    terminal: renderer._capabilities?.terminal ?? { from_xtversion: false, name: "", version: "" },
  })
}

function setNativePaletteUnneeded(renderer: any): void {
  renderer._terminalIsSetup = true
  setRendererCapabilities(renderer, {
    ...renderer._capabilities,
    rgb: true,
    ansi256: true,
    terminal: renderer._capabilities?.terminal ?? { from_xtversion: false, name: "", version: "" },
  })
}

describe("Palette caching behavior", () => {
  test("getPalette returns cached palette on subsequent calls", async () => {
    const { renderer, clock, mockStdin, mockStdout } = await createPaletteRenderer()

    const palette1 = await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })
    const palette2 = await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })

    expect(palette1).toBe(palette2)
    expect(palette1).toEqual(palette2)

    renderer.destroy()
  })

  test("getPalette caches correctly with non-256 size parameter", async () => {
    const { renderer, clock, mockStdin, mockStdout } = await createPaletteRenderer()

    const palette1 = await detectPaletteAndAdvanceClock(renderer, clock, { size: 16, timeout: 300 })
    const palette2 = await detectPaletteAndAdvanceClock(renderer, clock, { size: 16, timeout: 300 })

    expect(palette1).toBe(palette2)
    expect(renderer.paletteDetectionStatus).toBe("cached")

    renderer.destroy()
  })

  test("cached palette is returned instantly", async () => {
    const { renderer, clock, mockStdin, mockStdout, writes } = await createPaletteRenderer()

    await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })
    const writeCountAfterFirst = writes.length

    const timeAfterFirstDetection = clock.now()
    await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })

    expect(clock.now()).toBe(timeAfterFirstDetection)
    expect(writes.length).toBe(writeCountAfterFirst)

    renderer.destroy()
  })

  test("multiple concurrent calls share same detection", async () => {
    const { renderer, clock, mockStdin, mockStdout, writes } = await createPaletteRenderer()

    const palettePromises = [
      renderer.getPalette({ timeout: 300 }),
      renderer.getPalette({ timeout: 300 }),
      renderer.getPalette({ timeout: 300 }),
    ]

    await advancePaletteClock(clock, 300)

    const [palette1, palette2, palette3] = await Promise.all(palettePromises)

    expect(palette1).toBe(palette2)
    expect(palette2).toBe(palette3)

    const oscSupportChecks = writes.filter((w) => w.includes("\x1b]4;0;?"))
    expect(oscSupportChecks.length).toBeLessThanOrEqual(2)

    renderer.destroy()
  })

  test("concurrent requests with different sizes redetect for the later caller", async () => {
    const { renderer, clock } = await createPaletteRenderer()

    const palette16Promise = renderer.getPalette({ size: 16, timeout: 300 })
    const palette256Promise = renderer.getPalette({ size: 256, timeout: 300 })

    await advancePaletteClock(clock, 300)
    await flushAsync()

    expect(renderer.paletteDetectionStatus).toBe("detecting")

    await advancePaletteClock(clock, 300)

    const [palette16, palette256] = await Promise.all([palette16Promise, palette256Promise])

    expect(palette16.palette).toHaveLength(16)
    expect(palette256.palette).toHaveLength(256)
    expect(palette16).not.toBe(palette256)

    renderer.destroy()
  })

  test("palette detector created only once", async () => {
    const { renderer, clock, mockStdin, mockStdout } = await createPaletteRenderer()

    // @ts-expect-error - accessing private property for testing
    expect(renderer._paletteDetector).toBeNull()

    await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })

    // @ts-expect-error - accessing private property for testing
    const detector1 = renderer._paletteDetector
    expect(detector1).not.toBeNull()

    await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })

    // @ts-expect-error - accessing private property for testing
    const detector2 = renderer._paletteDetector
    expect(detector1).toBe(detector2)

    renderer.destroy()
  })

  test("cache persists with different timeout values", async () => {
    const { renderer, clock, mockStdin, mockStdout, writes } = await createPaletteRenderer()

    const palette1 = await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 100 })
    const writeCountAfterFirst = writes.length

    const palette2 = await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 5000 })

    expect(writes.length).toBe(writeCountAfterFirst)
    expect(palette1).toBe(palette2)

    renderer.destroy()
  })

  test("cache persists across renderer lifecycle", async () => {
    const { renderer, clock, mockStdin, mockStdout } = await createPaletteRenderer()

    const palette1 = await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })

    renderer.start()
    await flushAsync()
    renderer.pause()
    renderer.suspend()
    renderer.resume()
    renderer.stop()

    const palette2 = await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 100 })
    expect(palette1).toBe(palette2)

    renderer.destroy()
  })
})

describe("Palette detection with non-TTY", () => {
  test("handles non-TTY streams gracefully", async () => {
    const clock = new ManualClock()
    const mockStdin = new EventEmitter() as any
    mockStdin.isTTY = false
    mockStdin.setRawMode = () => {}
    mockStdin.resume = () => {}
    mockStdin.pause = () => {}
    mockStdin.setEncoding = () => {}

    const mockStdout = {
      isTTY: false,
      columns: 80,
      rows: 24,
      write: () => true,
    } as any

    const { renderer } = await createTestRenderer({
      stdin: mockStdin,
      stdout: mockStdout,
      clock,
    })

    const palette = await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 100 })

    expect(typeof palette === "object" && palette !== null && Array.isArray(palette.palette)).toBe(true)

    const cached = await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 100 })
    expect(palette).toBe(cached)

    renderer.destroy()
  })
})

describe("Palette detection with OSC responses", () => {
  test("detects colors from OSC responses", async () => {
    const clock = new ManualClock()
    const mockStdin = new EventEmitter() as any
    mockStdin.isTTY = true
    mockStdin.setRawMode = () => {}
    mockStdin.resume = () => {}
    mockStdin.pause = () => {}
    mockStdin.setEncoding = () => {}

    const mockStdout = {
      isTTY: true,
      columns: 80,
      rows: 24,
      write: (data: string | Buffer) => {
        const dataStr = data.toString()
        clock.setTimeout(() => {
          if (dataStr.includes("\x1b]4;0;?")) {
            mockStdin.emit("data", Buffer.from("\x1b]4;0;#000000\x07"))
          }
          if (dataStr.match(/\x1b\]4;\d+;/g)) {
            mockStdin.emit("data", Buffer.from("\x1b]4;0;#000000\x07"))
            mockStdin.emit("data", Buffer.from("\x1b]4;1;#ff0000\x07"))
            mockStdin.emit("data", Buffer.from("\x1b]4;2;#00ff00\x07"))
            mockStdin.emit("data", Buffer.from("\x1b]4;3;#0000ff\x07"))
            for (let i = 4; i < 256; i++) {
              mockStdin.emit("data", Buffer.from(`\x1b]4;${i};#808080\x07`))
            }
          }
        }, 0)
        return true
      },
    } as any

    const { renderer } = await createTestRenderer({
      stdin: mockStdin,
      stdout: mockStdout,
      useThread: false,
      clock,
    })

    const palette = await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })

    expect(typeof palette === "object" && palette !== null && Array.isArray(palette.palette)).toBe(true)
    expect(palette.palette.length).toBeGreaterThanOrEqual(16)
    expect(palette.palette[0]).toBe("#000000")
    expect(palette.palette[1]).toBe("#ff0000")
    expect(palette.palette[2]).toBe("#00ff00")
    expect(palette.palette[3]).toBe("#0000ff")

    const cached = await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 100 })
    expect(palette).toBe(cached)

    renderer.destroy()
  })

  test("handles RGB format responses", async () => {
    const clock = new ManualClock()
    const mockStdin = new EventEmitter() as any
    mockStdin.isTTY = true
    mockStdin.setRawMode = () => {}
    mockStdin.resume = () => {}
    mockStdin.pause = () => {}
    mockStdin.setEncoding = () => {}

    const mockStdout = {
      isTTY: true,
      columns: 80,
      rows: 24,
      write: (data: string | Buffer) => {
        const dataStr = data.toString()
        clock.setTimeout(() => {
          if (dataStr.includes("\x1b]4;0;?")) {
            mockStdin.emit("data", Buffer.from("\x1b]4;0;rgb:0000/0000/0000\x07"))
          }
          if (dataStr.match(/\x1b\]4;\d+;/g)) {
            mockStdin.emit("data", Buffer.from("\x1b]4;0;rgb:0000/0000/0000\x07"))
            mockStdin.emit("data", Buffer.from("\x1b]4;1;rgb:ffff/0000/0000\x07"))
            mockStdin.emit("data", Buffer.from("\x1b]4;2;rgb:8000/8000/8000\x07"))
            for (let i = 3; i < 256; i++) {
              mockStdin.emit("data", Buffer.from(`\x1b]4;${i};rgb:1111/1111/1111\x07`))
            }
          }
        }, 0)
        return true
      },
    } as any

    const { renderer } = await createTestRenderer({
      stdin: mockStdin,
      stdout: mockStdout,
      useThread: false,
      clock,
    })

    const palette = await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })

    expect(palette.palette[0]).toBe("#000000")
    expect(palette.palette[1]).toBe("#ff0000")
    expect(palette.palette[2]).toBe("#808080")

    renderer.destroy()
  })
})

describe("Palette integration tests", () => {
  test("palette detection does not interfere with input handling", async () => {
    const { renderer, clock, mockStdin, mockStdout } = await createPaletteRenderer()

    const keysReceived: string[] = []
    renderer.keyInput.on("keypress", (event) => {
      keysReceived.push(event.name || "unknown")
    })

    const palettePromise = renderer.getPalette({ timeout: 300 })

    mockStdin.emit("data", Buffer.from("a"))
    mockStdin.emit("data", Buffer.from("b"))
    mockStdin.emit("data", Buffer.from("c"))

    await flushAsync()

    expect(keysReceived.length).toBeGreaterThanOrEqual(3)

    await advancePaletteClock(clock, 300)
    await palettePromise

    renderer.destroy()
  })

  test("getPalette works with different renderer configurations", async () => {
    const configs = [{ width: 40, height: 10 }, { width: 120, height: 40 }, { useMouse: false }]

    for (const config of configs) {
      const { renderer: testRenderer, clock, mockStdin, mockStdout } = await createPaletteRenderer(config)

      const palette = await detectPaletteAndAdvanceClock(testRenderer, clock, { timeout: 300 })
      expect(typeof palette === "object" && palette !== null && Array.isArray(palette.palette)).toBe(true)

      const cached = await detectPaletteAndAdvanceClock(testRenderer, clock, { timeout: 100 })
      expect(palette).toBe(cached)

      testRenderer.destroy()
    }
  })
})

describe("Palette cache invalidation", () => {
  test("clearPaletteCache invalidates cache", async () => {
    const { renderer, clock, mockStdin, mockStdout } = await createPaletteRenderer()

    const palette1 = await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })
    expect(renderer.paletteDetectionStatus).toBe("cached")

    renderer.clearPaletteCache()
    expect(renderer.paletteDetectionStatus).toBe("idle")

    const palette2 = await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })

    expect(palette1).not.toBe(palette2)
    expect(renderer.paletteDetectionStatus).toBe("cached")

    renderer.destroy()
  })

  test("getPalette syncs native palette state again after cache invalidation and refetch", async () => {
    const { renderer, clock } = await createPaletteRenderer({ emitSpecialColors: false })
    setNativePaletteRequired(renderer)
    // @ts-expect-error - spying on private method for native palette publishing behavior
    const sync = spyOn(renderer, "syncNativePaletteState")

    await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })
    expect(sync).toHaveBeenCalledTimes(1)

    renderer.clearPaletteCache()
    await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })

    expect(sync).toHaveBeenCalledTimes(2)

    sync.mockRestore()
    renderer.destroy()
  })

  test("theme mode changes clear palette cache and schedule native palette refresh when native palette is needed", async () => {
    const { renderer } = await createPaletteRenderer()
    setNativePaletteRequired(renderer)
    const clear = spyOn(renderer, "clearPaletteCache")
    // @ts-expect-error - spying on private method for native palette refresh scheduling
    const refresh = spyOn(renderer, "refreshPalette")

    renderer.stdin.emit("data", Buffer.from("\x1b]10;#ffffff\x07"))
    renderer.stdin.emit("data", Buffer.from("\x1b]11;#000000\x07"))
    await flushAsync()

    expect(renderer.themeMode).toBe("dark")
    expect(clear).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)

    clear.mockRestore()
    refresh.mockRestore()
    renderer.destroy()
  })

  test("theme mode changes schedule palette refresh for truecolor terminals with palette listeners", async () => {
    const { renderer } = await createPaletteRenderer()
    setNativePaletteUnneeded(renderer)
    // @ts-expect-error - spying on private method for palette refresh scheduling
    const refresh = spyOn(renderer, "refreshPalette")
    renderer.on(CliRenderEvents.PALETTE, () => {})

    renderer.stdin.emit("data", Buffer.from("\x1b]10;#ffffff\x07"))
    renderer.stdin.emit("data", Buffer.from("\x1b]11;#000000\x07"))
    await flushAsync()

    expect(renderer.themeMode).toBe("dark")
    expect(refresh).toHaveBeenCalledTimes(1)

    refresh.mockRestore()
    renderer.destroy()
  })

  test("theme mode changes skip palette refresh for truecolor terminals without palette listeners", async () => {
    const { renderer } = await createPaletteRenderer()
    setNativePaletteUnneeded(renderer)
    // @ts-expect-error - spying on private method for palette refresh scheduling
    const refresh = spyOn(renderer, "refreshPalette")

    renderer.stdin.emit("data", Buffer.from("\x1b]10;#ffffff\x07"))
    renderer.stdin.emit("data", Buffer.from("\x1b]11;#000000\x07"))
    await flushAsync()

    expect(renderer.themeMode).toBe("dark")
    expect(refresh).not.toHaveBeenCalled()

    refresh.mockRestore()
    renderer.destroy()
  })

  test("startup palette refresh is skipped for truecolor terminals", async () => {
    const { renderer, writes } = await createPaletteRenderer()
    setNativePaletteUnneeded(renderer)

    // Startup only calls refresh when native palette state is useful.
    // @ts-expect-error - exercising private startup palette gate
    if (renderer.shouldSyncNativePaletteState()) renderer.refreshPalette()

    expect(writes).toEqual([])

    renderer.destroy()
  })

  test("setupTerminal does not refresh palette on truecolor startup", async () => {
    const { renderer } = await createPaletteRenderer({ useMouse: false })
    const lib = (renderer as unknown as { lib: any }).lib
    const originalSetupTerminal = lib.setupTerminal
    const originalGetTerminalCapabilities = lib.getTerminalCapabilities
    const originalQueryPixelResolution = lib.queryPixelResolution
    // @ts-expect-error - spying on private method for startup palette gate
    const refresh = spyOn(renderer, "refreshPalette")

    lib.setupTerminal = () => {}
    lib.queryPixelResolution = () => {}
    lib.getTerminalCapabilities = () =>
      createTerminalCapabilities({
        rgb: true,
        ansi256: true,
        terminal: { name: "Apple_Terminal", version: "", from_xtversion: false },
      })

    await renderer.setupTerminal()

    expect(refresh).not.toHaveBeenCalled()

    refresh.mockRestore()
    lib.setupTerminal = originalSetupTerminal
    lib.getTerminalCapabilities = originalGetTerminalCapabilities
    lib.queryPixelResolution = originalQueryPixelResolution
    renderer.destroy()
  })

  test("setupTerminal refreshes palette on ANSI-256 non-truecolor startup", async () => {
    const { renderer } = await createPaletteRenderer({ useMouse: false })
    const lib = (renderer as unknown as { lib: any }).lib
    const originalSetupTerminal = lib.setupTerminal
    const originalGetTerminalCapabilities = lib.getTerminalCapabilities
    const originalQueryPixelResolution = lib.queryPixelResolution
    // @ts-expect-error - spying on private method for startup palette gate
    const refresh = spyOn(renderer, "refreshPalette").mockImplementation(() => {})

    lib.setupTerminal = () => {}
    lib.queryPixelResolution = () => {}
    lib.getTerminalCapabilities = () =>
      createTerminalCapabilities({
        rgb: false,
        ansi256: true,
        terminal: { name: "Apple_Terminal", version: "", from_xtversion: false },
      })

    await renderer.setupTerminal()

    expect(refresh).toHaveBeenCalledTimes(1)

    refresh.mockRestore()
    lib.setupTerminal = originalSetupTerminal
    lib.getTerminalCapabilities = originalGetTerminalCapabilities
    lib.queryPixelResolution = originalQueryPixelResolution
    renderer.destroy()
  })

  test("getPalette emits palette change events for refreshed palettes", async () => {
    const { renderer, clock } = await createPaletteRenderer({ emitSpecialColors: false })
    const palettes: TerminalColors[] = []
    renderer.on(CliRenderEvents.PALETTE, (colors) => palettes.push(colors))

    await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })
    await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })

    expect(palettes).toHaveLength(1)
    expect(palettes[0]?.palette.length).toBe(16)

    renderer.destroy()
  })

  test("paletteDetectionStatus tracks detection lifecycle", async () => {
    const { renderer, clock, mockStdin, mockStdout } = await createPaletteRenderer()

    expect(renderer.paletteDetectionStatus).toBe("idle")

    const palettePromise = renderer.getPalette({ timeout: 300 })
    expect(renderer.paletteDetectionStatus).toBe("detecting")

    await advancePaletteClock(clock, 300)
    await palettePromise
    expect(renderer.paletteDetectionStatus).toBe("cached")

    renderer.destroy()
  })
})

describe("Capability repaint handling", () => {
  test("capability responses request a forced repaint", async () => {
    const clock = new ManualClock()
    const { renderer } = await createTestRenderer({ clock })
    const lib = (renderer as unknown as { lib: any }).lib

    const renderSpy = spyOn(lib, "render")
    const originalProcessCapabilityResponse = lib.processCapabilityResponse
    const originalGetTerminalCapabilities = lib.getTerminalCapabilities

    lib.processCapabilityResponse = () => {}
    lib.getTerminalCapabilities = () => createTerminalCapabilities({ rgb: true, ansi256: true, unicode: "unicode" })

    // @ts-expect-error - testing private renderer state
    expect(renderer.forceFullRepaintRequested).toBe(false)

    // @ts-expect-error - testing private renderer method
    renderer.capabilityHandler("\x1bP>|wezterm\x1b\\")

    // @ts-expect-error - testing private renderer state
    expect(renderer.forceFullRepaintRequested).toBe(true)
    // @ts-expect-error - testing private renderer state
    expect(renderer.updateScheduled).toBe(true)

    // @ts-expect-error - testing private renderer method
    await renderer.activateFrame()

    const lastCall = renderSpy.mock.calls[renderSpy.mock.calls.length - 1]
    expect(lastCall?.[1]).toBe(true)

    renderSpy.mockRestore()
    lib.processCapabilityResponse = originalProcessCapabilityResponse
    lib.getTerminalCapabilities = originalGetTerminalCapabilities
    renderer.destroy()
  })
})

describe("Palette detection with suspended renderer", () => {
  test("getPalette throws error when renderer is suspended", async () => {
    const { renderer, clock, mockStdin, mockStdout } = await createPaletteRenderer()

    renderer.suspend()

    await expect(renderer.getPalette({ timeout: 300 })).rejects.toThrow(
      "Cannot detect palette while renderer is suspended",
    )

    renderer.destroy()
  })

  test("getPalette works after resume", async () => {
    const { renderer, clock, mockStdin, mockStdout } = await createPaletteRenderer()

    renderer.suspend()
    renderer.resume()

    const palette = await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })
    expect(typeof palette === "object" && palette !== null && Array.isArray(palette.palette)).toBe(true)

    renderer.destroy()
  })
})

describe("Palette detector cleanup", () => {
  test("destroy cleans up palette detector", async () => {
    const { renderer, clock, mockStdin, mockStdout } = await createPaletteRenderer()

    await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })

    renderer.destroy()

    // @ts-expect-error - accessing private property for testing
    expect(renderer._paletteDetector).toBeNull()
    // @ts-expect-error - accessing private property for testing
    expect(renderer._paletteDetectionPromise).toBeNull()
    // @ts-expect-error - accessing private property for testing
    expect(renderer._paletteCache.size).toBe(0)
  })

  test("destroy ignores pending native palette publish", async () => {
    const { renderer, clock } = await createPaletteRenderer()
    setNativePaletteRequired(renderer)

    await detectPaletteAndAdvanceClock(renderer, clock, { size: 256, timeout: 300 })
    // @ts-expect-error - spying on private method for testing
    const sync = spyOn(renderer, "syncNativePaletteState")
    const requestRender = spyOn(renderer, "requestRender")

    // @ts-expect-error - accessing private method for testing
    renderer.refreshPalette()
    renderer.destroy()
    await flushAsync()

    expect(sync).not.toHaveBeenCalled()
    expect(requestRender).not.toHaveBeenCalled()

    sync.mockRestore()
    requestRender.mockRestore()
  })

  test("destroy during render ignores pending palette detection publish", async () => {
    const { renderer, clock } = await createPaletteRenderer()

    // @ts-expect-error - spying on private method for testing
    const sync = spyOn(renderer, "syncNativePaletteState")
    const palettePromise = renderer.getPalette({ size: 256, timeout: 300 })

    // @ts-expect-error - simulating destroy while a frame is unwinding
    renderer.rendering = true
    renderer.destroy()
    await advancePaletteClock(clock, 300)
    await palettePromise

    expect(sync).not.toHaveBeenCalled()

    sync.mockRestore()

    // @ts-expect-error - finish deferred destroy cleanup for the test renderer
    renderer.rendering = false
    // @ts-expect-error - finish deferred destroy cleanup for the test renderer
    renderer.finalizeDestroy()
  })

  test("destroy stops pending palette detector writes", async () => {
    const { renderer, clock } = await createPaletteRenderer({ useThread: false })

    // @ts-expect-error - spying on private method for testing
    const writeOut = spyOn(renderer, "writeOut")
    const palettePromise = renderer.getPalette({ size: 16, timeout: 300 })

    await flushAsync()
    clock.advance(0)
    renderer.destroy()
    await flushAsync()
    clock.advance(300)
    await palettePromise

    expect(writeOut).toHaveBeenCalledTimes(1)

    writeOut.mockRestore()
  })

  test("multiple destroy calls don't cause errors", async () => {
    const { renderer, clock, mockStdin, mockStdout } = await createPaletteRenderer()

    await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 300 })

    expect(() => {
      renderer.destroy()
      renderer.destroy()
      renderer.destroy()
    }).not.toThrow()
  })

  test("palette detection uses router OSC source without extra stdin listeners", async () => {
    const { renderer, clock, mockStdin, mockStdout } = await createPaletteRenderer()

    const baselineListenerCount = mockStdin.listenerCount("data")
    const palettePromise = renderer.getPalette({ timeout: 300 })

    const duringDetectionCount = mockStdin.listenerCount("data")
    expect(duringDetectionCount).toBe(baselineListenerCount)

    await advancePaletteClock(clock, 300)
    await palettePromise

    const afterDetectionCount = mockStdin.listenerCount("data")
    expect(afterDetectionCount).toBe(baselineListenerCount)

    renderer.destroy()
  })
})

describe("Palette detection while capabilities are unsettled", () => {
  test("getPalette runs immediately outside tmux", async () => {
    const { renderer, writes, clock } = await createSilentFollowUpPaletteRenderer()

    try {
      setRendererCapabilities(renderer, {
        multiplexer: "none",
        terminal: { name: "", version: "", from_xtversion: false },
      })
      startCapabilityDetectionWindow(renderer, clock)

      expect(renderer.capabilities?.multiplexer).toBe("none")

      void renderer.getPalette({ size: 16 })
      await flushAsync()

      expect(writes).toContain("\x1b]4;0;?\x07")
    } finally {
      renderer.destroy()
    }
  })

  test("getPalette defers local tmux palette detection while tmux version is unknown", async () => {
    const { renderer, writes, clock } = await createSilentFollowUpPaletteRenderer()

    try {
      setRendererCapabilities(renderer, {
        multiplexer: "tmux",
        terminal: { name: "", version: "", from_xtversion: false },
      })
      startCapabilityDetectionWindow(renderer, clock)

      expect(renderer.capabilities?.multiplexer).toBe("tmux")
      expect(renderer.capabilities?.terminal?.from_xtversion).toBe(false)

      void renderer.getPalette({ size: 16 })
      await flushAsync()

      expect(writes).toEqual([])
      expect(renderer.paletteDetectionStatus).toBe("idle")
    } finally {
      renderer.destroy()
    }
  })

  test("getPalette does not wait when tmux version came from env", async () => {
    const { renderer, writes, clock } = await createSilentFollowUpPaletteRenderer()

    try {
      setRendererCapabilities(renderer, {
        multiplexer: "tmux",
        rgb: true,
        ansi256: true,
        terminal: { name: "tmux", version: "3.6a", from_xtversion: false },
      })
      startCapabilityDetectionWindow(renderer, clock)

      void renderer.getPalette({ size: 16 })
      await flushAsync()

      expect(writes).toContain("\x1b]4;0;?\x07")
    } finally {
      renderer.destroy()
    }
  })

  test("getPalette uses wrapped palette queries after legacy tmux version is detected", async () => {
    const { renderer, writes, clock } = await createSilentFollowUpPaletteRenderer()

    try {
      setRendererCapabilities(renderer, {
        multiplexer: "tmux",
        terminal: { name: "", version: "", from_xtversion: false },
      })
      startCapabilityDetectionWindow(renderer, clock)

      void renderer.getPalette({ size: 16 })
      await flushAsync()

      expect(writes).toEqual([])

      // @ts-expect-error - simulating the asynchronous XTVERSION response path
      renderer.processCapabilitySequence("\x1bP>|tmux 3.5a\x1b\\", false)
      await flushAsync()

      expect(writes.some((write) => write.startsWith("\x1bPtmux;"))).toBe(true)
      expect(writes.some((write) => write.includes("\x1b\x1b]4;0;?\x07"))).toBe(true)
    } finally {
      renderer.destroy()
    }
  })

  test("getPalette uses plain palette queries after tmux 3.6 version is detected", async () => {
    const { renderer, writes, clock } = await createSilentFollowUpPaletteRenderer()

    try {
      setRendererCapabilities(renderer, {
        multiplexer: "tmux",
        terminal: { name: "", version: "", from_xtversion: false },
      })
      startCapabilityDetectionWindow(renderer, clock)

      void renderer.getPalette({ size: 16 })
      await flushAsync()

      expect(writes).toEqual([])

      // @ts-expect-error - simulating the asynchronous XTVERSION response path
      renderer.processCapabilitySequence("\x1bP>|tmux 3.6a\x1b\\", false)
      await flushAsync()

      expect(writes).toContain("\x1b]4;0;?\x07")
      expect(writes.some((write) => write.startsWith("\x1bPtmux;"))).toBe(false)
    } finally {
      renderer.destroy()
    }
  })

  test("getPalette does not wait for remote XTVERSION when local tmux env is unknown", async () => {
    const { renderer, writes, clock } = await createSilentFollowUpPaletteRenderer()

    try {
      setRendererCapabilities(renderer, {
        remote: true,
        multiplexer: "none",
        terminal: { name: "", version: "", from_xtversion: false },
      })
      startCapabilityDetectionWindow(renderer, clock)

      void renderer.getPalette({ size: 16 })
      await flushAsync()

      expect(renderer.capabilities?.multiplexer).toBe("none")
      expect(writes).toContain("\x1b]4;0;?\x07")
    } finally {
      renderer.destroy()
    }
  })
})

describe("Palette detection error handling", () => {
  test("getPalette settles after idle window when follow-up palette queries are silent", async () => {
    const { renderer, writes, clock } = await createSilentFollowUpPaletteRenderer()

    let settled = false
    let palette: TerminalColors | undefined
    const palettePromise = renderer.getPalette({ size: 16 }).then((result) => {
      settled = true
      palette = result
    })

    try {
      await flushAsync()
      clock.advance(0)
      await flushAsync()

      expect(writes).toContain("\x1b]4;0;?\x07")
      expect(writes.some((write) => write.includes("\x1b]4;1;?\x07"))).toBe(true)
      expect(writes.some((write) => write.includes("\x1b]10;?\x07"))).toBe(true)

      clock.advance(299)
      await flushAsync()
      expect(settled).toBe(false)

      clock.advance(1)
      await flushPaletteDetection()

      expect(settled).toBe(true)
      await palettePromise
      expect(palette?.palette.every((color) => color === null)).toBe(true)
    } finally {
      renderer.destroy()
    }
  })

  test("getPalette silent follow-up idle window is configurable with OTUI_PALETTE_IDLE_TIMEOUT_MS", async () => {
    const previousIdleTimeout = process.env.OTUI_PALETTE_IDLE_TIMEOUT_MS
    process.env.OTUI_PALETTE_IDLE_TIMEOUT_MS = "50"
    clearEnvCache()

    const { renderer, clock } = await createSilentFollowUpPaletteRenderer()
    let settled = false
    const palettePromise = renderer.getPalette({ size: 16 }).then(() => {
      settled = true
    })

    try {
      await flushAsync()
      clock.advance(0)
      await flushAsync()

      clock.advance(49)
      await flushAsync()
      expect(settled).toBe(false)

      clock.advance(1)
      await flushPaletteDetection()

      expect(settled).toBe(true)
      await palettePromise
    } finally {
      renderer.destroy()
      if (previousIdleTimeout === undefined) {
        delete process.env.OTUI_PALETTE_IDLE_TIMEOUT_MS
      } else {
        process.env.OTUI_PALETTE_IDLE_TIMEOUT_MS = previousIdleTimeout
      }
      clearEnvCache()
    }
  })

  test("handles timeout gracefully", async () => {
    const clock = new ManualClock()
    const mockStdin = new EventEmitter() as any
    mockStdin.isTTY = true
    mockStdin.setRawMode = () => {}
    mockStdin.resume = () => {}
    mockStdin.pause = () => {}
    mockStdin.setEncoding = () => {}

    const mockStdout = {
      isTTY: true,
      columns: 80,
      rows: 24,
      write: () => true,
    } as any

    const { renderer } = await createTestRenderer({
      stdin: mockStdin,
      stdout: mockStdout,
      clock,
    })

    const palette = await detectPaletteAndAdvanceClock(renderer, clock, { timeout: 100 })
    expect(typeof palette === "object" && palette !== null && Array.isArray(palette.palette)).toBe(true)
    expect(palette.palette.every((c) => c === null)).toBe(true)

    renderer.destroy()
  })

  test("handles stdin listener restoration on error", async () => {
    const { renderer, clock, mockStdin, mockStdout } = await createPaletteRenderer()

    try {
      const palettePromise = renderer.getPalette({ timeout: 300 })
      await advancePaletteClock(clock, 300)
      await palettePromise
    } catch (error) {}

    const listenerCount = mockStdin.listenerCount("data")
    expect(listenerCount).toBeGreaterThan(0)

    renderer.destroy()
  })
})

describe("Palette cache with different sizes", () => {
  test("cache works correctly when requesting size=16 twice", async () => {
    const { renderer, clock, mockStdin, mockStdout, writes } = await createPaletteRenderer()

    const palette1 = await detectPaletteAndAdvanceClock(renderer, clock, { size: 16, timeout: 300 })
    const writeCountAfterFirst = writes.length

    expect(renderer.paletteDetectionStatus).toBe("cached")
    expect(palette1.palette.length).toBe(16)

    const timeAfterFirstDetection = clock.now()
    const palette2 = await detectPaletteAndAdvanceClock(renderer, clock, { size: 16, timeout: 300 })

    expect(clock.now()).toBe(timeAfterFirstDetection)
    expect(writes.length).toBe(writeCountAfterFirst)
    expect(palette1).toBe(palette2)
    expect(renderer.paletteDetectionStatus).toBe("cached")

    renderer.destroy()
  })

  test("cache is invalidated when requesting different size", async () => {
    const { renderer, clock, mockStdin, mockStdout, writes } = await createPaletteRenderer({ useThread: false })

    const palette1 = await detectPaletteAndAdvanceClock(renderer, clock, { size: 16, timeout: 300 })
    const writeCountAfter16 = writes.length

    const palette2 = await detectPaletteAndAdvanceClock(renderer, clock, { size: 256, timeout: 300 })
    const writeCountAfter256 = writes.length

    expect(writeCountAfter256).toBeGreaterThan(writeCountAfter16)
    expect(palette1).not.toBe(palette2)

    renderer.destroy()
  })

  test("cache persists across multiple identical size requests", async () => {
    const { renderer, clock, mockStdin, mockStdout, writes } = await createPaletteRenderer()

    const palette1 = await detectPaletteAndAdvanceClock(renderer, clock, { size: 16, timeout: 300 })
    const writeCountAfterFirst = writes.length

    const palette2 = await detectPaletteAndAdvanceClock(renderer, clock, { size: 16, timeout: 300 })
    const palette3 = await detectPaletteAndAdvanceClock(renderer, clock, { size: 16, timeout: 300 })
    const palette4 = await detectPaletteAndAdvanceClock(renderer, clock, { size: 16, timeout: 300 })

    expect(writes.length).toBe(writeCountAfterFirst)
    expect(palette1).toBe(palette2)
    expect(palette2).toBe(palette3)
    expect(palette3).toBe(palette4)

    renderer.destroy()
  })

  test("cached call is significantly faster than initial detection", async () => {
    const { renderer, clock, mockStdin, mockStdout } = await createPaletteRenderer()

    await detectPaletteAndAdvanceClock(renderer, clock, { size: 16, timeout: 300 })
    const timeAfterFirstDetection = clock.now()

    await detectPaletteAndAdvanceClock(renderer, clock, { size: 16, timeout: 300 })

    expect(clock.now()).toBe(timeAfterFirstDetection)

    renderer.destroy()
  })
})
