import { describe, expect, it } from "bun:test"
import { EciAssignment, ErrorCorrectionLevel, QRCode, QrSegment } from "./qrcode.js"

describe("QR code ISO/IEC 18004:2024 conformance vectors", () => {
  it("encodes the numeric-mode example bit stream", () => {
    const segment = QrSegment.makeNumeric("01234567")

    expect(segmentBitString(segment)).toBe("000000110001010110011000011")
    expect(segment.getTotalBits(1)).toBe(41)
  })

  it("encodes the alphanumeric-mode example bit stream", () => {
    const segment = QrSegment.makeAlphanumeric("AC-42")

    expect(segmentBitString(segment)).toBe("0011100111011100111001000010")
    expect(segment.getTotalBits(1)).toBe(41)
  })

  it("encodes the Kanji-mode example codewords", () => {
    const segment = QrSegment.makeKanjiFromShiftJis([0x93, 0x5f, 0xe4, 0xaa])

    expect(segmentBitString(segment)).toBe("01101100111111101010101010")
    expect(segment.getTotalBits(1)).toBe(38)
  })

  it("encodes ECI assignment designators at all length boundaries", () => {
    expect(segmentBitString(QrSegment.makeEci(9))).toBe("00001001")
    expect(segmentBitString(QrSegment.makeEci(128))).toBe("1000000010000000")
    expect(segmentBitString(QrSegment.makeEci(999999))).toBe("110011110100001000111111")
  })

  it("matches the published version 1-M numeric codeword sequence before placement", () => {
    const qr = QRCode.encodeText("01234567", ErrorCorrectionLevel.M, {
      boostEcl: false,
      eciForUtf8: false,
      mask: 2,
      minVersion: 1,
      maxVersion: 1,
    })

    expect(readPlacedCodewords(qr.toMatrix(), qr.version, qr.mask)).toEqual([
      0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xa5, 0x24, 0xd4,
      0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55,
    ])
  })

  it("places all QR format-information sequences from the lookup table", () => {
    const expectedByDataBits = [
      0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0, 0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318,
      0x6c41, 0x6976, 0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b, 0x355f, 0x3068, 0x3f31, 0x3a06,
      0x24b4, 0x2183, 0x2eda, 0x2bed,
    ]
    const eclByFormatBits = new Map<number, ErrorCorrectionLevel>([
      [0b00, ErrorCorrectionLevel.M],
      [0b01, ErrorCorrectionLevel.L],
      [0b10, ErrorCorrectionLevel.H],
      [0b11, ErrorCorrectionLevel.Q],
    ])

    for (let dataBits = 0; dataBits < expectedByDataBits.length; dataBits++) {
      const ecl = eclByFormatBits.get(dataBits >>> 3)!
      const mask = dataBits & 0b111
      const qr = QRCode.encodeText("A", ecl, {
        boostEcl: false,
        eciForUtf8: false,
        mask,
        minVersion: 1,
        maxVersion: 1,
      })

      expect(readPrimaryFormatBits(qr.toMatrix())).toBe(expectedByDataBits[dataBits])
      expect(readSecondaryFormatBits(qr.toMatrix())).toBe(expectedByDataBits[dataBits])
    }
  })

  it("places representative version-information sequences from the lookup table", () => {
    const expectedByVersion = new Map<number, number>([
      [7, 0x07c94],
      [8, 0x085bc],
      [14, 0x0e60d],
      [21, 0x15683],
      [32, 0x209d5],
      [40, 0x28c69],
    ])

    for (const [version, expected] of expectedByVersion) {
      const qr = QRCode.encodeText("A", ErrorCorrectionLevel.H, {
        boostEcl: false,
        eciForUtf8: false,
        mask: 0,
        minVersion: version,
        maxVersion: version,
      })

      expect(readTopRightVersionBits(qr.toMatrix())).toBe(expected)
      expect(readBottomLeftVersionBits(qr.toMatrix())).toBe(expected)
    }
  })

  it("draws alignment patterns at representative table coordinates", () => {
    const expectedPositionsByVersion = new Map<number, number[]>([
      [2, [6, 18]],
      [7, [6, 22, 38]],
      [14, [6, 26, 46, 66]],
      [21, [6, 28, 50, 72, 94]],
      [32, [6, 34, 60, 86, 112, 138]],
      [40, [6, 30, 58, 86, 114, 142, 170]],
    ])

    for (const [version, positions] of expectedPositionsByVersion) {
      const qr = QRCode.encodeText("A", ErrorCorrectionLevel.H, {
        boostEcl: false,
        eciForUtf8: false,
        mask: 0,
        minVersion: version,
        maxVersion: version,
      })
      const modules = qr.toMatrix()

      for (const y of positions) {
        for (const x of positions) {
          if (overlapsFinderPattern(x, y, qr.size)) continue
          expectAlignmentPattern(modules, x, y)
        }
      }
    }
  })

  it("uses the specified QR data-mask conditions", () => {
    const coordinates: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [3, 2],
      [5, 7],
      [8, 9],
    ]

    for (let mask = 0; mask < 8; mask++) {
      for (const [x, y] of coordinates) {
        expect(QRCode.maskCondition(mask, x, y)).toBe(expectedMaskCondition(mask, x, y))
      }
    }
  })

  it("honors selected data-capacity boundaries", () => {
    expect(() => encodeExactNumeric(1, ErrorCorrectionLevel.H, 17)).not.toThrow()
    expect(() => encodeExactNumeric(1, ErrorCorrectionLevel.H, 18)).toThrow()
    expect(() => encodeExactNumeric(10, ErrorCorrectionLevel.Q, 364)).not.toThrow()
    expect(() => encodeExactNumeric(10, ErrorCorrectionLevel.Q, 365)).toThrow()
    expect(() => encodeExactNumeric(40, ErrorCorrectionLevel.L, 7089)).not.toThrow()
    expect(() => encodeExactNumeric(40, ErrorCorrectionLevel.L, 7090)).toThrow()
  })

  it("reports symbology identifiers for ECI and FNC1 modes", () => {
    expect(QRCode.encodeText("ABC", ErrorCorrectionLevel.M, { eciForUtf8: false }).symbologyIdentifier).toBe("]Q1")
    expect(QRCode.encodeEciText("\\000009ABC", ErrorCorrectionLevel.M).symbologyIdentifier).toBe("]Q2")
    expect(QRCode.encodeGs1Text("0104912345123459", ErrorCorrectionLevel.M).symbologyIdentifier).toBe("]Q3")
    expect(
      QRCode.encodeSegments(
        [QrSegment.makeEci(EciAssignment.ISO_8859_1), QrSegment.makeBytes([0x41])],
        ErrorCorrectionLevel.M,
        {
          fnc1First: true,
        },
      ).symbologyIdentifier,
    ).toBe("]Q4")
    expect(
      QRCode.encodeSegments([QrSegment.makeAlphanumeric("AA1234")], ErrorCorrectionLevel.M, {
        fnc1Second: { applicationIndicator: 37 },
      }).symbologyIdentifier,
    ).toBe("]Q5")
    expect(
      QRCode.encodeSegments(
        [QrSegment.makeEci(EciAssignment.ISO_8859_1), QrSegment.makeBytes([0x41])],
        ErrorCorrectionLevel.M,
        {
          fnc1Second: { applicationIndicator: 37 },
        },
      ).symbologyIdentifier,
    ).toBe("]Q6")
  })

  it("computes structured append parity over original data bytes", () => {
    const segments = [QrSegment.makeNumeric("0123456789"), QrSegment.makeKanji("日本")]

    expect(QRCode.computeStructuredAppendParity(segments)).toBe(0x85)
  })
})

