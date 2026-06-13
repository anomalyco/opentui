/*
 * ISO/IEC 18004:2024-oriented QR Code encoder in TypeScript.
 *
 * Scope implemented by this package:
 * - QR Code Model 2, versions 1..40, ECC levels L/M/Q/H
 * - Numeric, Alphanumeric, Byte, Kanji, ECI, Structured Append, and FNC1 signalling
 * - GS1/FNC1 helpers for separator handling
 * - Reed-Solomon error correction over GF(256)
 * - Data/ECC block interleaving for QR Code Model 2
 * - Function patterns, alignment/timing patterns, format and version information
 * - QR masks 0..7 with automatic mask selection
 * - DP-based mixed-mode optimization for QR text inputs
 * - SVG rendering with ISO quiet-zone minimum: 4 modules for QR
 *
 * Notes:
 * - Model 1 QR Code is a legacy format and is not generated here.
 * - rMQR is outside ISO/IEC 18004:2024 and is not generated here.
 * - Arbitrary non-character-set ECIs are signalled correctly, but payload conversion
 *   for application-defined ECI transformations must be done by the caller.
 */

import {
  EciAssignment,
  asciiBytes,
  encodeTextBytes,
  encodingForKnownEci,
  isKanjiModeShiftJisValue,
  shiftJisCodeForCharacter,
  validateBytes,
  type ByteEncoding,
} from "./qrcode.encoding.js"
import { matrixToSvg, matrixToTerminal, normalizeTerminalOptions, type TerminalRenderOptions } from "./qrcode.render.js"

export { EciAssignment, encodeTextBytes, type ByteEncoding } from "./qrcode.encoding.js"
export type { TerminalRenderOptions } from "./qrcode.render.js"

export enum ErrorCorrectionLevel {
  /** Recovers about 7% data damage. QR format bits: 01. */
  L = "L",
  /** Recovers about 15% data damage. QR format bits: 00. */
  M = "M",
  /** Recovers about 25% data damage. QR format bits: 11. */
  Q = "Q",
  /** Recovers about 30% data damage. QR format bits: 10. */
  H = "H",
}

export interface StructuredAppendInfo {
  /** 1-based position of this symbol in the structured append sequence. */
  position: number
  /** Total number of symbols in the structured append sequence, 2..16. */
  total: number
  /** 8-bit parity value, normally computed with QRCode.computeStructuredAppendParity(). */
  parity: number
}

export interface Fnc1SecondPositionInfo {
  /** Two decimal digits, a number 0..99, or one Latin alphabetic character. */
  applicationIndicator: string | number
}

export interface EncodeOptions {
  /** Minimum QR Code Model 2 version, inclusive. Default: 1. */
  minVersion?: number
  /** Maximum QR Code Model 2 version, inclusive. Default: 40. */
  maxVersion?: number
  /** Force QR mask pattern 0..7. Default: auto-select by penalty score. */
  mask?: number
  /** Upgrade ECC level if the data still fits in the selected version. Default: true. */
  boostEcl?: boolean
  /** Use DP mixed-mode optimization for text. Default: true. */
  optimize?: boolean
  /** Allow Kanji mode for characters encodable in Shift JIS Kanji ranges. Default: false. */
  kanji?: boolean
  /** Byte-segment character encoding for text fallback. Default: utf-8. */
  byteEncoding?: ByteEncoding
  /** Prefix UTF-8 byte-mode text with ECI assignment 26. Default: true when byteEncoding is utf-8. */
  eciForUtf8?: boolean
  /** Override the ECI assignment emitted before byte segments; set null to suppress ECI. */
  eciAssignment?: number | null
  /** Insert FNC1 in first position immediately after any structured append/ECI header. */
  fnc1First?: boolean
  /** Insert FNC1 in second position immediately after any structured append/ECI header. */
  fnc1Second?: Fnc1SecondPositionInfo
  /** Insert a structured append header at the start of the symbol. */
  structuredAppend?: StructuredAppendInfo
}

export interface Gs1Element {
  /** Application identifier, e.g. "01", "17", "10". Parentheses are not encoded. */
  ai: string
  /** Element-string data. */
  data: string
  /** Add a FNC1 field separator after this element. Do not set on the last element. */
  separatorAfter?: boolean
}

interface Block {
  data: number[]
  ecc: number[]
}

interface QrMetadata {
  containsEci: boolean
  fnc1: "none" | "first" | "second"
}

class BitBuffer {
  private readonly bits: number[] = []

  get length(): number {
    return this.bits.length
  }

  appendBits(value: number, bitCount: number): void {
    if (!Number.isInteger(value) || !Number.isInteger(bitCount) || bitCount < 0 || bitCount > 31) {
      throw new RangeError("Invalid bit append request")
    }
    if (bitCount < 31 && value >>> bitCount !== 0) {
      throw new RangeError(`Value ${value} does not fit in ${bitCount} bits`)
    }
    for (let i = bitCount - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1)
    }
  }

  appendData(other: BitBuffer): void {
    for (let i = 0; i < other.length; i++) this.bits.push(other.getBit(i))
  }

  getBit(index: number): number {
    return this.bits[index] ?? 0
  }

  toBytes(): number[] {
    const result: number[] = []
    for (let i = 0; i < this.bits.length; i += 8) {
      let value = 0
      for (let j = 0; j < 8 && i + j < this.bits.length; j++) value = (value << 1) | this.bits[i + j]
      if (this.bits.length - i < 8) value <<= 8 - (this.bits.length - i)
      result.push(value)
    }
    return result
  }
}

class Mode {
  static readonly NUMERIC = new Mode("NUMERIC", 0x1, [10, 12, 14], true)

  static readonly ALPHANUMERIC = new Mode("ALPHANUMERIC", 0x2, [9, 11, 13], true)

  static readonly BYTE = new Mode("BYTE", 0x4, [8, 16, 16], true)

  static readonly KANJI = new Mode("KANJI", 0x8, [8, 10, 12], true)

