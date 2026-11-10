import { test, expect } from "bun:test"
import { TerminalPalette, normalizeTerminalPalette } from "./terminal-palette.js"
import { EventEmitter } from "events"
import { Buffer } from "node:buffer"
import { ManualClock } from "../testing/manual-clock.js"

class MockStream extends EventEmitter {
  isTTY = true
  isRaw = false
  isPaused() {
    return false
  }
  write(_data: string) {
    return true
  }
}

function createPaletteHarness(
  options: {
    writeFn?: (data: string | Buffer) => boolean
    isLegacyTmux?: boolean
    isTmux?: boolean
    oscSource?: {
      subscribeOsc(handler: (sequence: string) => void): () => void
    }
  } = {},
) {
  const stdin = new MockStream() as any
  const stdout = new MockStream() as any
  const clock = new ManualClock()
  const palette = new TerminalPalette({
    stdin,
    stdout,
    writeFn: options.writeFn,
    isLegacyTmux: options.isLegacyTmux ?? false,
    isTmux: options.isTmux,
    oscSource: options.oscSource,
    clock,
  })

  return { stdin, stdout, clock, palette }
}

async function flushAsync(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function startPaletteDetection(
  options: {
    timeout?: number
    size?: number
    writeFn?: (data: string | Buffer) => boolean
    isLegacyTmux?: boolean
    isTmux?: boolean
  } = {},
) {
  const timeout = options.timeout ?? 2000
  const harness = createPaletteHarness({
    writeFn: options.writeFn,
    isLegacyTmux: options.isLegacyTmux,
    isTmux: options.isTmux,
  })
  const detectPromise = harness.palette.detect({
    timeout,
    size: options.size ?? 256,
  })

  harness.stdin.emit("data", Buffer.from("\x1b]4;0;#000000\x07"))
  await flushAsync()

  return { ...harness, detectPromise, timeout }
}

async function advanceClock(clock: ManualClock, ms: number): Promise<void> {
  await flushAsync()
  // Flush queued 0ms mock terminal responses before advancing the real timeout window.
  clock.advance(0)
  await flushAsync()
  clock.advance(ms)
  await flushAsync()
}

test("normalizeTerminalPalette returns detached fallback colors", () => {
  const normalized = normalizeTerminalPalette(null)
  normalized.palette[0].r = 1
  normalized.defaultForeground.g = 0

  const fresh = normalizeTerminalPalette(null)

  expect(fresh.palette[0].toInts()).toEqual([0, 0, 0, 255])
  expect(fresh.defaultForeground.toInts()).toEqual([255, 255, 255, 255])
})

test("TerminalPalette detectOSCSupport returns true on response", async () => {
  const { stdin, clock, palette } = createPaletteHarness()

  const detectPromise = palette.detectOSCSupport(500)

  stdin.emit("data", Buffer.from("\x1b]4;0;#ff0000\x07"))

  await advanceClock(clock, 500)

  const result = await detectPromise

  expect(result).toBe(true)
})

test("TerminalPalette detectOSCSupport returns false on timeout", async () => {
  const { clock, palette } = createPaletteHarness()

  const detectPromise = palette.detectOSCSupport(100)

  await advanceClock(clock, 300)

  const result = await detectPromise

  expect(result).toBe(false)
})

test("TerminalPalette parses OSC 4 hex format correctly", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    for (let i = 0; i < 256; i++) {
      const color = i === 0 ? "#ff00aa" : i === 1 ? "#00ff00" : i === 2 ? "#0000ff" : "#000000"
      stdin.emit("data", Buffer.from(`\x1b]4;${i};${color}\x07`))
    }
    stdin.emit("data", Buffer.from("\x1b]10;#aabbcc\x07"))
    stdin.emit("data", Buffer.from("\x1b]11;#ddeeff\x07"))
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#ff00aa")
  expect(result.palette[1]).toBe("#00ff00")
  expect(result.palette[2]).toBe("#0000ff")
  expect(result.defaultForeground).toBe("#aabbcc")
  expect(result.defaultBackground).toBe("#ddeeff")
})