function encodeExactNumeric(version: number, ecl: ErrorCorrectionLevel, length: number): QRCode {
  return QRCode.encodeSegments([QrSegment.makeNumeric("1".repeat(length))], ecl, {
    boostEcl: false,
    mask: 0,
    minVersion: version,
    maxVersion: version,
  })
}

function segmentBitString(segment: QrSegment): string {
  let result = ""
  for (let i = 0; i < segment.data.length; i++) result += segment.data.getBit(i).toString()
  return result
}

function readPlacedCodewords(modules: boolean[][], version: number, mask: number): number[] {
  const functionModules = makeFunctionModuleMap(version)
  const dataBits: number[] = []
  const size = modules.length

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (functionModules[y]![x]) continue
        dataBits.push(modules[y]![x] !== QRCode.maskCondition(mask, x, y) ? 1 : 0)
      }
    }
  }

  const codewords: number[] = []
  for (let i = 0; i + 7 < dataBits.length; i += 8) {
    let value = 0
    for (let j = 0; j < 8; j++) value = (value << 1) | dataBits[i + j]!
    codewords.push(value)
  }
  return codewords
}

function makeFunctionModuleMap(version: number): boolean[][] {
  const size = version * 4 + 17
  const map = Array.from({ length: size }, () => Array<boolean>(size).fill(false))

  const mark = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < size && y < size) map[y]![x] = true
  }
  const markFinder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy)
  }
  const markAlignment = (cx: number, cy: number): void => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(cx + dx, cy + dy)
  }

  for (let i = 0; i < size; i++) {
    mark(i, 6)
    mark(6, i)
  }
  markFinder(3, 3)
  markFinder(size - 4, 3)
  markFinder(3, size - 4)

  const positions = alignmentPositions(version)
  for (const y of positions) {
    for (const x of positions) {
      if (overlapsFinderPattern(x, y, size)) continue
      markAlignment(x, y)
    }
  }

  for (let i = 0; i <= 5; i++) mark(8, i)
  mark(8, 7)
  mark(8, 8)
  mark(7, 8)
  for (let i = 9; i < 15; i++) mark(14 - i, 8)
  for (let i = 0; i < 8; i++) mark(size - 1 - i, 8)
  for (let i = 8; i < 15; i++) mark(8, size - 15 + i)
  mark(8, size - 8)

  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      mark(a, b)
      mark(b, a)
    }
  }

  return map
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return []
  const size = version * 4 + 17
  const count = Math.floor(version / 7) + 2
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const result = [6]
  for (let position = size - 7; result.length < count; position -= step) result.splice(1, 0, position)
  return result
}

