#!/usr/bin/env node

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { OptimizedBuffer } from "../buffer.js"
import { EditBuffer } from "../edit-buffer.js"
import { EditorView } from "../editor-view.js"
import { BorderCharArrays } from "../lib/border.js"
import { RGBA } from "../lib/RGBA.js"
import { NativeImage } from "../image.js"
import { TextBufferView } from "../text-buffer-view.js"
import { TextBuffer } from "../text-buffer.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { SpanInfoStruct } from "../zig-structs.js"
import { resolveRenderLib, NativeAudioStreamCloseReason, NativeAudioStreamFormat, type RenderLib } from "../zig.js"
import { createCalibrationPlan, type CalibrationPlan } from "./ffi-fast-path-calibration.js"

type RuntimeName = "bun" | "node"

interface BenchmarkContext {
  lib: RenderLib
  renderer: TestRenderer
}

interface ScenarioRuntime {
  run(operations: number): number
  observe(): number
  teardown(): void
}

interface ScenarioDefinition {
  name: string
  operation: string
  description: string
  setup(context: BenchmarkContext): ScenarioRuntime
}

interface TimedRun {
  elapsedNs: number
  operations: number
  signal: number
  startedAtEpochMs: number
  endedAtEpochMs: number
  cpuUserMicros: number
  cpuSystemMicros: number
  voluntaryContextSwitches: number
  involuntaryContextSwitches: number
}

interface CalibratedRun {
  result: TimedRun
  diagnostics: {
    warmupBatches: TimedRun[]
    measurementBatches: TimedRun[]
    selectedAttempt: number
    calibrationConverged: boolean
    withinTargetWindow: boolean
  }
}

const COLORS = {
  fg: RGBA.fromValues(0.85, 0.9, 1, 1),
  bg: RGBA.fromValues(0.08, 0.12, 0.18, 1),
  translucentFg: RGBA.fromValues(1, 0.25, 0.1, 0.6),
  translucentBg: RGBA.fromValues(0.1, 0.35, 0.8, 0.45),
} as const

const defaultScenarios = createScenarios()
const targetedScenarios = createReusableStorageScenarios()
const scenarios = [...defaultScenarios, ...targetedScenarios]

if (process.argv.includes("--list-scenarios")) {
  for (const scenario of defaultScenarios) console.log(scenario.name)
  process.exit(0)
}

if (process.argv.includes("--list-targeted-scenarios")) {
  for (const scenario of targetedScenarios) console.log(scenario.name)
  process.exit(0)
}

const scenarioName = requiredArg("scenario")
const targetMs = positiveNumberArg("target-ms", 75)
const warmupMs = positiveNumberArg("warmup-ms", 30)
const jsonPath = optionalArg("json")
const outputEnabled = !process.argv.includes("--no-output")
const scenario = scenarios.find((candidate) => candidate.name === scenarioName)

if (!scenario) throw new Error(`unknown scenario: ${scenarioName}`)

const rendererSetup = await createTestRenderer({
  width: 16,
  height: 8,
  screenMode: "split-footer",
  footerHeight: 2,
  externalOutputMode: "passthrough",
  consoleMode: "disabled",
  useMouse: false,
  useThread: false,
  clearOnShutdown: false,
  maxFps: Number.POSITIVE_INFINITY,
})

const context: BenchmarkContext = { lib: resolveRenderLib(), renderer: rendererSetup.renderer }
let runtime: ScenarioRuntime | undefined

try {
  runtime = scenario.setup(context)
  const plan = createCalibrationPlan((operations) => timeRun(runtime!, operations), targetMs, warmupMs)
  if (process.argv.includes("--wait-for-start")) {
    if (outputEnabled) throw new Error("--wait-for-start requires --no-output")
    process.stdout.write("READY\n")
    await waitForStartSignal()
  }
  const calibrated = runRetained(runtime, plan, targetMs)
  const result = calibrated.result
  const observedChecksum = runtime.observe() >>> 0
  const checksum = hashNumbers(result.signal, observedChecksum, result.operations)
  const runtimeName: RuntimeName = typeof process.versions.bun === "string" ? "bun" : "node"
  const payload = {
    schemaVersion: 1,
    scenario: {
      name: scenario.name,
      operation: scenario.operation,
      description: scenario.description,
    },
    sample: {
      runtime: {
        name: runtimeName,
        version: process.versions.bun ?? process.version,
        platform: process.platform,
        arch: process.arch,
      },
      targetMs,
      warmupMs,
      elapsedNs: result.elapsedNs,
      operations: result.operations,
      nsPerOp: result.elapsedNs / result.operations,
      checksum,
      startedAtEpochMs: result.startedAtEpochMs,
      endedAtEpochMs: result.endedAtEpochMs,
      cpuUserMicros: result.cpuUserMicros,
      cpuSystemMicros: result.cpuSystemMicros,
      voluntaryContextSwitches: result.voluntaryContextSwitches,
      involuntaryContextSwitches: result.involuntaryContextSwitches,
      calibration: calibrated.diagnostics,
    },
  }

  if (jsonPath) writeFileSync(resolve(jsonPath), JSON.stringify(payload, null, 2))
  if (outputEnabled) console.log(JSON.stringify(payload, null, 2))
} finally {
  try {
    runtime?.teardown()
  } finally {
    rendererSetup.renderer.destroy()
  }
}

