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
  type NativeEditorStyle,
  type NativeEncodedStyledText,
} from "./zig.js"
import { type WidthMethod, type Highlight } from "./types.js"
import type { SyntaxStyle } from "./syntax-style.js"
import type { NativeResourceOwner, ResourceContext } from "./buffer.js"
import type { TextBufferView } from "./text-buffer-view.js"
import { fragmentKeysFor } from "./lib/fragment-keys.js"

export interface TextChunk {
  __isChunk: true
  text: string
  fg?: RGBA
  bg?: RGBA
  attributes?: number
  link?: { url: string }
  /**
   * Opaque application data for hit lookups (`renderer.getTextMetadataAt`). Core never reads it.
   * Lookups return this same value by identity, not a copy. It is not sent to native code: native
   * cells carry a numeric key that maps back to it.
   */
  metadata?: unknown
}

/** A text fragment found at a screen cell. `metadata` is the chunk's value, by identity. */
export type StyledTextHit = Readonly<{ metadata: unknown }>

export class TextBuffer {
  private lib: RenderLib
  private native: { owner: ResourceContext; handle: ContextTextBufferHandle }
  /** Fragment keys held by the installed content; released when the content is replaced. */
  private _fragmentKeys: Uint32Array | null = null
  private _length: number = 0
  private _byteSize: number = 0
  private _destroyed: boolean = false
  private _syntaxStyle?: SyntaxStyle

  constructor(lib: RenderLib, handle: ContextTextBufferHandle, source: NativeResourceOwner) {
    const owner = source?.resourceContext
    if (!owner) throw new Error("TextBuffer requires an explicit resource owner")
    owner.assertAlive()
    if (owner.renderLib !== lib || !handle || typeof handle !== "object" || handle.context !== owner.context) {
      throw new Error("TextBuffer Context owner mismatch")
    }
    this.lib = lib
    this.native = { owner, handle }
    this.updateLengths()
  }

  static create(widthMethod: WidthMethod, source: NativeResourceOwner): TextBuffer {
    const owner = source?.resourceContext
    if (!owner)
      throw new Error(
        "TextBuffer requires an explicit resource owner: pass renderer.nativeScene, or a ResourceContext when there is no renderer",
      )
    owner.assertAlive()
    const lib = owner.renderLib
    const handle = lib.createContextTextBuffer(owner.context, { widthMethod })
    try {
      return new TextBuffer(lib, handle, owner)
    } catch (error) {
      lib.destroyContextTextBuffer(owner.context, handle)
      throw error
    }
  }

  // Fail loud and clear
  // Instead of trying to return values that could work or not,
  // this at least will show a stack trace to know where the call to a destroyed TextBuffer was made
  private guard(): void {
    if (this._destroyed) throw new Error("TextBuffer is destroyed")
    this.native.owner.assertAlive()
  }

  /** @internal Dependent views must use the buffer's library and Context. */
  public _getOwner(): ResourceContext {
    this.guard()
    return this.native.owner
  }

  /** @internal Resources can be shared by scenes in the same Context. */
  public _getSceneHandle(scene: NativeResourceOwner): ContextTextBufferHandle {
    this.guard()
    if (this.native.owner !== scene.resourceContext) throw new Error("TextBuffer Context owner mismatch")
    return this.native.handle
  }

  private updateLengths(): void {
    const info = this.lib.contextTextBufferGetInfo(this.native.handle.context, this.native.handle)
    this._length = info.textLength
    this._byteSize = info.byteLength
  }

  /** @internal The fragment key registry shared by everything in this buffer's native Context. */
  public _fragmentKeyRegistry() {
    return fragmentKeysFor(this.native.handle.context)
  }

  /** @internal Retains fragment keys in this buffer's scope, so a presented key identifies this buffer. */
  public _fragmentKeySink() {
    return this._fragmentKeyRegistry().forScope(this)
  }

  /** @internal Whether this buffer's installed content holds fragment `key`. */
  public _holdsFragmentKey(key: number): boolean {
    return key !== 0 && (this._fragmentKeys?.includes(key) ?? false)
  }

  /** Replaces the keys held by installed content. Call only after native accepted the content. */
  private adoptFragmentKeys(keys: Uint32Array | null): void {
    const previous = this._fragmentKeys
    this._fragmentKeys = keys && keys.some((key) => key !== 0) ? keys : null
    if (previous) this._fragmentKeyRegistry().releaseAll(previous)
  }

  public setText(text: string): void {
    this.guard()
    // Publish accepted state before this boundary reports deferred callback errors.
    this.lib.getYogaHost().runMutation(() => {
      const textBytes = this.lib.encoder.encode(text)
      this.lib.contextTextBufferSetText(this.native.handle.context, this.native.handle, textBytes)
      this.adoptFragmentKeys(null)
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
      this.adoptFragmentKeys(null)
      this.updateLengths()
    })
  }

  public setStyledText(text: StyledText): void {
    this.guard()

    this.lib.getYogaHost().runMutation(() => {
      const chunks = text.chunks
      if (Array.isArray(chunks) && chunks.length === 0) {
        this.lib.contextTextBufferClear(this.native.handle.context, this.native.handle)
        this.adoptFragmentKeys(null)
      } else {
        // One snapshot pass produces the native records and the retained keys.
        const encoded = this.lib.encodeTextBufferStyledText(new StyledText(chunks), this._fragmentKeySink())
        this.installEncoded(encoded)
      }
      this.updateLengths()
    })
  }