test("TerminalPalette parses OSC 4 rgb format with 4 hex digits", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    stdin.emit("data", Buffer.from("\x1b]4;0;rgb:ffff/0000/aaaa\x07"))
    for (let i = 1; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toMatch(/^#[0-9a-f]{6}$/)
  expect(result.palette[0]).toBe("#ff00aa")
})

test("TerminalPalette parses OSC 4 rgb format with 2 hex digits", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    stdin.emit("data", Buffer.from("\x1b]4;0;rgb:ff/00/aa\x07"))
    for (let i = 1; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toMatch(/^#[0-9a-f]{6}$/)
  expect(result.palette[0]).toBe("#ff00aa")
})

test("TerminalPalette handles multiple color responses in single buffer", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    stdin.emit(
      "data",
      Buffer.from(
        "\x1b]4;0;rgb:0000/0000/0000\x07" +
          "\x1b]4;1;rgb:aa00/0000/0000\x07" +
          "\x1b]4;2;rgb:0000/aa00/0000\x07" +
          "\x1b]4;3;rgb:aa00/aa00/0000\x07",
      ),
    )

    for (let i = 4; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#000000")
  expect(result.palette[1]).toBe("#a90000")
  expect(result.palette[2]).toBe("#00a900")
  expect(result.palette[3]).toBe("#a9a900")
})

test("TerminalPalette handles BEL terminator", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    stdin.emit("data", Buffer.from("\x1b]4;0;#ff0000\x07"))
    for (let i = 1; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#ff0000")
})

test("TerminalPalette handles ST terminator", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    stdin.emit("data", Buffer.from("\x1b]4;0;#00ff00\x1b\\"))
    for (let i = 1; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#00ff00")
})

test("TerminalPalette scales color components correctly", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    stdin.emit("data", Buffer.from("\x1b]4;0;rgb:ffff/0000/0000\x07"))
    for (let i = 1; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#ff0000")
})

test("TerminalPalette returns null for colors that don't respond", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection({ timeout: 1000 })

  clock.setTimeout(() => {
    stdin.emit("data", Buffer.from("\x1b]4;0;#ff0000\x07"))
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#ff0000")
  expect(result.palette.some((color: string | null) => color === null)).toBe(true)
})

test("TerminalPalette handles response split across chunks", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    stdin.emit("data", Buffer.from("\x1b]4;0;#ff"))
    stdin.emit("data", Buffer.from("00aa\x07"))

    stdin.emit("data", Buffer.from("\x1b]4;1;rgb:0000/"))
    stdin.emit("data", Buffer.from("ffff/"))
    stdin.emit("data", Buffer.from("0000\x07"))

    for (let i = 2; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#ff00aa")
  expect(result.palette[1]).toBe("#00ff00")
})

test("TerminalPalette handles OSC response mixed with mouse events", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    stdin.emit("data", Buffer.from("\x1b]4;0;#ff00aa\x07"))
    stdin.emit("data", Buffer.from("\x1b[<0;10;5M"))
    stdin.emit("data", Buffer.from("\x1b]4;1;#00ff00\x07"))
    stdin.emit("data", Buffer.from("\x1b[<0;11;5M"))
    stdin.emit("data", Buffer.from("\x1b]4;2;#0000ff\x07"))
    stdin.emit("data", Buffer.from("\x1b[<0;12;5m"))

    for (let i = 3; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#ff00aa")
  expect(result.palette[1]).toBe("#00ff00")
  expect(result.palette[2]).toBe("#0000ff")
})

test("TerminalPalette handles OSC response mixed with key events", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    stdin.emit("data", Buffer.from("\x1b]4;0;#ff00aa\x07"))
    stdin.emit("data", Buffer.from("hello"))
    stdin.emit("data", Buffer.from("\x1b]4;1;#00ff00\x07"))
    stdin.emit("data", Buffer.from("\x1b[A"))
    stdin.emit("data", Buffer.from("\x1b]4;2;#0000ff\x07"))
    stdin.emit("data", Buffer.from("\x1b[B"))
    stdin.emit("data", Buffer.from("\x1b]4;3;#ffff00\x07"))

    for (let i = 4; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#ff00aa")
  expect(result.palette[1]).toBe("#00ff00")
  expect(result.palette[2]).toBe("#0000ff")
  expect(result.palette[3]).toBe("#ffff00")
})

test("TerminalPalette handles response split mid-escape sequence", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    stdin.emit("data", Buffer.from("\x1b"))
    stdin.emit("data", Buffer.from("]4;0;#ff00aa\x07"))

    stdin.emit("data", Buffer.from("\x1b]"))
    stdin.emit("data", Buffer.from("4;1;#00ff00\x07"))

    stdin.emit("data", Buffer.from("\x1b]4"))
    stdin.emit("data", Buffer.from(";2;#0000ff\x07"))

    stdin.emit("data", Buffer.from("\x1b]4;"))
    stdin.emit("data", Buffer.from("3;#ffff00\x07"))

    for (let i = 4; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#ff00aa")
  expect(result.palette[1]).toBe("#00ff00")
  expect(result.palette[2]).toBe("#0000ff")
  expect(result.palette[3]).toBe("#ffff00")
})

test("TerminalPalette handles mixed ANSI sequences and OSC responses", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    stdin.emit("data", Buffer.from("\x1b[2J"))
    stdin.emit("data", Buffer.from("\x1b]4;0;#ff00aa\x07"))
    stdin.emit("data", Buffer.from("\x1b[H"))
    stdin.emit("data", Buffer.from("\x1b]4;1;#00ff00\x07"))
    stdin.emit("data", Buffer.from("\x1b[31m"))
    stdin.emit("data", Buffer.from("\x1b]4;2;#0000ff\x07"))
    stdin.emit("data", Buffer.from("\x1b[0m"))

    for (let i = 3; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#ff00aa")
  expect(result.palette[1]).toBe("#00ff00")
  expect(result.palette[2]).toBe("#0000ff")
})

test("TerminalPalette handles complex chunking with partial responses", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    const response0 = "\x1b]4;0;rgb:ffff/0000/aaaa\x07"
    for (let i = 0; i < response0.length; i += 3) {
      stdin.emit("data", Buffer.from(response0.slice(i, i + 3)))
    }

    stdin.emit("data", Buffer.from("\x1b]4;1"))
    stdin.emit("data", Buffer.from(";#00"))
    stdin.emit("data", Buffer.from("some junk data"))
    stdin.emit("data", Buffer.from("ff00"))
    stdin.emit("data", Buffer.from("\x1b[D"))
    stdin.emit("data", Buffer.from("\x07"))

    stdin.emit("data", Buffer.from("\x1b]4;1;#00ff00\x07"))

    for (let i = 2; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#ff00aa")
  expect(result.palette[1]).toBe("#00ff00")
})

test("TerminalPalette ignores malformed responses and waits for valid ones", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    stdin.emit("data", Buffer.from("\x1b]4;0;#ff00\x07"))
    stdin.emit("data", Buffer.from("\x1b]4;1;rgb:gg00/0000/0000\x07"))
    stdin.emit("data", Buffer.from("\x1b]4;2;#zzzzzz\x07"))

    stdin.emit("data", Buffer.from("\x1b]4;0;#ff00aa\x07"))
    stdin.emit("data", Buffer.from("\x1b]4;1;#00ff00\x07"))
    stdin.emit("data", Buffer.from("\x1b]4;2;#0000ff\x07"))

    for (let i = 3; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#ff00aa")
  expect(result.palette[1]).toBe("#00ff00")
  expect(result.palette[2]).toBe("#0000ff")
})

test("TerminalPalette handles buffer overflow gracefully", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    const junkData = "x".repeat(10000)
    stdin.emit("data", Buffer.from(junkData))

    stdin.emit("data", Buffer.from("\x1b]4;0;#ff00aa\x07"))
    stdin.emit("data", Buffer.from("\x1b]4;1;#00ff00\x07"))

    for (let i = 2; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#ff00aa")
  expect(result.palette[1]).toBe("#00ff00")
})

test("TerminalPalette handles all 256 colors in a single blob", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    let blob = ""
    for (let i = 0; i < 256; i++) {
      const color = i === 0 ? "#ff0011" : i === 1 ? "#00ff22" : i === 255 ? "#aabbcc" : "#000000"
      blob += `\x1b]4;${i};${color}\x07`
    }

    stdin.emit("data", Buffer.from(blob))
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#ff0011")
  expect(result.palette[1]).toBe("#00ff22")
  expect(result.palette[255]).toBe("#aabbcc")
  expect(result.palette.length).toBe(256)
})

test("TerminalPalette handles blob split across multiple chunks", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    let blob = ""
    for (let i = 0; i < 256; i++) {
      const color = i === 5 ? "#112233" : i === 100 ? "#445566" : i === 200 ? "#778899" : "#000000"
      blob += `\x1b]4;${i};${color}\x07`
    }

    const chunkSize = 500
    for (let i = 0; i < blob.length; i += chunkSize) {
      stdin.emit("data", Buffer.from(blob.slice(i, i + chunkSize)))
    }
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[5]).toBe("#112233")
  expect(result.palette[100]).toBe("#445566")
  expect(result.palette[200]).toBe("#778899")
  expect(result.palette.length).toBe(256)
})

