import { getYogaNode } from "../lib/renderable-layout.js"
import {
  BoxRenderable,
  MarkdownRenderable,
  SyntaxStyle,
  TextareaRenderable,
  TextBuffer,
  TextBufferView,
  TextRenderable,
} from "../index.js"
import { OptimizedBuffer, ResourceContext } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { StdinParser } from "../lib/stdin-parser.js"
import type { Renderable } from "../Renderable.js"
import { CliRenderEvents, MouseEvent, type CliRendererErrorEvent } from "../renderer.js"
import { allocateProportionalColumnWidths } from "../renderables/text-table-width.js"
import { createTestRenderer, type TestRendererSetup } from "../testing.js"
import { Direction, FlexDirection, Node as YogaNode } from "../yoga.js"
import type { BenchmarkCase } from "./js-benchmark-harness.js"

const WIDTH = 140
const HEIGHT = 44
const LEAF_COUNT = 96
const YOGA_NODE_COUNT = 100
const RENDER_COLORS = {
  panel: RGBA.fromInts(28, 32, 38),
  element: RGBA.fromInts(40, 46, 56),
  accent: RGBA.fromInts(84, 171, 224),
  warning: RGBA.fromInts(219, 186, 96),
} as const
const RENDER_UNICODE = [
  "alpha 世界 é 👩‍💻 🇺🇳 wrap at the cell boundary ",
  "bravo 日本 ä 👨‍🚀 🇯🇵 different wrapped text ",
] as const

interface ColumnWidthInput {
  widths: number[]
  targetWidth: number
  minWidth: number
  expected: readonly number[]
}

const columnWidthInputs: readonly ColumnWidthInput[] = [
  {
    widths: [4, 49, 4, 54, 38],
    targetWidth: 104,
    minWidth: 1,
    expected: [4, 33, 4, 34, 29],
  },
  {
    widths: new Array(64).fill(17),
    targetWidth: 584,
    minWidth: 1,
    expected: [...new Array(8).fill(10), ...new Array(56).fill(9)],
  },
]

function proportionalColumnWidthsCase(): BenchmarkCase {
  return {
    category: "JS Text Table",
    name: "proportional-column-widths",
    workload_version: 1,
    parameters: {
      allocations_per_operation: 1,
      mix: "alternating",
      min_width: 1,
      ordinary_widths: "4,49,4,54,38",
      ordinary_target_width: 104,
      remainder_columns: 64,
      remainder_width: 17,
      remainder_target_width: 584,
    },
    setup() {
      for (const input of columnWidthInputs) {
        validateAllocation(
          allocateProportionalColumnWidths(input.widths, input.targetWidth, input.minWidth),
          input.expected,
        )
      }
      const contributions = columnWidthInputs.map((input) => input.expected[0]! + input.expected.at(-1)! * 3)
      let signal = 0
      let completed = 0
      let validated = 0
      let lastResult: number[] | undefined

      return {
        run(iteration) {
          const input = columnWidthInputs[iteration % columnWidthInputs.length]!
          lastResult = allocateProportionalColumnWidths(input.widths, input.targetWidth, input.minWidth)
          signal = (signal + lastResult[0]! + lastResult.at(-1)! * 3) | 0
          completed++
        },
        validateBatch(iterations) {
          const actual = completed - validated
          if (actual !== iterations) {
            throw new Error(`proportional-column-widths: completed ${actual} operations, expected ${iterations}`)
          }
          const remainderOperations = Math.floor(completed / 2)
          const ordinaryOperations = completed - remainderOperations
          const expectedSignal =
            (Math.imul(ordinaryOperations, contributions[0]!) + Math.imul(remainderOperations, contributions[1]!)) | 0
          if (signal !== expectedSignal) {
            throw new Error(`proportional-column-widths: signal ${signal}, expected ${expectedSignal}`)
          }
          const lastInput = columnWidthInputs[(completed - 1) % columnWidthInputs.length]!
          validateAllocation(lastResult, lastInput.expected)
          validated = completed
        },
        teardown() {},
      }
    },
  }
}

