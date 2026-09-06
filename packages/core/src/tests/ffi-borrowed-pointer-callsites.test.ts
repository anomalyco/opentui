import { describe, expect, test } from "bun:test"
import { NativeAudioStreamState as ExportedAudioStreamState, resolveRenderLib } from "../zig.js"
import {
  AudioCaptureStatsStruct,
  AudioStreamCreateOptionsStruct,
  AudioStreamStatsStruct,
  NativeAudioStreamCloseReason,
  NativeAudioStreamFormat,
  NativeAudioStreamState,
} from "../zig-structs.js"
import { RGBA } from "../lib/RGBA.js"
import { ptr, toArrayBuffer, type Pointer } from "../platform/ffi.js"

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

function fieldOffset(struct: { layoutByName: Map<string, { offset: number }> }, name: string): number {
  const field = struct.layoutByName.get(name)
  if (!field) {
    throw new Error(`Missing struct field: ${name}`)
  }
  return field.offset
}

describe("borrowed pointer call sites", () => {
  test("checked text and editor replacement preserve transient byte owners and spans", () => {
    const context = lib.createContext({ objectCapacity: 4, renderCellsMax: 1 })
    try {
      const text = lib.createContextTextBuffer(context)
      const edit = lib.createContextEditBuffer(context)
      const bytes = new Uint8Array([0, 65, 66, 0]).subarray(1, 3)
      withStubbedSymbols({ ot_text_buffer_set_text: () => 0, ot_edit_buffer_set_text: () => 0 }, (calls) => {
        lib.contextTextBufferSetText(context, text, bytes)
        lib.contextEditBufferSetText(context, edit, bytes)
        for (const name of ["ot_text_buffer_set_text", "ot_edit_buffer_set_text"]) {
          const input = calls[name]![0]![2] as Uint8Array
          expect(input).toBeInstanceOf(Uint8Array)
          expect(input.buffer).toBe(bytes.buffer)
          expect(input.byteOffset).toBe(bytes.byteOffset)
          expect(input.byteLength).toBe(bytes.byteLength)
          expect(calls[name]![0]![3]).toBe(bytes.byteLength)
        }
      })
    } finally {
      lib.destroyContext(context)
    }
  })

  test("audio stats reuse owned output storage without aliasing public results", () => {
    const outputs: ArrayBuffer[] = []
    let bytesReceived = 20n
    withStubbedSymbols(
      {
        audioGetStreamStats: (_engine, _stream, output: ArrayBuffer) => {
          outputs.push(output)
          AudioStreamStatsStruct.packInto(
            {
              bytesReceived: bytesReceived++,
              framesDecoded: 2n,
              framesPlayed: 1n,
              state: NativeAudioStreamState.Playing,
              sampleRate: 48000,
              channels: 2,
              bufferedFrames: 100,
              capacityFrames: 200,
              underruns: 0,
              errorCode: 0,
              readyGeneration: 1,
            },
            new DataView(output),
            0,
          )
          return 0
        },
      },
      () => {
        const first = lib.audioGetStreamStats(4 as never, 5)!
        const second = lib.audioGetStreamStats(4 as never, 5)!
        expect(first).not.toBe(second)
        expect(first.bytesReceived).toBe(20n)
        expect(second.bytesReceived).toBe(21n)
        expect(outputs[1]).toBe(outputs[0])
      },
    )
  })

  test("audio stream structs preserve the native ABI", () => {
    expect(AudioStreamCreateOptionsStruct.size).toBe(32)
    expect(
      Object.fromEntries(
        ["capacityMs", "startupMs", "resumeMs", "volume", "pan", "groupId", "maxProbeBytes", "format"].map((name) => [
          name,
          fieldOffset(AudioStreamCreateOptionsStruct, name),
        ]),
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

  test("audioCloseStream forwards its reason and unpacks the owned output buffer", () => {
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
        new DataView(args[3]),
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
      expect(calls[0]![3]).toBeInstanceOf(ArrayBuffer)
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
          format: 3 as never,
        }),
      ).toEqual({ status: -1, streamId: null })
      expect(calls).toHaveLength(1)
    })
  })

  test("Session cursor calls pass the packed options and color as transient typed-array owners", () => {
    const context = lib.createContext({ objectCapacity: 2, renderCellsMax: 16 })
    try {
      const session = lib.createSession(context, { chunkSize: 4096, spanCapacity: 4, maxBytes: 16384n })
      withStubbedSymbols({ ot_session_control: () => 0 }, (calls) => {
        const color = RGBA.fromValues(1, 1, 0, 1)
        lib.sessionSetCursor(context, session, { style: "block", blinking: true, color })

        expect(calls.ot_session_control).toHaveLength(1)
        const [, handle, record, bytes, length] = calls.ot_session_control[0]!
        expect(handle).toBeInstanceOf(BigUint64Array)
        expect(record).toBeInstanceOf(Uint32Array)
        expect([...record]).toEqual([20, 1, 8, 0, 0])
        expect(bytes).toBeInstanceOf(Uint8Array)
        expect(length).toBe(24)
        expect(new Uint32Array(bytes.buffer)[0]).toBe(14)
        expect(bytes[13]).toBe(0)
        expect(bytes[14]).toBe(1)
        expect([...new Uint16Array(bytes.buffer, 16, 4)]).toEqual([...color.buffer])
      })
    } finally {
      lib.destroyContext(context)
    }
  })

  test("image calls pass transient buffer owners directly", () => {
    const names = [
      "imageInfo",
      "imageDecode",
      "imageCreateFromRgba",
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

      lib.imageInfo(data)
      lib.imageDecode(data)
      lib.imageCreateFromRgba(pixels, 1, 1, 4)
      lib.imageGetInfo(handle)
      lib.imageRetain(handle)
      lib.imageClone(handle)
      lib.imageCopyPixels(handle, destination, 4, false)
      lib.imageResize(handle, 1, 1, 0)
      lib.imageExtract(handle, 0, 0, 1, 1)
      lib.imageExtend(handle, 0, 0, 0, 0, background)
      lib.imageTransform(handle, 0)
      lib.imageComposite(handle, handle, 0, 0, 0, 255)

      expect(calls.get("imageInfo")![0]).toBe(data)
      expect(calls.get("imageInfo")![2]).toBeInstanceOf(ArrayBuffer)
      expect(calls.get("imageDecode")![0]).toBe(data)
      expect(calls.get("imageDecode")![2]).toBeInstanceOf(Uint32Array)
      expect(calls.get("imageCreateFromRgba")![0]).toBe(pixels)
      expect(calls.get("imageCreateFromRgba")![5]).toBeInstanceOf(Uint32Array)
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

  test("empty image inputs preserve nullable pointer semantics", () => {
    withStubbedSymbols(
      {
        imageInfo: () => 0,
        imageDecode: () => 0,
        imageCreateFromRgba: () => 0,
        imageCopyPixels: () => 0,
      },
      (calls) => {
        const empty = new Uint8Array()
        lib.imageInfo(empty)
        lib.imageDecode(empty)
        lib.imageCreateFromRgba(empty, 0, 0, 0)
        lib.imageCopyPixels(1 as any, empty, 0, false)

        expect(calls.imageInfo[0]![0]).toBeNull()
        expect(calls.imageDecode[0]![0]).toBeNull()
        expect(calls.imageCreateFromRgba[0]![0]).toBeNull()
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