test("TerminalPalette handles blob with mixed junk data", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    let blob = ""
    for (let i = 0; i < 256; i++) {
      const color = i === 10 ? "#abcdef" : i === 50 ? "#fedcba" : "#000000"
      blob += `\x1b]4;${i};${color}\x07`

      if (i % 20 === 0) {
        blob += "JUNK_DATA_HERE"
      }
      if (i % 30 === 0) {
        blob += "\x1b[2J\x1b[H"
      }
      if (i % 40 === 0) {
        blob += "\x1b[<0;10;5M"
      }
    }

    stdin.emit("data", Buffer.from(blob))
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[10]).toBe("#abcdef")
  expect(result.palette[50]).toBe("#fedcba")
  expect(result.palette.length).toBe(256)
})

test("TerminalPalette handles realistic terminal response pattern", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    let chunk1 = ""
    for (let i = 0; i <= 5; i++) {
      chunk1 += `\x1b]4;${i};#ff0000\x07`
    }
    stdin.emit("data", Buffer.from(chunk1))

    let chunk2 = ""
    for (let i = 6; i <= 50; i++) {
      chunk2 += `\x1b]4;${i};#00ff00\x07`
    }
    stdin.emit("data", Buffer.from(chunk2.slice(0, 200)))
    stdin.emit("data", Buffer.from(chunk2.slice(200)))

    stdin.emit("data", Buffer.from("\x1b[<35;20;10M"))
    let chunk3 = ""
    for (let i = 51; i <= 150; i++) {
      chunk3 += `\x1b]4;${i};#0000ff\x07`
    }
    stdin.emit("data", Buffer.from(chunk3))

    let chunk4 = ""
    for (let i = 151; i <= 255; i++) {
      chunk4 += `\x1b]4;${i};#ffffff\x07`
    }
    stdin.emit("data", Buffer.from(chunk4))
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#ff0000")
  expect(result.palette[5]).toBe("#ff0000")
  expect(result.palette[6]).toBe("#00ff00")
  expect(result.palette[50]).toBe("#00ff00")
  expect(result.palette[51]).toBe("#0000ff")
  expect(result.palette[150]).toBe("#0000ff")
  expect(result.palette[151]).toBe("#ffffff")
  expect(result.palette[255]).toBe("#ffffff")
  expect(result.palette.length).toBe(256)
})