const WORD_WRAP_LOGICAL_LINES = 64
const WORD_WRAP_TOKENS_PER_LINE = 128
const WORD_WRAP_LINE_COLUMNS = 767
const WORD_WRAP_TEXT_BYTES = 49_151
const WORD_WRAP_WIDTH_A = 72
const WORD_WRAP_WIDTH_B = 78
const WORD_WRAP_MEASURE_HEIGHT = 2_048
const WORD_WRAP_LINE = `${"token ".repeat(WORD_WRAP_TOKENS_PER_LINE - 1)}token`
const WORD_WRAP_TEXT = new Array(WORD_WRAP_LOGICAL_LINES).fill(WORD_WRAP_LINE).join("\n")
const WORD_WRAP_CONTRIBUTION_A = 704_072
const WORD_WRAP_CONTRIBUTION_B = 1_920_234

function textBufferWordWrapMeasureCase(): BenchmarkCase {
  return {
    category: "JS Text",
    name: "text-buffer-word-wrap-measure",
    workload_version: 1,
    parameters: {
      width_method: "unicode",
      wrap_mode: "word",
      logical_lines: WORD_WRAP_LOGICAL_LINES,
      tokens_per_line: WORD_WRAP_TOKENS_PER_LINE,
      line_columns: WORD_WRAP_LINE_COLUMNS,
      text_bytes: WORD_WRAP_TEXT_BYTES,
      width_a: WORD_WRAP_WIDTH_A,
      width_b: WORD_WRAP_WIDTH_B,
      measure_height: WORD_WRAP_MEASURE_HEIGHT,
    },
    setup() {
      const owner = new ResourceContext({ objectCapacity: 2, renderCellsMax: 1 })
      try {
        const textBuffer = TextBuffer.create("unicode", owner)

        textBuffer.setText(WORD_WRAP_TEXT)
        const view = TextBufferView.create(textBuffer)

        view.setWrapMode("word")
        if (textBuffer.byteSize !== WORD_WRAP_TEXT_BYTES || textBuffer.getLineCount() !== WORD_WRAP_LOGICAL_LINES) {
          throw new Error(
            `text-buffer-word-wrap-measure: fixture shape bytes=${textBuffer.byteSize} ` +
              `lines=${textBuffer.getLineCount()}`,
          )
        }
        let checksum = 0
        let completed = 0
        let validated = 0

        return {
          run(iteration) {
            const even = (iteration & 1) === 0
            const result = view.measureForDimensions(
              even ? WORD_WRAP_WIDTH_A : WORD_WRAP_WIDTH_B,
              WORD_WRAP_MEASURE_HEIGHT,
            )
            const packed = result === null ? 0 : result.lineCount * 1_000 + result.widthColsMax
            checksum = (checksum + Math.imul(packed, even ? 1 : 3)) >>> 0
            completed++
          },
          validateBatch(iterations) {
            const actual = completed - validated
            if (actual !== iterations) {
              throw new Error(`text-buffer-word-wrap-measure: completed ${actual} operations, expected ${iterations}`)
            }
            const expected = expectedWordWrapChecksum(completed)
            if (checksum !== expected) {
              throw new Error(
                `text-buffer-word-wrap-measure: batch checksum ${checksum}, expected ${expected} ` +
                  `after ${completed} operations`,
              )
            }
            validated = completed
          },
          teardown() {
            view.destroy()
            textBuffer.destroy()
            owner.destroy()
          },
        }
      } catch (error) {
        owner.destroy()
        throw error
      }
    },
  }
}

const BOX_BUFFER_WIDTH = 80
const BOX_BUFFER_HEIGHT = 24
const BOX_CLEAR_BG = RGBA.fromInts(3, 7, 18)
const BOX_PANEL_BG = RGBA.fromInts(17, 24, 39)
const BOX_BORDER_FG = RGBA.fromInts(96, 165, 250)
const BOX_TITLE_FGS = [RGBA.fromInts(250, 204, 21), RGBA.fromInts(52, 211, 153)] as const
const BOX_TOP_TITLES = [" Alpha ", " Omega "] as const
const BOX_BOTTOM_TITLES = [" Ready ", " Busy! "] as const
const BOX_SIGNAL_INDEX = 2 * BOX_BUFFER_WIDTH + 37
const BOX_SIGNAL_CHARS = [65, 79] as const
const BOX_VARIANTS: readonly Parameters<OptimizedBuffer["drawBox"]>[0][] = BOX_TOP_TITLES.map((title, index) => ({
  x: 2,
  y: 2,
  width: 76,
  height: 20,
  borderStyle: "rounded",
  border: true,
  borderColor: BOX_BORDER_FG,
  backgroundColor: BOX_PANEL_BG,
  shouldFill: true,
  title,
  titleColor: BOX_TITLE_FGS[index]!,
  titleAlignment: "center",
  bottomTitle: BOX_BOTTOM_TITLES[index]!,
  bottomTitleAlignment: "right",
}))