function createScenarios(): ScenarioDefinition[] {
  return [
    {
      name: "renderer_set_pending_split_footer_transition",
      operation: "setPendingSplitFooterTransition",
      description: "Store alternating valid split-footer transitions on a live renderer",
      setup: ({ lib, renderer }) => {
        const snapshot = lib.createOptimizedBuffer(1, 1, "unicode", false, "ffi-bench-transition")
        lib.bufferSetCell(snapshot.ptr, 0, 0, "x", COLORS.fg, COLORS.bg, 0)
        lib.resetSplitScrollback(renderer.rendererPtr, 4, 6)
        return {
          run: (operations) => {
            for (let index = 0; index < operations; index++) {
              const alternate = index & 1
              lib.setPendingSplitFooterTransition(renderer.rendererPtr, 1, 2 + alternate, 2, 3 - alternate, 2, 1)
            }
            return operations
          },
          observe: () => {
            const result = lib.commitSplitFooterSnapshot(renderer.rendererPtr, snapshot, 1, false, false, 6, false)
            const splitOutputOffset = lib.getSplitOutputOffset(renderer.rendererPtr, 6)
            if (splitOutputOffset !== 3) throw new Error(`split transition was not applied: ${splitOutputOffset}`)
            return hashNumbers(
              result.status,
              result.renderOffset,
              splitOutputOffset,
              renderer.getNativeStats().nativeFrameCount,
            )
          },
          teardown: () => snapshot.destroy(),
        }
      },
    },
    {
      name: "renderer_commit_split_footer_snapshot",
      operation: "commitSplitFooterSnapshot",
      description: "Append a one-cell snapshot inside a valid split-footer frame batch",
      setup: ({ lib, renderer }) => {
        const snapshot = lib.createOptimizedBuffer(1, 1, "unicode", false, "ffi-bench-split-commit")
        lib.bufferSetCell(snapshot.ptr, 0, 0, "c", COLORS.fg, COLORS.bg, 0)
        return {
          run: (operations) => {
            let signal = 0
            for (let index = 0; index < operations; index++) {
              const result = lib.commitSplitFooterSnapshot(
                renderer.rendererPtr,
                snapshot,
                1,
                true,
                true,
                6,
                false,
                false,
                false,
              )
              signal = (signal + result.status + result.renderOffset) >>> 0
            }
            return signal
          },
          observe: () => bufferChecksum(snapshot),
          teardown: () => {
            snapshot.destroy()
          },
        }
      },
    },
    createFrameBufferScenario(false),
    createFrameBufferScenario(true),
    createDrawImageScenario("cell", 1, 1),
    createDrawImageScenario("frame", 40, 20),
    createDrawTextScenario("short", "x"),
    createDrawTextScenario("long", "OpenTUI direct FFI benchmark payload ".repeat(4)),
    createDrawTextScenario("unicode", "A界e\u0301👩‍🚀"),
    createSingleBufferScenario(
      "buffer_set_cell_with_alpha_blending",
      "bufferSetCellWithAlphaBlending",
      "Blend one translucent cell through the production wrapper",
      2,
      2,
      (lib, buffer, operations) => {
        for (let index = 0; index < operations; index++) {
          lib.bufferSetCellWithAlphaBlending(
            buffer.ptr,
            index & 1,
            (index >>> 1) & 1,
            index & 1 ? "b" : "a",
            COLORS.translucentFg,
            COLORS.translucentBg,
            index & 1,
          )
        }
        return operations
      },
    ),
    createSingleBufferScenario(
      "buffer_set_cell",
      "bufferSetCell",
      "Set one scalar cell through the production wrapper",
      2,
      2,
      (lib, buffer, operations) => {
        for (let index = 0; index < operations; index++) {
          lib.bufferSetCell(buffer.ptr, index & 1, (index >>> 1) & 1, index & 1 ? "s" : "t", COLORS.fg, COLORS.bg, 1)
        }
        return operations
      },
    ),
    createDrawCharScenario(false),
    createDrawCharScenario(true),
    createSuperSampleScenario("cell", 1, 1),
    createSuperSampleScenario("frame", 80, 24),
    createPackedBufferScenario("origin", 1, 1, 0, 0),
    createPackedBufferScenario("positioned", 1, 1, 1, 1),
    createPackedBufferScenario("frame", 80, 24, 0, 0),
    createGrayscaleScenario(false, "cell", 1, 1),
    createGrayscaleScenario(false, "frame", 80, 24),
    createGrayscaleScenario(true, "cell", 1, 1),
    createGrayscaleScenario(true, "frame", 80, 24),
    createGridScenario("small", new Int32Array([0, 2]), new Int32Array([0, 2]), 3, 3),
    createGridScenario(
      "large",
      new Int32Array(Array.from({ length: 11 }, (_, index) => index * 8)),
      new Int32Array(Array.from({ length: 7 }, (_, index) => index * 4)),
      80,
      24,
    ),
    createBoxScenario("fill", 40, 12, 1 << 4, null, null),
    createBoxScenario("titled", 4, 3, 0b1_1111, "T", "B"),
    createBoxScenario("frame", 80, 24, 0b1_1111, "OpenTUI frame", "status"),
    createTextRangeScenario(false, "short"),
    createTextRangeScenario(false, "multiline"),
    createTextRangeScenario(true, "short"),
    createTextRangeScenario(true, "multiline"),
    createTextBufferSelectionScenario(false, false),
    createTextBufferSelectionScenario(false, true),
    createTextBufferSelectionScenario(true, false),
    createTextBufferSelectionScenario(true, true),
    createEditorSelectionScenario(false, false),
    createEditorSelectionScenario(false, true),
    createEditorSelectionScenario(true, false),
    createEditorSelectionScenario(true, true),
  ]
}

