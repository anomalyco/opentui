import { type LineInfo, type RenderContext } from "../types.js"
import { StyledText } from "../lib/styled-text.js"
import { SyntaxStyle } from "../syntax-style.js"
import { getTreeSitterClient, TreeSitterClient } from "../lib/tree-sitter/index.js"
import { TextBufferRenderable, type TextBufferOptions } from "./TextBufferRenderable.js"
import { ScrollBoxRenderable } from "./ScrollBox.js"
import type { NativeRenderableIntegration, Renderable } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import type { SimpleHighlight } from "../lib/tree-sitter/types.js"
import type { TextChunk } from "../text-buffer.js"
import { treeSitterToTextChunks } from "../lib/tree-sitter-styled-text.js"

export interface HighlightContext {
  content: string
  filetype: string
  syntaxStyle: SyntaxStyle
}

export type OnHighlightCallback = (
  highlights: SimpleHighlight[],
  context: HighlightContext,
) => SimpleHighlight[] | undefined | Promise<SimpleHighlight[] | undefined>

export interface ChunkRenderContext extends HighlightContext {
  highlights: SimpleHighlight[]
  sourceRanges?: Array<{ start: number; end: number }>
}

export type OnChunksCallback = (
  chunks: TextChunk[],
  context: ChunkRenderContext,
) => TextChunk[] | undefined | Promise<TextChunk[] | undefined>

export interface CodeOptions extends TextBufferOptions {
  content?: string
  filetype?: string
  syntaxStyle: SyntaxStyle
  treeSitterClient?: TreeSitterClient
  conceal?: boolean
  drawUnstyledText?: boolean
  streaming?: boolean
  initialStyledText?: StyledText
  baseHighlight?: string
  onHighlight?: OnHighlightCallback
  onChunks?: OnChunksCallback
}

type ConcealLineRange = [start: number, end: number]

const PREVIEW = -2
// The layer a streamed fence's syntax goes in, as in Rust's editor.
const SYNTAX_LAYER = 1

export class CodeRenderable extends TextBufferRenderable {
  static override readonly nativeIntegration: NativeRenderableIntegration = {
    ...TextBufferRenderable.nativeIntegration,
    kind: "text_view",
    body: { native: this.prototype.renderSelf },
    lifecycle: {
      ...TextBufferRenderable.nativeIntegration.lifecycle,
      update: {
        idle: this.prototype.onUpdate,
        active: (renderable) => (renderable as CodeRenderable)._highlightsDirty,
      },
    },
  }

  private _content: string
  private _filetype?: string
  private _syntaxStyle: SyntaxStyle
  private _isHighlighting: boolean = false
  private _treeSitterClient: TreeSitterClient
  private _highlightsDirty: boolean = false
  // Every input change makes a new version. The buffer holds the highlight of `_shownVersion`, raw text at -1, or a
  // preview, or what a failure kept, at PREVIEW.
  private _version: number = 0
  private _shownVersion: number = -1
  private _highlightLoopActive: boolean = false
  private _highlightPromise?: Promise<void>
  private _highlightRerun: boolean = false
  private _conceal: boolean
  private _drawUnstyledText: boolean
  private _shouldRenderTextBuffer: boolean = true
  private _streaming: boolean
  private _initialStyledText?: StyledText
  private _checkPainted = false
  private _baseHighlight?: string
  private _onHighlight?: OnHighlightCallback
  private _onChunks?: OnChunksCallback
  private _highlightingPromise: Promise<void> = Promise.resolve()
  // Temporary rendered-line -> source-line map for concealment; native extmarks should replace this.
  private _renderedLineSources?: number[]
  private _mappedLineInfo?: LineInfo
  // While set, the buffer holds `_content` and grows only by appends; the worker's copy `id` holds its first `sent`
  // units, and each reply writes the syntax layer for the prefix it covers (record 312).
  private _deltas?: { client: TreeSitterClient; id: number; filetype: string; sent: number }
  private _groupSets = new Map<string, number>()
  private static nextCopy = 0
  private _streamsDeltas = false

  protected _contentDefaultOptions = {
    content: "",
    conceal: true,
    drawUnstyledText: true,
    streaming: false,
  } satisfies Partial<CodeOptions>