function directBoxDrawingCase(): BenchmarkCase {
  return {
    category: "JS Buffer",
    name: "draw-box-titled-scissored",
    // Version 2 includes a checked lease for each cell observation.
    workload_version: 2,
    parameters: {
      buffer_width: BOX_BUFFER_WIDTH,
      buffer_height: BOX_BUFFER_HEIGHT,
      width_method: "unicode",
      box_x: 2,
      box_y: 2,
      box_width: 76,
      box_height: 20,
      scissor_x: 0,
      scissor_y: 0,
      scissor_width: 72,
      scissor_height: BOX_BUFFER_HEIGHT,
      border_style: "rounded",
      should_fill: true,
      titles_per_box: 2,
      title_variants: 2,
      visible_cells: 1_400,
    },
    setup() {
      const owner = new ResourceContext({ objectCapacity: 4, renderCellsMax: BOX_BUFFER_WIDTH * BOX_BUFFER_HEIGHT })
      try {
        const buffer = OptimizedBuffer.create(BOX_BUFFER_WIDTH, BOX_BUFFER_HEIGHT, "unicode", {
          owner,
          id: "js-bench-draw-box-titled-scissored",
        })

        buffer.clear(BOX_CLEAR_BG)
        buffer.pushScissorRect(0, 0, 72, BOX_BUFFER_HEIGHT)
        let observedSignal = 0
        let expectedSignal = 0
        let completed = 0
        let validated = 0

        return {
          run(iteration) {
            const variant = iteration & 1
            buffer.drawBox(BOX_VARIANTS[variant]!)
            observedSignal = (observedSignal + buffer.withBuffers((cells) => cells.char[BOX_SIGNAL_INDEX]!)) | 0
            expectedSignal = (expectedSignal + BOX_SIGNAL_CHARS[variant]!) | 0
            completed++
          },
          validateBatch(iterations) {
            const actual = completed - validated
            if (actual !== iterations) {
              throw new Error(`draw-box-titled-scissored: completed ${actual} operations, expected ${iterations}`)
            }
            if (observedSignal !== expectedSignal) {
              throw new Error(`draw-box-titled-scissored: observation ${observedSignal}, expected ${expectedSignal}`)
            }
            validated = completed
          },
          teardown() {
            try {
              buffer.clearScissorRects()
            } finally {
              buffer.destroy()
              owner.destroy()
            }
          },
        }
      } catch (error) {
        owner.destroy()
        throw error
      }
    },
  }
}

export const defaultBenchmarkCases: readonly BenchmarkCase[] = [
  layoutLeafWidthCase(),
  yogaLayoutReadsCase(),
  mouseCase("direct-bubble-depth-8", false),
  mouseCase("stdin-sgr-bubble-depth-8", true),
  proportionalColumnWidthsCase(),
  textBufferWordWrapMeasureCase(),
  directBoxDrawingCase(),
]

export const renderBenchmarkCases: readonly BenchmarkCase[] = [
  denseCellFillsCase(),
  sceneRebuildCase(),
  textareaCase("edits"),
  textareaCase("cursor"),
  textareaCase("selection"),
  markdownTableUpdateCase(),
  paintBeforeAfterCase(),
]

export const allBenchmarkCases: readonly BenchmarkCase[] = [...defaultBenchmarkCases, ...renderBenchmarkCases]

interface CompletedFrameFixture {
  mutate(iteration: number): void
  validate(completed: number): void
  prepareTiming?(): void
  teardown?(): void
}

