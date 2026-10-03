import { ResourceContext } from "../buffer.js"
import { beforeEach, afterEach } from "bun:test"

let resourceContext: ResourceContext
beforeEach(() => {
  resourceContext = new ResourceContext({ objectCapacity: 65536, renderCellsMax: 1000000 })
})
afterEach(() => resourceContext.destroy())

import { describe, expect, it } from "bun:test"
import { TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import { stringToStyledText } from "../lib/styled-text.js"

/**
 * These tests verify algorithmic complexity rather than absolute performance.
 * By comparing ratios of execution times for different input sizes, we can
 * detect O(n²) regressions regardless of the machine's speed.
 *
 * For O(n) algorithms: doubling input size should roughly double the time (ratio ~2)
 * For O(n²) algorithms: doubling input size should quadruple the time (ratio ~4)
 *
 * We use a threshold that allows for CI variance while still catching O(n²) behavior.
 * The threshold is set to catch quadratic complexity (ratio ~4) while allowing
 * linear complexity with noise (ratio ~2-3.5).
 */
describe("Word wrap algorithmic complexity", () => {
  function measureBatch(fn: (width: number) => void, widths: number[]): number {
    const start = performance.now()
    for (const width of widths) fn(width)
    return performance.now() - start
  }

  // Load can only add time to a batch, so the fastest of many short batches is its unpreempted cost.
  function measureMinRatio(smallFn: (width: number) => void, largeFn: (width: number) => void, widths: number[]) {
    let small = Infinity
    let large = Infinity
    for (let i = 0; i < 101; i++) {
      small = Math.min(small, measureBatch(smallFn, widths))
      large = Math.min(large, measureBatch(largeFn, widths))
    }
    return large / small
  }

  const COMPLEXITY_THRESHOLD = 1.75
  const MEASURE_WIDTHS = [76, 77, 78, 79, 80, 81, 82, 83]

  it("a split grapheme does not disable ASCII fitting for the remaining word", () => {
    const control = TextBuffer.create("wcwidth", resourceContext)
    const split = TextBuffer.create("wcwidth", resourceContext)
    const controlView = TextBufferView.create(control)
    const splitView = TextBufferView.create(split)
    try {
      for (const buffer of [control, split]) {
        buffer.setText("\u{1f44b}")
        buffer.append(buffer === split ? "\u{1f3fb}" : "\u{1f44b}")
        buffer.append("x".repeat(64000))
        buffer.append("y")
      }
      controlView.setWrapMode("word")
      splitView.setWrapMode("word")
      for (const width of MEASURE_WIDTHS) {
        expect(splitView.measureForDimensions(width, 100)).toEqual(controlView.measureForDimensions(width, 100))
      }
      const controlMeasure = (width: number) => {
        controlView.measureForDimensions(width, 100)
      }
      const ratio = measureMinRatio(
        controlMeasure,
        (width) => {
          splitView.measureForDimensions(width, 100)
        },
        MEASURE_WIDTHS,
      )
      // The shared ASCII suffix must not inherit the prefix's scalar Unicode scan.
      expect(ratio).toBeLessThan(5)
    } finally {
      splitView.destroy()
      controlView.destroy()
      split.destroy()
      control.destroy()
    }
  })

  it("should have O(n) complexity for word wrap without word breaks", () => {
    const smallSize = 20000
    const largeSize = 40000

    const smallText = "x".repeat(smallSize)
    const largeText = "x".repeat(largeSize)

    const smallBuffer = TextBuffer.create("wcwidth", resourceContext)
    const largeBuffer = TextBuffer.create("wcwidth", resourceContext)

    smallBuffer.setStyledText(stringToStyledText(smallText))
    largeBuffer.setStyledText(stringToStyledText(largeText))

    const smallView = TextBufferView.create(smallBuffer)
    const largeView = TextBufferView.create(largeBuffer)

    smallView.setWrapMode("word")
    largeView.setWrapMode("word")
    smallView.setWrapWidth(80)
    largeView.setWrapWidth(80)

    for (const width of MEASURE_WIDTHS) {
      smallView.measureForDimensions(width, 100)
      largeView.measureForDimensions(width, 100)
    }

    const ratio = measureMinRatio(
      (width) => {
        smallView.measureForDimensions(width, 100)
      },
      (width) => {
        largeView.measureForDimensions(width, 100)
      },
      MEASURE_WIDTHS,
    )

    smallView.destroy()
    largeView.destroy()
    smallBuffer.destroy()
    largeBuffer.destroy()

    const inputRatio = largeSize / smallSize

    expect(ratio).toBeLessThan(inputRatio * COMPLEXITY_THRESHOLD)
  })

  it("should have O(n) complexity for word wrap with word breaks", () => {
    const smallSize = 20000
    const largeSize = 40000

    const makeText = (size: number) => {
      const words = Math.ceil(size / 11)
      return Array(words).fill("xxxxxxxxxx").join(" ").slice(0, size)
    }

    const smallText = makeText(smallSize)
    const largeText = makeText(largeSize)

    const smallBuffer = TextBuffer.create("wcwidth", resourceContext)
    const largeBuffer = TextBuffer.create("wcwidth", resourceContext)

    smallBuffer.setStyledText(stringToStyledText(smallText))
    largeBuffer.setStyledText(stringToStyledText(largeText))

    const smallView = TextBufferView.create(smallBuffer)
    const largeView = TextBufferView.create(largeBuffer)

    smallView.setWrapMode("word")
    largeView.setWrapMode("word")
    smallView.setWrapWidth(80)
    largeView.setWrapWidth(80)

    // Warm up with changing widths so we measure wrap work, not cache hits.
    for (const width of MEASURE_WIDTHS) {
      smallView.measureForDimensions(width, 100)
      largeView.measureForDimensions(width, 100)
    }

    const ratio = measureMinRatio(
      (width) => {
        smallView.measureForDimensions(width, 100)
      },
      (width) => {
        largeView.measureForDimensions(width, 100)
      },
      MEASURE_WIDTHS,
    )

    smallView.destroy()
    largeView.destroy()
    smallBuffer.destroy()
    largeBuffer.destroy()

    const inputRatio = largeSize / smallSize

    expect(ratio).toBeLessThan(inputRatio * COMPLEXITY_THRESHOLD)
  })

  it("should have O(n) complexity for char wrap mode", () => {
    const smallSize = 20000
    const largeSize = 40000

    const smallText = "x".repeat(smallSize)
    const largeText = "x".repeat(largeSize)

    const smallBuffer = TextBuffer.create("wcwidth", resourceContext)
    const largeBuffer = TextBuffer.create("wcwidth", resourceContext)

    smallBuffer.setStyledText(stringToStyledText(smallText))
    largeBuffer.setStyledText(stringToStyledText(largeText))

    const smallView = TextBufferView.create(smallBuffer)
    const largeView = TextBufferView.create(largeBuffer)

    smallView.setWrapMode("char")
    largeView.setWrapMode("char")
    smallView.setWrapWidth(80)
    largeView.setWrapWidth(80)

    for (const width of MEASURE_WIDTHS) {
      smallView.measureForDimensions(width, 100)
      largeView.measureForDimensions(width, 100)
    }

    const ratio = measureMinRatio(
      (width) => {
        smallView.measureForDimensions(width, 100)
      },
      (width) => {
        largeView.measureForDimensions(width, 100)
      },
      MEASURE_WIDTHS,
    )

    smallView.destroy()
    largeView.destroy()
    smallBuffer.destroy()
    largeBuffer.destroy()

    const inputRatio = largeSize / smallSize

    expect(ratio).toBeLessThan(inputRatio * COMPLEXITY_THRESHOLD)
  })

  // NOTE: Is flaky
  it.skip("should scale linearly when wrap width changes", () => {
    const text = "x".repeat(50000)

    const buffer = TextBuffer.create("wcwidth", resourceContext)
    buffer.setStyledText(stringToStyledText(text))

    const view = TextBufferView.create(buffer)
    view.setWrapMode("word")

    const widths = [60, 70, 80, 90, 100]
    const times: number[] = []

    // Warmup
    view.setWrapWidth(50)
    view.measureForDimensions(50, 100)

    // Measure first (uncached) call for each width
    for (const width of widths) {
      view.setWrapWidth(width)
      const start = performance.now()
      view.measureForDimensions(width, 100)
      times.push(performance.now() - start)
    }

    view.destroy()
    buffer.destroy()

    // All times should be roughly similar (within 3x of each other)
    // since the text size is the same
    const maxTime = Math.max(...times)
    const minTime = Math.min(...times)

    expect(maxTime / minTime).toBeLessThan(3)
  })
})