  constructor(ctx: RenderContext, options: CodeOptions) {
    super(ctx, options, true)

    try {
      this._content = options.content ?? this._contentDefaultOptions.content
      this._filetype = options.filetype
      this._syntaxStyle = options.syntaxStyle
      this._treeSitterClient = options.treeSitterClient ?? getTreeSitterClient()
      this._conceal = options.conceal ?? this._contentDefaultOptions.conceal
      this._drawUnstyledText = options.drawUnstyledText ?? this._contentDefaultOptions.drawUnstyledText
      this._streaming = options.streaming ?? this._contentDefaultOptions.streaming
      this._initialStyledText = options.initialStyledText
      this._baseHighlight = options.baseHighlight
      this._onHighlight = options.onHighlight
      this._onChunks = options.onChunks

      if (this._content.length > 0) {
        if (this._initialStyledText && this._drawUnstyledText) {
          this.textBuffer.setStyledText(this._initialStyledText)
        } else {
          this.textBuffer.setText(this._content)
        }
        this.updateTextInfo()
        this.setShouldRenderTextBuffer(this._drawUnstyledText || !this._filetype)
      }

      this.setHighlightsDirty(this._content.length > 0)
      this.onLifecyclePass = this.checkPainted
    } catch (error) {
      this.rollbackConstruction(error)
    }
  }

  get content(): string {
    return this._content
  }

  // `streaming` and `drawUnstyledText` change what shows while a highlight runs, not the highlight.
  private invalidateHighlights(renders = true): void {
    this.setHighlightsDirty(true)
    if (renders) this._version++
    if (this.isDestroyed) return
    // A change made after the frame's update hooks still paints in that frame.
    if (!this._drawUnstyledText && this._filetype) this.paintHighlightsOnly()
    if (this._shownVersion < 0 || this._shownVersion === this._version) return
    // An older highlight stays only through frames that paint the block, whose update hook replaces it. Decided against
    // the last painted frame, not the layout in progress, so the order of changes within a turn does not matter: a block
    // that frame did not paint shows its current text now, which layout measures; one it painted is checked again before
    // each later frame's layout (its lifecycle pass, which a custom onLifecyclePass replaces).
    if (this.onLifecyclePass === this.checkPainted && this._ctx.nativeScene.painted(this)) {
      this._checkPainted = true
      this._ctx.nativeScene.lifecyclePasses.refresh(this)
    } else this.showPlainText()
  }

  private showPlainText(): void {
    this.setShouldRenderTextBuffer(false)
    this.textBuffer.setText(this._content)
    this._shownVersion = -1
    this.setRenderedLineSources(undefined)
    this.updateTextInfo()
  }

  // Before a frame's layout: a block that the last frame painted keeps its older highlight until its update hook's
  // highlight lands; one it culled shows its current text, which this frame measures (one frame late). It is the block's
  // lifecycle pass.
  private readonly checkPainted = (): void => {
    const stale = !this.isDestroyed && this._shownVersion >= 0 && this._shownVersion !== this._version
    if (stale && this._ctx.nativeScene.painted(this)) return
    this._checkPainted = false
    this._ctx.nativeScene.lifecyclePasses.refresh(this)
    if (!stale) return
    this.showPlainText()
    // Culled below the view before its update hook ran: a callback that scrolls it back in a later frame finds the
    // highlight sooner. Above the view its new height would move the rows in view; a request in flight would make the
    // next one wait for it.
    if (this._highlightsDirty && !this._highlightLoopActive && this.belowView()) this.scheduleHighlights()
  }

  // Below the view of a shown ScrollBox; no highlight starts while the block or an ancestor is hidden.
  private belowView(): boolean {
    let box: ScrollBoxRenderable | undefined
    for (let node: Renderable | null = this; node; node = node.parent) {
      if (!node.visible) return false
      if (!box && node instanceof ScrollBoxRenderable) box = node
    }
    return !!box && this.y >= box.viewport.y
  }

  override _needsLifecyclePass(): boolean {
    if (this.onLifecyclePass !== this.checkPainted) return super._needsLifecyclePass()
    return this._checkPainted
  }

  // A style input changed. A block that shows its current highlight keeps what it paints and its height, as the current
  // version, and asks the worker; the new highlight replaces it. Otherwise it highlights again.
  private changeStyle(): void {
    if (this._shownVersion < 0 || this._shownVersion !== this._version || this.isDestroyed)
      return this.invalidateHighlights()
    this._shownVersion = ++this._version
    this.setHighlightsDirty(true)
  }