function completedFrameCase(
  name: string,
  parameters: Record<string, string | number | boolean>,
  createFixture: (target: TestRendererSetup) => CompletedFrameFixture,
): BenchmarkCase {
  return {
    category: "JS Render",
    name,
    workload_version: 1,
    parameters: {
      width: WIDTH,
      height: HEIGHT,
      terminal_policy: "remote-unicode-memory",
      operation: "mutation-and-completed-frame",
      ...parameters,
    },
    async setup() {
      const target = await createTestRenderer({
        width: WIDTH,
        height: HEIGHT,
        targetFps: 60,
        maxFps: 60,
        screenMode: "main-screen",
        externalOutputMode: "passthrough",
        consoleMode: "disabled",
        bufferedOutput: "memory",
        remote: true,
        forwardEnvKeys: [],
        useMouse: true,
      })
      const errors: Error[] = []
      const onError = ({ error }: CliRendererErrorEvent) => errors.push(error)
      target.renderer.on(CliRenderEvents.RENDER_ERROR, onError)
      let fixture: CompletedFrameFixture | undefined
      try {
        target.renderer.setCursorPosition(0, 0, false)
        fixture = createFixture(target)
        await target.renderOnce()
        await target.renderOnce()
        if (fixture.prepareTiming) {
          fixture.prepareTiming()
          await target.renderOnce()
        }
        if (errors.length > 0) throw errors[0]
      } catch (error) {
        try {
          fixture?.teardown?.()
        } catch {
          // Preserve the setup or initial-frame failure.
        }
        target.renderer.destroy()
        await target.renderer.closed
        throw error
      }
      const activeFixture = fixture
      let completed = 0
      let validated = 0
      let validatedFrames = target.renderer.getNativeStats().nativeFrameCount
      return {
        async: true,
        async run(iteration) {
          activeFixture.mutate(iteration)
          await target.renderOnce()
          completed++
        },
        validateBatch(iterations) {
          const actual = completed - validated
          if (actual !== iterations) throw new Error(`${name}: completed ${actual} operations, expected ${iterations}`)
          const nativeFrames = target.renderer.getNativeStats().nativeFrameCount
          const frameCount = nativeFrames - validatedFrames
          if (frameCount !== iterations)
            throw new Error(`${name}: completed ${frameCount} frames, expected ${iterations}`)
          if (errors.length > 0) throw errors[0]
          activeFixture.validate(completed)
          validated = completed
          validatedFrames = nativeFrames
        },
        async teardown() {
          try {
            activeFixture.teardown?.()
          } finally {
            target.renderer.off(CliRenderEvents.RENDER_ERROR, onError)
            target.renderer.destroy()
            await target.renderer.closed
          }
        },
      }
    },
  }
}

function denseCellFillsCase(): BenchmarkCase {
  return completedFrameCase("dense-cell-fills", { boxes: WIDTH * HEIGHT, mutation: "all-backgrounds" }, (target) => {
    const boxes = Array.from({ length: WIDTH * HEIGHT }, (_, index) => {
      const box = new BoxRenderable(target.renderer, {
        position: "absolute",
        left: index % WIDTH,
        top: Math.floor(index / WIDTH),
        width: 1,
        height: 1,
        backgroundColor: RENDER_COLORS.panel,
      })
      target.renderer.root.add(box)
      return box
    })
    return {
      mutate(iteration) {
        for (let index = 0; index < boxes.length; index++) {
          boxes[index]!.backgroundColor = (iteration + index) % 2 ? RENDER_COLORS.panel : RENDER_COLORS.element
        }
      },
      validate(completed) {
        const iteration = completed - 1
        let mismatch = -1
        target.renderer.currentRenderBuffer.withBuffers(({ bg }) => {
          for (let index = 0; index < boxes.length; index++) {
            const expected = ((iteration + index) % 2 ? RENDER_COLORS.panel : RENDER_COLORS.element).buffer
            const offset = index * 4
            if (
              bg[offset] !== expected[0] ||
              bg[offset + 1] !== expected[1] ||
              bg[offset + 2] !== expected[2] ||
              bg[offset + 3] !== expected[3]
            ) {
              mismatch = index
              break
            }
          }
        })
        if (mismatch !== -1) {
          throw new Error(`dense-cell-fills: box ${mismatch} phase mismatch`)
        }
        if (target.renderer.getNativeStats().cellsUpdated === 0)
          throw new Error("dense-cell-fills: frame changed no cells")
      },
    }
  })
}