function overlapsFinderPattern(x: number, y: number, size: number): boolean {
  return (x === 6 && y === 6) || (x === 6 && y === size - 7) || (x === size - 7 && y === 6)
}

function expectedMaskCondition(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (y + x) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (y + x) % 3 === 0
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
    case 5:
      return ((y * x) % 2) + ((y * x) % 3) === 0
    case 6:
      return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0
    case 7:
      return (((y + x) % 2) + ((y * x) % 3)) % 2 === 0
    default:
      throw new RangeError("Mask must be in 0..7")
  }
}

function readPrimaryFormatBits(modules: boolean[][]): number {
  return readBitsAtCoordinates(modules, [
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
  ])
}

function readSecondaryFormatBits(modules: boolean[][]): number {
  const size = modules.length
  const coordinates: Array<[number, number]> = []
  for (let i = 0; i < 8; i++) coordinates.push([size - 1 - i, 8])
  for (let i = 8; i < 15; i++) coordinates.push([8, size - 15 + i])
  return readBitsAtCoordinates(modules, coordinates)
}

function readTopRightVersionBits(modules: boolean[][]): number {
  const size = modules.length
  const coordinates: Array<[number, number]> = []
  for (let i = 0; i < 18; i++) coordinates.push([size - 11 + (i % 3), Math.floor(i / 3)])
  return readBitsAtCoordinates(modules, coordinates)
}

function readBottomLeftVersionBits(modules: boolean[][]): number {
  const size = modules.length
  const coordinates: Array<[number, number]> = []
  for (let i = 0; i < 18; i++) coordinates.push([Math.floor(i / 3), size - 11 + (i % 3)])
  return readBitsAtCoordinates(modules, coordinates)
}

function readBitsAtCoordinates(modules: boolean[][], coordinates: Array<[number, number]>): number {
  let bits = 0
  for (let i = 0; i < coordinates.length; i++) {
    const [x, y] = coordinates[i]!
    if (modules[y]![x]) bits |= 1 << i
  }
  return bits
}

function expectAlignmentPattern(modules: boolean[][], centerX: number, centerY: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy))
      expect(modules[centerY + dy]![centerX + dx]).toBe(distance !== 1)
    }
  }
}