  static readonly ECI = new Mode("ECI", 0x7, [0, 0, 0], false)
  static readonly STRUCTURED_APPEND = new Mode("STRUCTURED_APPEND", 0x3, [0, 0, 0], false)
  static readonly FNC1_FIRST = new Mode("FNC1_FIRST", 0x5, [0, 0, 0], false)
  static readonly FNC1_SECOND = new Mode("FNC1_SECOND", 0x9, [0, 0, 0], false)

  private constructor(
    readonly name: string,
    readonly modeBits: number,
    private readonly charCountBitsForVersionRange: readonly [number, number, number],
    readonly hasCharacterCount: boolean,
  ) {}

  numCharCountBits(version: number): number {
    if (!this.hasCharacterCount) return 0
    if (version < 1 || version > 40) throw new RangeError("Version must be in 1..40")
    return this.charCountBitsForVersionRange[Math.floor((version + 7) / 17)]
  }
}

class ReedSolomon {
  static computeDivisor(degree: number): number[] {
    if (!Number.isInteger(degree) || degree < 1 || degree > 255) throw new RangeError("Invalid Reed-Solomon degree")
    const result = Array<number>(degree).fill(0)
    result[degree - 1] = 1
    let root = 1
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = ReedSolomon.multiply(result[j], root)
        if (j + 1 < degree) result[j] ^= result[j + 1]
      }
      root = ReedSolomon.multiply(root, 0x02)
    }
    return result
  }

  static computeRemainder(data: readonly number[], divisor: readonly number[]): number[] {
    const result = Array<number>(divisor.length).fill(0)
    for (const b of data) {
      if (!Number.isInteger(b) || b < 0 || b > 0xff) throw new RangeError("Data codeword out of range")
      const factor = b ^ result.shift()!
      result.push(0)
      for (let i = 0; i < result.length; i++) result[i] ^= ReedSolomon.multiply(divisor[i], factor)
    }
    return result
  }

  static multiply(x: number, y: number): number {
    if (x >>> 8 !== 0 || y >>> 8 !== 0) throw new RangeError("Reed-Solomon operands must be bytes")
    let z = 0
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d)
      z ^= ((y >>> i) & 1) * x
    }
    return z & 0xff
  }
}

export class QrSegment {
  private static readonly ALPHANUMERIC_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"

  private constructor(
    readonly mode: Mode,
    readonly numChars: number,
    readonly data: BitBuffer,
    readonly parityBytes: readonly number[] = [],
  ) {}

  static makeNumeric(digits: string): QrSegment {
    if (!/^[0-9]*$/.test(digits)) throw new Error("Numeric mode accepts digits only")
    const bb = new BitBuffer()
    for (let i = 0; i < digits.length; ) {
      const n = Math.min(digits.length - i, 3)
      bb.appendBits(Number(digits.substring(i, i + n)), n * 3 + 1)
      i += n
    }
    return new QrSegment(Mode.NUMERIC, digits.length, bb, asciiBytes(digits))
  }

