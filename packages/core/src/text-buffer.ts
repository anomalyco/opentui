import { readFileSync } from "node:fs"
import { StyledText } from "./lib/styled-text.js"
import { RGBA } from "./lib/RGBA.js"
import {
  NativeEditHighlightOperation,
  NativeEditorStyleMask,
  NativeError,
  NativeStatus,
  type RenderLib,
  type ContextTextBufferHandle,
  type NativeEncodedStyledText,
} from "./zig.js"
import { type WidthMethod, type Highlight } from "./types.js"
import type { SyntaxStyle } from "./syntax-style.js"
import type { NativeResourceOwner } from "./buffer.js"
import type { TextBufferView } from "./text-buffer-view.js"

export interface TextChunk {
  __isChunk: true
  text: string
  fg?: RGBA
  bg?: RGBA
  attributes?: number
  link?: { url: string }
}

export class TextBuffer {
  private lib: RenderLib
  private native: { scene: NativeResourceOwner; handle: ContextTextBufferHandle }
  private _length: number = 0
  private _byteSize: number = 0
  private _destroyed: boolean = false
  private _syntaxStyle?: SyntaxStyle

  constructor(lib: RenderLib, handle: ContextTextBufferHandle, scene: NativeResourceOwner) {
    if (!scene?.driver) throw new Error("TextBuffer requires an explicit resource owner")
    scene.assertAlive()
    if (
      scene.driver.renderLib !== lib ||
      !handle ||
      typeof handle !== "object" ||
      handle.context !== scene.driver.context
    ) {
      throw new Error("TextBuffer Context owner mismatch")
    }
    this.lib = lib
    this.native = { scene, handle }
    this.updateLengths()
  }

  static create(widthMethod: WidthMethod, owner: NativeResourceOwner): TextBuffer {
    if (!owner?.driver) throw new Error("TextBuffer requires an explicit resource owner")
    owner.assertAlive()
    const lib = owner.driver.renderLib
    const handle = lib.createContextTextBuffer(owner.driver.context, { widthMethod })
    try {
      return new TextBuffer(lib, handle, owner)
    } catch (error) {
      lib.destroyContextTextBuffer(owner.driver.context, handle)
      throw error
    }
  }

  // Fail loud and clear
  // Instead of trying to return values that could work or not,
  // this at least will show a stack trace to know where the call to a destroyed TextBuffer was made
  private guard(): void {
    if (this._destroyed) throw new Error("TextBuffer is destroyed")
    this.native.scene.assertAlive()
  }

  /** @internal Dependent views must use the buffer's library and Context. */
  public _getOwner(): { lib: RenderLib; scene: NativeResourceOwner } {
    this.guard()
    return { lib: this.lib, scene: this.native.scene }
  }

  /** @internal Requires the exact resource owner. */
  public _getSceneHandle(scene: NativeResourceOwner): ContextTextBufferHandle {
    this.guard()
    if (this.native.scene !== scene) throw new Error("TextBuffer Context owner mismatch")
    return this.native.handle
  }

  private updateLengths(): void {
    const info = this.lib.contextTextBufferGetInfo(this.native.handle.context, this.native.handle)
    this._length = info.textLength
    this._byteSize = info.byteLength
  }

  public setText(text: string): void {
    this.guard()
    // Publish accepted state before this boundary reports deferred callback errors.
    this.lib.getYogaHost().runMutation(() => {
      const textBytes = this.lib.encoder.encode(text)
      this.lib.contextTextBufferSetText(this.native.handle.context, this.native.handle, textBytes)
      this.updateLengths()
    })
  }

  public append(text: string): void {
    this.guard()
    // Publish accepted state before this boundary reports deferred callback errors.
    this.lib.getYogaHost().runMutation(() => {
      const textBytes = this.lib.encoder.encode(text)
      this.lib.contextTextBufferAppend(this.native.handle.context, this.native.handle, textBytes)
      this.updateLengths()
    })
  }

