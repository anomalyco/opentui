import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { BoxRenderable, OptimizedBuffer } from "@opentui/core"
import { createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { ErrorCorrectionLevel, QRCode, QrSegment } from "../lib/qrcode.js"
import { QRCodeRenderable } from "./QRCode.js"

let testRenderer: TestRenderer
let renderOnce: () => Promise<void>
let resize: (width: number, height: number) => void
let captureCharFrame: () => string
let captureSpans: ReturnType<typeof createTestRenderer> extends Promise<infer T>
  ? T extends { captureSpans: infer TCaptureSpans }
    ? TCaptureSpans
    : never
  : never

describe("QR code ISO-derived vectors", () => {
  it("places the published format-string example for L mask 4", () => {
    const qr = QRCode.encodeText("HELLO WORLD", ErrorCorrectionLevel.L, {
      boostEcl: false,
      eciForUtf8: false,
      mask: 4,
    })
    const modules = qr.toMatrix()

    expect(toBinaryString(readPrimaryFormatBits(modules), 15)).toBe("110011000101111")
    expect(toBinaryString(readSecondaryFormatBits(modules), 15)).toBe("110011000101111")
  })

  it("places the published version-7 information example", () => {
    const qr = encodeExactVersionQRCode(7)
    const modules = qr.toMatrix()

    expect(toBinaryString(readTopRightVersionBits(modules), 18)).toBe("000111110010010100")
    expect(toBinaryString(readBottomLeftVersionBits(modules), 18)).toBe("000111110010010100")
  })
})

describe("QRCode", () => {
  it("writes the dark module at the ISO-defined coordinate", () => {
    const qr = QRCode.encodeText("HELLO WORLD", ErrorCorrectionLevel.M, {
      boostEcl: false,
      eciForUtf8: false,
    })
    const modules = qr.toMatrix()

    expect(qr.version).toBe(1)
    expect(qr.size).toBe(21)
    expect(modules[4 * qr.version + 9]![8]).toBe(true)
  })

  it("places the selected format bits in both format information regions", () => {
    const qr = QRCode.encodeText("HELLO WORLD", ErrorCorrectionLevel.M, {
      boostEcl: false,
      eciForUtf8: false,
    })
    const modules = qr.toMatrix()
    const expectedFormatBits = computeQRCodeFormatBits(qr.errorCorrectionLevel, qr.mask)

    expect(readPrimaryFormatBits(modules)).toBe(expectedFormatBits)
    expect(readSecondaryFormatBits(modules)).toBe(expectedFormatBits)
  })

  it("places version information correctly for version 7 and above", () => {
    const qr = encodeExactVersionQRCode(7)
    const modules = qr.toMatrix()
    const expectedVersionBits = computeQRCodeVersionBits(qr.version)

    expect(readTopRightVersionBits(modules)).toBe(expectedVersionBits)
    expect(readBottomLeftVersionBits(modules)).toBe(expectedVersionBits)
  })

  it("draws alignment patterns at the published coordinates", () => {
    const qr = encodeExactVersionQRCode(7)
    const modules = qr.toMatrix()
    const positions = getQRCodeAlignmentPatternPositions(qr.version)

    for (let y = 0; y < positions.length; y++) {
      for (let x = 0; x < positions.length; x++) {
        const overlapsFinderCorner =
          (x === 0 && y === 0) || (x === 0 && y === positions.length - 1) || (x === positions.length - 1 && y === 0)

        if (!overlapsFinderCorner) {
          expectAlignmentPattern(modules, positions[x]!, positions[y]!)
        }
      }
    }
  })

  it("rejects structured append headers with a single total symbol", () => {
    expect(() => QrSegment.makeStructuredAppendHeader(1, 1, 0)).toThrow(RangeError)
    expect(() =>
      QRCode.encodeSegments([QrSegment.makeBytes([0])], ErrorCorrectionLevel.M, {
        structuredAppend: { position: 1, total: 1, parity: 0 },
      }),
    ).toThrow(RangeError)
  })
})

describe("QRCodeRenderable", () => {
  beforeEach(async () => {
    ;({
      renderer: testRenderer,
      renderOnce,
      resize,
      captureCharFrame,
      captureSpans,
    } = await createTestRenderer({
      width: 80,
      height: 40,
    }))
  })

  afterEach(() => {
    testRenderer.destroy()
  })

  it("uses the default 4-module quiet zone in its intrinsic size", async () => {
    const qr = new QRCodeRenderable(testRenderer, {
      content: "HELLO WORLD",
    })

    testRenderer.root.add(qr)
    await renderOnce()

    expect(qr.width).toBe(80)
    expect(qr.height).toBe(15)
  })

  it("rejects quiet zones smaller than the QR Code minimum", () => {
    expect(
      () =>
        new QRCodeRenderable(testRenderer, {
          content: "HELLO WORLD",
          quietZone: 3,
        }),
    ).toThrow(RangeError)
  })

  it("updates intrinsic dimensions when the scale changes", async () => {
    const qr = new QRCodeRenderable(testRenderer, {
      content: "HELLO WORLD",
      quietZone: 4,
      scale: 1,
    })

    testRenderer.root.add(qr)
    await renderOnce()

    expect(qr.width).toBe(80)
    expect(qr.height).toBe(15)

    const initialFrame = captureCharFrame()
    expect(initialFrame).toContain("█")

    qr.scale = 2
    await renderOnce()

    expect(qr.width).toBe(80)
    expect(qr.height).toBe(29)
    expect(captureCharFrame()).not.toBe(initialFrame)
  })

  it("shrinks to fit a smaller parent height", async () => {
    const container = new BoxRenderable(testRenderer, {
      width: 60,
      height: 20,
      flexDirection: "column",
    })
    const qr = new QRCodeRenderable(testRenderer, {
      content: "HELLO WORLD",
      scale: 2,
    })

    container.add(qr)
    testRenderer.root.add(container)
    await renderOnce()

    expect(qr.width).toBe(60)
    expect(qr.height).toBe(15)
  })

  it("collapses when the available height cannot fit scale 1", async () => {
    const container = new BoxRenderable(testRenderer, {
      width: 33,
      height: 16,
      flexDirection: "column",
    })
    const qr = new QRCodeRenderable(testRenderer, {
      content: "https://opentui.com/docs/getting-started",
      quietZone: 4,
      scale: 2,
    })

    container.add(qr)
    testRenderer.root.add(container)
    await renderOnce()

    expect(qr.getLayoutNode().getComputedLayout().height).toBe(0)
    expect(captureCharFrame()).not.toContain("█")
    expect(captureCharFrame()).not.toContain("▀")
    expect(captureCharFrame()).not.toContain("▄")
  })

  it("renders fallback content when the available size cannot fit scale 1", async () => {
    const container = new BoxRenderable(testRenderer, {
      width: 24,
      height: 4,
      flexDirection: "column",
    })
    const qr = new QRCodeRenderable(testRenderer, {
      content: "https://opentui.com/docs/getting-started",
      quietZone: 4,
      scale: 2,
      fallbackContent: "Resize for QR",
      fallbackColor: "#94a3b8",
    })

    container.add(qr)
    testRenderer.root.add(container)
    await renderOnce()

    expect(captureCharFrame()).toContain("Resize for QR")
    expect(captureCharFrame()).not.toContain("█")
    expect(captureCharFrame()).not.toContain("▀")
    expect(captureCharFrame()).not.toContain("▄")
  })

  it("grows back to the preferred scale after being too small", async () => {
    const container = new BoxRenderable(testRenderer, {
      width: "100%",
      height: "100%",
      maxWidth: 72,
      maxHeight: 38,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
    })
    const qr = new QRCodeRenderable(testRenderer, {
      content: "opentui.com",
      quietZone: 4,
      scale: 2,
      fallbackContent: "Resize for QR",
    })

    container.add(qr)
    testRenderer.root.add(container)
    await renderOnce()

    expect(qr.getLayoutNode().getComputedLayout().width).toBe(58)
    expect(qr.getLayoutNode().getComputedLayout().height).toBe(29)

    resize(20, 8)
    await renderOnce()

    expect(captureCharFrame()).toContain("Resize for QR")

    resize(80, 40)
    await renderOnce()

    expect(qr.getLayoutNode().getComputedLayout().width).toBe(58)
    expect(qr.getLayoutNode().getComputedLayout().height).toBe(29)
    expect(captureCharFrame()).toContain("█")
  })

  it("keeps the parent background outside the centered QR square when stretched", async () => {
    const container = new BoxRenderable(testRenderer, {
      width: 60,
      height: 20,
      backgroundColor: "#112233",
      flexDirection: "column",
    })
    const qr = new QRCodeRenderable(testRenderer, {
      content: "HELLO WORLD",
      scale: 2,
      backgroundColor: "#ffffff",
    })

    container.add(qr)
    testRenderer.root.add(container)
    await renderOnce()

    const qrRow = captureSpans().lines[2]?.spans ?? []
    expect(qrRow.length).toBeGreaterThan(1)
    expect(qrRow[0]?.bg.equals(qr.backgroundColor)).toBe(false)
    expect(qrRow.some((span) => span.bg.equals(qr.backgroundColor))).toBe(true)
    expect(qrRow[qrRow.length - 1]?.bg.equals(qr.backgroundColor)).toBe(false)
  })

  it("caches rendered cells and only redraws them after QR inputs change", async () => {
    const paintTracker = trackOptimizedBufferPaints()

    try {
      const qr = new QRCodeRenderable(testRenderer, {
        content: "HELLO WORLD",
        quietZone: 4,
        scale: 1,
      })

      testRenderer.root.add(qr)
      await renderOnce()

      expect(paintTracker.counts.fillRect).toBeGreaterThan(0)
      expect(paintTracker.counts.setCell).toBeGreaterThan(0)

      const afterFirstPaint = { ...paintTracker.counts }

      await renderOnce()

      expect(paintTracker.counts.fillRect).toBe(afterFirstPaint.fillRect)
      expect(paintTracker.counts.setCell).toBe(afterFirstPaint.setCell)
      expect(paintTracker.counts.drawFrameBuffer).toBeGreaterThan(afterFirstPaint.drawFrameBuffer)

      qr.foregroundColor = "#ff0000"
      await renderOnce()

      expect(paintTracker.counts.fillRect).toBeGreaterThan(afterFirstPaint.fillRect)
      expect(paintTracker.counts.setCell).toBeGreaterThan(afterFirstPaint.setCell)

      const afterColorPaint = { ...paintTracker.counts }

      await renderOnce()

      expect(paintTracker.counts.fillRect).toBe(afterColorPaint.fillRect)
      expect(paintTracker.counts.setCell).toBe(afterColorPaint.setCell)
      expect(paintTracker.counts.drawFrameBuffer).toBeGreaterThan(afterColorPaint.drawFrameBuffer)

      qr.content = "HELLO OPENTUI"
      await renderOnce()

      expect(paintTracker.counts.fillRect).toBeGreaterThan(afterColorPaint.fillRect)
      expect(paintTracker.counts.setCell).toBeGreaterThan(afterColorPaint.setCell)
    } finally {
      paintTracker.restore()
    }
  })
})

function trackOptimizedBufferPaints(): {
  counts: {
    fillRect: number
    setCell: number
    drawFrameBuffer: number
  }
  restore: () => void
} {
  const counts = {
    fillRect: 0,
    setCell: 0,
    drawFrameBuffer: 0,
  }
  const originalFillRect = OptimizedBuffer.prototype.fillRect
  const originalSetCell = OptimizedBuffer.prototype.setCell
  const originalDrawFrameBuffer = OptimizedBuffer.prototype.drawFrameBuffer

  OptimizedBuffer.prototype.fillRect = function (
    this: OptimizedBuffer,
    ...args: Parameters<OptimizedBuffer["fillRect"]>
  ): void {
    counts.fillRect++
    originalFillRect.apply(this, args)
  }

  OptimizedBuffer.prototype.setCell = function (
    this: OptimizedBuffer,
    ...args: Parameters<OptimizedBuffer["setCell"]>
  ): void {
    counts.setCell++
    originalSetCell.apply(this, args)
  }

  OptimizedBuffer.prototype.drawFrameBuffer = function (
    this: OptimizedBuffer,
    ...args: Parameters<OptimizedBuffer["drawFrameBuffer"]>
  ): void {
    counts.drawFrameBuffer++
    originalDrawFrameBuffer.apply(this, args)
  }

  return {
    counts,
    restore: () => {
      OptimizedBuffer.prototype.fillRect = originalFillRect
      OptimizedBuffer.prototype.setCell = originalSetCell
      OptimizedBuffer.prototype.drawFrameBuffer = originalDrawFrameBuffer
    },
  }
}

function encodeExactVersionQRCode(targetVersion: number): QRCode {
  return QRCode.encodeText("A", ErrorCorrectionLevel.H, {
    boostEcl: false,
    eciForUtf8: false,
    mask: 0,
    maxVersion: targetVersion,
    minVersion: targetVersion,
  })
}

function getQRCodeAlignmentPatternPositions(version: number): number[] {
  if (version === 1) {
    return []
  }

  const size = version * 4 + 17
  const count = Math.floor(version / 7) + 2
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const positions = [6]

  for (let position = size - 7; positions.length < count; position -= step) {
    positions.splice(1, 0, position)
  }

  return positions
}

function computeQRCodeFormatBits(errorCorrectionLevel: ErrorCorrectionLevel, mask: number): number {
  const formatBitsByEcl: Record<ErrorCorrectionLevel, number> = {
    [ErrorCorrectionLevel.M]: 0b00,
    [ErrorCorrectionLevel.L]: 0b01,
    [ErrorCorrectionLevel.H]: 0b10,
    [ErrorCorrectionLevel.Q]: 0b11,
  }
  const data = (formatBitsByEcl[errorCorrectionLevel] << 3) | mask
  let remainder = data

  for (let i = 0; i < 10; i++) {
    remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537)
  }

  return ((data << 10) | remainder) ^ 0x5412
}