  static makeAlphanumeric(text: string): QrSegment {
    if (!QrSegment.isAlphanumeric(text)) throw new Error("Alphanumeric mode accepts only: 0-9 A-Z space $%*+-./:")
    const bb = new BitBuffer()
    let i = 0
    for (; i + 2 <= text.length; i += 2) {
      const value =
        QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)) * 45 +
        QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i + 1))
      bb.appendBits(value, 11)
    }
    if (i < text.length) bb.appendBits(QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)), 6)
    return new QrSegment(Mode.ALPHANUMERIC, text.length, bb, asciiBytes(text))
  }

  static makeBytes(bytes: Uint8Array | number[]): QrSegment {
    const bb = new BitBuffer()
    const arr = validateBytes(Array.from(bytes))
    for (const b of arr) bb.appendBits(b, 8)
    return new QrSegment(Mode.BYTE, arr.length, bb, arr)
  }

  static makeBytesFromText(text: string, encoding: ByteEncoding = "utf-8"): QrSegment {
    return QrSegment.makeBytes(encodeTextBytes(text, encoding))
  }

  static makeKanji(text: string): QrSegment {
    const bytes: number[] = []
    for (const ch of Array.from(text)) {
      const sjis = shiftJisCodeForCharacter(ch)
      if (!isKanjiModeShiftJisValue(sjis))
        throw new Error(`Character ${JSON.stringify(ch)} is not encodable in QR Kanji mode`)
      bytes.push(sjis >>> 8, sjis & 0xff)
    }
    return QrSegment.makeKanjiFromShiftJis(bytes)
  }

  static makeKanjiFromShiftJis(bytes: Uint8Array | number[]): QrSegment {
    const arr = validateBytes(Array.from(bytes))
    if (arr.length % 2 !== 0) throw new Error("Kanji mode requires an even number of Shift JIS bytes")
    const bb = new BitBuffer()
    for (let i = 0; i < arr.length; i += 2) {
      const sjis = (arr[i] << 8) | arr[i + 1]
      let subtracted: number
      if (sjis >= 0x8140 && sjis <= 0x9ffc) subtracted = sjis - 0x8140
      else if (sjis >= 0xe040 && sjis <= 0xebbf) subtracted = sjis - 0xc140
      else throw new Error(`Shift JIS value 0x${sjis.toString(16).toUpperCase()} is outside QR Kanji-mode ranges`)
      const encoded = (subtracted >>> 8) * 0xc0 + (subtracted & 0xff)
      bb.appendBits(encoded, 13)
    }
    return new QrSegment(Mode.KANJI, arr.length / 2, bb, arr)
  }

  static makeEci(assignVal: number): QrSegment {
    if (!Number.isInteger(assignVal) || assignVal < 0 || assignVal >= 1_000_000) {
      throw new RangeError("ECI assignment value must be in 0..999999")
    }
    const bb = new BitBuffer()
    if (assignVal < 128) bb.appendBits(assignVal, 8)
    else if (assignVal < 16_384) bb.appendBits(0x8000 | assignVal, 16)
    else bb.appendBits(0xc00000 | assignVal, 24)
    return new QrSegment(Mode.ECI, 0, bb)
  }

  static makeStructuredAppendHeader(position: number, total: number, parity: number): QrSegment {
    validateStructuredAppend(position, total, parity)
    const bb = new BitBuffer()
    bb.appendBits(((position - 1) << 4) | (total - 1), 8)
    bb.appendBits(parity, 8)
    return new QrSegment(Mode.STRUCTURED_APPEND, 0, bb)
  }

  static makeFnc1FirstPosition(): QrSegment {
    return new QrSegment(Mode.FNC1_FIRST, 0, new BitBuffer())
  }

  static makeFnc1SecondPosition(applicationIndicator: string | number): QrSegment {
    const bb = new BitBuffer()
    bb.appendBits(encodeFnc1SecondApplicationIndicator(applicationIndicator), 8)
    return new QrSegment(Mode.FNC1_SECOND, 0, bb)
  }

  static isNumeric(text: string): boolean {
    return /^[0-9]*$/.test(text)
  }

  static isAlphanumeric(text: string): boolean {
    return /^[0-9A-Z $%*+\-./:]*$/.test(text)
  }

  static isKanji(text: string): boolean {
    if (text.length === 0) return true
    for (const ch of Array.from(text)) {
      let sjis: number
      try {
        sjis = shiftJisCodeForCharacter(ch)
      } catch {
        return false
      }
      if (!isKanjiModeShiftJisValue(sjis)) return false
    }
    return true
  }

  static makeSegments(
    text: string,
    options: Pick<EncodeOptions, "eciForUtf8" | "kanji" | "byteEncoding" | "eciAssignment"> = {},
  ): QrSegment[] {
    if (text.length === 0) return []
    if (QrSegment.isNumeric(text)) return [QrSegment.makeNumeric(text)]
    if (QrSegment.isAlphanumeric(text)) return [QrSegment.makeAlphanumeric(text)]
    if (options.kanji === true && QrSegment.isKanji(text)) return [QrSegment.makeKanji(text)]

    const encoding = options.byteEncoding ?? "utf-8"
    const segments = [QrSegment.makeBytesFromText(text, encoding)]
    return QrSegment.addEciIfNeeded(segments, encoding, options)
  }

  static makeOptimizedSegments(
    text: string,
    version: number,
    options: Pick<EncodeOptions, "eciForUtf8" | "kanji" | "byteEncoding" | "eciAssignment"> = {},
  ): QrSegment[] {
    QRCode.validateVersionPublic(version)
    return QrSegment.makeOptimizedSegmentsInternal(text, version, options)
  }

  static makeEciSegmentsFromEscapedText(
    escapedText: string,
    options: { defaultEncoding?: ByteEncoding; defaultEci?: number | null } = {},
  ): QrSegment[] {
    const defaultEncoding = options.defaultEncoding ?? "iso-8859-1"
    const result: QrSegment[] = []
    let currentEci = options.defaultEci
    let currentEncoding = defaultEncoding
    let buffer = ""

    const flush = (): void => {
      if (buffer.length === 0) return
      result.push(QrSegment.makeBytesFromText(buffer, currentEncoding))
      buffer = ""
    }

    for (let i = 0; i < escapedText.length; ) {
      if (escapedText.charAt(i) !== "\\") {
        buffer += escapedText.charAt(i++)
        continue
      }
      if (escapedText.charAt(i + 1) === "\\") {
        buffer += "\\"
        i += 2
        continue
      }
      const digits = escapedText.substring(i + 1, i + 7)
      if (/^[0-9]{6}$/.test(digits)) {
        flush()
        currentEci = Number(digits)
        result.push(QrSegment.makeEci(currentEci))
        currentEncoding = encodingForKnownEci(currentEci) ?? currentEncoding
        i += 7
        continue
      }
      throw new Error("Single backslash in ECI text must be followed by six digits or another backslash")
    }
    flush()
    return result
  }

  getTotalBits(version: number): number {
    if (!this.mode.hasCharacterCount) return 4 + this.data.length
    const ccbits = this.mode.numCharCountBits(version)
    if (this.numChars >= 1 << ccbits) return Infinity
    return 4 + ccbits + this.data.length
  }

  private static addEciIfNeeded(
    segments: QrSegment[],
    encoding: ByteEncoding,
    options: Pick<EncodeOptions, "eciForUtf8" | "eciAssignment">,
  ): QrSegment[] {
    if (!segments.some((seg) => seg.mode === Mode.BYTE)) return segments
    let assignment: number | null
    if (options.eciAssignment !== undefined) assignment = options.eciAssignment
    else if (encoding === "utf-8") assignment = options.eciForUtf8 === false ? null : EciAssignment.UTF_8
    else if (encoding === "shift-jis") assignment = EciAssignment.SHIFT_JIS
    else assignment = null
    return assignment === null ? segments : [QrSegment.makeEci(assignment), ...segments]
  }

  private static makeOptimizedSegmentsInternal(
    text: string,
    version: number,
    options: Pick<EncodeOptions, "eciForUtf8" | "kanji" | "byteEncoding" | "eciAssignment">,
  ): QrSegment[] {
    if (text.length === 0) return []
    const chars = Array.from(text)
    const n = chars.length
    const encoding = options.byteEncoding ?? "utf-8"
    const allowKanji = options.kanji === true
    const byteParts = chars.map((ch) => Array.from(encodeTextBytes(ch, encoding)))

    let eciBits = 0
    let eciAssignment: number | null = null
    if (options.eciAssignment !== undefined) eciAssignment = options.eciAssignment
    else if (encoding === "utf-8") eciAssignment = options.eciForUtf8 === false ? null : EciAssignment.UTF_8
    else if (encoding === "shift-jis") eciAssignment = EciAssignment.SHIFT_JIS
    else eciAssignment = null
    eciBits = eciAssignment === null ? 0 : QrSegment.makeEci(eciAssignment).getTotalBits(version)

    type Used = 0 | 1
    type Prev = { prevIndex: number; prevUsed: Used; mode: Mode }
    const inf = Number.POSITIVE_INFINITY
    const dp: [number[], number[]] = [Array<number>(n + 1).fill(inf), Array<number>(n + 1).fill(inf)]
    const prev: [Array<Prev | null>, Array<Prev | null>] = [
      Array<Prev | null>(n + 1).fill(null),
      Array<Prev | null>(n + 1).fill(null),
    ]
    dp[0][0] = 0

    const modeHeaderBits = (mode: Mode, count: number, byteCount: number): number => {
      const ccbits = mode.numCharCountBits(version)
      const nChars = mode === Mode.BYTE ? byteCount : count
      if (nChars >= 1 << ccbits) return inf
      return 4 + ccbits
    }

    const dataBitsFor = (mode: Mode, count: number, byteCount: number): number => {
      if (mode === Mode.NUMERIC) return Math.floor(count / 3) * 10 + (count % 3 === 1 ? 4 : count % 3 === 2 ? 7 : 0)
      if (mode === Mode.ALPHANUMERIC) return Math.floor(count / 2) * 11 + (count % 2) * 6
      if (mode === Mode.KANJI) return count * 13
      return byteCount * 8
    }

    const update = (from: number, fromUsed: Used, to: number, toUsed: Used, mode: Mode, cost: number): void => {
      const total = dp[fromUsed][from] + cost
      if (total < dp[toUsed][to]) {
        dp[toUsed][to] = total
        prev[toUsed][to] = { prevIndex: from, prevUsed: fromUsed, mode }
      }
    }

    for (let i = 0; i < n; i++) {
      for (const used of [0, 1] as const) {
        if (!Number.isFinite(dp[used][i])) continue

        let count = 0
        for (let j = i; j < n && /^[0-9]$/.test(chars[j]); j++) {
          count++
          const header = modeHeaderBits(Mode.NUMERIC, count, 0)
          if (Number.isFinite(header))
            update(i, used, j + 1, used, Mode.NUMERIC, header + dataBitsFor(Mode.NUMERIC, count, 0))
        }

        count = 0
        for (let j = i; j < n && QrSegment.isAlphanumeric(chars[j]); j++) {
          count++
          const header = modeHeaderBits(Mode.ALPHANUMERIC, count, 0)
          if (Number.isFinite(header))
            update(i, used, j + 1, used, Mode.ALPHANUMERIC, header + dataBitsFor(Mode.ALPHANUMERIC, count, 0))
        }

        if (allowKanji) {
          count = 0
          for (let j = i; j < n && QrSegment.isKanji(chars[j]); j++) {
            count++
            const header = modeHeaderBits(Mode.KANJI, count, 0)
            if (Number.isFinite(header))
              update(i, used, j + 1, used, Mode.KANJI, header + dataBitsFor(Mode.KANJI, count, 0))
          }
        }

        let byteCount = 0
        for (let j = i; j < n; j++) {
          byteCount += byteParts[j].length
          const header = modeHeaderBits(Mode.BYTE, j - i + 1, byteCount)
          if (!Number.isFinite(header)) break
          const eciOverhead = used === 0 && eciAssignment !== null ? eciBits : 0
          update(i, used, j + 1, 1, Mode.BYTE, eciOverhead + header + dataBitsFor(Mode.BYTE, 0, byteCount))
        }
      }
    }

    const finalUsed: Used = dp[0][n] <= dp[1][n] ? 0 : 1
    if (!Number.isFinite(dp[finalUsed][n]))
      throw new Error("Text cannot be represented in the requested symbol version/modes")

    const runs: { start: number; end: number; mode: Mode }[] = []
    for (let index = n, used: Used = finalUsed; index > 0; ) {
      const p = prev[used][index]
      if (p === null) throw new Error("Internal error reconstructing optimized segments")
      runs.push({ start: p.prevIndex, end: index, mode: p.mode })
      index = p.prevIndex
      used = p.prevUsed
    }
    runs.reverse()

    const segments: QrSegment[] = []
    if (finalUsed === 1 && eciAssignment !== null) segments.push(QrSegment.makeEci(eciAssignment))
    for (const run of runs) {
      const part = chars.slice(run.start, run.end).join("")
      if (run.mode === Mode.NUMERIC) segments.push(QrSegment.makeNumeric(part))
      else if (run.mode === Mode.ALPHANUMERIC) segments.push(QrSegment.makeAlphanumeric(part))
      else if (run.mode === Mode.KANJI) segments.push(QrSegment.makeKanji(part))
      else segments.push(QrSegment.makeBytesFromText(part, encoding))
    }
    return segments
  }
}

