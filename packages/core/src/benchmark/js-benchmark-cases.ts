import { BoxRenderable, TextBuffer, TextBufferView } from "../index.js"
import { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { StdinParser } from "../lib/stdin-parser.js"
import type { Renderable } from "../Renderable.js"
import { MouseEvent } from "../renderer.js"
import { allocateProportionalColumnWidths } from "../renderables/text-table-width.js"
import { createTestRenderer } from "../testing.js"
import type { BenchmarkCase } from "./js-benchmark-harness.js"

const WIDTH = 140
const HEIGHT = 44
const LEAF_COUNT = 96
const YOGA_NODE_COUNT = 100

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
      const textBuffer = TextBuffer.create("unicode")
      try {
        textBuffer.setText(WORD_WRAP_TEXT)
        const view = TextBufferView.create(textBuffer)
        try {
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
            },
          }
        } catch (error) {
          view.destroy()
          throw error
        }
      } catch (error) {
        textBuffer.destroy()
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
    workload_version: 1,
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
      const buffer = OptimizedBuffer.create(BOX_BUFFER_WIDTH, BOX_BUFFER_HEIGHT, "unicode", {
        id: "js-bench-draw-box-titled-scissored",
      })
      try {
        const raw = buffer.buffers
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
            observedSignal = (observedSignal + raw.char[BOX_SIGNAL_INDEX]!) | 0
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
            }
          },
        }
      } catch (error) {
        buffer.destroy()
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

function layoutLeafWidthCase(): BenchmarkCase {
  return {
    category: "JS Layout",
    name: "leaf-width-calculate",
    workload_version: 2,
    parameters: { width: WIDTH, height: HEIGHT, nodes: LEAF_COUNT },
    async setup() {
      const { renderer } = await createTestRenderer({ width: WIDTH, height: HEIGHT })
      const root = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column" })
      renderer.root.add(root)
      const leaves = Array.from({ length: LEAF_COUNT }, (_, index) => {
        const leaf = new BoxRenderable(renderer, { width: index % 2 === 0 ? 6 : 11, height: 1, flexShrink: 0 })
        root.add(leaf)
        return leaf
      })
      renderer.root.calculateLayout()
      let completed = 0
      let validated = 0

      return {
        run(iteration) {
          const target = iteration % leaves.length
          const leaf = leaves[target]!
          leaf.width = Math.floor(iteration / leaves.length) % 2 === 0 ? 13 : 7
          renderer.root.calculateLayout()
          completed++
        },
        validateBatch(iterations) {
          const actual = completed - validated
          if (actual !== iterations) {
            throw new Error(`leaf-width-calculate: completed ${actual} operations, expected ${iterations}`)
          }
          if (renderer.root.getLayoutNode().isDirty()) throw new Error("leaf-width-calculate: layout remained dirty")
          const checksum = layoutChecksum(leaves)
          const expected = expectedLeafLayoutChecksum(completed)
          if (checksum !== expected) {
            throw new Error(`leaf-width-calculate: final checksum ${checksum}, expected ${expected}`)
          }
          validated = completed
        },
        teardown: () => renderer.destroy(),
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
        return node.getLayoutNode()
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

function validateYogaFixture(nodes: readonly ReturnType<BoxRenderable["getLayoutNode"]>[]): void {
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

function layoutChecksum(renderables: readonly BoxRenderable[]): number {
  let checksum = 0
  for (let index = 0; index < renderables.length; index++) {
    const layout = renderables[index]!.getLayoutNode().getComputedLayout()
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