function computeQRCodeVersionBits(version: number): number {
  let remainder = version

  for (let i = 0; i < 12; i++) {
    remainder = (remainder << 1) ^ (((remainder >>> 11) & 1) * 0x1f25)
  }

  return (version << 12) | remainder
}

function readPrimaryFormatBits(modules: boolean[][]): number {
  const coordinates: Array<[number, number]> = [
    [8, 0],
    [8, 1],
    [8, 2],
    [8, 3],
    [8, 4],
    [8, 5],
    [8, 7],
    [8, 8],
    [7, 8],
    [5, 8],
    [4, 8],
    [3, 8],
    [2, 8],
    [1, 8],
    [0, 8],
  ]

  return readBitsAtCoordinates(modules, coordinates)
}

function readSecondaryFormatBits(modules: boolean[][]): number {
  const size = modules.length
  const coordinates: Array<[number, number]> = []

  for (let i = 0; i < 8; i++) {
    coordinates.push([size - 1 - i, 8])
  }

  for (let i = 8; i < 15; i++) {
    coordinates.push([8, size - 15 + i])
  }

  return readBitsAtCoordinates(modules, coordinates)
}

function readTopRightVersionBits(modules: boolean[][]): number {
  const size = modules.length
  const coordinates: Array<[number, number]> = []

  for (let i = 0; i < 18; i++) {
    coordinates.push([size - 11 + (i % 3), Math.floor(i / 3)])
  }

  return readBitsAtCoordinates(modules, coordinates)
}

function readBottomLeftVersionBits(modules: boolean[][]): number {
  const coordinates: Array<[number, number]> = []

  for (let i = 0; i < 18; i++) {
    coordinates.push([Math.floor(i / 3), modules.length - 11 + (i % 3)])
  }

  return readBitsAtCoordinates(modules, coordinates)
}

function readBitsAtCoordinates(modules: boolean[][], coordinates: Array<[number, number]>): number {
  let bits = 0

  for (let i = 0; i < coordinates.length; i++) {
    const [x, y] = coordinates[i]!
    if (modules[y]![x]) {
      bits |= 1 << i
    }
  }

  return bits
}

function expectAlignmentPattern(modules: boolean[][], centerX: number, centerY: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy))
      const expected = distance !== 1
      expect(modules[centerY + dy]![centerX + dx]).toBe(expected)
    }
  }
}

function toBinaryString(value: number, width: number): string {
  return value.toString(2).padStart(width, "0")
}