function createDrawImageScenario(label: string, width: number, height: number): ScenarioDefinition {
  return {
    name: `buffer_draw_image_${label}`,
    operation: "OptimizedBuffer.drawImage",
    description: `Clear and draw a retained image into a ${width}x${height} cell placement through the production wrapper`,
    setup: () => {
      const buffer = OptimizedBuffer.create(width, height)
      const pixels = new Uint8Array(320 * 200 * 4)
      for (let index = 0; index < pixels.length; index += 4) {
        pixels[index] = (index >>> 2) & 0xff
        pixels[index + 1] = ((index >>> 2) * 3) & 0xff
        pixels[index + 2] = ((index >>> 2) * 7) & 0xff
        pixels[index + 3] = 255
      }
      let image: NativeImage
      try {
        image = NativeImage.fromRgba(pixels, 320, 200)
      } catch (error) {
        buffer.destroy()
        throw error
      }
      return {
        run: (operations) => {
          let signal = 0
          for (let index = 0; index < operations; index++) {
            buffer.clear(COLORS.bg)
            signal += Number(buffer.drawImage(image, 0, 0, width, height, 320, 200, 0, 0, 320, 200, "auto"))
          }
          return signal
        },
        observe: () => bufferChecksum(buffer) + image.width + image.height,
        teardown: () => {
          buffer.destroy()
          image.dispose()
        },
      }
    },
  }
}

function createReusableStorageScenarios(): ScenarioDefinition[] {
  return [
    createLogicalCursorScenario(),
    createVisualCursorScenario(),
    createMeasureResultScenario(),
    createAudioStreamStatsScenario(),
    createSpanInfoDecodeScenario(),
  ]
}

function createAudioStreamStatsScenario(): ScenarioDefinition {
  return {
    name: "reusable_audio_stream_stats_public",
    operation: "audioGetStreamStats",
    description: "Return fresh audio stream stats from internally reused FFI storage",
    setup: ({ lib }) => {
      const engine = lib.createAudioEngine()
      if (!engine) throw new Error("failed to create benchmark audio engine")
      const created = lib.audioCreateStream(engine, {
        capacityMs: 2_000,
        startupMs: 1_000,
        resumeMs: 500,
        volume: 1,
        pan: 0,
        groupId: 0,
        maxProbeBytes: 2 * 1024 * 1024,
        format: NativeAudioStreamFormat.Mp3,
      })
      if (created.status !== 0 || created.streamId == null) {
        lib.destroyAudioEngine(engine)
        throw new Error(`failed to create benchmark audio stream: ${created.status}`)
      }
      return {
        run: (operations) => {
          let signal = 0
          for (let index = 0; index < operations; index++) {
            const stats = lib.audioGetStreamStats(engine, created.streamId!)
            signal = (signal + (stats?.state ?? 0)) >>> 0
          }
          return signal
        },
        observe: () => lib.audioGetStreamStats(engine, created.streamId!)?.state ?? 0,
        teardown: () => {
          lib.audioCloseStream(engine, created.streamId!, NativeAudioStreamCloseReason.Disposed)
          lib.destroyAudioEngine(engine)
        },
      }
    },
  }
}