export class QRCode {
  private static readonly MIN_VERSION = 1
  private static readonly MAX_VERSION = 40

  // Indexed as [ECL index][version]. Leading -1 is a placeholder for index 0.
  private static readonly ECC_CODEWORDS_PER_BLOCK: readonly number[][] = [
    [
      -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30,
      30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    ],
    [
      -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28,
      28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
    ],
    [
      -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30,
      30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    ],
    [
      -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30,
      30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    ],
  ]

  private static readonly NUM_ERROR_CORRECTION_BLOCKS: readonly number[][] = [
    [
      -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18,
      19, 19, 20, 21, 22, 24, 25,
    ],
    [
      -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31,
      33, 35, 37, 38, 40, 43, 45, 47, 49,
    ],
    [
      -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40,
      43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
    ],
    [
      -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48,
      51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
    ],
  ]

  private static readonly FORMAT_BITS_BY_ECL: Record<ErrorCorrectionLevel, number> = {
    [ErrorCorrectionLevel.M]: 0b00,
    [ErrorCorrectionLevel.L]: 0b01,
    [ErrorCorrectionLevel.H]: 0b10,
    [ErrorCorrectionLevel.Q]: 0b11,
  }

  private static readonly ECL_ORDER: readonly ErrorCorrectionLevel[] = [
    ErrorCorrectionLevel.L,
    ErrorCorrectionLevel.M,
    ErrorCorrectionLevel.Q,
    ErrorCorrectionLevel.H,
  ]