  public loadFile(path: string): void {
    this.guard()
    this.lib.getYogaHost().runMutation(() => {
      let bytes: Uint8Array
      try {
        bytes = readFileSync(path)
      } catch (cause) {
        throw new Error(`Failed to load file: ${path}`, { cause })
      }
      this.lib.contextTextBufferSetText(this.native.handle.context, this.native.handle, bytes)
      this.updateLengths()
    })
  }

  public setStyledText(text: StyledText): void {
    this.guard()

    this.lib.getYogaHost().runMutation(() => {
      const chunks = text.chunks
      if (Array.isArray(chunks) && chunks.length === 0) {
        this.lib.contextTextBufferClear(this.native.handle.context, this.native.handle)
      } else {
        const beforeNative = () => this._syntaxStyle?._getSceneHandle(this.native.scene)
        this.lib.contextTextBufferSetStyledText(
          this.native.handle.context,
          this.native.handle,
          new StyledText(chunks),
          beforeNative,
        )
      }
      this.updateLengths()
    })
  }

  /** @internal Uses an input snapshot without invoking chunk getters again. */
  public _setEncodedStyledText(text: NativeEncodedStyledText): void {
    this.guard()
    this.lib.getYogaHost().runMutation(() => {
      this.lib.contextTextBufferSetEncodedStyledText(this.native.handle.context, this.native.handle, text)
      this.updateLengths()
    })
  }

  /** @internal Returns false for oversized batches without changing any resource. */
  public static _replaceStyledTextBatch(
    replacements: { textBuffer: TextBuffer; textBufferView: TextBufferView; text: NativeEncodedStyledText }[],
    beforeNative: () => void,
  ): boolean {
    if (replacements.length === 0) {
      beforeNative()
      return true
    }
    const { lib, scene } = replacements[0].textBuffer._getOwner()
    const entries = replacements.map(({ textBuffer, textBufferView, text }) => ({
      buffer: textBuffer._getSceneHandle(scene),
      view: textBufferView._getSceneHandle(scene),
      text,
    }))
    return lib.getYogaHost().runMutation(() => {
      const info = lib.contextTextBufferReplaceStyledBatch(scene.driver.context, entries, beforeNative)
      if (info === null) return false
      for (let index = 0; index < replacements.length; index++) {
        replacements[index].textBuffer._length = info[index * 2]
        replacements[index].textBuffer._byteSize = info[index * 2 + 1]
      }
      return true
    })
  }

  /** @internal Apply a complete default style through one checked native mutation. */
  public _setDefaults(fg: RGBA | null, bg: RGBA | null, attributes: number | null): void {
    this.guard()
    return this.lib.contextTextBufferSetDefaults(
      this.native.handle.context,
      this.native.handle,
      NativeEditorStyleMask.All,
      { fg, bg, attributes },
    )
  }

  public setDefaultFg(fg: RGBA | null): void {
    this.guard()
    return this.lib.contextTextBufferSetDefaults(
      this.native.handle.context,
      this.native.handle,
      NativeEditorStyleMask.Foreground,
      { fg },
    )
  }

  public setDefaultBg(bg: RGBA | null): void {
    this.guard()
    return this.lib.contextTextBufferSetDefaults(
      this.native.handle.context,
      this.native.handle,
      NativeEditorStyleMask.Background,
      { bg },
    )
  }

  public setDefaultAttributes(attributes: number | null): void {
    this.guard()
    return this.lib.contextTextBufferSetDefaults(
      this.native.handle.context,
      this.native.handle,
      NativeEditorStyleMask.Attributes,
      { attributes },
    )
  }

  public resetDefaults(): void {
    this.guard()
    return this.lib.contextTextBufferSetDefaults(
      this.native.handle.context,
      this.native.handle,
      NativeEditorStyleMask.All,
      {},
    )
  }

  public getLineCount(): number {
    this.guard()
    return this.lib.contextTextBufferGetInfo(this.native.handle.context, this.native.handle).lineCount
  }

  public get length(): number {
    this.guard()
    return this._length
  }

  public get byteSize(): number {
    this.guard()
    return this._byteSize
  }

  public getPlainText(): string {
    this.guard()
    return this.lib.contextTextBufferGetText(this.native.handle.context, this.native.handle)
  }