function createSpanInfoDecodeScenario(): ScenarioDefinition {
  return {
    name: "reusable_span_info_unpack_list",
    operation: "SpanInfoStruct.unpackList",
    description: "Decode 256 reduced native span records",
    setup: () => {
      const count = 256
      const buffer = new ArrayBuffer(SpanInfoStruct.size * count)
      const view = new DataView(buffer)
      for (let index = 0; index < count; index++) {
        SpanInfoStruct.packInto(
          { chunkPtr: index + 1, offset: index * 4, len: 4, chunkIndex: index, reserved: 0 },
          view,
          index * SpanInfoStruct.size,
        )
      }
      return {
        run: (operations) => {
          let signal = 0
          for (let index = 0; index < operations; index++) {
            const spans = SpanInfoStruct.unpackList(buffer, count)
            signal = (signal + spans[0]!.len + spans[count - 1]!.chunkIndex) >>> 0
          }
          return signal
        },
        observe: () => SpanInfoStruct.unpackList(buffer, count).length,
        teardown: () => {},
      }
    },
  }
}

function createLogicalCursorScenario(): ScenarioDefinition {
  return {
    name: "reusable_logical_cursor_public",
    operation: "editBufferGetCursorPosition",
    description: "Return a fresh logical cursor from internally reused FFI storage",
    setup: ({ lib }) => {
      const editBuffer = EditBuffer.create("unicode")
      editBuffer.setText("logical cursor")
      editBuffer.setCursorByOffset(3)
      return {
        run: (operations) => {
          let signal = 0
          for (let index = 0; index < operations; index++) {
            const cursor = lib.editBufferGetCursorPosition(editBuffer.ptr)
            signal = (signal + cursor.offset) >>> 0
          }
          return signal
        },
        observe: () => editBuffer.getCursorPosition().offset,
        teardown: () => editBuffer.destroy(),
      }
    },
  }
}

function createVisualCursorScenario(): ScenarioDefinition {
  return {
    name: "reusable_visual_cursor_public",
    operation: "editorViewGetVisualCursor",
    description: "Return a fresh visual cursor from internally reused FFI storage",
    setup: ({ lib }) => {
      const editBuffer = EditBuffer.create("unicode")
      editBuffer.setText("visual cursor")
      editBuffer.setCursorByOffset(4)
      const editorView = EditorView.create(editBuffer, 16, 4)
      return {
        run: (operations) => {
          let signal = 0
          for (let index = 0; index < operations; index++) {
            const cursor = lib.editorViewGetVisualCursor(editorView.ptr)
            signal = (signal + cursor.offset) >>> 0
          }
          return signal
        },
        observe: () => editorView.getVisualCursor().offset,
        teardown: () => {
          editorView.destroy()
          editBuffer.destroy()
        },
      }
    },
  }
}

function createMeasureResultScenario(): ScenarioDefinition {
  return {
    name: "reusable_measure_result_public",
    operation: "textBufferViewMeasureForDimensions",
    description: "Return a fresh text measurement result from internally reused FFI storage",
    setup: ({ lib }) => {
      const textBuffer = TextBuffer.create("unicode")
      textBuffer.setText("measure this text across wrapped lines")
      const textBufferView = TextBufferView.create(textBuffer)
      textBufferView.setWrapMode("word")
      return {
        run: (operations) => {
          let signal = 0
          for (let index = 0; index < operations; index++) {
            const measure = lib.textBufferViewMeasureForDimensions(textBufferView.ptr, 10, 100)
            signal = (signal + (measure?.lineCount ?? 0)) >>> 0
          }
          return signal
        },
        observe: () => textBufferView.measureForDimensions(10, 100)?.widthColsMax ?? 0,
        teardown: () => {
          textBufferView.destroy()
          textBuffer.destroy()
        },
      }
    },
  }
}

function createFrameBufferScenario(region: boolean): ScenarioDefinition {
  return {
    name: `buffer_draw_frame_buffer_${region ? "region" : "full"}`,
    operation: "drawFrameBuffer",
    description: region ? "Copy an explicit one-cell source region" : "Copy a complete two-cell frame buffer",
    setup: ({ lib }) => {
      const target = lib.createOptimizedBuffer(2, 1, "unicode", false, `ffi-bench-frame-target-${region}`)
      const source = lib.createOptimizedBuffer(2, 1, "unicode", false, `ffi-bench-frame-source-${region}`)
      lib.bufferDrawText(source.ptr, "fr", 0, 0, COLORS.fg, COLORS.bg, 0)
      return {
        run: (operations) => {
          if (region) {
            for (let index = 0; index < operations; index++) {
              lib.drawFrameBuffer(target.ptr, index & 1, 0, source.ptr, index & 1, 0, 1, 1)
            }
          } else {
            for (let index = 0; index < operations; index++) {
              lib.drawFrameBuffer(target.ptr, 0, 0, source.ptr)
            }
          }
          return operations
        },
        observe: () => bufferChecksum(target),
        teardown: () => {
          source.destroy()
          target.destroy()
        },
      }
    },
  }
}