  readonly size: number
  readonly symbologyIdentifier: string
  readonly containsEci: boolean
  readonly fnc1: "none" | "first" | "second"
  private readonly modules: boolean[][]
  private readonly functionModules: boolean[][]

  private constructor(
    readonly version: number,
    readonly errorCorrectionLevel: ErrorCorrectionLevel,
    readonly mask: number,
    dataCodewords: number[],
    metadata: QrMetadata,
  ) {
    QRCode.validateVersion(version)
    QRCode.validateMask(mask)
    this.containsEci = metadata.containsEci
    this.fnc1 = metadata.fnc1
    this.symbologyIdentifier = QRCode.makeSymbologyIdentifier(metadata)
    this.size = version * 4 + 17
    this.modules = Array.from({ length: this.size }, () => Array<boolean>(this.size).fill(false))
    this.functionModules = Array.from({ length: this.size }, () => Array<boolean>(this.size).fill(false))

    this.drawFunctionPatterns()
    const allCodewords = this.addEccAndInterleave(dataCodewords)
    this.drawCodewords(allCodewords)
    this.applyMask(mask)
    this.drawFormatBits(mask)
    this.drawVersionBits()
  }

  static encodeText(
    text: string,
    ecl: ErrorCorrectionLevel = ErrorCorrectionLevel.M,
    options: EncodeOptions = {},
  ): QRCode {
    const optimize = options.optimize !== false
    if (!optimize) return QRCode.encodeSegments(QrSegment.makeSegments(text, options), ecl, options)

    const minVersion = options.minVersion ?? QRCode.MIN_VERSION
    const maxVersion = options.maxVersion ?? QRCode.MAX_VERSION
    QRCode.validateVersion(minVersion)
    QRCode.validateVersion(maxVersion)
    if (minVersion > maxVersion) throw new RangeError("minVersion cannot exceed maxVersion")

    const cache = new Map<number, QrSegment[]>()
    for (let version = minVersion; version <= maxVersion; version++) {
      const rangeKey = Math.floor((version + 7) / 17)
      let segments = cache.get(rangeKey)
      if (segments === undefined) {
        segments = QrSegment.makeOptimizedSegments(text, version, options)
        cache.set(rangeKey, segments)
      }
      const fullSegments = QRCode.applyPrefixSegments(segments, options)
      if (QRCode.getTotalBits(fullSegments, version) <= QRCode.getNumDataCodewords(version, ecl) * 8) {
        return QRCode.encodeSegments(segments, ecl, { ...options, minVersion: version, maxVersion: version })
      }
    }
    throw new Error("Data too long for requested QR Code version range and error correction level")
  }

  static encodeBytes(
    bytes: Uint8Array | number[],
    ecl: ErrorCorrectionLevel = ErrorCorrectionLevel.M,
    options: EncodeOptions = {},
  ): QRCode {
    return QRCode.encodeSegments([QrSegment.makeBytes(bytes)], ecl, options)
  }

  static encodeEciText(
    escapedText: string,
    ecl: ErrorCorrectionLevel = ErrorCorrectionLevel.M,
    options: EncodeOptions = {},
  ): QRCode {
    return QRCode.encodeSegments(QrSegment.makeEciSegmentsFromEscapedText(escapedText), ecl, options)
  }

  static encodeGs1Text(
    gs1Data: string | Gs1Element[],
    ecl: ErrorCorrectionLevel = ErrorCorrectionLevel.M,
    options: EncodeOptions = {},
  ): QRCode {
    const payload = typeof gs1Data === "string" ? gs1Data : buildGs1Payload(gs1Data)
    const segments =
      options.optimize === false
        ? QrSegment.makeSegments(payload, { ...options, eciAssignment: null, eciForUtf8: false })
        : QrSegment.makeOptimizedSegments(payload, options.minVersion ?? 1, {
            ...options,
            eciAssignment: null,
            eciForUtf8: false,
          })
    return QRCode.encodeSegments(segments, ecl, { ...options, fnc1First: true, eciAssignment: null, eciForUtf8: false })
  }

  static encodeStructuredAppend(
    parts: readonly (readonly QrSegment[])[],
    ecl: ErrorCorrectionLevel = ErrorCorrectionLevel.M,
    options: EncodeOptions = {},
  ): QRCode[] {
    if (parts.length < 2 || parts.length > 16) throw new RangeError("Structured append requires 2..16 symbols")
    const parity = QRCode.computeStructuredAppendParity(parts.flat())
    return parts.map((part, index) =>
      QRCode.encodeSegments(Array.from(part), ecl, {
        ...options,
        structuredAppend: { position: index + 1, total: parts.length, parity },
      }),
    )
  }

  static computeStructuredAppendParity(segments: readonly QrSegment[]): number {
    let result = 0
    for (const seg of segments) for (const b of seg.parityBytes) result ^= b
    return result
  }

