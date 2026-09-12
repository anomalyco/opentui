import { describe, expect, test } from "bun:test"
import { NativeAudioStreamState as ExportedAudioStreamState, resolveRenderLib } from "../zig.js"
import {
  AudioCaptureStatsStruct,
  AudioStreamCreateOptionsStruct,
  AudioStreamStatsStruct,
  CursorStyleOptionsStruct,
  GridDrawOptionsStruct,
  ImageDrawOptionsStruct,
  LogicalCursorStruct,
  MeasureResultStruct,
  NativeAudioStreamCloseReason,
  NativeAudioStreamFormat,
  NativeAudioStreamState,
  StyledChunkStruct,
  VisualCursorStruct,
} from "../zig-structs.js"
import { RGBA } from "../lib/RGBA.js"
import { ptr, toArrayBuffer, type Pointer } from "../platform/ffi.js"
import { OptimizedBuffer } from "../buffer.js"

// Borrowed-pointer contract for styled text, styled placeholders, and cursor
// options: packed struct buffers must reach the FFI symbol as object values so
// the backend can borrow them for the synchronous call. Passing a pre-resolved
// address instead reintroduces the Node use-after-free from issue #1212.

const lib = resolveRenderLib()
const symbols = (lib as any).opentui.symbols as Record<string, (...args: any[]) => any>

function withStubbedSymbols(
  replacements: Record<string, (...args: any[]) => any>,
  fn: (calls: Record<string, any[][]>) => void,
): void {
  const originals: Record<string, (...args: any[]) => any> = {}
  const calls: Record<string, any[][]> = {}
  for (const [name, replacement] of Object.entries(replacements)) {
    originals[name] = symbols[name]!
    calls[name] = []
    symbols[name] = (...args: any[]) => {
      calls[name]!.push(args)
      return replacement(...args)
    }
  }
  try {
    fn(calls)
  } finally {
    for (const [name, original] of Object.entries(originals)) symbols[name] = original
  }
}

function withStubbedSymbol(name: string, fn: (calls: any[][]) => void): void {
  withStubbedSymbols({ [name]: () => undefined }, (calls) => fn(calls[name]!))
}