test("TerminalPalette uses custom write function when provided", async () => {
  const writtenData: string[] = []

  const customWrite = (data: string | Buffer) => {
    writtenData.push(data.toString())
    return true
  }

  const { stdin, clock, palette } = createPaletteHarness({ writeFn: customWrite })

  const detectPromise = palette.detectOSCSupport(500)

  stdin.emit("data", Buffer.from("\x1b]4;0;#ff0000\x07"))

  await advanceClock(clock, 500)

  const result = await detectPromise

  expect(result).toBe(true)
  expect(writtenData.length).toBe(1)
  expect(writtenData[0]).toBe("\x1b]4;0;?\x07")
})

test("TerminalPalette uses custom write function for palette detection", async () => {
  const writtenData: string[] = []

  const customWrite = (data: string | Buffer) => {
    writtenData.push(data.toString())
    return true
  }

  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection({ writeFn: customWrite })

  clock.setTimeout(() => {
    for (let i = 0; i < 256; i++) {
      const color = "#aabbcc"
      stdin.emit("data", Buffer.from(`\x1b]4;${i};${color}\x07`))
    }
  }, 0)

  await advanceClock(clock, timeout)

  await detectPromise

  expect(writtenData.length).toBe(3)
  expect(writtenData[0]).toBe("\x1b]4;0;?\x07")

  const paletteQuery = writtenData[1]
  for (let i = 0; i < 256; i++) {
    expect(paletteQuery).toContain(`\x1b]4;${i};?\x07`)
  }

  const specialQuery = writtenData[2]
  expect(specialQuery).toContain("\x1b]10;?\x07")
  expect(specialQuery).toContain("\x1b]11;?\x07")
})