function createDrawTextScenario(variant: "short" | "long" | "unicode", text: string): ScenarioDefinition {
  const codePoints = [...text].map((char) => char.codePointAt(0)!)
  return {
    name: `buffer_draw_text_${variant}`,
    operation: "bufferDrawText",
    description: `Draw ${variant} text through the encoding and FFI wrapper`,
    setup: ({ lib }) => {
      const buffer = lib.createOptimizedBuffer(
        Math.max(2, codePoints.length + 2),
        1,
        "unicode",
        false,
        `ffi-bench-text-${variant}`,
      )
      return {
        run: (operations) => {
          for (let index = 0; index < operations; index++) {
            lib.bufferDrawText(buffer.ptr, text, 0, 0, COLORS.fg, COLORS.bg, index & 1)
          }
          return operations
        },
        observe: () => {
          lib.bufferDrawText(buffer.ptr, text, 0, 0, COLORS.fg, COLORS.bg, 0)
          if (variant !== "unicode") {
            const chars = buffer.buffers.char
            for (let index = 0; index < codePoints.length; index++) {
              if (chars[index] !== codePoints[index]) {
                throw new Error(
                  `text verification failed at ${index}: expected ${codePoints[index]}, got ${chars[index]}`,
                )
              }
            }
          }
          return bufferChecksum(buffer)
        },
        teardown: () => buffer.destroy(),
      }
    },
  }
}

function createDrawCharScenario(packed: boolean): ScenarioDefinition {
  return {
    name: `buffer_draw_char_${packed ? "packed_grapheme" : "scalar"}`,
    operation: "bufferDrawChar",
    description: packed ? "Draw a retained encoded grapheme handle" : "Draw a Unicode scalar value",
    setup: ({ lib }) => {
      const buffer = lib.createOptimizedBuffer(2, 1, "unicode", false, `ffi-bench-char-${packed}`)
      const encoded = packed ? lib.encodeUnicode("👩‍🚀", "unicode") : null
      const char = packed ? encoded?.data[0]?.char : "Z".codePointAt(0)
      if (char === undefined || (packed && char <= 0x80000000)) throw new Error("failed to create packed grapheme")
      return {
        run: (operations) => {
          for (let index = 0; index < operations; index++) {
            lib.bufferDrawChar(buffer.ptr, char, index & 1, 0, COLORS.fg, COLORS.bg, index & 1)
          }
          return operations
        },
        observe: () => bufferChecksum(buffer),
        teardown: () => {
          if (encoded) lib.freeUnicode(encoded)
          buffer.destroy()
        },
      }
    },
  }
}

function createSuperSampleScenario(
  variant: "cell" | "frame",
  terminalWidth: number,
  terminalHeight: number,
): ScenarioDefinition {
  const pixelWidth = terminalWidth * 2
  const pixelHeight = terminalHeight * 2
  const alignedBytesPerRow = pixelWidth * 4
  return {
    name: `buffer_draw_super_sample_buffer_${variant}`,
    operation: "bufferDrawSuperSampleBuffer",
    description: `Draw a ${terminalWidth}x${terminalHeight} terminal image from a retained RGBA pixel buffer`,
    setup: ({ lib }) => {
      const buffer = lib.createOptimizedBuffer(
        terminalWidth,
        terminalHeight,
        "unicode",
        false,
        `ffi-bench-super-sample-${variant}`,
      )
      const pixels = new Uint8Array(alignedBytesPerRow * pixelHeight)
      for (let index = 0; index < pixels.length; index += 4) {
        pixels[index] = (index >>> 2) & 0xff
        pixels[index + 1] = (index >>> 5) & 0xff
        pixels[index + 2] = (index >>> 8) & 0xff
        pixels[index + 3] = 0xff
      }
      return {
        run: (operations) => {
          for (let index = 0; index < operations; index++) {
            lib.bufferDrawSuperSampleBuffer(
              buffer.ptr,
              0,
              0,
              pixels,
              pixels.byteLength,
              "rgba8unorm",
              alignedBytesPerRow,
            )
          }
          return operations
        },
        observe: () => bufferChecksum(buffer),
        teardown: () => buffer.destroy(),
      }
    },
  }
}