  private setHighlightsDirty(value: boolean): void {
    if (this._highlightsDirty === value) return
    this._highlightsDirty = value
    if (!this.isDestroyed) this.refreshNativeSceneHooks()
  }

  private setShouldRenderTextBuffer(value: boolean): void {
    if (this._shouldRenderTextBuffer === value) return
    this._shouldRenderTextBuffer = value
    if (!this.isDestroyed) this._ctx.nativeScene.setTextViewPaint(this, value)
  }

  set content(value: string) {
    if (this._content === value) return
    this.runMutation(() => this.writeContent(value))
  }

  private writeContent(value: string): void {
    const delta = this._deltas && value.startsWith(this._content) ? value.slice(this._content.length) : undefined
    this._content = value
    if (delta !== undefined) {
      this.textBuffer.append(delta)
      this._version++
      this.setHighlightsDirty(true)
      this.updateTextInfo()
      this.requestRender()
      return
    }
    this.stopDeltas()
    // Streaming keeps a painted highlight until the next one lands.
    if (this._streaming && this._shouldRenderTextBuffer && this._shownVersion >= 0 && !this._drawUnstyledText) {
      this.invalidateHighlights()
      this.requestRender()
      return
    }
    if (value && this._initialStyledText && this._drawUnstyledText) {
      this.textBuffer.setStyledText(this._initialStyledText)
      this._shownVersion = PREVIEW
    } else {
      this.textBuffer.setText(value)
      this._shownVersion = -1
      if (this._streamsDeltas && this.deltasAllowed()) {
        const id = CodeRenderable.nextCopy++
        this._deltas = { client: this._treeSitterClient, id, filetype: this._filetype!, sent: 0 }
      }
    }
    this.invalidateHighlights()
    this.setRenderedLineSources(undefined)
    this.updateTextInfo()
  }

  // Only a streamed Markdown fence on the default path: no hook, no conceal, no preview. Markdown ends a fence's lines
  // with "\n" alone, so its UTF-8 offsets are native's.
  private deltasAllowed(): boolean {
    return (
      this._streaming &&
      !!this._filetype &&
      !this._conceal &&
      !this._onHighlight &&
      !this._onChunks &&
      !this._baseHighlight &&
      !this._initialStyledText
    )
  }

  /**
   * @internal Markdown marks a fence while its block is open: while it streams, its appends go to the highlighter as
   * deltas. A closed block's text is final, so its worker copy goes (C4 question 4): now if the last reply covers the
   * text, else once the reply for the rest lands.
   */
  public _setStreamsDeltas(open: boolean): void {
    this._streamsDeltas = open
    if (!open && this._shownVersion === this._version) this.stopDeltas()
  }

  private stopDeltas(): void {
    const deltas = this._deltas
    this._deltas = undefined
    // A destroyed client has freed its copies; the worker ignores one it never had.
    deltas?.client.removeCopy(deltas.id).catch(() => {})
  }

  public updateStreamingPreview(content: string, initialStyledText: StyledText): void {
    this._content = content
    this._initialStyledText = initialStyledText
    this._shownVersion = PREVIEW
    this.invalidateHighlights()
    this.textBuffer.setStyledText(initialStyledText)
    this.setRenderedLineSources(undefined)
    this.updateTextInfo()
  }

  public override get lineInfo(): LineInfo {
    if (!this._renderedLineSources) return super.lineInfo
    if (this._mappedLineInfo) return this._mappedLineInfo

    const lineInfo = super.lineInfo
    const renderedLineSources = this._renderedLineSources

    // Native reports visual rows for the rendered buffer; remap those rows back to source lines.
    this._mappedLineInfo = {
      ...lineInfo,
      lineSources: lineInfo.lineSources.map((line) => renderedLineSources[line] ?? line),
    }
    return this._mappedLineInfo
  }

  public override getLineSources(startLine: number, lineCount: number): number[] {
    if (this.needsLineInfoFallback(CodeRenderable.prototype)) {
      return this.lineInfo.lineSources.slice(startLine, startLine + lineCount)
    }
    const sources = this.textBufferView.getLineSources(startLine, lineCount)
    const renderedLineSources = this._renderedLineSources
    return renderedLineSources ? sources.map((line) => renderedLineSources[line] ?? line) : sources
  }

  public override get wrapMode(): "none" | "char" | "word" {
    return super.wrapMode
  }