  static encodeSegments(
    segments: QrSegment[],
    ecl: ErrorCorrectionLevel = ErrorCorrectionLevel.M,
    options: EncodeOptions = {},
  ): QRCode {
    let minVersion = options.minVersion ?? QRCode.MIN_VERSION
    let maxVersion = options.maxVersion ?? QRCode.MAX_VERSION
    const mask = options.mask ?? -1
    const boostEcl = options.boostEcl !== false

    QRCode.validateVersion(minVersion)
    QRCode.validateVersion(maxVersion)
    if (minVersion > maxVersion) throw new RangeError("minVersion cannot exceed maxVersion")
    if (mask !== -1) QRCode.validateMask(mask)
    if (!(ecl in QRCode.FORMAT_BITS_BY_ECL)) throw new Error("Invalid error correction level")

    segments = QRCode.applyPrefixSegments(segments, options)
    QRCode.validateQrSegmentOrder(segments)
    const metadata = QRCode.collectMetadata(segments)

    let version = minVersion
    let dataUsedBits = 0
    for (; ; version++) {
      const capacityBits = QRCode.getNumDataCodewords(version, ecl) * 8
      dataUsedBits = QRCode.getTotalBits(segments, version)
      if (dataUsedBits <= capacityBits) break
      if (version >= maxVersion)
        throw new Error("Data too long for requested QR Code version range and error correction level")
    }

    if (boostEcl) {
      for (const candidate of QRCode.ECL_ORDER) {
        if (
          QRCode.eclIndex(candidate) > QRCode.eclIndex(ecl) &&
          dataUsedBits <= QRCode.getNumDataCodewords(version, candidate) * 8
        ) {
          ecl = candidate
        }
      }
    }

    const capacityBits = QRCode.getNumDataCodewords(version, ecl) * 8
    const bb = new BitBuffer()
    for (const seg of segments) {
      bb.appendBits(seg.mode.modeBits, 4)
      if (seg.mode.hasCharacterCount) {
        const ccbits = seg.mode.numCharCountBits(version)
        if (seg.numChars >= 1 << ccbits) throw new Error("Segment too long for selected version")
        bb.appendBits(seg.numChars, ccbits)
      }
      bb.appendData(seg.data)
    }

    bb.appendBits(0, Math.min(4, capacityBits - bb.length))
    bb.appendBits(0, (8 - (bb.length % 8)) % 8)
    for (let padByte = 0xec; bb.length < capacityBits; padByte ^= 0xec ^ 0x11) bb.appendBits(padByte, 8)
    if (bb.length !== capacityBits) throw new Error("Internal error: data bit length mismatch")

    const dataCodewords = bb.toBytes()
    return mask === -1
      ? QRCode.makeWithBestMask(version, ecl, dataCodewords, metadata)
      : new QRCode(version, ecl, mask, dataCodewords, metadata)
  }