function createPackedBufferScenario(
  variant: "origin" | "positioned" | "frame",
  terminalWidth: number,
  terminalHeight: number,
  posX: number,
  posY: number,
): ScenarioDefinition {
  return {
    name: `buffer_draw_packed_buffer_${variant}`,
    operation: "bufferDrawPackedBuffer",
    description: `Draw a valid ${terminalWidth}x${terminalHeight} CellResult payload at ${posX},${posY}`,
    setup: ({ lib }) => {
      const buffer = lib.createOptimizedBuffer(
        terminalWidth + posX,
        terminalHeight + posY,
        "unicode",
        false,
        `ffi-bench-packed-buffer-${variant}`,
      )
      const packed = new ArrayBuffer(terminalWidth * terminalHeight * 48)
      const view = new DataView(packed)
      for (let cell = 0; cell < terminalWidth * terminalHeight; cell++) {
        const offset = cell * 48
        view.setFloat32(offset, 0.08, true)
        view.setFloat32(offset + 4, 0.12, true)
        view.setFloat32(offset + 8, 0.18, true)
        view.setFloat32(offset + 12, 1, true)
        view.setFloat32(offset + 16, 0.85, true)
        view.setFloat32(offset + 20, 0.9, true)
        view.setFloat32(offset + 24, 1, true)
        view.setFloat32(offset + 28, 1, true)
        view.setUint32(offset + 32, 0x2588, true)
      }
      const packedBytes = new Uint8Array(packed)
      return {
        run: (operations) => {
          for (let index = 0; index < operations; index++) {
            lib.bufferDrawPackedBuffer(
              buffer.ptr,
              packedBytes,
              packedBytes.byteLength,
              posX,
              posY,
              terminalWidth,
              terminalHeight,
            )
          }
          return operations
        },
        observe: () => bufferChecksum(buffer),
        teardown: () => buffer.destroy(),
      }
    },
  }
}

function createGrayscaleScenario(
  supersampled: boolean,
  variant: "cell" | "frame",
  terminalWidth: number,
  terminalHeight: number,
): ScenarioDefinition {
  const sourceWidth = supersampled ? terminalWidth * 2 : terminalWidth
  const sourceHeight = supersampled ? terminalHeight * 2 : terminalHeight
  return {
    name: `buffer_draw_grayscale_buffer${supersampled ? "_supersampled" : ""}_${variant}`,
    operation: supersampled ? "bufferDrawGrayscaleBufferSupersampled" : "bufferDrawGrayscaleBuffer",
    description: `Draw a ${terminalWidth}x${terminalHeight} ${supersampled ? "supersampled " : ""}grayscale image`,
    setup: ({ lib }) => {
      const buffer = lib.createOptimizedBuffer(
        terminalWidth,
        terminalHeight,
        "unicode",
        false,
        `ffi-bench-grayscale-${supersampled}-${variant}`,
      )
      const intensities = new Float32Array(sourceWidth * sourceHeight)
      for (let index = 0; index < intensities.length; index++) intensities[index] = (index % 17) / 16
      return {
        run: (operations) => {
          if (supersampled) {
            for (let index = 0; index < operations; index++) {
              lib.bufferDrawGrayscaleBufferSupersampled(
                buffer.ptr,
                0,
                0,
                intensities,
                sourceWidth,
                sourceHeight,
                COLORS.fg,
                COLORS.bg,
              )
            }
          } else {
            for (let index = 0; index < operations; index++) {
              lib.bufferDrawGrayscaleBuffer(
                buffer.ptr,
                0,
                0,
                intensities,
                sourceWidth,
                sourceHeight,
                COLORS.fg,
                COLORS.bg,
              )
            }
          }
          return operations
        },
        observe: () => bufferChecksum(buffer),
        teardown: () => {
          buffer.destroy()
          void intensities.byteLength
        },
      }
    },
  }
}

function createGridScenario(
  variant: "small" | "large",
  columnOffsets: Int32Array,
  rowOffsets: Int32Array,
  width: number,
  height: number,
): ScenarioDefinition {
  return createSingleBufferScenario(
    `buffer_draw_grid_${variant}`,
    "bufferDrawGrid",
    `Draw a ${columnOffsets.length - 1}x${rowOffsets.length - 1} grid with valid offset arrays`,
    width,
    height,
    (lib, buffer, operations) => {
      for (let index = 0; index < operations; index++) {
        lib.bufferDrawGrid(
          buffer.ptr,
          BorderCharArrays.single,
          COLORS.fg,
          COLORS.bg,
          columnOffsets,
          columnOffsets.length - 1,
          rowOffsets,
          rowOffsets.length - 1,
          {
            drawInner: true,
            drawOuter: true,
          },
        )
      }
      return operations
    },
  )
}

function createBoxScenario(
  variant: "fill" | "titled" | "frame",
  width: number,
  height: number,
  packedOptions: number,
  title: string | null,
  bottomTitle: string | null,
): ScenarioDefinition {
  return createSingleBufferScenario(
    `buffer_draw_box_${variant}`,
    "bufferDrawBox",
    `Draw a ${width}x${height} ${variant} box through the production wrapper`,
    width,
    height,
    (lib, buffer, operations) => {
      for (let index = 0; index < operations; index++) {
        lib.bufferDrawBox(
          buffer.ptr,
          0,
          0,
          width,
          height,
          BorderCharArrays.single,
          packedOptions,
          COLORS.fg,
          COLORS.bg,
          COLORS.fg,
          title,
          bottomTitle,
        )
      }
      return operations
    },
  )
}

