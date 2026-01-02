import { TextBufferRenderable, type TextBufferOptions } from "./TextBufferRenderable"
import { RGBA } from "../lib/RGBA"
import type { RenderContext } from "../types"
import type { OptimizedBuffer } from "../buffer"
import { resolveRenderLib, type RenderLib } from "../zig"
import { vtermDataToStyledText, type VTermData } from "../lib/vterm-ffi"
import type { MouseEvent } from "../renderer"

// Re-export types from vterm-ffi for backwards compatibility
export {
  VTermStyleFlags,
  type VTermSpan,
  type VTermLine,
  type VTermData,
  vtermDataToStyledText,
} from "../lib/vterm-ffi"

const DEFAULT_FG = RGBA.fromHex("#d4d4d4")

function trimEmptyLines(data: VTermData): void {
  while (data.lines.length > 0) {
    const lastLine = data.lines[data.lines.length - 1]
    const hasText = lastLine.spans.some((span) => span.text.trim().length > 0)
    if (hasText) break
    data.lines.pop()
  }
}

export interface StatelessTerminalOptions extends TextBufferOptions {
  ansi?: string | Buffer
  cols?: number
  rows?: number
  limit?: number
  trimEnd?: boolean
}

export class StatelessTerminalRenderable extends TextBufferRenderable {
  private _ansi: string | Buffer
  private _cols: number
  private _rows: number
  private _limit?: number
  private _trimEnd?: boolean
  private _needsUpdate: boolean = true
  private _lineCount: number = 0
  private _lib: RenderLib

  constructor(ctx: RenderContext, options: StatelessTerminalOptions) {
    super(ctx, { ...options, fg: DEFAULT_FG, wrapMode: "none" })
    this._ansi = options.ansi ?? ""
    this._cols = options.cols ?? 120
    this._rows = options.rows ?? 40
    this._limit = options.limit
    this._trimEnd = options.trimEnd
    this._lib = resolveRenderLib()
  }

  get lineCount(): number {
    return this._lineCount
  }

  get ansi(): string | Buffer {
    return this._ansi
  }

  set ansi(value: string | Buffer) {
    if (this._ansi !== value) {
      this._ansi = value
      this._needsUpdate = true
      this.requestRender()
    }
  }

  get cols(): number {
    return this._cols
  }

  set cols(value: number) {
    if (this._cols !== value) {
      this._cols = value
      this._needsUpdate = true
      this.requestRender()
    }
  }

  get rows(): number {
    return this._rows
  }

  set rows(value: number) {
    if (this._rows !== value) {
      this._rows = value
      this._needsUpdate = true
      this.requestRender()
    }
  }

  get limit(): number | undefined {
    return this._limit
  }

  set limit(value: number | undefined) {
    if (this._limit !== value) {
      this._limit = value
      this._needsUpdate = true
      this.requestRender()
    }
  }

  get trimEnd(): boolean | undefined {
    return this._trimEnd
  }

  set trimEnd(value: boolean | undefined) {
    if (this._trimEnd !== value) {
      this._trimEnd = value
      this._needsUpdate = true
      this.requestRender()
    }
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (this._needsUpdate) {
      const data = this._lib.vtermPtyToJson(this._ansi, {
        cols: this._cols,
        rows: this._rows,
        limit: this._limit,
      }) as VTermData

      if (this._trimEnd) trimEmptyLines(data)

      this.textBuffer.setStyledText(vtermDataToStyledText(data))
      this.updateTextInfo()
      this._lineCount = this.textBufferView.logicalLineInfo.lineStarts.length
      this._needsUpdate = false
    }
    super.renderSelf(buffer)
  }

  getScrollPositionForLine(lineNumber: number): number {
    const clampedLine = Math.max(0, Math.min(lineNumber, this._lineCount - 1))
    const lineStarts = this.textBufferView.logicalLineInfo.lineStarts
    const lineYOffset = lineStarts?.[clampedLine] ?? clampedLine
    return this.y + lineYOffset
  }
}

export interface TerminalOptions extends TextBufferOptions {
  cols?: number
  rows?: number
  trimEnd?: boolean
  readable?: ReadableStream<string>
  writable?: WritableStream<string>
}

let nextTerminalId = 1

export class TerminalRenderable extends TextBufferRenderable {
  private _cols: number
  private _rows: number
  private _trimEnd?: boolean
  private _contentDirty: boolean = true
  private _lineCount: number = 0
  private _terminalId: number
  private _lib: RenderLib
  private _destroyed = false
  private _readable?: ReadableStream<string>
  private _writable?: WritableStream<string>
  private _reader?: ReadableStreamDefaultReader<string>
  private _writer?: WritableStreamDefaultWriter<string>

  constructor(ctx: RenderContext, options: TerminalOptions) {
    super(ctx, { ...options, fg: DEFAULT_FG, wrapMode: "none" })

    this._cols = options.cols ?? 120
    this._rows = options.rows ?? 40
    this._trimEnd = options.trimEnd
    this._lib = resolveRenderLib()
    this._terminalId = nextTerminalId++

    const success = this._lib.vtermCreateTerminal(this._terminalId, this._cols, this._rows)
    if (!success) {
      throw new Error("Failed to create terminal")
    }

    if (options.readable) {
      this._readable = options.readable
      this._reader = options.readable.getReader()
      this.startReading()
    }

    if (options.writable) {
      this._writable = options.writable
      this._writer = options.writable.getWriter()
    }
  }