  public getTextRange(startOffset: number, endOffset: number): string {
    this.guard()
    if (startOffset >= endOffset) return ""
    return this.lib.contextTextBufferGetRange(this.native.handle.context, this.native.handle, startOffset, endOffset)
  }

  /**
   * Add a highlight using character offsets into the full text.
   * start/end in highlight represent absolute character positions.
   */
  public addHighlightByCharRange(highlight: Highlight): void {
    this.guard()
    return this.lib.contextTextBufferHighlight(
      this.native.handle.context,
      this.native.handle,
      NativeEditHighlightOperation.AddRange,
      0,
      highlight,
    )
  }

  /**
   * Add a highlight to a specific line by column positions.
   * start/end in highlight represent column offsets.
   */
  public addHighlight(lineIdx: number, highlight: Highlight): void {
    this.guard()
    return this.lib.contextTextBufferHighlight(
      this.native.handle.context,
      this.native.handle,
      NativeEditHighlightOperation.AddLine,
      lineIdx,
      highlight,
    )
  }

  public removeHighlightsByRef(hlRef: number): void {
    this.guard()
    return this.lib.contextTextBufferHighlight(
      this.native.handle.context,
      this.native.handle,
      NativeEditHighlightOperation.RemoveRef,
      hlRef,
    )
  }

  public clearLineHighlights(lineIdx: number): void {
    this.guard()
    return this.lib.contextTextBufferHighlight(
      this.native.handle.context,
      this.native.handle,
      NativeEditHighlightOperation.ClearLine,
      lineIdx,
    )
  }

  public clearAllHighlights(): void {
    this.guard()
    return this.lib.contextTextBufferHighlight(
      this.native.handle.context,
      this.native.handle,
      NativeEditHighlightOperation.ClearAll,
    )
  }

  public getLineHighlights(lineIdx: number): Array<Highlight> {
    this.guard()
    return this.lib.contextTextBufferGetHighlights(this.native.handle.context, this.native.handle, lineIdx)
  }

  public getHighlightCount(): number {
    this.guard()
    return this.lib.contextTextBufferGetInfo(this.native.handle.context, this.native.handle).highlightCount
  }

  public setSyntaxStyle(style: SyntaxStyle | null): void {
    this.guard()
    this.lib.getYogaHost().runMutation(() => {
      this.lib.contextTextBufferSetSyntaxStyle(
        this.native.handle.context,
        this.native.handle,
        style?._getSceneHandle(this.native.scene) ?? null,
      )
      this._syntaxStyle = style ?? undefined
    })
  }

  public getSyntaxStyle(): SyntaxStyle | null {
    this.guard()
    return this._syntaxStyle ?? null
  }

  public setTabWidth(width: number): void {
    this.guard()
    this.lib.getYogaHost().runMutation(() => {
      this.lib.contextTextBufferSetTabWidth(this.native.handle.context, this.native.handle, width)
      this.updateLengths()
    })
  }

  public getTabWidth(): number {
    this.guard()
    return this.lib.contextTextBufferGetInfo(this.native.handle.context, this.native.handle).tabWidth
  }

  public clear(): void {
    this.guard()
    this.lib.getYogaHost().runMutation(() => {
      this.lib.contextTextBufferClear(this.native.handle.context, this.native.handle)
      this._length = 0
      this._byteSize = 0
    })
  }

  public reset(): void {
    this.guard()
    this.lib.getYogaHost().runMutation(() => {
      this.lib.contextTextBufferClear(this.native.handle.context, this.native.handle, true)
      this._length = 0
      this._byteSize = 0
    })
  }

  public destroy(): void {
    if (this._destroyed) return
    this.lib.getYogaHost().runMutation(() => {
      if (!this.native.scene.driver.contextDisposed) {
        try {
          this.lib.destroyContextTextBuffer(this.native.handle.context, this.native.handle)
        } catch (error) {
          if (!(error instanceof NativeError) || error.status !== NativeStatus.StaleHandle) throw error
        }
      }
      this._destroyed = true
      this._syntaxStyle = undefined
    })
  }
}