  public override set wrapMode(value: "none" | "char" | "word") {
    if (super.wrapMode !== value) {
      this._mappedLineInfo = undefined
      super.wrapMode = value
    }
  }

  protected override onResize(width: number, height: number): void {
    this._mappedLineInfo = undefined
    super.onResize(width, height)
  }

  protected override updateTextInfo(): void {
    this._mappedLineInfo = undefined
    super.updateTextInfo()
  }

  get filetype(): string | undefined {
    return this._filetype
  }

  set filetype(value: string | undefined) {
    if (this._filetype !== value) {
      this._filetype = value
      this.invalidateHighlights()
    }
  }

  get syntaxStyle(): SyntaxStyle {
    return this._syntaxStyle
  }

  set syntaxStyle(value: SyntaxStyle) {
    if (this._syntaxStyle !== value) {
      this._syntaxStyle = value
      this.changeStyle()
    }
  }

  get conceal(): boolean {
    return this._conceal
  }

  set conceal(value: boolean) {
    if (this._conceal !== value) {
      this._conceal = value
      this.changeStyle()
    }
  }

  get drawUnstyledText(): boolean {
    return this._drawUnstyledText
  }

  set drawUnstyledText(value: boolean) {
    if (this._drawUnstyledText !== value) {
      this._drawUnstyledText = value
      this.invalidateHighlights(false)
    }
  }

  get streaming(): boolean {
    return this._streaming
  }

  set initialStyledText(value: StyledText | undefined) {
    if (this._initialStyledText === value) return
    this._initialStyledText = value
    // A preview changes what shows while a highlight runs, not the highlight. A buffer without one holds the new
    // preview, or the source, now (also culled); while streaming, a preview replaces a highlight on its way out. A
    // cleared preview that painted stays until the highlight lands (the end of a stream), so a chunk callback's text
    // never shows raw; the source that replaces a preview where unstyled text is not drawn does not paint.
    const shows = value && this._drawUnstyledText
    const replaces = shows && this._streaming && this._isHighlighting
    const previewed = this._shownVersion === PREVIEW
    if (!this._content || !(this._shownVersion < 0 || replaces) || (!value && previewed)) return
    this.runMutation(() => {
      if (shows) this.textBuffer.setStyledText(value)
      else this.textBuffer.setText(this._content)
      if (!shows && previewed && !this._drawUnstyledText && this._filetype) this.setShouldRenderTextBuffer(false)
      this._shownVersion = shows ? PREVIEW : -1
      this.setRenderedLineSources(undefined)
      this.updateTextInfo()
    })
  }

  set streaming(value: boolean) {
    if (this._streaming !== value) {
      this._streaming = value
      // At once, since a hidden block runs no update hook to do it.
      if (!value) this.stopDeltas()
      this.invalidateHighlights(false)
    }
  }

  get treeSitterClient(): TreeSitterClient {
    return this._treeSitterClient
  }

  set treeSitterClient(value: TreeSitterClient) {
    if (this._treeSitterClient !== value) {
      this._treeSitterClient = value
      this.invalidateHighlights()
    }
  }

  get onHighlight(): OnHighlightCallback | undefined {
    return this._onHighlight
  }

  get baseHighlight(): string | undefined {
    return this._baseHighlight
  }

  set baseHighlight(value: string | undefined) {
    if (this._baseHighlight !== value) {
      this._baseHighlight = value
      this.changeStyle()
    }
  }

  set onHighlight(value: OnHighlightCallback | undefined) {
    if (this._onHighlight !== value) {
      this._onHighlight = value
      this.changeStyle()
    }
  }

  get onChunks(): OnChunksCallback | undefined {
    return this._onChunks
  }

  set onChunks(value: OnChunksCallback | undefined) {
    if (this._onChunks !== value) {
      this._onChunks = value
      this.changeStyle()
    }
  }

  get isHighlighting(): boolean {
    return this._isHighlighting || this._highlightRerun
  }

  get highlightingDone(): Promise<void> {
    return this._highlightingPromise
  }

  protected async transformChunks(chunks: TextChunk[], context: ChunkRenderContext): Promise<TextChunk[]> {
    if (!this._onChunks) return chunks

    const modified = await this._onChunks(chunks, context)
    return modified ?? chunks
  }