  private async startReading(): Promise<void> {
    if (!this._reader) return

    try {
      while (!this._destroyed) {
        const { done, value } = await this._reader.read()
        if (done || this._destroyed) break
        if (value) {
          this._lib.vtermFeedTerminal(this._terminalId, value)
          this._contentDirty = true
          this.requestRender()
        }
      }
    } catch {
      // Stream closed or errored
    }
  }

  get lineCount(): number {
    return this._lineCount
  }

  get cols(): number {
    return this._cols
  }

  set cols(value: number) {
    if (this._cols !== value) {
      this._cols = value
      this._lib.vtermResizeTerminal(this._terminalId, value, this._rows)
      this._contentDirty = true
      this.requestRender()
    }
  }

  get rows(): number {
    return this._rows
  }

  set rows(value: number) {
    if (this._rows !== value) {
      this._rows = value
      this._lib.vtermResizeTerminal(this._terminalId, this._cols, value)
      this._contentDirty = true
      this.requestRender()
    }
  }

  get trimEnd(): boolean | undefined {
    return this._trimEnd
  }

  set trimEnd(value: boolean | undefined) {
    if (this._trimEnd !== value) {
      this._trimEnd = value
      this._contentDirty = true
      this.requestRender()
    }
  }

  get readable(): ReadableStream<string> | undefined {
    return this._readable
  }

  set readable(value: ReadableStream<string> | undefined) {
    if (value === this._readable) return
    if (this._readable && value) {
      throw new Error("TerminalRenderable: changing readable stream is not supported")
    }
    this._readable = value
    if (value) {
      this._reader = value.getReader()
      this.startReading()
    }
  }

  get writable(): WritableStream<string> | undefined {
    return this._writable
  }

  set writable(value: WritableStream<string> | undefined) {
    if (value === this._writable) return
    if (this._writable && value) {
      throw new Error("TerminalRenderable: changing writable stream is not supported")
    }
    this._writable = value
    if (value) {
      this._writer = value.getWriter()
    }
  }

  feed(data: string | Buffer): void {
    this._lib.vtermFeedTerminal(this._terminalId, data)
    this._contentDirty = true
    this.requestRender()
  }

  reset(): void {
    this._lib.vtermResetTerminal(this._terminalId)
    this._contentDirty = true
    this.requestRender()
  }

  getCursor(): [number, number] {
    return this._lib.vtermGetTerminalCursor(this._terminalId)
  }

  getText(): string {
    return this._lib.vtermGetTerminalText(this._terminalId)
  }

  isReady(): boolean {
    return this._lib.vtermIsTerminalReady(this._terminalId)
  }

  protected override onMouseEvent(event: MouseEvent): void {
    super.onMouseEvent(event)
    if (!this._writer) return

    const { x, y, type, button, modifiers, scroll } = event

    // Check bounds
    if (x < this.x || x >= this.x + this.width || y < this.y || y >= this.y + this.height) return

    // Transform to 1-based terminal coordinates
    const col = x - this.x + 1
    const row = y - this.y + 1

    let encoded: string | null = null

    if (scroll) {
      // Scroll: button 64=up, 65=down, 66=left, 67=right
      const buttonMap = { up: 64, down: 65, left: 66, right: 67 }
      const scrollBtn = buttonMap[scroll.direction]
      encoded = this.encodeMouse("press", scrollBtn, col, row, modifiers)
    } else {
      // Mouse events
      let encodeType: "press" | "release" | "move" | null = null
      if (type === "down") encodeType = "press"
      else if (type === "up") encodeType = "release"
      else if (type === "move" || type === "drag") encodeType = "move"

      if (encodeType) {
        encoded = this.encodeMouse(encodeType, button, col, row, modifiers)
      }
    }

    if (encoded) {
      this._writer.write(encoded)
    }
  }

  private encodeMouse(
    type: "press" | "release" | "move",
    button: number,
    col: number,
    row: number,
    modifiers?: { shift: boolean; alt: boolean; ctrl: boolean },
  ): string {
    let btn = button
    if (modifiers?.shift) btn |= 4
    if (modifiers?.alt) btn |= 8
    if (modifiers?.ctrl) btn |= 16
    if (type === "move") btn |= 32
    const suffix = type === "release" ? "m" : "M"
    return `\x1b[<${btn};${col};${row}${suffix}`
  }

  destroy(): void {
    if (!this._destroyed) {
      this._destroyed = true
      this._reader?.cancel()
      this._writer?.close()
      this._lib.vtermDestroyTerminal(this._terminalId)
    }
    super.destroy()
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (this._contentDirty && !this._destroyed) {
      const data = this._lib.vtermGetTerminalJson(this._terminalId, {}) as VTermData

      if (this._trimEnd) trimEmptyLines(data)

      this.textBuffer.setStyledText(vtermDataToStyledText(data))
      this.updateTextInfo()
      this._lineCount = this.textBufferView.logicalLineInfo.lineStarts.length
      this._contentDirty = false
    }
    super.renderSelf(buffer)
  }
}