  getModule(x: number, y: number): boolean {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.size || y >= this.size) {
      throw new RangeError("Module coordinates out of bounds")
    }
    return this.modules[y][x]
  }

  /** Returns a deep copy of the QR module matrix. True is dark, false is light. */
  toMatrix(): boolean[][] {
    return this.modules.map((row) => row.slice())
  }

  /** Render as SVG. The border is the quiet zone in modules; ISO QR Code requires at least 4. */
  toSvgString(options: { border?: number; moduleSize?: number; lightColor?: string; darkColor?: string } = {}): string {
    const border = options.border ?? 4
    return matrixToSvg(
      this.modules,
      border,
      4,
      options.moduleSize ?? 1,
      options.lightColor ?? "#FFFFFF",
      options.darkColor ?? "#000000",
    )
  }

  /**
   * Render as terminal text. Default quiet zone is 4 modules, matching the QR Code minimum.
   * Use { ansi: true } for scanner-facing terminal output with explicit black/white backgrounds.
   */
  toTerminalString(options: number | TerminalRenderOptions = {}): string {
    const renderOptions = normalizeTerminalOptions(options, 4, 4)
    return matrixToTerminal(this.modules, renderOptions)
  }

  static validateVersionPublic(version: number): void {
    QRCode.validateVersion(version)
  }

  private static applyPrefixSegments(segments: QrSegment[], options: EncodeOptions): QrSegment[] {
    const result = segments.slice()
    const prefix: QrSegment[] = []
    if (options.structuredAppend !== undefined) {
      if (result.some((seg) => seg.mode === Mode.STRUCTURED_APPEND))
        throw new Error("Structured append header supplied both in options and segments")
      prefix.push(
        QrSegment.makeStructuredAppendHeader(
          options.structuredAppend.position,
          options.structuredAppend.total,
          options.structuredAppend.parity,
        ),
      )
    }

    let insertAt = 0
    while (insertAt < result.length && result[insertAt].mode === Mode.ECI) insertAt++

    if (options.fnc1First === true && options.fnc1Second !== undefined)
      throw new Error("Use either FNC1 first or second position, not both")
    if (options.fnc1First === true) result.splice(insertAt, 0, QrSegment.makeFnc1FirstPosition())
    if (options.fnc1Second !== undefined)
      result.splice(insertAt, 0, QrSegment.makeFnc1SecondPosition(options.fnc1Second.applicationIndicator))
    return [...prefix, ...result]
  }

  private static validateQrSegmentOrder(segments: readonly QrSegment[]): void {
    let index = 0
    if (segments[index]?.mode === Mode.STRUCTURED_APPEND) index++
    while (segments[index]?.mode === Mode.ECI) index++
    if (segments[index]?.mode === Mode.FNC1_FIRST || segments[index]?.mode === Mode.FNC1_SECOND) index++

    let seenStructuredAppend = false
    let seenFnc1 = false
    for (let i = 0; i < segments.length; i++) {
      const mode = segments[i].mode
      if (mode === Mode.STRUCTURED_APPEND) {
        if (seenStructuredAppend || i !== 0)
          throw new Error("Structured append header must appear only once at the start")
        seenStructuredAppend = true
      } else if (mode === Mode.FNC1_FIRST || mode === Mode.FNC1_SECOND) {
        if (seenFnc1 || i >= index)
          throw new Error(
            "FNC1 mode must appear only once before the first data segment, after structured append/ECI headers",
          )
        seenFnc1 = true
      }
    }
  }

  private static collectMetadata(segments: readonly QrSegment[]): QrMetadata {
    let containsEci = false
    let fnc1: "none" | "first" | "second" = "none"
    for (const seg of segments) {
      if (seg.mode === Mode.ECI) containsEci = true
      else if (seg.mode === Mode.FNC1_FIRST) fnc1 = "first"
      else if (seg.mode === Mode.FNC1_SECOND) fnc1 = "second"
    }
    return { containsEci, fnc1 }
  }

  private static makeSymbologyIdentifier(metadata: QrMetadata): string {
    if (metadata.fnc1 === "first") return metadata.containsEci ? "]Q4" : "]Q3"
    if (metadata.fnc1 === "second") return metadata.containsEci ? "]Q6" : "]Q5"
    return metadata.containsEci ? "]Q2" : "]Q1"
  }

  private static makeWithBestMask(
    version: number,
    ecl: ErrorCorrectionLevel,
    dataCodewords: number[],
    metadata: QrMetadata,
  ): QRCode {
    let bestQr: QRCode | null = null
    let bestPenalty = Infinity
    for (let mask = 0; mask < 8; mask++) {
      const qr = new QRCode(version, ecl, mask, dataCodewords, metadata)
      const penalty = qr.getPenaltyScore()
      if (penalty < bestPenalty) {
        bestPenalty = penalty
        bestQr = qr
      }
    }
    if (bestQr === null) throw new Error("Internal error: no mask selected")
    return bestQr
  }

  private drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      if (!this.functionModules[6][i]) this.setFunctionModule(i, 6, i % 2 === 0)
      if (!this.functionModules[i][6]) this.setFunctionModule(6, i, i % 2 === 0)
    }

    this.drawFinderPattern(3, 3)
    this.drawFinderPattern(this.size - 4, 3)
    this.drawFinderPattern(3, this.size - 4)

    const align = this.getAlignmentPatternPositions()
    for (const y of align) {
      for (const x of align) {
        if ((x === 6 && y === 6) || (x === 6 && y === this.size - 7) || (x === this.size - 7 && y === 6)) continue
        this.drawAlignmentPattern(x, y)
      }
    }

    this.drawFormatBits(0)
    this.drawVersionBits()
    this.setFunctionModule(8, this.size - 8, true)
  }

  private drawFinderPattern(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        this.setFunctionModule(x, y, dist !== 2 && dist !== 4)
      }
    }
  }

  private drawAlignmentPattern(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        this.setFunctionModule(cx + dx, cy + dy, dist === 2 || dist === 0)
      }
    }
  }

  private drawFormatBits(mask: number): void {
    const data = (QRCode.FORMAT_BITS_BY_ECL[this.errorCorrectionLevel] << 3) | mask
    const bits = formatBits(data, 0x5412)

    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i))
    this.setFunctionModule(8, 7, getBit(bits, 6))
    this.setFunctionModule(8, 8, getBit(bits, 7))
    this.setFunctionModule(7, 8, getBit(bits, 8))
    for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i))

    for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i))
    for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i))
    this.setFunctionModule(8, this.size - 8, true)
  }

  private drawVersionBits(): void {
    if (this.version < 7) return
    let rem = this.version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25)
    const bits = (this.version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i)
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.setFunctionModule(a, b, bit)
      this.setFunctionModule(b, a, bit)
    }
  }

  private drawCodewords(data: number[]): void {
    let bitIndex = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vert : vert
          if (this.functionModules[y][x]) continue
          const dark = bitIndex < data.length * 8 ? getBit(data[Math.floor(bitIndex / 8)], 7 - (bitIndex & 7)) : false
          this.modules[y][x] = dark
          bitIndex++
        }
      }
    }
    if (bitIndex !== QRCode.getNumRawDataModules(this.version))
      throw new Error("Internal error: codeword placement mismatch")
  }

  private applyMask(mask: number): void {
    QRCode.validateMask(mask)
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.functionModules[y][x] && QRCode.maskCondition(mask, x, y)) this.modules[y][x] = !this.modules[y][x]
      }
    }
  }

  private getPenaltyScore(): number {
    const size = this.size
    let result = 0

    for (let y = 0; y < size; y++) {
      let runColor = false
      let runLength = 0
      for (let x = 0; x < size; x++) {
        const color = this.modules[y][x]
        if (x === 0 || color !== runColor) {
          runColor = color
          runLength = 1
        } else {
          runLength++
          if (runLength === 5) result += 3
          else if (runLength > 5) result++
        }
      }
    }
    for (let x = 0; x < size; x++) {
      let runColor = false
      let runLength = 0
      for (let y = 0; y < size; y++) {
        const color = this.modules[y][x]
        if (y === 0 || color !== runColor) {
          runColor = color
          runLength = 1
        } else {
          runLength++
          if (runLength === 5) result += 3
          else if (runLength > 5) result++
        }
      }
    }

    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = this.modules[y][x]
        if (
          color === this.modules[y][x + 1] &&
          color === this.modules[y + 1][x] &&
          color === this.modules[y + 1][x + 1]
        )
          result += 3
      }
    }

    for (let y = 0; y < size; y++) {
      let bits = 0
      for (let x = 0; x < size; x++) {
        bits = ((bits << 1) & 0x7ff) | (this.modules[y][x] ? 1 : 0)
        if (x >= 10 && (bits === 0x05d || bits === 0x5d0)) result += 40
      }
    }
    for (let x = 0; x < size; x++) {
      let bits = 0
      for (let y = 0; y < size; y++) {
        bits = ((bits << 1) & 0x7ff) | (this.modules[y][x] ? 1 : 0)
        if (y >= 10 && (bits === 0x05d || bits === 0x5d0)) result += 40
      }
    }

    let dark = 0
    for (const row of this.modules) for (const module of row) if (module) dark++
    const total = size * size
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
    result += k * 10
    return result
  }

  private addEccAndInterleave(data: number[]): number[] {
    const version = this.version
    const eclIndex = QRCode.eclIndex(this.errorCorrectionLevel)
    const numBlocks = QRCode.NUM_ERROR_CORRECTION_BLOCKS[eclIndex][version]
    const blockEccLen = QRCode.ECC_CODEWORDS_PER_BLOCK[eclIndex][version]
    const rawCodewords = Math.floor(QRCode.getNumRawDataModules(version) / 8)
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
    const shortBlockDataLen = Math.floor(rawCodewords / numBlocks) - blockEccLen

    if (data.length !== QRCode.getNumDataCodewords(version, this.errorCorrectionLevel)) {
      throw new Error("Internal error: unexpected number of data codewords")
    }

    const rsDivisor = ReedSolomon.computeDivisor(blockEccLen)
    const blocks: Block[] = []
    let offset = 0
    for (let i = 0; i < numBlocks; i++) {
      const dataLen = shortBlockDataLen + (i < numShortBlocks ? 0 : 1)
      const dat = data.slice(offset, offset + dataLen)
      offset += dataLen
      blocks.push({ data: dat, ecc: ReedSolomon.computeRemainder(dat, rsDivisor) })
    }
    if (offset !== data.length) throw new Error("Internal error: data block split mismatch")

    const result: number[] = []
    const maxDataLen = Math.max(...blocks.map((b) => b.data.length))
    for (let i = 0; i < maxDataLen; i++)
      for (const block of blocks) if (i < block.data.length) result.push(block.data[i])
    for (let i = 0; i < blockEccLen; i++) for (const block of blocks) result.push(block.ecc[i])
    if (result.length !== rawCodewords) throw new Error("Internal error: interleaved codeword count mismatch")
    return result
  }

  private getAlignmentPatternPositions(): number[] {
    if (this.version === 1) return []
    const numAlign = Math.floor(this.version / 7) + 2
    const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2
    const result = [6]
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
    return result
  }

  private setFunctionModule(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark
    this.functionModules[y][x] = true
  }

  private static getTotalBits(segments: readonly QrSegment[], version: number): number {
    let result = 0
    for (const seg of segments) {
      const n = seg.getTotalBits(version)
      if (!Number.isFinite(n)) return Infinity
      result += n
    }
    return result
  }

  private static getNumDataCodewords(version: number, ecl: ErrorCorrectionLevel): number {
    QRCode.validateVersion(version)
    const eclIndex = QRCode.eclIndex(ecl)
    return (
      Math.floor(QRCode.getNumRawDataModules(version) / 8) -
      QRCode.ECC_CODEWORDS_PER_BLOCK[eclIndex][version] * QRCode.NUM_ERROR_CORRECTION_BLOCKS[eclIndex][version]
    )
  }

  private static getNumRawDataModules(version: number): number {
    QRCode.validateVersion(version)
    let result = (16 * version + 128) * version + 64
    if (version >= 2) {
      const numAlign = Math.floor(version / 7) + 2
      result -= (25 * numAlign - 10) * numAlign - 55
      if (version >= 7) result -= 36
    }
    return result
  }

  static maskCondition(mask: number, x: number, y: number): boolean {
    switch (mask) {
      case 0:
        return (x + y) % 2 === 0
      case 1:
        return y % 2 === 0
      case 2:
        return x % 3 === 0
      case 3:
        return (x + y) % 3 === 0
      case 4:
        return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
      case 5:
        return ((x * y) % 2) + ((x * y) % 3) === 0
      case 6:
        return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
      case 7:
        return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
      default:
        throw new RangeError("Mask must be in 0..7")
    }
  }

  private static eclIndex(ecl: ErrorCorrectionLevel): number {
    switch (ecl) {
      case ErrorCorrectionLevel.L:
        return 0
      case ErrorCorrectionLevel.M:
        return 1
      case ErrorCorrectionLevel.Q:
        return 2
      case ErrorCorrectionLevel.H:
        return 3
      default:
        throw new Error("Invalid error correction level")
    }
  }

  private static validateVersion(version: number): void {
    if (!Number.isInteger(version) || version < QRCode.MIN_VERSION || version > QRCode.MAX_VERSION) {
      throw new RangeError("Version must be in 1..40")
    }
  }

  private static validateMask(mask: number): void {
    if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new RangeError("Mask must be in 0..7")
  }
}