  // Streaming keeps what it paints until the next highlight lands, except raw text where unstyled text is not drawn. A
  // current highlight stays.
  private ensureVisibleTextBeforeHighlight(): void {
    const keeps = this._streaming && this._shouldRenderTextBuffer
    if (this._drawUnstyledText) {
      if (!keeps && this._shownVersion !== this._version) {
        if (this._initialStyledText) {
          this.textBuffer.setStyledText(this._initialStyledText)
        } else {
          this.textBuffer.setText(this._content)
        }
        this._shownVersion = this._initialStyledText ? PREVIEW : -1
        this.setRenderedLineSources(undefined)
        // The constructor's preview, kept by its first update, has painted from now on.
      } else if (keeps && this._shownVersion === -1 && this._initialStyledText) this._shownVersion = PREVIEW
      this.setShouldRenderTextBuffer(true)
    } else {
      this.paintHighlightsOnly()
    }
  }

  private paintHighlightsOnly(): void {
    if (!this._streaming || !this._shouldRenderTextBuffer || this._shownVersion === -1)
      this.setShouldRenderTextBuffer(this._shownVersion === this._version)
  }

  // The delta state while it still describes the block: the same client and filetype, and still eligible.
  private currentDeltas(): CodeRenderable["_deltas"] {
    const deltas = this._deltas
    const same = deltas?.client === this._treeSitterClient && deltas.filetype === this._filetype
    return same && this.deltasAllowed() ? deltas : undefined
  }

  private async startHighlight(): Promise<void> {
    const deltas = this.currentDeltas()
    if (deltas) return this.highlightDelta(deltas)
    this.stopDeltas()
    const content = this._content
    const filetype = this._filetype
    const version = this._version

    if (!filetype) return

    this._isHighlighting = true
    // A reply for an older version is dropped.
    const current = () => {
      if (version !== this._version) this.requestRender()
      return version === this._version && !this.isDestroyed
    }

    // Text a chunk callback has not seen is never shown: a failed highlight (a rejection or an error answer) keeps what
    // the block shows (its preview or an earlier highlight), else the chunk path runs without highlights.
    const keeps = () => (this._initialStyledText && this._drawUnstyledText) || this._shownVersion !== -1
    try {
      const result = await this._treeSitterClient
        .highlightOnce(content, filetype)
        .then((answer) => {
          if (answer.error) throw new Error(answer.error)
          return answer
        })
        .catch((error) => {
          if (!this._onChunks || keeps()) throw error
          console.warn("Code highlighting failed, rendering without highlights:", error)
          return { highlights: [] }
        })
      if (!current()) return

      let highlights = result.highlights ?? []

      if (this._onHighlight && highlights.length >= 0) {
        const context: HighlightContext = {
          content,
          filetype,
          syntaxStyle: this._syntaxStyle,
        }
        const modified = await this._onHighlight(highlights, context)
        if (modified !== undefined) {
          highlights = modified
        }
      }

      if (!current()) return

      if (highlights.length > 0 || this._onChunks || this._baseHighlight) {
        const sourceRanges: Array<{ start: number; end: number }> | undefined = this._onChunks ? [] : undefined
        const context: ChunkRenderContext = {
          content,
          filetype,
          syntaxStyle: this._syntaxStyle,
          highlights,
          sourceRanges,
        }

        let chunks = treeSitterToTextChunks(content, highlights, this._syntaxStyle, {
          enabled: this._conceal,
          baseHighlight: this._baseHighlight,
          ranges: sourceRanges,
        })
        // onChunks may rewrite text arbitrarily, so the conceal-only source map would be invalid.
        const renderedLineSources = this._onChunks ? undefined : this.getConcealLinesSourceMap(content, highlights)

        chunks = await this.transformChunks(chunks, context)

        if (!current()) return
        this.settle(version, new StyledText(chunks), renderedLineSources)
      } else {
        this.settle(version, undefined, undefined)
      }
    } catch (error) {
      if (version !== this._version) {
        this.requestRender()
        return
      }

      console.warn("Code highlighting failed, falling back to plain text:", error)
      if (this.isDestroyed) return
      this.settle(-1, undefined, undefined, !!this._onChunks)
    }
  }