test("TerminalPalette falls back to stdout.write when no custom write function provided", async () => {
  const clock = new ManualClock()
  const stdin = new MockStream() as any
  const writtenData: string[] = []

  const stdout = new MockStream() as any
  stdout.write = (data: string) => {
    writtenData.push(data)
    return true
  }

  const palette = new TerminalPalette({
    stdin,
    stdout,
    isLegacyTmux: false,
    clock,
  })

  const detectPromise = palette.detectOSCSupport(500)

  stdin.emit("data", Buffer.from("\x1b]4;0;#ff0000\x07"))

  await advanceClock(clock, 500)

  const result = await detectPromise

  expect(result).toBe(true)
  expect(writtenData.length).toBe(1)
  expect(writtenData[0]).toBe("\x1b]4;0;?\x07")
})

test("TerminalPalette custom write function can intercept and modify output", async () => {
  const interceptedWrites: string[] = []
  let actualWrites = 0

  const customWrite = (data: string | Buffer) => {
    interceptedWrites.push(data.toString())
    actualWrites++
    return true
  }

  const { stdin, clock, palette } = createPaletteHarness({ writeFn: customWrite })

  const detectPromise = palette.detectOSCSupport(500)

  stdin.emit("data", Buffer.from("\x1b]4;0;#ff0000\x07"))

  await advanceClock(clock, 500)

  await detectPromise

  expect(actualWrites).toBe(1)
  expect(interceptedWrites.length).toBe(1)
  expect(interceptedWrites[0]).toBe("\x1b]4;0;?\x07")
})

test("TerminalPalette detects all special OSC colors (10-19)", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    for (let i = 0; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
    stdin.emit("data", Buffer.from("\x1b]10;#ff0001\x07"))
    stdin.emit("data", Buffer.from("\x1b]11;#ff0002\x07"))
    stdin.emit("data", Buffer.from("\x1b]12;#ff0003\x07"))
    stdin.emit("data", Buffer.from("\x1b]13;#ff0004\x07"))
    stdin.emit("data", Buffer.from("\x1b]14;#ff0005\x07"))
    stdin.emit("data", Buffer.from("\x1b]15;#ff0006\x07"))
    stdin.emit("data", Buffer.from("\x1b]16;#ff0007\x07"))
    stdin.emit("data", Buffer.from("\x1b]17;#ff0008\x07"))
    stdin.emit("data", Buffer.from("\x1b]19;#ff0009\x07"))
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.defaultForeground).toBe("#ff0001")
  expect(result.defaultBackground).toBe("#ff0002")
  expect(result.cursorColor).toBe("#ff0003")
  expect(result.mouseForeground).toBe("#ff0004")
  expect(result.mouseBackground).toBe("#ff0005")
  expect(result.tekForeground).toBe("#ff0006")
  expect(result.tekBackground).toBe("#ff0007")
  expect(result.highlightBackground).toBe("#ff0008")
  expect(result.highlightForeground).toBe("#ff0009")
})

test("TerminalPalette only wraps OSC 4 and only queries tmux-supported special colors in legacy tmux", async () => {
  const writes: string[] = []
  const { clock, detectPromise, timeout } = await startPaletteDetection({
    isLegacyTmux: true,
    isTmux: true,
    writeFn: (data) => {
      writes.push(data.toString())
      return true
    },
  })

  expect(writes.some((write) => write.startsWith("\x1bPtmux;\x1b\x1b]4;"))).toBe(true)
  expect(writes).toContain("\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07")
  expect(writes.some((write) => write.includes("\x1b]13;?"))).toBe(false)

  await advanceClock(clock, timeout)
  await detectPromise
})

test("TerminalPalette uses plain OSC 4 but limits special color queries in modern tmux", async () => {
  const writes: string[] = []
  const { clock, detectPromise, timeout } = await startPaletteDetection({
    isTmux: true,
    writeFn: (data) => {
      writes.push(data.toString())
      return true
    },
  })

  expect(writes).toContain("\x1b]4;0;?\x07")
  expect(writes.some((write) => write.startsWith("\x1bPtmux;"))).toBe(false)
  expect(writes).toContain("\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07")
  expect(writes.some((write) => write.includes("\x1b]13;?"))).toBe(false)

  await advanceClock(clock, timeout)
  await detectPromise
})