function createTextRangeScenario(editable: boolean, variant: "short" | "multiline"): ScenarioDefinition {
  const lines =
    variant === "short"
      ? ["alpha beta", "gamma delta", "unicode 界"]
      : Array.from({ length: 200 }, (_, index) => `line ${index.toString().padStart(3, "0")} unicode 界🙂 payload`)
  const text = lines.join("\n")
  const maxLength = new TextEncoder().encode(text).byteLength
  return {
    name: `${editable ? "edit" : "text"}_buffer_get_text_range_by_coords_${variant}`,
    operation: editable ? "editBufferGetTextRangeByCoords" : "textBufferGetTextRangeByCoords",
    description: `Read a ${variant} coordinate range from a live ${editable ? "EditBuffer" : "TextBuffer"}`,
    setup: ({ lib }) => {
      const owner = editable ? EditBuffer.create("unicode") : TextBuffer.create("unicode")
      owner.setText(text)
      const getRange = editable
        ? (startCol: number, endRow: number, endCol: number) =>
            lib.editBufferGetTextRangeByCoords((owner as EditBuffer).ptr, 0, startCol, endRow, endCol, maxLength)
        : (startCol: number, endRow: number, endCol: number) =>
            lib.textBufferGetTextRangeByCoords((owner as TextBuffer).ptr, 0, startCol, endRow, endCol, maxLength)
      return {
        run: (operations) => {
          let signal = 0
          for (let index = 0; index < operations; index++) {
            const bytes = getRange(
              index & 1,
              variant === "short" ? 1 : lines.length - 1,
              variant === "short" ? 5 + (index & 1) : lines.at(-1)!.length,
            )
            signal = (signal + (bytes?.byteLength ?? 0) + (bytes?.[0] ?? 0)) >>> 0
          }
          return signal
        },
        observe: () => {
          const endRow = variant === "short" ? 1 : lines.length - 1
          const endCol = variant === "short" ? 5 : lines.at(-1)!.length
          const expected =
            variant === "short"
              ? `${lines[0]}\n${lines[1]!.slice(0, endCol)}`
              : `${lines.slice(0, -1).join("\n")}\n${lines.at(-1)!.slice(0, -1)}`
          const bytes = getRange(0, endRow, endCol)
          const actual = bytes ? new TextDecoder().decode(bytes) : null
          if (actual !== expected) throw new Error(`range verification failed: expected ${expected}, got ${actual}`)
          return stringChecksum(actual)
        },
        teardown: () => owner.destroy(),
      }
    },
  }
}

function createTextBufferSelectionScenario(update: boolean, styled: boolean): ScenarioDefinition {
  const bg = styled ? COLORS.bg : null
  const fg = styled ? COLORS.fg : null
  return {
    name: `text_buffer_view_${update ? "update" : "set"}_local_selection_${styled ? "styled" : "plain"}`,
    operation: update ? "textBufferViewUpdateLocalSelection" : "textBufferViewSetLocalSelection",
    description: `${update ? "Update" : "Set"} a ${styled ? "styled" : "plain"} local selection on a live TextBufferView`,
    setup: ({ lib }) => {
      const buffer = TextBuffer.create("unicode")
      buffer.setText("alpha beta\ngamma delta")
      const view = TextBufferView.create(buffer)
      view.setViewportSize(20, 2)
      view.setLocalSelection(0, 0, 1, 0, bg ?? undefined, fg ?? undefined)
      return {
        run: (operations) => {
          let signal = 0
          for (let index = 0; index < operations; index++) {
            const focus = index & 1 ? 5 : 9
            const changed = update
              ? lib.textBufferViewUpdateLocalSelection(view.ptr, 0, 0, focus, 0, bg, fg)
              : lib.textBufferViewSetLocalSelection(view.ptr, 0, 0, focus, 0, bg, fg)
            signal = (signal + Number(changed) + focus) >>> 0
          }
          return signal
        },
        observe: () => {
          if (update) lib.textBufferViewUpdateLocalSelection(view.ptr, 0, 0, 5, 0, bg, fg)
          else lib.textBufferViewSetLocalSelection(view.ptr, 0, 0, 5, 0, bg, fg)
          const selected = view.getSelectedText()
          if (selected !== "alpha") throw new Error(`selection verification failed: ${selected}`)
          return stringChecksum(selected)
        },
        teardown: () => {
          view.destroy()
          buffer.destroy()
        },
      }
    },
  }
}