  // Sends the text the worker has not seen; the reply covers that prefix and is never stale: text appended meanwhile
  // stays plain until the next step sends it. A failure, or a name native rejects, goes back to whole highlights.
  private async highlightDelta(deltas: NonNullable<CodeRenderable["_deltas"]>): Promise<void> {
    const version = this._version
    const offset = deltas.sent
    const content = this._content
    deltas.sent = content.length
    this._isHighlighting = true
    const answer = await deltas.client
      .highlightAppend(deltas.id, offset, content.slice(offset), deltas.filetype)
      .catch((error: unknown) => ({ highlights: undefined, error: String(error) }))
    // A reply for a block that changed language, concealment or hooks meanwhile is not shown; the next step goes whole.
    if (this.currentDeltas() !== deltas || this.isDestroyed) return
    try {
      if (!answer.highlights) throw new Error(answer.error)
      const names: string[][] = []
      // No captures paint the buffer's defaults, as a whole highlight without any does: an empty layer.
      const { highlights } = answer
      const options = { enabled: false, names }
      const chunks = highlights.length ? treeSitterToTextChunks(content, highlights, this._syntaxStyle, options) : []
      const runs: number[] = []
      let end = 0
      chunks.forEach((chunk, index) => {
        // A capture past the text (Markdown's closing backticks parse with a line break after them) leaves an empty one.
        if (!chunk.text) return
        const start = end
        // UTF-8 as native stores it (a lone surrogate becomes U+FFFD, 3 bytes).
        end += Buffer.byteLength(chunk.text)
        const key = names[index]!
        let set = this._groupSets.get(key.join("\n"))
        if (set === undefined) this._groupSets.set(key.join("\n"), (set = this.textBuffer._groupSet(key)))
        runs.push(start, end, set)
      })
      if (this.textBuffer.getSyntaxStyle() !== this._syntaxStyle) this.textBuffer.setSyntaxStyle(this._syntaxStyle)
      this.textBuffer._setLayer(SYNTAX_LAYER, 0, Buffer.byteLength(content), new Uint32Array(runs))
    } catch {
      this.stopDeltas()
      this._highlightRerun = true
      return
    }
    this._shownVersion = version
    this._isHighlighting = false
    // A closed block's copy goes once a reply covers all its text.
    if (!this._streamsDeltas && deltas.sent === this._content.length) this.stopDeltas()
    this.setShouldRenderTextBuffer(true)
    // A layer changes no text, so nothing else asks for the frame that shows it.
    this.requestRender()
  }

  // Without styled text the highlight is the plain content; version -1 marks a failed highlight. A block that keeps what
  // it shows keeps its buffer and paint: hidden raw text stays hidden, painted text counts as kept.
  private settle(version: number, text: StyledText | undefined, lineSources: number[] | undefined, keep = false): void {
    if (!keep) {
      if (text) this.textBuffer.setStyledText(text)
      else this.textBuffer.setText(this._content)
      this.setRenderedLineSources(lineSources)
      this._shownVersion = version
      this.setShouldRenderTextBuffer(true)
    } else if (this._shouldRenderTextBuffer) this._shownVersion = PREVIEW
    this._isHighlighting = false
    this.setHighlightsDirty(false)
    this.updateTextInfo()
  }

  private async runHighlights(): Promise<void> {
    try {
      do {
        this._highlightRerun = false
        await this.startHighlight()
      } while (this._highlightRerun && !this.isDestroyed && this._content.length > 0 && this._filetype)
    } finally {
      this._isHighlighting = false
      this._highlightLoopActive = false
      this._highlightRerun = false
    }
  }

  private clearPendingHighlight(): void {
    this._isHighlighting = false
    this._highlightRerun = false
    this._highlightingPromise = Promise.resolve()
  }

  private setRenderedLineSources(lineSources: number[] | undefined): void {
    this._renderedLineSources = lineSources
    this._mappedLineInfo = undefined
  }

  private static isIdentityLineSources(lineSources: number[]): boolean {
    for (let i = 0; i < lineSources.length; i++) {
      if (lineSources[i] !== i) return false
    }
    return true
  }

  private static getMergedConcealLineRanges(highlights: SimpleHighlight[]): ConcealLineRange[] {
    const ranges: ConcealLineRange[] = []

    for (const highlight of highlights) {
      const meta = highlight[3]
      if (meta?.concealLines === undefined) continue

      const group = highlight[2]
      const isEmptyConceal =
        meta.conceal === "" || (meta.conceal === undefined && (group === "conceal" || group.startsWith("conceal.")))
      if (isEmptyConceal) {
        ranges.push([highlight[0], highlight[1]])
      }
    }

    if (ranges.length <= 1) return ranges

    // Overlapping conceal ranges must collapse before line-by-line source mapping.
    ranges.sort((a, b) => a[0] - b[0])
    let writeIndex = 0

    for (let i = 1; i < ranges.length; i++) {
      const current = ranges[writeIndex]
      const next = ranges[i]

      if (next[0] <= current[1]) {
        current[1] = Math.max(current[1], next[1])
      } else {
        writeIndex++
        ranges[writeIndex] = next
      }
    }

    ranges.length = writeIndex + 1
    return ranges
  }

