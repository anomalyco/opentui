import { type LineInfo, type RenderContext } from "../types.js"
import { StyledText } from "../lib/styled-text.js"
import { SyntaxStyle } from "../syntax-style.js"
import { getTreeSitterClient, TreeSitterClient } from "../lib/tree-sitter/index.js"
import { TextBufferRenderable, type TextBufferOptions } from "./TextBufferRenderable.js"
import { ScrollBoxRenderable } from "./ScrollBox.js"
import type { NativeRenderableIntegration } from "../Renderable.js"
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

// The worker's last results per client by exact filetype and content, oldest first, so that a block mounted again
// (a tab switch) paints in its first frame. Only worker output is kept; style, conceal and callbacks apply when it
// shows. Each block owns at most one entry; the keys' total length is bounded.
const REMEMBERED_LENGTH_MAX = 1 << 18
type Remembered = { highlights: SimpleHighlight[]; owners: Set<number>; kept: boolean }
type Memory = { length: number; results: Map<string, Remembered>; owners: Map<number, string> }
const remembered = new WeakMap<TreeSitterClient, Memory>()
let rememberOwners = 0

const rememberKey = (filetype: string, content: string) => `${filetype.length}:${filetype}${content}`

// Callbacks may change what they get; a remembered result must not change with them.
const copyHighlights = (highlights: SimpleHighlight[]) =>
  highlights.map(
    ([start, end, group, meta]): SimpleHighlight => (meta ? [start, end, group, { ...meta }] : [start, end, group]),
  )

// A callback answer usable before layout is an array or undefined; anything else may settle later and is dropped.
function answeredNow<T>(value: T[] | undefined | PromiseLike<T[] | undefined>): value is T[] | undefined {
  if (value === undefined || Array.isArray(value)) return true
  Promise.resolve(value).then(undefined, () => {})
  return false
}

function memoryOf(client: TreeSitterClient): Memory {
  const known = remembered.get(client)
  if (known) return known
  const memory: Memory = { length: 0, results: new Map(), owners: new Map() }
  remembered.set(client, memory)
  // A new parser or a destroyed worker may highlight the same text differently.
  const forget = () => {
    client.off("parsers:changed", forget)
    stop()
    if (remembered.get(client) === memory) remembered.delete(client)
  }
  client.on("parsers:changed", forget)
  const stop = client.onDestroy(forget)
  return memory
}

// Ends a live block's claim on its entry. A destroyed block's entry stays for its next mount (`kept`) until evicted; a
// live block's earlier result goes once no live block holds it.
function release(memory: Memory, owner: number, destroyed = false): void {
  const key = memory.owners.get(owner)
  if (key === undefined) return
  memory.owners.delete(owner)
  const entry = memory.results.get(key)!
  entry.owners.delete(owner)
  entry.kept ||= destroyed
  if (entry.owners.size === 0 && !entry.kept) evict(memory, key)
}

function evict(memory: Memory, key: string): void {
  for (const owner of memory.results.get(key)!.owners) memory.owners.delete(owner)
  memory.results.delete(key)
  memory.length -= key.length
}