function sceneRebuildCase(): BenchmarkCase {
  return completedFrameCase("scene-rebuild-128", { pairs: 128, mutation: "destroy-and-rebuild" }, (target) => {
    const construct = (phase: number) => {
      const group = new BoxRenderable(target.renderer, { width: "100%", height: "100%" })
      target.renderer.root.add(group)
      for (let index = 0; index < 128; index++) {
        const row = new BoxRenderable(target.renderer, {
          position: "absolute",
          left: (index % 2) * 70,
          top: Math.floor(index / 2),
          width: 70,
          height: 1,
          backgroundColor: phase ? RENDER_COLORS.panel : RENDER_COLORS.element,
        })
        group.add(row)
        row.add(
          new TextRenderable(target.renderer, {
            width: "100%",
            height: 1,
            content: `cycle ${phase} ${index} ${RENDER_UNICODE[phase]}`,
            fg: RENDER_COLORS.accent,
            wrapMode: "none",
          }),
        )
      }
      return group
    }
    let group = construct(0)
    return {
      mutate(iteration) {
        group.destroyRecursively()
        group = construct((iteration + 1) % 2)
      },
      validate(completed) {
        const count = Array.from(target.renderer.nativeScene.getRenderables()).length
        if (count !== 258) throw new Error(`scene-rebuild-128: retained ${count} nodes, expected 258`)
        const frame = target.captureCharFrame()
        const phase = completed % 2
        const rows = countOccurrences(frame, `cycle ${phase}`)
        const staleRows = countOccurrences(frame, `cycle ${(phase + 1) % 2}`)
        if (rows !== HEIGHT * 2 || staleRows !== 0) {
          throw new Error(`scene-rebuild-128: rendered ${rows} current and ${staleRows} stale rows`)
        }
      },
      teardown: () => group.destroyRecursively(),
    }
  })
}

function textareaCase(kind: "edits" | "cursor" | "selection"): BenchmarkCase {
  return completedFrameCase(`textarea-${kind}`, { mutation: kind, logical_lines: 25 }, (target) => {
    const initial =
      "prefix " +
      RENDER_UNICODE[0] +
      "\n" +
      Array.from({ length: 24 }, (_, index) => `line ${index} ${RENDER_UNICODE[index % 2]}`).join("\n")
    const editor = new TextareaRenderable(target.renderer, {
      width: "100%",
      height: "100%",
      initialValue: initial,
      wrapMode: "word",
      textColor: RENDER_COLORS.accent,
      backgroundColor: RENDER_COLORS.panel,
      selectionBg: RENDER_COLORS.warning,
      showCursor: true,
      cursorStyle: { style: "block", blinking: false },
    })
    target.renderer.root.add(editor)
    editor.focus()
    editor.gotoBufferHome()
    return {
      mutate(iteration) {
        const phase = (iteration + 1) % 2
        if (kind === "edits") {
          if (phase) editor.insertText("界")
          else editor.deleteCharBackward()
        } else if (kind === "cursor") {
          editor.setCursor(0, phase ? 15 : 7)
        } else if (phase) {
          editor.setSelection(0, 6)
        } else {
          editor.clearSelection()
        }
      },
      validate(completed) {
        const phase = completed % 2
        if (editor.plainText !== (kind === "edits" && phase ? `界${initial}` : initial)) {
          throw new Error(`textarea-${kind}: text phase mismatch`)
        }
        if (kind === "cursor" && editor.logicalCursor.col !== (phase ? 15 : 7)) {
          throw new Error("textarea-cursor: cursor phase mismatch")
        }
        if (kind === "selection" && editor.getSelectedText() !== (phase ? "prefix" : "")) {
          throw new Error("textarea-selection: selection phase mismatch")
        }
        const firstLine = target.captureCharFrame().split("\n")[0]!
        if (!firstLine.startsWith(kind === "edits" && phase ? "界prefix" : "prefix")) {
          throw new Error(`textarea-${kind}: rendered text phase mismatch`)
        }
        if (kind === "cursor") {
          const cursor = target.renderer.getCursorState()
          if (!cursor.visible || cursor.x !== (phase ? 16 : 8)) {
            throw new Error(`textarea-cursor: rendered cursor ${cursor.x}, expected ${phase ? 16 : 8}`)
          }
        }
        if (kind === "selection") {
          const expected = (phase ? RENDER_COLORS.warning : RENDER_COLORS.panel).buffer
          target.renderer.currentRenderBuffer.withBuffers(({ bg }) => {
            for (let index = 0; index < 6; index++) {
              const offset = index * 4
              if (
                bg[offset] !== expected[0] ||
                bg[offset + 1] !== expected[1] ||
                bg[offset + 2] !== expected[2] ||
                bg[offset + 3] !== expected[3]
              ) {
                throw new Error(`textarea-selection: rendered cell ${index} phase mismatch`)
              }
            }
          })
        }
      },
    }
  })
}