async function forceGc(): Promise<void> {
  if (typeof Bun !== "undefined") {
    Bun.gc(true)
  }
  ;(globalThis as any).gc?.()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function fieldOffset(struct: { layoutByName: Map<string, { offset: number }> }, name: string): number {
  const field = struct.layoutByName.get(name)
  if (!field) {
    throw new Error(`Missing struct field: ${name}`)
  }
  return field.offset
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function readPackedColor(packed: ArrayBuffer, offset: number): number[] {
  // 64-bit StyledChunk/CursorStyleOptions layout; matches the supported
  // x64/arm64 native targets.
  const address = new DataView(packed).getBigUint64(offset, true)
  expect(address).not.toBe(0n)
  return [...new Uint16Array(toArrayBuffer(address as unknown as Pointer, 0, 8).slice(0))]
}

describe("borrowed pointer call sites", () => {
  test("PCM uses shared byte-oriented stream symbols and borrowed offset views", () => {
    const create = symbols.audioCreateStream
    const write = symbols.audioWriteStream
    const input = new Uint8Array(10).subarray(1, 8)
    symbols.audioCreateStream = (_engine, packed: Uint8Array, output: Uint32Array) => {
      expect(packed).toBeInstanceOf(Uint8Array)
      const options = AudioStreamCreateOptionsStruct.unpack(packed.buffer as ArrayBuffer)
      expect(options.capacityMs).toBe(500)
      expect(options.format).toBe(3)
      expect(options.sampleRate).toBe(44100)
      expect(options.channels).toBe(2)
      expect(output).toBeInstanceOf(Uint32Array)
      output[0] = 257
      return 0
    }
    symbols.audioWriteStream = (_engine, id, view, bytes) => {
      expect(id).toBe(257)
      expect(view).toBe(input)
      expect(bytes).toBe(7)
      return 3
    }
    try {
      expect(
        lib.audioCreateStream(1 as any, {
          format: NativeAudioStreamFormat.Pcm,
          maxProbeBytes: 0,
          sampleRate: 44100,
          channels: 2,
          capacityMs: 500,
          startupMs: 20,
          resumeMs: 20,
          volume: 1,
          pan: 0,
          groupId: 0,
        }),
      ).toEqual({ status: 0, streamId: 257 })
      expect(lib.audioWriteStream(1 as any, 257, input)).toBe(3)
      expect(Object.keys(symbols).some((name) => /audio.*Pcm/.test(name))).toBe(false)
    } finally {
      symbols.audioCreateStream = create
      symbols.audioWriteStream = write
    }
  })

  test("passes reusable struct views through the native FFI boundary", () => {
    const buffer = lib.createEditBuffer("wcwidth")
    try {
      expect(lib.editBufferGetCursorPosition(buffer)).toEqual({ row: 0, col: 0, offset: 0 })
    } finally {
      lib.destroyEditBuffer(buffer)
    }
  })

  test("preserves the native viewport lookup success result", () => {
    const x = new Uint32Array([1])
    const y = new Uint32Array([1])
    const width = new Uint32Array([1])
    const height = new Uint32Array([1])

    expect([false, 0]).toContain(symbols.editorViewGetViewport(0, x, y, width, height))
    expect([x[0], y[0], width[0], height[0]]).toEqual([0, 0, 0, 0])
  })

  test("stabilizes retained text memory before resolving its pointer", () => {
    withStubbedSymbols(
      {
        textBufferRegisterMemBuffer: () => 1,
        textBufferReplaceMemBuffer: () => 1,
        textBufferAppend: () => undefined,
      },
      (calls) => {
        const registered = new Uint8Array([1, 2, 3])
        const replaced = new Uint8Array([4, 5, 6])
        const appended = new Uint8Array([7, 8, 9])

        lib.textBufferRegisterMemBuffer(1 as any, registered)
        lib.textBufferReplaceMemBuffer(1 as any, 1, replaced)
        lib.textBufferAppend(1 as any, appended)

        void registered.buffer
        void replaced.buffer
        void appended.buffer
        expect(calls.textBufferRegisterMemBuffer[0]![1]).toBe(ptr(registered))
        expect(calls.textBufferReplaceMemBuffer[0]![2]).toBe(ptr(replaced))
        expect(calls.textBufferAppend[0]![1]).toBe(ptr(appended))
      },
    )
  })

  test("passes transient owners directly through remaining synchronous wrappers", () => {
    withStubbedSymbols(
      {
        bufferColorMatrix: () => undefined,
        bufferDrawGrayscaleBuffer: () => undefined,
        bufferDrawPackedBuffer: () => undefined,
        bufferDrawSuperSampleBuffer: () => undefined,
        bufferDrawText: () => undefined,
        bufferGetId: () => 0,
        getBuildOptions: () => undefined,
        editorViewGetViewport: () => undefined,
        audioGetPlaybackDeviceName: () => 0,
        streamDrainSpans: () => 0,
      },
      (calls) => {
        const fg = RGBA.fromValues(1, 1, 1, 1)
        const bg = RGBA.fromValues(0, 0, 0, 1)
        const matrix = new Float32Array(16)
        const mask = new Float32Array(3)
        const intensities = new Float32Array(4)
        const spans = new Uint8Array(64)
        const pixels = new Uint8Array(16)
        const packed = new Uint8Array(48)
        const buffer = new OptimizedBuffer(lib, 1 as any, 2, 2, {})

        buffer.colorMatrix(matrix, mask)
        buffer.drawGrayscaleBuffer(0, 0, intensities, 2, 2, fg, bg)
        buffer.drawSuperSampleBuffer(0, 0, pixels, pixels.byteLength, "rgba8unorm", 8)
        buffer.drawPackedBuffer(packed, packed.byteLength, 0, 0, 1, 1)
        lib.bufferDrawText(1 as any, "x", 0, 0, fg, bg)
        lib.bufferGetId(1 as any)
        lib.getBuildOptions()
        lib.editorViewGetViewport(1 as any)
        lib.audioGetPlaybackDeviceName(1 as any, 0)
        lib.streamDrainSpans(1 as any, spans, 1)

        expect(calls.bufferColorMatrix[0]![1]).toBe(matrix)
        expect(calls.bufferColorMatrix[0]![2]).toBe(mask)
        expect(calls.bufferDrawGrayscaleBuffer[0]![3]).toBe(intensities)
        expect(calls.bufferDrawGrayscaleBuffer[0]![6]).toBe(fg.buffer)
        expect(calls.bufferDrawGrayscaleBuffer[0]![7]).toBe(bg.buffer)
        expect(calls.bufferDrawSuperSampleBuffer[0]![3]).toBe(pixels)
        expect(calls.bufferDrawPackedBuffer[0]![1]).toBe(packed)
        expect(calls.bufferDrawText[0]![1]).toBeInstanceOf(Uint8Array)
        expect(calls.bufferDrawText[0]![5]).toBe(fg.buffer)
        expect(calls.bufferDrawText[0]![6]).toBe(bg.buffer)
        expect(calls.bufferGetId[0]![1]).toBeInstanceOf(Uint8Array)
        expect(calls.getBuildOptions[0]![0]).toBeInstanceOf(ArrayBuffer)
        expect(calls.editorViewGetViewport[0]!.slice(1)).toEqual([
          expect.any(Uint32Array),
          expect.any(Uint32Array),
          expect.any(Uint32Array),
          expect.any(Uint32Array),
        ])
        expect(calls.audioGetPlaybackDeviceName[0]![2]).toBeInstanceOf(Uint8Array)
        expect(calls.streamDrainSpans[0]![1]).toBe(spans)
      },
    )
  })

  test("reuses owned output storage while preserving public result identity", () => {
    const originals = {
      editBufferGetCursorPosition: symbols.editBufferGetCursorPosition,
      editorViewGetVisualCursor: symbols.editorViewGetVisualCursor,
      textBufferViewMeasureForDimensions: symbols.textBufferViewMeasureForDimensions,
      audioGetStreamStats: symbols.audioGetStreamStats,
    }
    const outputViews: Record<string, Uint8Array[]> = {
      logical: [],
      visual: [],
      measure: [],
      audio: [],
    }
    let logicalOffset = 1
    let visualOffset = 10
    let lineCount = 2
    let bytesReceived = 20n

    symbols.editBufferGetCursorPosition = (_buffer, output: Uint8Array) => {
      outputViews.logical.push(output)
      LogicalCursorStruct.packInto({ row: 0, col: logicalOffset, offset: logicalOffset++ }, dataView(output), 0)
    }
    symbols.editorViewGetVisualCursor = (_view, output: Uint8Array) => {
      outputViews.visual.push(output)
      VisualCursorStruct.packInto(
        { visualRow: 0, visualCol: visualOffset, logicalRow: 0, logicalCol: visualOffset, offset: visualOffset++ },
        dataView(output),
        0,
      )
    }
    symbols.textBufferViewMeasureForDimensions = (_view, _width, _height, output: Uint8Array) => {
      outputViews.measure.push(output)
      MeasureResultStruct.packInto({ lineCount: lineCount++, widthColsMax: 8 }, dataView(output), 0)
      return 1
    }
    symbols.audioGetStreamStats = (_engine, _streamId, output: Uint8Array) => {
      outputViews.audio.push(output)
      AudioStreamStatsStruct.packInto(
        {
          bytesReceived: bytesReceived++,
          framesDecoded: 2n,
          framesPlayed: 1n,
          state: NativeAudioStreamState.Playing,
          sampleRate: 48_000,
          channels: 2,
          bufferedFrames: 100,
          capacityFrames: 200,
          underruns: 0,
          errorCode: 0,
          readyGeneration: 1,
        },
        dataView(output),
        0,
      )
      return 0
    }

    try {
      const logicalFirst = lib.editBufferGetCursorPosition(1 as any)
      const logicalSecond = lib.editBufferGetCursorPosition(1 as any)
      expect(logicalFirst).not.toBe(logicalSecond)
      expect(logicalFirst.offset).toBe(1)
      expect(logicalSecond.offset).toBe(2)

      const visualFirst = lib.editorViewGetVisualCursor(2 as any)
      const visualSecond = lib.editorViewGetVisualCursor(2 as any)
      expect(visualFirst).not.toBe(visualSecond)
      expect(visualFirst.offset).toBe(10)
      expect(visualSecond.offset).toBe(11)

      const measureFirst = lib.textBufferViewMeasureForDimensions(3 as any, 8, 10)!
      const measureSecond = lib.textBufferViewMeasureForDimensions(3 as any, 8, 10)!
      expect(measureFirst).not.toBe(measureSecond)
      expect(measureFirst.lineCount).toBe(2)
      expect(measureSecond.lineCount).toBe(3)

      const audioFirst = lib.audioGetStreamStats(4 as any, 5)!
      const audioSecond = lib.audioGetStreamStats(4 as any, 5)!
      expect(audioFirst).not.toBe(audioSecond)
      expect(audioFirst.bytesReceived).toBe(20n)
      expect(audioSecond.bytesReceived).toBe(21n)

      for (const views of Object.values(outputViews)) {
        expect(views).toHaveLength(2)
        expect(views[0]).toBeInstanceOf(Uint8Array)
        expect(views[1]).toBe(views[0])
      }
    } finally {
      Object.assign(symbols, originals)
    }
  })

  test("grid draw repacks and forwards one owning Uint8Array", () => {
    const calls: any[][] = []
    const original = symbols.bufferDrawGrid
    const fg = RGBA.fromValues(1, 1, 1, 1)
    const bg = RGBA.fromValues(0, 0, 0, 1)
    symbols.bufferDrawGrid = (...args: any[]) => calls.push(args)
    try {
      const chars = new Uint32Array(11)
      const offsets = new Int32Array([0, 1])
      lib.bufferDrawGrid(1 as any, chars, fg, bg, offsets, 1, offsets, 1, {
        drawInner: true,
        drawOuter: false,
      })
      const firstView = calls[0]![8] as Uint8Array
      expect(firstView).toBeInstanceOf(Uint8Array)
      expect(firstView).toEqual(new Uint8Array([1, 0]))

      lib.bufferDrawGrid(1 as any, chars, fg, bg, offsets, 1, offsets, 1, {
        drawInner: false,
        drawOuter: true,
      })
      expect(calls[1]![8]).toBe(firstView)
      expect(firstView).toEqual(new Uint8Array([0, 1]))
    } finally {
      symbols.bufferDrawGrid = original
    }
  })

  test("all cursor queries return fresh results from reused native storage", () => {
    const logicalQueries = [
      "editBufferGetCursorPosition",
      "editBufferGetNextWordBoundary",
      "editBufferGetPrevWordBoundary",
      "editBufferGetEOL",
    ] as const
    const visualQueries = [
      "editorViewGetVisualCursor",
      "editorViewGetNextWordBoundary",
      "editorViewGetPrevWordBoundary",
      "editorViewGetEOL",
      "editorViewGetVisualSOL",
      "editorViewGetVisualEOL",
    ] as const
    const originals = new Map<string, (...args: any[]) => any>()

    try {
      for (const [index, name] of logicalQueries.entries()) {
        originals.set(name, symbols[name])
        const outputViews: Uint8Array[] = []
        let offset = index + 2
        symbols[name] = (...args: any[]) => {
          const output = args.at(-1) as Uint8Array
          outputViews.push(output)
          LogicalCursorStruct.packInto({ row: index, col: index + 1, offset: offset++ }, dataView(output), 0)
        }
        const first = (lib as any)[name](1)
        const second = (lib as any)[name](1)
        expect(first).not.toBe(second)
        expect(first).toEqual({ row: index, col: index + 1, offset: index + 2 })
        expect(second).toEqual({ row: index, col: index + 1, offset: index + 3 })
        expect(outputViews[0]).toBeInstanceOf(Uint8Array)
        expect(outputViews[1]).toBe(outputViews[0])
      }

      originals.set("editBufferOffsetToPosition", symbols.editBufferOffsetToPosition)
      const positionViews: Uint8Array[] = []
      symbols.editBufferOffsetToPosition = (_buffer, offset: number, output: Uint8Array) => {
        positionViews.push(output)
        LogicalCursorStruct.packInto({ row: 1, col: 2, offset }, dataView(output), 0)
        return 1
      }
      const firstPosition = lib.editBufferOffsetToPosition(1 as any, 9)
      const secondPosition = lib.editBufferOffsetToPosition(1 as any, 10)
      expect(firstPosition).toEqual({ row: 1, col: 2, offset: 9 })
      expect(secondPosition).toEqual({ row: 1, col: 2, offset: 10 })
      expect(positionViews[0]).toBeInstanceOf(Uint8Array)
      expect(positionViews[1]).toBe(positionViews[0])

      for (const [index, name] of visualQueries.entries()) {
        originals.set(name, symbols[name])
        const outputViews: Uint8Array[] = []
        let offset = index + 4
        symbols[name] = (...args: any[]) => {
          const output = args.at(-1) as Uint8Array
          outputViews.push(output)
          VisualCursorStruct.packInto(
            {
              visualRow: index,
              visualCol: index + 1,
              logicalRow: index + 2,
              logicalCol: index + 3,
              offset: offset++,
            },
            dataView(output),
            0,
          )
        }
        const first = (lib as any)[name](1)
        const second = (lib as any)[name](1)
        expect(first).not.toBe(second)
        expect(first.offset).toBe(index + 4)
        expect(second.offset).toBe(index + 5)
        expect(outputViews[0]).toBeInstanceOf(Uint8Array)
        expect(outputViews[1]).toBe(outputViews[0])
      }
    } finally {
      for (const [name, original] of originals) symbols[name] = original
    }
  })

  test("audio stream structs preserve the native ABI", () => {
    expect(AudioStreamCreateOptionsStruct.size).toBe(40)
    expect(
      Object.fromEntries(
        [
          "capacityMs",
          "startupMs",
          "resumeMs",
          "volume",
          "pan",
          "groupId",
          "maxProbeBytes",
          "format",
          "sampleRate",
          "channels",
        ].map((name) => [name, fieldOffset(AudioStreamCreateOptionsStruct, name)]),
      ),
    ).toEqual({
      capacityMs: 0,
      startupMs: 4,
      resumeMs: 8,
      volume: 12,
      pan: 16,
      groupId: 20,
      maxProbeBytes: 24,
      format: 28,
      sampleRate: 32,
      channels: 36,
    })

    const packed = AudioStreamCreateOptionsStruct.pack({
      capacityMs: 2000,
      startupMs: 1000,
      resumeMs: 500,
      volume: 0.75,
      pan: -0.25,
      groupId: 7,
      maxProbeBytes: 2 * 1024 * 1024,
      format: NativeAudioStreamFormat.Mp3,
    })
    const view = new DataView(packed)
    expect(view.getUint32(0, true)).toBe(2000)
    expect(view.getUint32(4, true)).toBe(1000)
    expect(view.getUint32(8, true)).toBe(500)
    expect(view.getFloat32(12, true)).toBe(0.75)
    expect(view.getFloat32(16, true)).toBe(-0.25)
    expect(view.getUint32(20, true)).toBe(7)
    expect(view.getUint32(24, true)).toBe(2 * 1024 * 1024)
    expect(view.getUint32(28, true)).toBe(NativeAudioStreamFormat.Mp3)
    expect(view.getUint32(32, true)).toBe(0)
    expect(view.getUint32(36, true)).toBe(0)

    expect(AudioStreamStatsStruct.size).toBe(56)
    expect(
      Object.fromEntries(
        [
          "bytesReceived",
          "framesDecoded",
          "framesPlayed",
          "state",
          "sampleRate",
          "channels",
          "bufferedFrames",
          "capacityFrames",
          "underruns",
          "errorCode",
          "readyGeneration",
        ].map((name) => [name, fieldOffset(AudioStreamStatsStruct, name)]),
      ),
    ).toEqual({
      bytesReceived: 0,
      framesDecoded: 8,
      framesPlayed: 16,
      state: 24,
      sampleRate: 28,
      channels: 32,
      bufferedFrames: 36,
      capacityFrames: 40,
      underruns: 44,
      errorCode: 48,
      readyGeneration: 52,
    })
  })

  test("audio capture stats preserve the 40-byte native ABI", () => {
    expect(AudioCaptureStatsStruct.size).toBe(40)
    expect(
      Object.fromEntries(
        [
          "framesReceived",
          "framesRead",
          "framesDropped",
          "sampleRate",
          "channels",
          "bufferedFrames",
          "capacityFrames",
        ].map((name) => [name, fieldOffset(AudioCaptureStatsStruct, name)]),
      ),
    ).toEqual({
      framesReceived: 0,
      framesRead: 8,
      framesDropped: 16,
      sampleRate: 24,
      channels: 28,
      bufferedFrames: 32,
      capacityFrames: 36,
    })
  })

  test("audio capture wrappers pass transient buffers directly and normalize booleans", () => {
    const originals = {
      name: symbols.audioGetCaptureDeviceName,
      isDefault: symbols.audioIsCaptureDeviceDefault,
      start: symbols.audioStartCapture,
      running: symbols.audioIsCaptureRunning,
      read: symbols.audioReadCapture,
      stats: symbols.audioGetCaptureStats,
    }
    const calls: Record<string, any[][]> = { name: [], start: [], read: [], stats: [] }
    symbols.audioGetCaptureDeviceName = (...args: any[]) => {
      calls.name.push(args)
      ;(args[2] as Uint8Array).set(new TextEncoder().encode("Microphone"))
      return 10
    }
    symbols.audioIsCaptureDeviceDefault = () => 1
    symbols.audioIsCaptureRunning = () => 1
    symbols.audioStartCapture = (...args: any[]) => {
      calls.start.push(args)
      return 0
    }
    symbols.audioReadCapture = (...args: any[]) => {
      calls.read.push(args)
      new Uint32Array(args[4] as ArrayBuffer)[0] = 2
      return 0
    }
    symbols.audioGetCaptureStats = (...args: any[]) => {
      calls.stats.push(args)
      AudioCaptureStatsStruct.packInto(
        {
          framesReceived: 5n,
          framesRead: 2n,
          framesDropped: 1n,
          sampleRate: 48_000,
          channels: 1,
          bufferedFrames: 3,
          capacityFrames: 48_000,
        },
        new DataView(args[1] as ArrayBuffer),
        0,
      )
      return 0
    }

    try {
      expect(lib.audioGetCaptureDeviceName(1 as any, 2)).toBe("Microphone")
      expect(lib.audioIsCaptureDeviceDefault(1 as any, 2)).toBe(true)
      expect(lib.audioStartCapture(1 as any, { noFixedSizedCallback: true }, 1, 48_000)).toBe(0)
      expect(lib.audioIsCaptureRunning(1 as any)).toBe(true)
      const output = new Float32Array(4)
      expect(lib.audioReadCapture(1 as any, output, 4)).toEqual({ status: 0, framesRead: 2 })
      expect(lib.audioGetCaptureStats(1 as any)).toEqual({
        status: 0,
        stats: {
          framesReceived: 5n,
          framesRead: 2n,
          framesDropped: 1n,
          sampleRate: 48_000,
          channels: 1,
          bufferedFrames: 3,
          capacityFrames: 48_000,
        },
      })

      expect(calls.name[0]![2]).toBeInstanceOf(Uint8Array)
      expect(calls.start[0]![1]).toBeInstanceOf(ArrayBuffer)
      expect(calls.read[0]![1]).toBe(output)
      expect(calls.read[0]![2]).toBe(output.length)
      expect(calls.read[0]![3]).toBe(4)
      expect(calls.read[0]![4]).toBeInstanceOf(ArrayBuffer)
      expect(calls.stats[0]![1]).toBeInstanceOf(ArrayBuffer)
    } finally {
      symbols.audioGetCaptureDeviceName = originals.name
      symbols.audioIsCaptureDeviceDefault = originals.isDefault
      symbols.audioStartCapture = originals.start
      symbols.audioIsCaptureRunning = originals.running
      symbols.audioReadCapture = originals.read
      symbols.audioGetCaptureStats = originals.stats
    }
  })

  test("audio capture reads forward the destination sample capacity", () => {
    const calls: any[][] = []
    const original = symbols.audioReadCapture
    symbols.audioReadCapture = (...args: any[]) => {
      calls.push(args)
      return -1
    }
    try {
      const output = new Float32Array(3)
      expect(lib.audioReadCapture(1 as any, output, 1)).toEqual({ status: -1, framesRead: 0 })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toHaveLength(5)
      expect(calls[0]![1]).toBe(output)
      expect(calls[0]![2]).toBe(output.length)
      expect(calls[0]![3]).toBe(1)
      expect(calls[0]![4]).toBeInstanceOf(ArrayBuffer)
    } finally {
      symbols.audioReadCapture = original
    }
  })

  test("audio capture start contains option getter failures and defaults callback sizing", () => {
    const calls: any[][] = []
    const original = symbols.audioStartCapture
    symbols.audioStartCapture = (...args: any[]) => {
      calls.push(args)
      return 0
    }
    try {
      expect(lib.audioStartCapture(1 as any, undefined, 1, 48_000)).toBe(0)
      const packed = new Uint8Array(calls[0]![1] as ArrayBuffer)
      expect(packed[17]).toBe(1)

      const options = Object.create({ periods: 3 }) as { periods?: number; noFixedSizedCallback?: boolean }
      Object.defineProperty(options, "noFixedSizedCallback", { value: false, enumerable: false })
      expect(lib.audioStartCapture(1 as any, options, 1, 48_000)).toBe(0)
      const inherited = new DataView(calls[1]![1] as ArrayBuffer)
      expect(inherited.getUint32(8, true)).toBe(3)
      expect(inherited.getUint8(17)).toBe(0)

      const throwing = {
        get periods(): number {
          throw new Error("getter failed")
        },
      }
      expect(lib.audioStartCapture(1 as any, throwing, 1, 48_000)).toBe(-1)
      expect(calls).toHaveLength(2)
    } finally {
      symbols.audioStartCapture = original
    }
  })

  test("audioCloseStream forwards its reason and unpacks the owned output view", () => {
    const calls: any[][] = []
    const original = symbols.audioCloseStream
    symbols.audioCloseStream = (...args: any[]) => {
      calls.push(args)
      AudioStreamStatsStruct.packInto(
        {
          bytesReceived: 123n,
          framesDecoded: 456n,
          framesPlayed: 321n,
          state: NativeAudioStreamState.Failed,
          sampleRate: 44_100,
          channels: 2,
          bufferedFrames: 0,
          capacityFrames: 44_100,
          underruns: 3,
          errorCode: -3,
          readyGeneration: 7,
        },
        dataView(args[3] as Uint8Array),
        0,
      )
      return 0
    }
    try {
      const result = lib.audioCloseStream(11 as any, 22, NativeAudioStreamCloseReason.TransportError)
      expect(calls).toHaveLength(1)
      expect(calls[0]![0]).toBe(11)
      expect(calls[0]![1]).toBe(22)
      expect(calls[0]![2]).toBe(NativeAudioStreamCloseReason.TransportError)
      expect(calls[0]![3]).toBeInstanceOf(Uint8Array)
      expect(result).toEqual({
        status: 0,
        stats: {
          bytesReceived: 123n,
          framesDecoded: 456n,
          framesPlayed: 321n,
          state: NativeAudioStreamState.Failed,
          sampleRate: 44_100,
          channels: 2,
          bufferedFrames: 0,
          capacityFrames: 44_100,
          underruns: 3,
          errorCode: -3,
          readyGeneration: 7,
        },
      })
      expect(ExportedAudioStreamState).toBe(NativeAudioStreamState)
    } finally {
      symbols.audioCloseStream = original
    }
  })

  test("audioWriteStream passes the byte owner directly and forwards count, zero, and errors", () => {
    const calls: any[][] = []
    const original = symbols.audioWriteStream
    const results = [3, 0, -4, 0]
    symbols.audioWriteStream = (...args: any[]) => {
      calls.push(args)
      return results.shift()
    }
    try {
      const bytes = new Uint8Array([1, 2, 3])
      expect(lib.audioWriteStream(0 as any, 1, bytes)).toBe(3)
      expect(lib.audioWriteStream(0 as any, 1, bytes)).toBe(0)
      expect(lib.audioWriteStream(0 as any, 1, bytes)).toBe(-4)
      expect(lib.audioWriteStream(0 as any, 1, new Uint8Array())).toBe(0)
      expect(calls).toHaveLength(4)
      expect(calls[0]).toHaveLength(4)
      expect(calls[0]![2]).toBe(bytes)
      expect(calls[0]![3]).toBe(bytes.byteLength)
      expect(calls[3]![2]).toBeNull()
      expect(calls[3]![3]).toBe(0)
    } finally {
      symbols.audioWriteStream = original
    }
  })

  test("stream create wrappers reject invalid groups and formats before FFI conversion", () => {
    withStubbedSymbol("audioCreateStream", (calls) => {
      expect(lib.audioSetStreamGroup(0 as any, 1, 1.5)).toBe(-1)
      expect(
        lib.audioCreateStream(0 as any, {
          capacityMs: 100,
          startupMs: 10,
          resumeMs: 10,
          maxProbeBytes: 1024 * 1024,
          format: NativeAudioStreamFormat.Mp3,
          volume: 1,
          pan: 0,
          groupId: 1.5,
        }),
      ).toEqual({ status: -1, streamId: null })
      const validOptions = {
        capacityMs: 100,
        startupMs: 10,
        resumeMs: 10,
        maxProbeBytes: 1024 * 1024,
        volume: 1,
        pan: 0,
        groupId: 0,
      }
      void lib.audioCreateStream(0 as any, {
        ...validOptions,
        format: NativeAudioStreamFormat.Flac,
      })
      expect(
        lib.audioCreateStream(0 as any, {
          ...validOptions,
          format: 1.5 as never,
        }),
      ).toEqual({ status: -1, streamId: null })
      expect(
        lib.audioCreateStream(0 as any, {
          ...validOptions,
          format: 4 as never,
        }),
      ).toEqual({ status: -1, streamId: null })
      for (const invalid of [{ sampleRate: 44100.5 }, { channels: NaN }]) {
        expect(
          lib.audioCreateStream(0 as any, {
            ...validOptions,
            format: NativeAudioStreamFormat.Pcm,
            sampleRate: 44100,
            channels: 2,
            ...invalid,
          }),
        ).toEqual({ status: -1, streamId: null })
      }
      expect(calls).toHaveLength(1)
    })
  })

  test("textBufferSetStyledText passes the packed chunk buffer as an object value", () => {
    withStubbedSymbol("textBufferSetStyledText", (calls) => {
      const chunks = [
        { text: "hello", fg: RGBA.fromValues(1, 0, 0, 1) },
        { text: "world", bg: RGBA.fromValues(0, 0, 1, 1) },
      ]

      lib.textBufferSetStyledText(0 as any, chunks)

      expect(calls).toHaveLength(1)
      expect(calls[0]![1]).toBeInstanceOf(ArrayBuffer)
      expect((calls[0]![1] as ArrayBuffer).byteLength).toBe(StyledChunkStruct.size * chunks.length)
      expect(calls[0]![2]).toBe(chunks.length)
    })
  })

  test("editorViewSetPlaceholderStyledText passes the packed chunk buffer as an object value", () => {
    withStubbedSymbol("editorViewSetPlaceholderStyledText", (calls) => {
      lib.editorViewSetPlaceholderStyledText(0 as any, [{ text: "placeholder", fg: RGBA.fromValues(0, 1, 0, 1) }])
      lib.editorViewSetPlaceholderStyledText(0 as any, [{ text: "" }])

      expect(calls).toHaveLength(2)
      expect(calls[0]![1]).toBeInstanceOf(ArrayBuffer)
      expect((calls[0]![1] as ArrayBuffer).byteLength).toBe(StyledChunkStruct.size)
      expect(calls[1]![1]).toBeNull()
      expect(calls[1]![2]).toBe(0)
    })
  })

  test("setCursorStyleOptions passes the packed options buffer as an object value", () => {
    withStubbedSymbol("setCursorStyleOptions", (calls) => {
      lib.setCursorStyleOptions(0 as any, { style: "block", blinking: true, color: RGBA.fromValues(1, 1, 0, 1) })

      expect(calls).toHaveLength(1)
      expect(calls[0]![1]).toBeInstanceOf(ArrayBuffer)
      expect((calls[0]![1] as ArrayBuffer).byteLength).toBe(CursorStyleOptionsStruct.size)
    })
  })

  test("image calls pass transient buffer owners directly", () => {
    const names = [
      "bufferDrawImage",
      "imageInfo",
      "imageDecode",
      "imageCreateFromRgba",
      "imageCreateFromPixels",
      "imageUpdatePixels",
      "imageGetInfo",
      "imageRetain",
      "imageClone",
      "imageCopyPixels",
      "imageResize",
      "imageExtract",
      "imageExtend",
      "imageTransform",
      "imageComposite",
    ] as const
    const originals = new Map<string, (...args: any[]) => any>()
    const calls = new Map<string, any[]>()
    for (const name of names) {
      originals.set(name, symbols[name]!)
      symbols[name] = (...args: any[]) => {
        calls.set(name, args)
        return 0
      }
    }

    try {
      const data = Uint8Array.of(1, 2, 3, 4)
      const pixels = Uint8Array.of(5, 6, 7, 255)
      const destination = new Uint8Array(4)
      const background = Uint8Array.of(8, 9, 10, 255)
      const handle = 1 as any

      lib.bufferDrawImage(handle, handle, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, "auto")
      const firstImageOptions = calls.get("bufferDrawImage")![2]
      lib.bufferDrawImage(handle, handle, 2, 3, 4, 5, 6, 7, 0, 0, 1, 1, "sixel")
      lib.imageInfo(data)
      lib.imageDecode(data)
      lib.imageCreateFromRgba(pixels, 1, 1, 4)
      lib.imageCreateFromPixels(pixels, 1, 1, 4, 1, 1)
      lib.imageUpdatePixels(handle, pixels, 4, 1, 1)
      lib.imageGetInfo(handle)
      lib.imageRetain(handle)
      lib.imageClone(handle)
      lib.imageCopyPixels(handle, destination, 4, false)
      lib.imageResize(handle, 1, 1, 0)
      lib.imageExtract(handle, 0, 0, 1, 1)
      lib.imageExtend(handle, 0, 0, 0, 0, background)
      lib.imageTransform(handle, 0)
      lib.imageComposite(handle, handle, 0, 0, 0, 255)

      expect(calls.get("bufferDrawImage")![2]).toBe(firstImageOptions)
      expect(firstImageOptions).toBeInstanceOf(Uint8Array)
      expect((firstImageOptions as Uint8Array).byteLength).toBe(ImageDrawOptionsStruct.size)
      expect(ImageDrawOptionsStruct.unpack((firstImageOptions as Uint8Array).buffer)).toMatchObject({
        x: 2,
        y: 3,
        width: 4,
        height: 5,
        pixelWidth: 6,
        pixelHeight: 7,
        protocol: 2,
      })
      expect(calls.get("imageInfo")![0]).toBe(data)
      expect(calls.get("imageInfo")![2]).toBeInstanceOf(ArrayBuffer)
      expect(calls.get("imageDecode")![0]).toBe(data)
      expect(calls.get("imageDecode")![2]).toBeInstanceOf(Uint32Array)
      expect(calls.get("imageCreateFromRgba")![0]).toBe(pixels)
      expect(calls.get("imageCreateFromRgba")![5]).toBeInstanceOf(Uint32Array)
      expect(calls.get("imageCreateFromPixels")![0]).toBe(pixels)
      expect(calls.get("imageCreateFromPixels")!.slice(1, 7)).toEqual([4n, 1, 1, 4, 1, 1])
      expect(calls.get("imageCreateFromPixels")![7]).toBeInstanceOf(Uint32Array)
      expect(calls.get("imageUpdatePixels")![1]).toBe(pixels)
      expect(calls.get("imageUpdatePixels")!.slice(2)).toEqual([4n, 4, 1, 1])
      expect(calls.get("imageGetInfo")![1]).toBeInstanceOf(ArrayBuffer)
      expect(calls.get("imageRetain")![1]).toBeInstanceOf(Uint32Array)
      expect(calls.get("imageClone")![1]).toBeInstanceOf(Uint32Array)
      expect(calls.get("imageCopyPixels")![1]).toBe(destination)
      expect(calls.get("imageResize")![4]).toBeInstanceOf(Uint32Array)
      expect(calls.get("imageExtract")![5]).toBeInstanceOf(Uint32Array)
      expect(calls.get("imageExtend")![5]).toBe(background)
      expect(calls.get("imageExtend")![6]).toBeInstanceOf(Uint32Array)
      expect(calls.get("imageTransform")![2]).toBeInstanceOf(Uint32Array)
      expect(calls.get("imageComposite")![6]).toBeInstanceOf(Uint32Array)
    } finally {
      for (const [name, original] of originals) symbols[name] = original
    }
  })

  test("imageGetPixelsPtr preserves portable pointer returns", () => {
    const original = symbols.imageGetPixelsPtr
    const pointer = 1234n as Pointer
    symbols.imageGetPixelsPtr = (handle) => {
      expect(handle).toBe(1)
      return pointer
    }
    try {
      expect(lib.imageGetPixelsPtr(1 as any)).toBe(pointer)
      symbols.imageGetPixelsPtr = () => 0n
      expect(lib.imageGetPixelsPtr(1 as any)).toBeNull()
    } finally {
      symbols.imageGetPixelsPtr = original
    }
  })

  test("empty image inputs preserve buffer and nullable pointer semantics", () => {
    withStubbedSymbols(
      {
        imageInfo: () => 0,
        imageDecode: () => 0,
        imageCreateFromRgba: () => 0,
        imageUpdatePixels: () => 0,
        imageCopyPixels: () => 0,
      },
      (calls) => {
        const empty = new Uint8Array()
        lib.imageInfo(empty)
        lib.imageDecode(empty)
        lib.imageCreateFromRgba(empty, 0, 0, 0)
        lib.imageUpdatePixels(1 as any, empty, 0, 0, 0)
        lib.imageCopyPixels(1 as any, empty, 0, false)

        expect(calls.imageInfo[0]![0]).toBeNull()
        expect(calls.imageDecode[0]![0]).toBeNull()
        expect(calls.imageCreateFromRgba[0]![0]).toBeNull()
        expect(calls.imageUpdatePixels[0]![1]).toBe(empty)
        expect(calls.imageCopyPixels[0]![1]).toBeNull()
      },
    )
  })

  test("imageExtend rejects a short background before native access", () => {
    withStubbedSymbol("imageExtend", (calls) => {
      expect(lib.imageExtend(1 as any, 0, 0, 0, 0, Uint8Array.of(1, 2, 3))).toEqual({
        status: 7,
        handle: null,
      })
      expect(calls).toHaveLength(0)
    })
  })

  test("clipboard calls pass transient request and output buffers as object values", () => {
    withStubbedSymbols(
      {
        clipboardServiceCreate: () => 1,
        clipboardServiceDestroy: () => 0,
        clipboardReadOperationStart: () => 0,
        clipboardWriteOperationStart: () => 0,
        clipboardClearOperationStart: () => 0,
        clipboardOperationResultMimeLength: () => 0,
        clipboardOperationResultMimeCopy: () => 0,
        clipboardOperationResultDataCopy: () => 0,
        clipboardOperationResultErrorCode: () => 0,
        clipboardOperationResultDiagnosticCopy: () => 0,
      },
      (calls) => {
        const service = lib.clipboardServiceCreate(4, 5, "seat0")!
        lib.clipboardReadOperationStart(service, Uint8Array.of(1, 2), 0, 16, 32, 64, 100)
        lib.clipboardWriteOperationStart(service, Uint8Array.of(3, 4), 0, 100)
        lib.clipboardClearOperationStart(service, 0, 100)
        lib.clipboardOperationResultMimeLength(1 as any)
        lib.clipboardOperationResultMimeCopy(1 as any, new Uint8Array(2))
        lib.clipboardOperationResultDataCopy(1 as any, new Uint8Array(2))
        lib.clipboardOperationResultErrorCode(1 as any)
        lib.clipboardOperationResultDiagnosticCopy(1 as any, new Uint8Array(2))
        lib.clipboardServiceDestroy(service)

        expect(calls.clipboardServiceCreate![0]![2]).toBeInstanceOf(Uint8Array)
        expect(calls.clipboardReadOperationStart![0]![1]).toBeInstanceOf(Uint8Array)
        expect(calls.clipboardReadOperationStart![0]!.slice(4, 8)).toEqual([16, 32, 64, 100])
        expect(calls.clipboardReadOperationStart![0]![8]).toBeInstanceOf(Uint32Array)
        expect(calls.clipboardWriteOperationStart![0]![1]).toBeInstanceOf(Uint8Array)
        expect(calls.clipboardWriteOperationStart![0]![5]).toBeInstanceOf(Uint32Array)
        expect(calls.clipboardClearOperationStart![0]![3]).toBeInstanceOf(Uint32Array)
        expect(calls.clipboardOperationResultMimeLength![0]![1]).toBeInstanceOf(Uint32Array)
        expect(calls.clipboardOperationResultMimeCopy![0]![1]).toBeInstanceOf(Uint8Array)
        expect(calls.clipboardOperationResultDataCopy![0]![1]).toBeInstanceOf(Uint8Array)
        expect(calls.clipboardOperationResultErrorCode![0]![1]).toBeInstanceOf(Uint32Array)
        expect(calls.clipboardOperationResultDiagnosticCopy![0]![1]).toBeInstanceOf(Uint8Array)
      },
    )
  })
})

describe("packed color owner retention", () => {
  test("styled chunk fg and bg colors stay readable after GC of transient chunks", async () => {
    const fgOffset = fieldOffset(StyledChunkStruct, "fg")
    const bgOffset = fieldOffset(StyledChunkStruct, "bg")

    const packTransientChunks = (count: number) => {
      const chunks = []
      const expected = []
      for (let i = 0; i < count; i++) {
        const fg = RGBA.fromValues((i % 16) / 15, 0, 1, 1)
        const bg = RGBA.fromValues(0, (i % 16) / 15, 0, 1)
        chunks.push({ text: `chunk-${i}`, fg, bg })
        expected.push({ fg: [...fg.buffer], bg: [...bg.buffer] })
      }
      // The chunk objects and their RGBA instances are unreachable after this
      // returns; only the packed buffer may keep the color memory alive.
      return { packed: StyledChunkStruct.packList(chunks), expected }
    }

    const count = 16
    const { packed, expected } = packTransientChunks(count)

    for (let round = 0; round < 20; round++) {
      const churn = []
      for (let i = 0; i < 2048; i++) {
        churn.push(new Uint16Array(4).fill(round))
      }
      await forceGc()

      for (let i = 0; i < count; i++) {
        const base = i * StyledChunkStruct.size
        expect(readPackedColor(packed, base + fgOffset)).toEqual(expected[i]!.fg)
        expect(readPackedColor(packed, base + bgOffset)).toEqual(expected[i]!.bg)
      }
    }
  })

  test("cursor style color stays readable after GC of the transient RGBA", async () => {
    const colorOffset = fieldOffset(CursorStyleOptionsStruct, "color")

    const packTransientColor = () => {
      const color = RGBA.fromValues(0.5, 0.25, 0.75, 1)
      return {
        packed: CursorStyleOptionsStruct.pack({ style: 255, blinking: 255, color, cursor: 255 }),
        expected: [...color.buffer],
      }
    }

    const { packed, expected } = packTransientColor()

    for (let round = 0; round < 20; round++) {
      const churn = []
      for (let i = 0; i < 2048; i++) {
        churn.push(new Uint16Array(4).fill(round))
      }
      await forceGc()

      expect(readPackedColor(packed, colorOffset)).toEqual(expected)
    }
  })
})