test("TerminalPalette handles special colors in rgb format", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    for (let i = 0; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
    stdin.emit("data", Buffer.from("\x1b]10;rgb:ffff/0000/0000\x07"))
    stdin.emit("data", Buffer.from("\x1b]11;rgb:0000/ffff/0000\x07"))
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.defaultForeground).toBe("#ff0000")
  expect(result.defaultBackground).toBe("#00ff00")
})

test("TerminalPalette handles missing special colors gracefully", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    for (let i = 0; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
    stdin.emit("data", Buffer.from("\x1b]10;#ff0001\x07"))
    stdin.emit("data", Buffer.from("\x1b]11;#ff0002\x07"))
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.defaultForeground).toBe("#ff0001")
  expect(result.defaultBackground).toBe("#ff0002")
  expect(result.cursorColor).toBe(null)
  expect(result.mouseForeground).toBe(null)
  expect(result.mouseBackground).toBe(null)
})

test("TerminalPalette special colors with ST terminator", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    for (let i = 0; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
    stdin.emit("data", Buffer.from("\x1b]10;#aabbcc\x1b\\"))
    stdin.emit("data", Buffer.from("\x1b]11;#ddeeff\x1b\\"))
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.defaultForeground).toBe("#aabbcc")
  expect(result.defaultBackground).toBe("#ddeeff")
})

test("TerminalPalette handles mixed palette and special color responses", async () => {
  const { stdin, clock, detectPromise, timeout } = await startPaletteDetection()

  clock.setTimeout(() => {
    stdin.emit("data", Buffer.from("\x1b]4;0;#010203\x07"))
    stdin.emit("data", Buffer.from("\x1b]10;#aabbcc\x07"))
    stdin.emit("data", Buffer.from("\x1b]4;1;#040506\x07"))
    stdin.emit("data", Buffer.from("\x1b]11;#ddeeff\x07"))
    for (let i = 2; i < 256; i++) {
      stdin.emit("data", Buffer.from(`\x1b]4;${i};#000000\x07`))
    }
  }, 0)

  await advanceClock(clock, timeout)

  const result = await detectPromise

  expect(result.palette[0]).toBe("#010203")
  expect(result.palette[1]).toBe("#040506")
  expect(result.defaultForeground).toBe("#aabbcc")
  expect(result.defaultBackground).toBe("#ddeeff")
})

test("TerminalPalette returns null special colors on non-TTY", async () => {
  const { stdin, stdout, clock, palette } = createPaletteHarness()
  stdin.isTTY = false
  stdout.isTTY = false

  const detectPromise = palette.detect({ timeout: 100 })

  await advanceClock(clock, 100)

  const result = await detectPromise

  expect(result.defaultForeground).toBe(null)
  expect(result.defaultBackground).toBe(null)
  expect(result.cursorColor).toBe(null)
  expect(result.palette.every((c: string | null) => c === null)).toBe(true)
})

test("TerminalPalette returns null special colors on OSC not supported", async () => {
  const { clock, palette } = createPaletteHarness()

  const detectPromise = palette.detect({ timeout: 100 })

  await advanceClock(clock, 300)

  const result = await detectPromise

  expect(result.defaultForeground).toBe(null)
  expect(result.defaultBackground).toBe(null)
  expect(result.cursorColor).toBe(null)
  expect(result.palette.every((c: string | null) => c === null)).toBe(true)
})

test("TerminalPalette can read OSC from router subscription source", async () => {
  const stdin = new MockStream() as any

  const handlers = new Set<(sequence: string) => void>()
  let subscribeCount = 0
  let unsubscribeCount = 0

  const oscSource = {
    subscribeOsc(handler: (sequence: string) => void) {
      subscribeCount++
      handlers.add(handler)
      return () => {
        unsubscribeCount++
        handlers.delete(handler)
      }
    },
  }

  const clock = new ManualClock()
  const stdout = new MockStream() as any
  const palette = new TerminalPalette({
    stdin,
    stdout,
    isLegacyTmux: false,
    oscSource,
    clock,
  })

  const detectPromise = palette.detectOSCSupport(500)
  for (const handler of handlers) {
    handler("\x1b]4;0;#ff0000\x07")
  }

  await advanceClock(clock, 500)

  const supported = await detectPromise
  expect(supported).toBe(true)
  expect(subscribeCount).toBe(1)
  expect(unsubscribeCount).toBe(1)
  expect(stdin.listenerCount("data")).toBe(0)
})