function markdownTableUpdateCase(): BenchmarkCase {
  return completedFrameCase("markdown-table-update", { rows: 14, columns: 3 }, (target) => {
    const style = SyntaxStyle.fromStyles(
      {
        default: { fg: RENDER_COLORS.accent },
        "markup.strong": { bold: true },
        "markup.raw": { fg: RENDER_COLORS.warning },
      },
      target.renderer.nativeScene,
    )
    try {
      const content = [0, 1].map(
        (phase) =>
          "| Name | Status | Detail |\n| --- | --- | --- |\n" +
          Array.from(
            { length: 14 },
            (_, index) =>
              `| **item ${index}** | ${phase ? "ready" : "pending"} | \`${index}\` ${RENDER_UNICODE[phase]} |`,
          ).join("\n"),
      )
      const markdown = new MarkdownRenderable(target.renderer, {
        width: "100%",
        content: content[0],
        syntaxStyle: style,
        tableOptions: { style: "grid", widthMode: "full", wrapMode: "word", cellPadding: 0 },
      })
      target.renderer.root.add(markdown)
      return {
        mutate(iteration) {
          const next = content[(iteration + 1) % 2]!
          markdown.content = next
          if (markdown.content !== next) throw new Error("markdown-table-update: content mutation was not accepted")
        },
        validate(completed) {
          const expected = completed % 2 ? "ready" : "pending"
          const stale = completed % 2 ? "pending" : "ready"
          const frame = target.captureCharFrame()
          const rows = countOccurrences(frame, expected)
          const staleRows = countOccurrences(frame, stale)
          if (rows !== 14 || staleRows !== 0) {
            throw new Error(`markdown-table-update: rendered ${rows} current and ${staleRows} stale rows`)
          }
        },
        teardown() {
          markdown.destroyRecursively()
          style.destroy()
        },
      }
    } catch (error) {
      style.destroy()
      throw error
    }
  })
}

function paintBeforeAfterCase(): BenchmarkCase {
  return completedFrameCase("paint-before-after", { boxes: 32, hooks_per_box: 2 }, (target) => {
    let phase = 0
    let beforeCalls = 0
    let afterCalls = 0
    const boxes: BoxRenderable[] = []
    function renderBefore(this: BoxRenderable, buffer: OptimizedBuffer) {
      buffer.fillRect(this.x, this.y, this.width, this.height, RENDER_COLORS.element)
    }
    function renderAfter(this: BoxRenderable, buffer: OptimizedBuffer) {
      buffer.drawText(RENDER_UNICODE[phase], this.x + 1, this.y + 1, RENDER_COLORS.accent)
    }
    for (let index = 0; index < 32; index++) {
      const box = new BoxRenderable(target.renderer, {
        position: "absolute",
        left: (index % 4) * 35,
        top: Math.floor(index / 4) * 5,
        width: 34,
        height: 4,
        border: true,
        backgroundColor: RENDER_COLORS.panel,
        renderBefore(buffer) {
          beforeCalls++
          renderBefore.call(this, buffer)
        },
        renderAfter(buffer) {
          afterCalls++
          renderAfter.call(this, buffer)
        },
      })
      target.renderer.root.add(box)
      boxes.push(box)
    }
    return {
      prepareTiming() {
        if (beforeCalls !== 64 || afterCalls !== 64) {
          throw new Error(`paint-before-after: setup observed ${beforeCalls}/${afterCalls} callbacks, expected 64 each`)
        }
        for (const box of boxes) {
          box.renderBefore = renderBefore
          box.renderAfter = renderAfter
        }
      },
      mutate(iteration) {
        phase = (iteration + 1) % 2
      },
      validate(completed) {
        const expected = RENDER_UNICODE[completed % 2].split(" ")[0]!
        const stale = RENDER_UNICODE[(completed + 1) % 2].split(" ")[0]!
        const frame = target.captureCharFrame()
        const outputs = countOccurrences(frame, expected)
        const staleOutputs = countOccurrences(frame, stale)
        if (outputs !== 32 || staleOutputs !== 0) {
          throw new Error(`paint-before-after: rendered ${outputs} current and ${staleOutputs} stale outputs`)
        }
      },
    }
  })
}

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1
}