function createEditorSelectionScenario(update: boolean, styled: boolean): ScenarioDefinition {
  const bg = styled ? COLORS.bg : null
  const fg = styled ? COLORS.fg : null
  return {
    name: `editor_view_${update ? "update" : "set"}_local_selection_${styled ? "styled" : "plain"}`,
    operation: update ? "editorViewUpdateLocalSelection" : "editorViewSetLocalSelection",
    description: `${update ? "Update" : "Set"} a ${styled ? "styled" : "plain"} local selection on a live EditorView`,
    setup: ({ lib }) => {
      const buffer = EditBuffer.create("unicode")
      buffer.setText("alpha beta\ngamma delta")
      const view = EditorView.create(buffer, 20, 2)
      view.setLocalSelection(0, 0, 1, 0, bg ?? undefined, fg ?? undefined, false, false)
      return {
        run: (operations) => {
          let signal = 0
          for (let index = 0; index < operations; index++) {
            const focus = index & 1 ? 5 : 9
            const changed = update
              ? lib.editorViewUpdateLocalSelection(view.ptr, 0, 0, focus, 0, bg, fg, false, false)
              : lib.editorViewSetLocalSelection(view.ptr, 0, 0, focus, 0, bg, fg, false, false)
            signal = (signal + Number(changed) + focus) >>> 0
          }
          return signal
        },
        observe: () => stringChecksum(view.getSelectedText()),
        teardown: () => {
          view.destroy()
          buffer.destroy()
        },
      }
    },
  }
}

function createSingleBufferScenario(
  name: string,
  operation: string,
  description: string,
  width: number,
  height: number,
  run: (lib: RenderLib, buffer: OptimizedBuffer, operations: number) => number,
): ScenarioDefinition {
  return {
    name,
    operation,
    description,
    setup: ({ lib }) => {
      const buffer = lib.createOptimizedBuffer(width, height, "unicode", false, `ffi-bench-${name}`)
      return {
        run: (operations) => run(lib, buffer, operations),
        observe: () => bufferChecksum(buffer),
        teardown: () => buffer.destroy(),
      }
    },
  }
}

function runRetained(runtime: ScenarioRuntime, plan: CalibrationPlan<TimedRun>, targetMs: number): CalibratedRun {
  const targetNs = targetMs * 1_000_000
  const result = timeRun(runtime, plan.operations)
  const withinTargetWindow = result.elapsedNs >= targetNs * 0.9 && result.elapsedNs <= targetNs * 1.1
  return {
    result,
    diagnostics: {
      ...plan.diagnostics,
      withinTargetWindow,
    },
  }
}

function timeRun(runtime: ScenarioRuntime, operations: number): TimedRun {
  const cpuBefore = process.cpuUsage()
  const resourceBefore = process.resourceUsage()
  const startedAtEpochMs = performance.timeOrigin + performance.now()
  const start = process.hrtime.bigint()
  const signal = runtime.run(operations)
  const elapsedNs = Number(process.hrtime.bigint() - start)
  const endedAtEpochMs = performance.timeOrigin + performance.now()
  const cpu = process.cpuUsage(cpuBefore)
  const resource = process.resourceUsage()
  return {
    elapsedNs,
    operations,
    signal,
    startedAtEpochMs,
    endedAtEpochMs,
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
    voluntaryContextSwitches: Math.max(0, resource.voluntaryContextSwitches - resourceBefore.voluntaryContextSwitches),
    involuntaryContextSwitches: Math.max(
      0,
      resource.involuntaryContextSwitches - resourceBefore.involuntaryContextSwitches,
    ),
  }
}

async function waitForStartSignal(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("timed out waiting for paired benchmark start signal")), 120_000)
    const onData = () => finish()
    const onEnd = () => finish(new Error("paired benchmark input closed before start signal"))
    const onError = (error: Error) => finish(error)
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      process.stdin.off("data", onData)
      process.stdin.off("end", onEnd)
      process.stdin.off("error", onError)
      if (error) reject(error)
      else resolve()
    }
    process.stdin.once("data", onData)
    process.stdin.once("end", onEnd)
    process.stdin.once("error", onError)
    process.stdin.resume()
  })
}

function bufferChecksum(buffer: OptimizedBuffer): number {
  const buffers = buffer.buffers
  let hash = 2166136261
  for (const values of [buffers.char, buffers.fg, buffers.bg, buffers.attributes]) {
    for (let index = 0; index < values.length; index++) {
      hash = Math.imul(hash ^ values[index]!, 16777619)
    }
  }
  return hash >>> 0
}

function stringChecksum(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return hash >>> 0
}

function hashNumbers(...values: number[]): number {
  let hash = 2166136261
  for (const value of values) hash = Math.imul(hash ^ (value >>> 0), 16777619)
  return hash >>> 0
}

function positiveNumberArg(name: string, fallback: number): number {
  const value = Number(optionalArg(name) ?? fallback)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be > 0`)
  return value
}

function requiredArg(name: string): string {
  const value = optionalArg(name)
  if (!value) throw new Error(`--${name} is required`)
  return value
}

function optionalArg(name: string): string | null {
  const prefix = `--${name}=`
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null
}
