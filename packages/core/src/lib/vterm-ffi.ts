import { StyledText } from "./styled-text"
import { RGBA } from "./RGBA"
import type { TextChunk } from "../text-buffer"
import { TextAttributes } from "../types"

const DEFAULT_FG = RGBA.fromHex("#d4d4d4")

export const VTermStyleFlags = {
  BOLD: 1,
  ITALIC: 2,
  UNDERLINE: 4,
  STRIKETHROUGH: 8,
  INVERSE: 16,
  FAINT: 32,
} as const

export interface VTermSpan {
  text: string
  fg: string | null
  bg: string | null
  flags: number
  width: number
}

export interface VTermLine {
  spans: VTermSpan[]
}

export interface VTermData {
  cols: number
  rows: number
  cursor: [number, number]
  offset: number
  totalLines: number
  lines: VTermLine[]
}

function convertSpanToChunk(span: VTermSpan): TextChunk {
  const { text, fg, bg, flags } = span

  let fgColor = fg ? RGBA.fromHex(fg) : DEFAULT_FG
  let bgColor = bg ? RGBA.fromHex(bg) : undefined

  if (flags & VTermStyleFlags.INVERSE) {
    const temp = fgColor
    fgColor = bgColor || DEFAULT_FG
    bgColor = temp
  }

  let attributes = 0
  if (flags & VTermStyleFlags.BOLD) attributes |= TextAttributes.BOLD
  if (flags & VTermStyleFlags.ITALIC) attributes |= TextAttributes.ITALIC
  if (flags & VTermStyleFlags.UNDERLINE) attributes |= TextAttributes.UNDERLINE
  if (flags & VTermStyleFlags.STRIKETHROUGH) attributes |= TextAttributes.STRIKETHROUGH
  if (flags & VTermStyleFlags.FAINT) attributes |= TextAttributes.DIM

  return { __isChunk: true, text, fg: fgColor, bg: bgColor, attributes }
}

export function vtermDataToStyledText(data: VTermData): StyledText {
  const chunks: TextChunk[] = []

  for (let i = 0; i < data.lines.length; i++) {
    const line = data.lines[i]

    if (line.spans.length === 0) {
      chunks.push({ __isChunk: true, text: " ", attributes: 0 })
    } else {
      for (const span of line.spans) {
        chunks.push(convertSpanToChunk(span))
      }
    }

    if (i < data.lines.length - 1) {
      chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    }
  }

  return new StyledText(chunks)
}