function remember(memory: Memory, owner: number, key: string, highlights: SimpleHighlight[]): void {
  release(memory, owner)
  if (key.length > REMEMBERED_LENGTH_MAX) return
  const entry = memory.results.get(key)
  if (entry) {
    memory.results.delete(key)
  } else {
    for (const oldest of memory.results.keys()) {
      if (memory.length + key.length <= REMEMBERED_LENGTH_MAX) break
      evict(memory, oldest)
    }
    memory.length += key.length
  }
  const owners = (entry?.owners ?? new Set<number>()).add(owner)
  memory.results.set(key, { highlights, owners, kept: entry?.kept ?? false })
  memory.owners.set(owner, key)
}

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
  private _highlightSnapshotId: number = 0
  private _highlightLoopActive: boolean = false
  private _highlightPromise?: Promise<void>
  private _highlightRerun: boolean = false
  private _conceal: boolean
  private _drawUnstyledText: boolean
  private _shouldRenderTextBuffer: boolean = true
  private _streaming: boolean
  private _initialStyledText?: StyledText
  private _hadInitialContent: boolean = false
  private readonly _rememberOwner = ++rememberOwners
  // A remembered result for the current state is painted; the next change of state ends it.
  private _restored = false
  private _restorePending = true
  private _baseHighlight?: string
  private _onHighlight?: OnHighlightCallback
  private _onChunks?: OnChunksCallback
  private _highlightingPromise: Promise<void> = Promise.resolve()
  // Temporary rendered-line -> source-line map for concealment; native extmarks should replace this.
  private _renderedLineSources?: number[]
  private _mappedLineInfo?: LineInfo

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
      this.onLifecyclePass = this.restoreHighlights
    } catch (error) {
      this.rollbackConstruction(error)
    }
  }

  get content(): string {
    return this._content
  }

  private invalidateHighlights(): void {
    this.setHighlightsDirty(true)
    this._highlightSnapshotId++
    this._restored = false
    this._restorePending = true
    this._ctx.nativeScene.lifecyclePasses.refresh(this)
  }

  // The callbacks and a transformChunks override see the highlights; a remembered result must not change with them.
  private exposesHighlights(): boolean {
    return !!(this._onHighlight || this._onChunks) || this.transformChunks !== CodeRenderable.prototype.transformChunks
  }

  override _needsLifecyclePass(): boolean {
    if (this.onLifecyclePass !== this.restoreHighlights) return super._needsLifecyclePass()
    return this._restorePending
  }

  // Before layout, a block that would wait for the worker shows the worker's last result for exactly its filetype and
  // content, when its callbacks answer at once. The worker still runs and replaces it.
  private readonly restoreHighlights = (): void => {
    this._restorePending = false
    this._ctx.nativeScene.lifecyclePasses.refresh(this)
    const content = this._content
    const filetype = this._filetype
    if (!this._highlightsDirty || this._drawUnstyledText || !filetype || !content) return
    const memory = remembered.get(this._treeSitterClient)
    const last = memory?.results.get(rememberKey(filetype, content))
    if (!last) return
    const snapshot = this._highlightSnapshotId
    let text: StyledText | undefined
    let lineSources: number[] | undefined
    try {
      const own = this.exposesHighlights() ? copyHighlights(last.highlights) : last.highlights
      const modified = this._onHighlight?.(own, { content, filetype, syntaxStyle: this._syntaxStyle })
      if (!answeredNow(modified)) return
      const highlights = modified ?? own
      if (highlights.length > 0 || this._onChunks || this._baseHighlight) {
        const styled = this.styleHighlights(content, filetype, highlights)
        if (!answeredNow(styled.chunks)) return
        text = new StyledText(styled.chunks ?? [])
        lineSources = styled.lineSources
      }
    } catch {
      return
    }
    // A callback may have changed the block (its content, filetype, ...), destroyed it, or changed the client's parsers.
    if (snapshot !== this._highlightSnapshotId || this.isDestroyed) return
    if (remembered.get(this._treeSitterClient) !== memory) return
    if (text) this.textBuffer.setStyledText(text)
    else this.textBuffer.setText(content)
    this.setRenderedLineSources(lineSources)
    this._restored = true
    this.setShouldRenderTextBuffer(true)
    this.updateTextInfo()
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
    // Streaming keeps the shown highlight until the next one lands (_hadInitialContent implies _streaming).
    if (this._hadInitialContent && this._shouldRenderTextBuffer && this._filetype && !this._drawUnstyledText) {
      if (this._ctx.nativeScene.reachesHooks(this)) {
        this._content = value
        this.invalidateHighlights()
        this.requestRender()
        // The frame's layout can still cull the block before its update hook runs (a sibling above grows, the view
        // shrinks or follows a new last child); then layout measures the plain text, as below.
        let box: ScrollBoxRenderable | undefined
        for (let node = this.parent; node; node = node.parent) if (node instanceof ScrollBoxRenderable) box ??= node
        box?.afterLayout(() => {
          if (this._highlightsDirty) this.runMutation(() => this.writeContent(this._content))
        })
        return
      }
      // No update hook runs here to start the highlight, so layout measures the plain text, unpainted until it lands.
      this.setShouldRenderTextBuffer(false)
    }

    if (value && this._initialStyledText && this._drawUnstyledText) {
      this.textBuffer.setStyledText(this._initialStyledText)
    } else {
      this.textBuffer.setText(value)
    }
    this._content = value
    this.invalidateHighlights()
    this.setRenderedLineSources(undefined)
    this.updateTextInfo()
  }

  public updateStreamingPreview(content: string, initialStyledText: StyledText): void {
    this._content = content
    this._initialStyledText = initialStyledText
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
      this.invalidateHighlights()
    }
  }

  get conceal(): boolean {
    return this._conceal
  }

  set conceal(value: boolean) {
    if (this._conceal !== value) {
      this._conceal = value
      this.invalidateHighlights()
    }
  }

  get drawUnstyledText(): boolean {
    return this._drawUnstyledText
  }

  set drawUnstyledText(value: boolean) {
    if (this._drawUnstyledText !== value) {
      this._drawUnstyledText = value
      this.invalidateHighlights()
    }
  }

  get streaming(): boolean {
    return this._streaming
  }

  set initialStyledText(value: StyledText | undefined) {
    if (this._initialStyledText !== value) {
      if (value && this._streaming && this._drawUnstyledText && this._isHighlighting) {
        this.updateStreamingPreview(this._content, value)
        return
      }

      this._initialStyledText = value
      this.invalidateHighlights()
    }
  }

  set streaming(value: boolean) {
    if (this._streaming !== value) {
      this._streaming = value
      this._hadInitialContent = false
      this.invalidateHighlights()
    }
  }

  get treeSitterClient(): TreeSitterClient {
    return this._treeSitterClient
  }

  /** @internal The client's current remembered results, for tests. */
  static _rememberedFor(client: TreeSitterClient): { length: number; owners: ReadonlyMap<number, string> } | undefined {
    return remembered.get(client)
  }

  // A memory that a parser change or a destroyed worker has dropped holds nothing to release.
  private releaseRemembered(destroyed: boolean): void {
    const memory = remembered.get(this._treeSitterClient)
    if (memory) release(memory, this._rememberOwner, destroyed)
  }

  set treeSitterClient(value: TreeSitterClient) {
    if (this._treeSitterClient !== value) {
      this.releaseRemembered(false)
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
      this.invalidateHighlights()
    }
  }

  set onHighlight(value: OnHighlightCallback | undefined) {
    if (this._onHighlight !== value) {
      this._onHighlight = value
      this.invalidateHighlights()
    }
  }

  get onChunks(): OnChunksCallback | undefined {
    return this._onChunks
  }

  set onChunks(value: OnChunksCallback | undefined) {
    if (this._onChunks !== value) {
      this._onChunks = value
      this.invalidateHighlights()
    }
  }

  get isHighlighting(): boolean {
    return this._isHighlighting || this._highlightRerun
  }

  get highlightingDone(): Promise<void> {
    return this._highlightingPromise
  }

  // Synchronous when onChunks answers at once, so a remembered result can show before layout.
  protected transformChunks(chunks: TextChunk[], context: ChunkRenderContext): TextChunk[] | Promise<TextChunk[]> {
    const modified = this._onChunks?.(chunks, context)
    if (modified === undefined || Array.isArray(modified)) return modified ?? chunks
    return Promise.resolve(modified).then((value) => value ?? chunks)
  }

  private styleHighlights(content: string, filetype: string, highlights: SimpleHighlight[]) {
    const sourceRanges: Array<{ start: number; end: number }> | undefined = this._onChunks ? [] : undefined
    const context: ChunkRenderContext = { content, filetype, syntaxStyle: this._syntaxStyle, highlights, sourceRanges }
    const chunks = treeSitterToTextChunks(content, highlights, this._syntaxStyle, {
      enabled: this._conceal,
      baseHighlight: this._baseHighlight,
      ranges: sourceRanges,
    })
    // onChunks may rewrite text arbitrarily, so the conceal-only source map would be invalid.
    const lineSources = this._onChunks ? undefined : this.getConcealLinesSourceMap(content, highlights)
    return { chunks: this.transformChunks(chunks, context), lineSources }
  }

  private ensureVisibleTextBeforeHighlight(): void {
    const content = this._content
    const isInitialContent = this._streaming && !this._hadInitialContent
    const shouldDrawUnstyledNow = this._streaming ? isInitialContent && this._drawUnstyledText : this._drawUnstyledText

    if (this._streaming && !isInitialContent) {
      if (this._drawUnstyledText) this.setShouldRenderTextBuffer(true)
    } else if (shouldDrawUnstyledNow) {
      if (this._initialStyledText) {
        this.textBuffer.setStyledText(this._initialStyledText)
      } else {
        this.textBuffer.setText(content)
      }
      this.setRenderedLineSources(undefined)
      this.setShouldRenderTextBuffer(true)
    } else {
      this.setShouldRenderTextBuffer(this._restored)
    }
  }

  private async startHighlight(): Promise<void> {
    const content = this._content
    const filetype = this._filetype
    const snapshotId = ++this._highlightSnapshotId

    if (!filetype) return

    const isInitialContent = this._streaming && !this._hadInitialContent
    if (isInitialContent) {
      this._hadInitialContent = true
    }

    this._isHighlighting = true
    const client = this._treeSitterClient
    const memory = this._drawUnstyledText ? undefined : memoryOf(client)

    try {
      const result = await client.highlightOnce(content, filetype)

      if (snapshotId !== this._highlightSnapshotId) {
        this.requestRender()
        return
      }

      if (this.isDestroyed) return

      let highlights = result.highlights ?? []
      // Into the memory it was asked of; after a parser change or a destroyed worker, nothing reads that one.
      if (memory && !result.error) {
        const copy = this.exposesHighlights() ? copyHighlights(highlights) : highlights
        remember(memory, this._rememberOwner, rememberKey(filetype, content), copy)
      }

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

      if (snapshotId !== this._highlightSnapshotId) {
        this.requestRender()
        return
      }

      if (this.isDestroyed) return

      if (highlights.length > 0 || this._onChunks || this._baseHighlight) {
        const styled = this.styleHighlights(content, filetype, highlights)
        const chunks = await styled.chunks

        if (snapshotId !== this._highlightSnapshotId) {
          this.requestRender()
          return
        }

        if (this.isDestroyed) return

        const styledText = new StyledText(chunks)
        this.textBuffer.setStyledText(styledText)
        this.setRenderedLineSources(styled.lineSources)
      } else {
        this.textBuffer.setText(content)
        this.setRenderedLineSources(undefined)
      }

      this.setShouldRenderTextBuffer(true)
      this._isHighlighting = false
      this.setHighlightsDirty(false)
      this.updateTextInfo()
      this.requestRender()
    } catch (error) {
      if (snapshotId !== this._highlightSnapshotId) {
        this.requestRender()
        return
      }

      console.warn("Code highlighting failed, falling back to plain text:", error)
      if (this.isDestroyed) return
      this.textBuffer.setText(content)
      this.setRenderedLineSources(undefined)
      this.setShouldRenderTextBuffer(true)
      this._isHighlighting = false
      this.setHighlightsDirty(false)
      this.updateTextInfo()
      this.requestRender()
    }
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
    this._highlightSnapshotId++
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
      this.setShouldRenderTextBuffer(hasContent)
      this.setHighlightsDirty(false)
      this.clearPendingHighlight()

      if (hasContent) {
        this.textBuffer.setText(this._content)
        this.setRenderedLineSources(undefined)
        this.updateTextInfo()
      }
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
      // Its last result stays for the block mounted in its place.
      run(() => this.releaseRemembered(true))
      run(() => super.destroyOwnedResources())
    })
  }
}