  /** @internal Uses an input snapshot without invoking chunk getters again. Adopts its keys. */
  public _setEncodedStyledText(text: NativeEncodedStyledText): void {
    this.guard()
    this.lib.getYogaHost().runMutation(() => {
      this.installEncoded(text)
      this.updateLengths()
    })
  }

  /** Installs encoded text; adopts its keys on success and releases them if native rejects it. */
  private installEncoded(text: NativeEncodedStyledText): void {
    try {
      this.lib.contextTextBufferSetEncodedStyledText(this.native.handle.context, this.native.handle, text)
    } catch (error) {
      this._fragmentKeyRegistry().releaseAll(text.keys)
      throw error
    }
    this.adoptFragmentKeys(text.keys)
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
    const owner = replacements[0].textBuffer._getOwner()
    const lib = owner.renderLib
    const entries = replacements.map(({ textBuffer, textBufferView, text }) => ({
      buffer: textBuffer._getSceneHandle(owner),
      view: textBufferView._getSceneHandle(owner),
      text,
    }))
    return lib.getYogaHost().runMutation(() => {
      let info: Uint32Array | null
      try {
        info = lib.contextTextBufferReplaceStyledBatch(owner.context, entries, beforeNative)
      } catch (error) {
        // A rejected batch publishes nothing, so no cell keeps any of its keys.
        for (const { textBuffer, text } of replacements) textBuffer._fragmentKeyRegistry().releaseAll(text.keys)
        throw error
      }
      // An oversized batch returns null without changing any resource. The caller still owns
      // the encodings and either reinstalls them one by one or drops them.
      if (info === null) return false
      for (let index = 0; index < replacements.length; index++) {
        replacements[index].textBuffer._length = info[index * 2]
        replacements[index].textBuffer._byteSize = info[index * 2 + 1]
        replacements[index].textBuffer.adoptFragmentKeys(replacements[index].text.keys)
      }
      return true
    })
  }

  private setDefaults(mask: NativeEditorStyleMask, style: NativeEditorStyle): void {
    this.guard()
    this.lib.contextTextBufferSetDefaults(this.native.handle.context, this.native.handle, mask, style)
  }

  /** @internal Apply a complete default style through one checked native mutation. */
  public _setDefaults(fg: RGBA | null, bg: RGBA | null, attributes: number | null): void {
    this.setDefaults(NativeEditorStyleMask.All, { fg, bg, attributes })
  }

  public setDefaultFg(fg: RGBA | null): void {
    this.setDefaults(NativeEditorStyleMask.Foreground, { fg })
  }

  public setDefaultBg(bg: RGBA | null): void {
    this.setDefaults(NativeEditorStyleMask.Background, { bg })
  }

  public setDefaultAttributes(attributes: number | null): void {
    this.setDefaults(NativeEditorStyleMask.Attributes, { attributes })
  }

  public resetDefaults(): void {
    this.setDefaults(NativeEditorStyleMask.All, {})
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

  private highlight(operation: NativeEditHighlightOperation, argument?: number, highlight?: Highlight): void {
    this.guard()
    this.lib.contextTextBufferHighlight(this.native.handle.context, this.native.handle, operation, argument, highlight)
  }

  /**
   * Add a highlight using character offsets into the full text.
   * start/end in highlight represent absolute character positions.
   */
  public addHighlightByCharRange(highlight: Highlight): void {
    this.highlight(NativeEditHighlightOperation.AddRange, 0, highlight)
  }

  /**
   * Add a highlight to a specific line by column positions.
   * start/end in highlight represent column offsets.
   */
  public addHighlight(lineIdx: number, highlight: Highlight): void {
    this.highlight(NativeEditHighlightOperation.AddLine, lineIdx, highlight)
  }

  public removeHighlightsByRef(hlRef: number): void {
    this.highlight(NativeEditHighlightOperation.RemoveRef, hlRef)
  }

  public clearLineHighlights(lineIdx: number): void {
    this.highlight(NativeEditHighlightOperation.ClearLine, lineIdx)
  }

  public clearAllHighlights(): void {
    this.highlight(NativeEditHighlightOperation.ClearAll)
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
        style?._getSceneHandle(this.native.owner) ?? null,
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
      this.adoptFragmentKeys(null)
      this._length = 0
      this._byteSize = 0
    })
  }

  public reset(): void {
    this.guard()
    this.lib.getYogaHost().runMutation(() => {
      this.lib.contextTextBufferClear(this.native.handle.context, this.native.handle, true)
      this.adoptFragmentKeys(null)
      this._length = 0
      this._byteSize = 0
    })
  }

  public destroy(): void {
    if (this._destroyed) return
    this.lib.getYogaHost().runMutation(() => {
      if (!this.native.owner.disposed) {
        try {
          this.lib.releaseAfterPaint(this.native.handle.context, () =>
            this.lib.destroyContextTextBuffer(this.native.handle.context, this.native.handle),
          )
        } catch (error) {
          if (!(error instanceof NativeError) || error.status !== NativeStatus.StaleHandle) throw error
        }
      }
      this._destroyed = true
      this._syntaxStyle = undefined
      this.adoptFragmentKeys(null)
    })
  }
}