function layoutLeafWidthCase(): BenchmarkCase {
  return {
    category: "JS Layout",
    name: "leaf-width-calculate",
    workload_version: 3,
    parameters: { width: WIDTH, height: HEIGHT, nodes: LEAF_COUNT, ownership: "standalone" },
    setup() {
      const root = YogaNode.create()
      const leaves: YogaNode[] = []
      try {
        root.setWidth(WIDTH)
        root.setHeight(HEIGHT)
        root.setFlexDirection(FlexDirection.Column)
        for (let index = 0; index < LEAF_COUNT; index++) {
          const leaf = YogaNode.create()
          leaves.push(leaf)
          root.insertChild(leaf, index)
          leaf.setWidth(index % 2 === 0 ? 6 : 11)
          leaf.setHeight(1)
          leaf.setFlexShrink(0)
        }
        root.calculateLayout(WIDTH, HEIGHT, Direction.LTR)
      } catch (error) {
        for (const leaf of leaves) leaf.free()
        root.free()
        throw error
      }
      let completed = 0
      let validated = 0

      return {
        run(iteration) {
          const target = iteration % leaves.length
          const leaf = leaves[target]!
          leaf.setWidth(Math.floor(iteration / leaves.length) % 2 === 0 ? 13 : 7)
          root.calculateLayout(WIDTH, HEIGHT, Direction.LTR)
          completed++
        },
        validateBatch(iterations) {
          const actual = completed - validated
          if (actual !== iterations) {
            throw new Error(`leaf-width-calculate: completed ${actual} operations, expected ${iterations}`)
          }
          if (root.isDirty()) throw new Error("leaf-width-calculate: layout remained dirty")
          const checksum = layoutChecksum(leaves)
          const expected = expectedLeafLayoutChecksum(completed)
          if (checksum !== expected) {
            throw new Error(`leaf-width-calculate: final checksum ${checksum}, expected ${expected}`)
          }
          validated = completed
        },
        teardown: () => root.freeRecursive(),
      }
    },
  }
}

function yogaLayoutReadsCase(): BenchmarkCase {
  return {
    category: "JS Render",
    name: "yoga-layout-reads-100",
    workload_version: 1,
    parameters: { width: WIDTH, height: HEIGHT, nodes: YOGA_NODE_COUNT },
    async setup() {
      const { renderer, renderOnce } = await createTestRenderer({ width: WIDTH, height: HEIGHT })
      const root = new BoxRenderable(renderer, { width: "100%", flexDirection: "column" })
      renderer.root.add(root)
      const nodes = Array.from({ length: YOGA_NODE_COUNT }, (_, index) => {
        const node = new BoxRenderable(renderer, { width: "100%", height: 1, flexShrink: 0 })
        root.add(node)
        return getYogaNode(node)
      })
      await renderOnce()
      try {
        validateYogaFixture(nodes)
      } catch (error) {
        renderer.destroy()
        throw error
      }
      const expectedChecksum = YOGA_NODE_COUNT * (WIDTH + 1) + YOGA_NODE_COUNT * (YOGA_NODE_COUNT - 1)
      let completed = 0
      let validated = 0
      let checksum = 0

      return {
        run() {
          for (let index = 0; index < nodes.length; index++) {
            const layout = nodes[index]!.getComputedLayout()
            checksum = (checksum + layout.left + layout.top + layout.width + layout.height + index) | 0
          }
          completed++
        },
        validateBatch(iterations) {
          const actual = completed - validated
          if (actual !== iterations) {
            throw new Error(`yoga-layout-reads-100: completed ${actual} operations, expected ${iterations}`)
          }
          const expected = (expectedChecksum * completed) | 0
          if (checksum !== expected) {
            throw new Error(`yoga-layout-reads-100: batch checksum ${checksum}, expected ${expected}`)
          }
          validated = completed
        },
        teardown: () => renderer.destroy(),
      }
    },
  }
}