export function createQrSvg(
  text: string,
  options: EncodeOptions & { ecl?: ErrorCorrectionLevel; border?: number; moduleSize?: number } = {},
): string {
  const qr = QRCode.encodeText(text, options.ecl ?? ErrorCorrectionLevel.M, options)
  return qr.toSvgString({ border: options.border ?? 4, moduleSize: options.moduleSize ?? 8 })
}

function encodeFnc1SecondApplicationIndicator(applicationIndicator: string | number): number {
  if (typeof applicationIndicator === "number") {
    if (!Number.isInteger(applicationIndicator) || applicationIndicator < 0 || applicationIndicator > 99) {
      throw new RangeError("FNC1 second-position numeric application indicator must be 0..99")
    }
    return applicationIndicator
  }
  if (/^[0-9]{2}$/.test(applicationIndicator)) return Number(applicationIndicator)
  if (/^[A-Za-z]$/.test(applicationIndicator)) return applicationIndicator.charCodeAt(0) + 100
  throw new Error("FNC1 second-position application indicator must be two digits or one Latin alphabetic character")
}

function validateStructuredAppend(position: number, total: number, parity: number): void {
  if (!Number.isInteger(total) || total < 2 || total > 16)
    throw new RangeError("Structured append total must be in 2..16")
  if (!Number.isInteger(position) || position < 1 || position > total)
    throw new RangeError("Structured append position must be in 1..total")
  if (!Number.isInteger(parity) || parity < 0 || parity > 0xff)
    throw new RangeError("Structured append parity must be an 8-bit value")
}

function buildGs1Payload(elements: readonly Gs1Element[]): string {
  let result = ""
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]
    if (!/^[0-9A-Za-z]+$/.test(el.ai)) throw new Error("GS1 AI should contain only letters/digits without parentheses")
    const data = el.data.replace(/%/g, "%%")
    result += el.ai + data
    if (el.separatorAfter === true && i + 1 < elements.length) result += "%"
  }
  return result
}

function getBit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0
}

function formatBits(data: number, xorMask: number): number {
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537)
  return ((data << 10) | rem) ^ xorMask
}
