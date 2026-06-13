import { SHIFT_JIS_CODE_BY_CHAR } from "./qrcode.shift-jis.js"

export type ByteEncoding = "utf-8" | "iso-8859-1" | "shift-jis"

export const EciAssignment = {
  ISO_8859_1: 3,
  SHIFT_JIS: 20,
  UTF_8: 26,
} as const

export function encodeTextBytes(text: string, encoding: ByteEncoding = "utf-8"): Uint8Array {
  switch (encoding) {
    case "utf-8":
      return new TextEncoder().encode(text)
    case "iso-8859-1":
      return new Uint8Array(encodeIso88591(text))
    case "shift-jis":
      return new Uint8Array(encodeShiftJis(text))
    default:
      throw new Error("Unsupported byte encoding")
  }
}

export function shiftJisCodeForCharacter(ch: string): number {
  const cp = ch.codePointAt(0)!
  if (cp <= 0x7f) return cp
  const code = SHIFT_JIS_CODE_BY_CHAR[ch]
  if (code === undefined) throw new Error(`Character ${JSON.stringify(ch)} is not encodable in Shift JIS`)
  return code
}

export function isKanjiModeShiftJisValue(value: number): boolean {
  return (value >= 0x8140 && value <= 0x9ffc) || (value >= 0xe040 && value <= 0xebbf)
}

export function encodingForKnownEci(eci: number): ByteEncoding | null {
  if (eci === EciAssignment.ISO_8859_1) return "iso-8859-1"
  if (eci === EciAssignment.SHIFT_JIS) return "shift-jis"
  if (eci === EciAssignment.UTF_8) return "utf-8"
  return null
}

export function validateBytes(bytes: number[]): number[] {
  for (const b of bytes) if (!Number.isInteger(b) || b < 0 || b > 0xff) throw new RangeError("Byte value out of range")
  return bytes
}

export function asciiBytes(text: string): number[] {
  const result: number[] = []
  for (let i = 0; i < text.length; i++) result.push(text.charCodeAt(i))
  return result
}

function encodeIso88591(text: string): number[] {
  const result: number[] = []
  for (const ch of Array.from(text)) {
    const cp = ch.codePointAt(0)!
    if (cp > 0xff) throw new Error(`Character ${JSON.stringify(ch)} is not encodable in ISO-8859-1`)
    result.push(cp)
  }
  return result
}

function encodeShiftJis(text: string): number[] {
  const result: number[] = []
  for (const ch of Array.from(text)) {
    const code = shiftJisCodeForCharacter(ch)
    if (code <= 0xff) result.push(code)
    else result.push(code >>> 8, code & 0xff)
  }
  return result
}