function mouseCase(name: string, stdin: boolean): BenchmarkCase {
  const depth = 8
  return {
    category: "JS Mouse",
    name,
    workload_version: 1,
    parameters: { width: 10, height: 10, depth, input: stdin ? "stdin-sgr" : "direct" },
    async setup() {
      const { renderer, renderOnce } = await createTestRenderer({ width: 10, height: 10 })
      let parent: Renderable = renderer.root
      let leaf: Renderable = renderer.root
      let handled = 0
      for (let index = 0; index < depth; index++) {
        const child = new BoxRenderable(renderer, { width: 10, height: 10 })
        child.onMouse = () => handled++
        parent.add(child)
        parent = child
        leaf = child
      }
      const event = new MouseEvent(leaf, {
        type: "move",
        button: 0,
        x: 1,
        y: 1,
        modifiers: { shift: false, alt: false, ctrl: false },
      })
      const sequence = Buffer.from("\x1b[<35;2;2M")
      if (stdin) {
        await renderOnce()
        renderer.stdin.emit("data", sequence)
        const validationParser = new StdinParser({ armTimeouts: false })
        try {
          validateSgrMove(validationParser, sequence)
        } catch (error) {
          renderer.destroy()
          throw error
        } finally {
          validationParser.destroy()
        }
      }
      let validated = handled

      return {
        run() {
          if (stdin) renderer.stdin.emit("data", sequence)
          else leaf.processMouseEvent(event)
        },
        validateBatch(iterations) {
          const actual = handled - validated
          const expected = iterations * depth
          if (actual !== expected) throw new Error(`${name}: dispatched ${actual} handlers, expected ${expected}`)
          validated = handled
        },
        teardown: () => renderer.destroy(),
      }
    },
  }
}

function validateYogaFixture(nodes: readonly ReturnType<typeof getYogaNode>[]): void {
  for (let index = 0; index < nodes.length; index++) {
    const layout = nodes[index]!.getComputedLayout()
    if (
      layout.left !== 0 ||
      layout.top !== index ||
      layout.right !== 0 ||
      layout.bottom !== 0 ||
      layout.width !== WIDTH ||
      layout.height !== 1
    ) {
      throw new Error(
        `yoga-layout-reads-100: node ${index} fixture geometry ${JSON.stringify(layout)}, expected ` +
          `left=0 top=${index} right=0 bottom=0 width=${WIDTH} height=1`,
      )
    }
  }
}

function validateSgrMove(parser: StdinParser, sequence: Buffer): void {
  parser.push(sequence)
  const decoded = parser.read()
  const trailing = parser.read()
  const event = decoded?.type === "mouse" ? decoded.event : undefined
  if (
    decoded?.type !== "mouse" ||
    decoded.encoding !== "sgr" ||
    decoded.raw !== sequence.toString("latin1") ||
    event?.type !== "move" ||
    event.button !== 0 ||
    event.x !== 1 ||
    event.y !== 1 ||
    event.modifiers.shift ||
    event.modifiers.alt ||
    event.modifiers.ctrl ||
    event.scroll !== undefined ||
    trailing !== null
  ) {
    throw new Error(`stdin-sgr-bubble-depth-8: fixed SGR bytes decoded incorrectly: ${JSON.stringify(decoded)}`)
  }
}

function layoutChecksum(nodes: readonly YogaNode[]): number {
  let checksum = 0
  for (let index = 0; index < nodes.length; index++) {
    const layout = nodes[index]!.getComputedLayout()
    checksum = (checksum + layout.left * 3 + layout.top * 5 + layout.width * 7 + layout.height * 11 + index) | 0
  }
  return checksum
}

function expectedLeafLayoutChecksum(operations: number): number {
  let checksum = 0
  for (let index = 0; index < LEAF_COUNT; index++) {
    let width = index % 2 === 0 ? 6 : 11
    if (operations > index) {
      const updates = Math.floor((operations - 1 - index) / LEAF_COUNT) + 1
      width = updates % 2 === 1 ? 13 : 7
    }
    checksum = (checksum + index * 6 + width * 7 + 11) | 0
  }
  return checksum
}

function validateAllocation(actual: readonly number[] | undefined, expected: readonly number[]): void {
  if (!actual || actual.length !== expected.length) {
    throw new Error(`proportional-column-widths: output length ${actual?.length ?? 0}, expected ${expected.length}`)
  }
  for (let index = 0; index < expected.length; index++) {
    if (actual[index] !== expected[index]) {
      throw new Error(`proportional-column-widths: output ${index} was ${actual[index]}, expected ${expected[index]}`)
    }
  }
}

function expectedWordWrapChecksum(completed: number): number {
  const widthAOperations = Math.floor((completed + 1) / 2)
  const widthBOperations = Math.floor(completed / 2)
  return (
    (Math.imul(widthAOperations, WORD_WRAP_CONTRIBUTION_A) + Math.imul(widthBOperations, WORD_WRAP_CONTRIBUTION_B)) >>>
    0
  )
}