  private getConcealLinesSourceMap(content: string, highlights: SimpleHighlight[]): number[] | undefined {
    if (!this._conceal || content.length === 0) return undefined

    // setStyledText gives native only rendered text; rebuild enough source identity for concealed lines.
    // Native view-resolved extmarks should make this a layout query instead of a parallel map.
    const concealLineRanges = CodeRenderable.getMergedConcealLineRanges(highlights)
    if (concealLineRanges.length === 0) return undefined

    const lineSources: number[] = []
    let sourceLine = 0
    let lineStart = 0
    let rangeIndex = 0
    let currentRenderedLineHasText = false

    const setCurrentRenderedLineSource = (line: number, hasText: boolean): void => {
      // Until visible text is emitted, a rendered line can still map to a later collapsed source line.
      if (lineSources.length === 0) {
        lineSources.push(line)
      } else if (!currentRenderedLineHasText) {
        lineSources[lineSources.length - 1] = line
      }

      if (hasText) currentRenderedLineHasText = true
    }

    while (lineStart <= content.length) {
      const newlineOffset = content.indexOf("\n", lineStart)
      const lineEnd = newlineOffset === -1 ? content.length : newlineOffset

      while (rangeIndex < concealLineRanges.length && concealLineRanges[rangeIndex][1] <= lineStart) {
        rangeIndex++
      }

      const range = concealLineRanges[rangeIndex]
      const fullyConcealed = !!range && lineEnd > lineStart && range[0] <= lineStart && range[1] >= lineEnd
      const lineBreakConcealed =
        newlineOffset !== -1 && !!range && range[0] <= newlineOffset && range[1] >= newlineOffset

      if (!fullyConcealed || !lineBreakConcealed) {
        const hasText = lineEnd > lineStart && !fullyConcealed
        if (hasText || newlineOffset !== -1 || !fullyConcealed) {
          setCurrentRenderedLineSource(sourceLine, hasText)
        }

        if (newlineOffset !== -1 && !lineBreakConcealed) {
          lineSources.push(sourceLine + 1)
          currentRenderedLineHasText = false
        }
      }

      sourceLine++
      if (newlineOffset === -1) break
      lineStart = newlineOffset + 1
    }

    if (lineSources.length === 0 || CodeRenderable.isIdentityLineSources(lineSources)) return undefined
    return lineSources
  }

  public getLineHighlights(lineIdx: number) {
    return this.textBuffer.getLineHighlights(lineIdx)
  }

  protected override onUpdate(deltaTime: number): void {
    super.onUpdate(deltaTime)
    this.scheduleHighlights()
  }

  private scheduleHighlights(): void {
    if (!this._highlightsDirty || this.isDestroyed) return

    const hasContent = this._content.length > 0
    if (!hasContent || !this._filetype) {
      this.stopDeltas()
      this.setShouldRenderTextBuffer(hasContent)
      this.setHighlightsDirty(false)
      this.clearPendingHighlight()
      this.textBuffer.setText(this._content)
      this._shownVersion = -1
      this.setRenderedLineSources(undefined)
      this.updateTextInfo()
      return
    }

    this.ensureVisibleTextBeforeHighlight()
    this.setHighlightsDirty(false)
    if (this._highlightLoopActive) {
      this._isHighlighting = true
      this._highlightRerun = true
      this._highlightingPromise = this._highlightPromise!
      return
    }

    // A rerun joins the active loop, so its promise is read only while the loop is active.
    this._highlightLoopActive = true
    this._highlightPromise = this.runHighlights()
    this._highlightingPromise = this._highlightPromise
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (!this._shouldRenderTextBuffer) return
    super.renderSelf(buffer)
  }

  protected override destroyOwnedResources(): void {
    this.runCleanup((run) => {
      run(() => this.clearPendingHighlight())
      run(() => this.stopDeltas())
      run(() => super.destroyOwnedResources())
    })
  }
}
