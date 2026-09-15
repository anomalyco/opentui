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
      expect(calls[3]![2]).toBeInstanceOf(Uint8Array)
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

  test("image calls pass transient buffer owners directly", () => {
    const names = [
      "ot_image_inspect",
      "ot_image_decode",
      "ot_image_create_pixels",
      "ot_image_get_info",
      "ot_image_retain",
      "ot_image_clone",
      "ot_image_copy_pixels",
      "ot_image_resize",
      "ot_image_extract",
      "ot_image_extend",
      "ot_image_transform",
      "ot_image_composite",
    ] as const
    const context = lib.createContext({ objectCapacity: 4, renderCellsMax: 1 })
    const handle = lib.imageCreateFromRgba(context, Uint8Array.of(1, 2, 3, 255), 1, 1, 4).handle!
    const originals = new Map<string, (...args: any[]) => any>()
    const calls = new Map<string, any[]>()
    for (const name of names) {
      originals.set(name, symbols[name]!)
      symbols[name] = (...args: any[]) => {
        calls.set(name, args)
        return -1
      }
    }

    try {
      const data = Uint8Array.of(1, 2, 3, 4)
      const pixels = Uint8Array.of(5, 6, 7, 255)
      const destination = new Uint8Array(4)
      const background = Uint8Array.of(8, 9, 10, 255)
      lib.imageInfo(context, data)
      lib.imageDecode(context, data)
      lib.imageCreateFromRgba(context, pixels, 1, 1, 4)
      lib.imageGetInfo(handle)
      lib.imageRetain(handle)
      lib.imageClone(handle)
      lib.imageCopyPixels(handle, destination, 4, false)
      lib.imageResize(handle, 1, 1, 0)
      lib.imageExtract(handle, 0, 0, 1, 1)
      lib.imageExtend(handle, 0, 0, 0, 0, background)
      lib.imageTransform(handle, 0)
      lib.imageComposite(handle, handle, 0, 0, 0, 255)

      for (const [input, source] of [
        [calls.get("ot_image_inspect")![1], data],
        [calls.get("ot_image_decode")![1], data],
        [calls.get("ot_image_create_pixels")![1], pixels],
        [calls.get("ot_image_copy_pixels")![2], destination],
        [calls.get("ot_image_extend")![6], background],
      ]) {
        expect(input).toBeInstanceOf(Uint8Array)
        expect(input.buffer).toBe(source.buffer)
        expect(input.byteOffset).toBe(source.byteOffset)
        expect(input.byteLength).toBe(source.byteLength)
      }
      expect(calls.get("ot_image_inspect")![3]).toBeInstanceOf(Uint32Array)
      expect(calls.get("ot_image_decode")![3]).toBeInstanceOf(BigUint64Array)
      expect(calls.get("ot_image_create_pixels")![8]).toBeInstanceOf(BigUint64Array)
      expect(calls.get("ot_image_get_info")![2]).toBeInstanceOf(Uint32Array)
      expect(calls.get("ot_image_retain")![2]).toBeInstanceOf(BigUint64Array)
      expect(calls.get("ot_image_clone")![3]).toBeInstanceOf(BigUint64Array)
      expect(calls.get("ot_image_resize")![5]).toBeInstanceOf(BigUint64Array)
      expect(calls.get("ot_image_extract")![6]).toBeInstanceOf(BigUint64Array)
      expect(calls.get("ot_image_extend")![7]).toBeInstanceOf(BigUint64Array)
      expect(calls.get("ot_image_transform")![3]).toBeInstanceOf(BigUint64Array)
      expect(calls.get("ot_image_composite")![7]).toBeInstanceOf(BigUint64Array)
    } finally {
      for (const [name, original] of originals) symbols[name] = original
      lib.destroyContext(context)
    }
  })

  test("imageExtend rejects a short background before native access", () => {
    withStubbedSymbol("ot_image_extend", (calls) => {
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
        ot_clipboard_service_create: () => 0,
        ot_clipboard_service_destroy: () => 0,
        ot_clipboard_read_operation_start: () => 0,
        ot_clipboard_write_operation_start: () => 0,
        ot_clipboard_clear_operation_start: () => 0,
        ot_clipboard_operation_result_mime_length: () => 0,
        ot_clipboard_operation_result_mime_copy: () => 0,
        ot_clipboard_operation_result_data_copy: () => 0,
        ot_clipboard_operation_result_error_code: () => 0,
        ot_clipboard_operation_result_diagnostic_copy: () => 0,
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

        expect(calls.ot_clipboard_service_create![0]![3]).toBeInstanceOf(Uint8Array)
        expect(calls.ot_clipboard_read_operation_start![0]![1]).toBeInstanceOf(Uint8Array)
        expect(calls.ot_clipboard_read_operation_start![0]!.slice(4, 8)).toEqual([16, 32, 64, 100])
        expect(calls.ot_clipboard_read_operation_start![0]![8]).toBeInstanceOf(BigUint64Array)
        expect(calls.ot_clipboard_write_operation_start![0]![1]).toBeInstanceOf(Uint8Array)
        expect(calls.ot_clipboard_write_operation_start![0]![5]).toBeInstanceOf(BigUint64Array)
        expect(calls.ot_clipboard_clear_operation_start![0]![3]).toBeInstanceOf(BigUint64Array)
        expect(calls.ot_clipboard_operation_result_mime_length![0]![2]).toBeInstanceOf(Uint32Array)
        expect(calls.ot_clipboard_operation_result_mime_copy![0]![2]).toBeInstanceOf(Uint8Array)
        expect(calls.ot_clipboard_operation_result_data_copy![0]![2]).toBeInstanceOf(Uint8Array)
        expect(calls.ot_clipboard_operation_result_error_code![0]![2]).toBeInstanceOf(Uint32Array)
        expect(calls.ot_clipboard_operation_result_diagnostic_copy![0]![2]).toBeInstanceOf(Uint8Array)
      },
    )
  })
})
