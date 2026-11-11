import { Renderable, type RenderableOptions, type NativeRenderableIntegration } from "../Renderable.js"
import { type RenderContext, type TerminalCapabilities } from "../types.js"
import { SyntaxStyle, type StyleDefinition } from "../syntax-style.js"
import type { TextChunk } from "../text-buffer.js"
import { createTextAttributes } from "../utils.js"
import type { BorderStyle } from "../lib/border.js"
import { RGBA, parseColor, type ColorInput } from "../lib/RGBA.js"
import { Lexer, type MarkedToken, type Token, type Tokens } from "marked"
import { CodeRenderable, type ChunkRenderContext, type OnChunksCallback, type OnHighlightCallback } from "./Code.js"
import { BoxRenderable } from "./Box.js"
import { StyledText } from "../lib/styled-text.js"
import { TextRenderable } from "./Text.js"
import {
  TextTableRenderable,
  type TextTableCellContent,
  type TextTableColumnFitter,
  type TextTableColumnWidthMode,
  type TextTableContent,
} from "./TextTable.js"
import { getTreeSitterClient, type TreeSitterClient } from "../lib/tree-sitter/index.js"
import { infoStringToFiletype } from "../lib/tree-sitter/resolve-ft.js"
import { parseMarkdownIncremental, type ParseState } from "./markdown-parser.js"
import { detectLinks, normalizeMarkdownLinkTarget } from "../lib/detect-links.js"
import type { SimpleHighlight } from "../lib/tree-sitter/types.js"
import { MAX_LINK_URL_BYTES } from "../zig.js"

export type MarkdownTableStyle = "grid" | "columns"

export interface MarkdownTableOptions {
  /**
   * Visual style preset for markdown tables.
   * - "grid": boxed table with visible borders.
   * - "columns": borderless columns optimized for separated block output.
   *
   * Defaults to "columns" in `internalBlockMode: "top-level"`, otherwise "grid".
   */
  style?: MarkdownTableStyle
  /**
   * Strategy for sizing table columns.
   * - "content": columns fit to intrinsic content width.
   * - "full": columns expand to fill available width.
   */
  widthMode?: TextTableColumnWidthMode
  /**
   * Column fitting method when shrinking constrained tables.
   */
  columnFitter?: TextTableColumnFitter
  /**
   * Wrapping strategy for table cell content.
   */
  wrapMode?: "none" | "char" | "word"
  /**
   * Padding applied on all sides of each table cell.
   */
  cellPadding?: number
  /**
   * Horizontal padding applied on the left and right of each table cell.
   */
  cellPaddingX?: number
  /**
   * Vertical padding applied above and below each table cell.
   */
  cellPaddingY?: number
  /**
   * Enables/disables table border rendering.
   */
  borders?: boolean
  /**
   * Overrides outer border visibility. Defaults to `borders`.
   */
  outerBorder?: boolean
  /**
   * Border style for markdown tables.
   */
  borderStyle?: BorderStyle
  /**
   * Border color for markdown tables. Defaults to conceal style color.
   */
  borderColor?: ColorInput
  /**
   * Enables/disables selection support on markdown tables.
   */
  selectable?: boolean
}

export interface MarkdownOptions extends RenderableOptions<MarkdownRenderable> {
  content?: string
  syntaxStyle: SyntaxStyle
  fg?: ColorInput
  bg?: ColorInput
  /** Controls concealment for markdown syntax markers in markdown text blocks. */
  conceal?: boolean
  /** Controls concealment inside fenced code blocks rendered by CodeRenderable. */
  concealCode?: boolean
  treeSitterClient?: TreeSitterClient
  /**
   * Enable streaming mode for incremental content updates.
   *
   * Semantics:
   * - The trailing markdown block stays unstable while streaming is enabled.
   * - Tables render all rows produced by the markdown parser (including trailing rows).
   * - Incomplete table rows are normalized by the parser and rendered with empty cells
   *   where data is missing.
   *
   * Expectations:
   * - Keep this true while chunks are still being appended.
   * - Set this to false once streaming is complete to finalize trailing token parsing.
   */
  streaming?: boolean
  /**
   * Options for internally rendered markdown tables.
   */
  tableOptions?: MarkdownTableOptions
  /**
   * Custom node renderer. Return a Renderable to override default rendering,
   * or undefined/null to use default rendering.
   */
  renderNode?: (token: Token, context: RenderNodeContext) => Renderable | undefined | null
  /**
   * Internal only.
   * - "coalesced": combine ordinary markdown into larger render blocks.
   * - "top-level": preserve top-level markdown blocks as separate render blocks.
   */
  internalBlockMode?: "coalesced" | "top-level"
  /**
   * Rewrites the display text of every paragraph, heading and table cell, in lists and quotes too, before it is
   * shown: to show IDs as titled links, for example. Code blocks and `renderNode` results never reach it. It runs
   * when a block is drawn or changes, on the streaming preview too, and must be synchronous.
   */
  inlineHook?: MarkdownInlineHook
  /** When set, the hook runs only on blocks and cells whose source contains one of these strings. */
  inlineHookFilter?: readonly string[]
}

/** One piece of a prose block's display text, as an inline hook sees and returns it. */
export interface MarkdownInlineSpan {
  text: string
  fg?: RGBA
  bg?: RGBA
  attributes?: number
  /** A hyperlink Markdown already found (a Markdown link, an autolink or a bare URL). */
  link?: { url: string }
  /** Whether the span is a code span. Without conceal its text keeps the backticks. */
  code: boolean
  /** What a click on the span means to the app, such as a session ID. Never sent to the terminal. */
  target?: string
}

/** What an inline hook knows about the block or table cell. */
export interface MarkdownInlineContext {
  /** The block's or cell's Markdown source. */
  source: string
  conceal: boolean
  syntaxStyle: SyntaxStyle
  /** Whether the spans are one table cell's content; false for paragraphs and headings, in lists and quotes too. */
  tableCell: boolean
}

export type MarkdownInlineHook = (spans: MarkdownInlineSpan[], context: MarkdownInlineContext) => MarkdownInlineSpan[]

export interface RenderNodeContext {
  syntaxStyle: SyntaxStyle
  conceal: boolean
  concealCode: boolean
  treeSitterClient?: TreeSitterClient
  /** Creates default renderable for this token */
  defaultRender: () => Renderable | null
}

export type MarkdownCodeBlockRenderer = (
  token: Tokens.Code,
  context: RenderNodeContext,
) => Renderable | undefined | null

export type MarkdownCodeBlockRendererMap =
  | ReadonlyMap<string, MarkdownCodeBlockRenderer>
  | Readonly<Record<string, MarkdownCodeBlockRenderer>>

type MarkdownRenderNode = NonNullable<MarkdownOptions["renderNode"]> & {
  codeBlockOnly?: boolean
}

function normalizeMarkdownCodeBlockRenderers(
  renderers: MarkdownCodeBlockRendererMap,
): ReadonlyMap<string, MarkdownCodeBlockRenderer> {
  const rendererMap = new Map<string, MarkdownCodeBlockRenderer>()
  const maybeMap = renderers as Partial<ReadonlyMap<string, MarkdownCodeBlockRenderer>>

  if (typeof maybeMap.forEach === "function") {
    maybeMap.forEach((renderer, language) => {
      rendererMap.set(language, renderer)
    })
    return rendererMap
  }

  const rendererRecord = renderers as Readonly<Record<string, MarkdownCodeBlockRenderer>>
  for (const [language, renderer] of Object.entries(rendererRecord)) {
    rendererMap.set(language, renderer)
  }

  return rendererMap
}

export function createMarkdownCodeBlockRenderer(
  renderers: MarkdownCodeBlockRendererMap,
): MarkdownOptions["renderNode"] {
  const rendererMap = normalizeMarkdownCodeBlockRenderers(renderers)

  const renderNode: MarkdownRenderNode = (token, context) => {
    if (token.type !== "code") {
      return undefined
    }

    const language = infoStringToFiletype(token.lang ?? "")
    if (!language) return undefined

    return rendererMap.get(language)?.(token as Tokens.Code, context)
  }

  renderNode.codeBlockOnly = true
  return renderNode
}

interface TableContentCache {
  content: TextTableContent
  cellKeys: Uint32Array[]
}

interface CustomRenderableResult {
  renderable?: Renderable
  tableContentCache?: TableContentCache
  tracksInterBlockMargin: boolean
  canUpdateInPlace: boolean
}

interface CustomRenderDefaultResult {
  renderable: Renderable | null | undefined
  tableContentCache?: TableContentCache
}

interface RenderNodeResult {
  renderable?: Renderable
  defaultResult?: CustomRenderDefaultResult
}

interface ResolvedTableRenderableOptions {
  columnWidthMode: TextTableColumnWidthMode
  columnFitter: TextTableColumnFitter
  wrapMode: "none" | "char" | "word"
  cellPadding: number
  cellPaddingX: number
  cellPaddingY: number
  columnGap: number
  border: boolean
  outerBorder: boolean
  showBorders: boolean
  borderStyle: BorderStyle
  borderColor: ColorInput
  fg?: RGBA
  selectable: boolean
}

const TRAILING_MARKDOWN_BLOCK_BREAKS_RE = /(?:\r?\n){2,}$/
const TRAILING_MARKDOWN_BLOCK_NEWLINES_RE = /(?:\r?\n)+$/
const markdownLinkEncoder = new TextEncoder()

function isSupportedLinkTarget(url: string): boolean {
  if (url.length > MAX_LINK_URL_BYTES || /[\x00-\x1f\x7f-\x9f]/.test(url)) return false
  return markdownLinkEncoder.encode(url).byteLength <= MAX_LINK_URL_BYTES
}

function colorsEqual(left?: RGBA, right?: RGBA): boolean {
  if (!left || !right) return left === right
  return left.equals(right)
}

export interface BlockState {
  token: MarkedToken
  tokenRaw: string // Cache raw for comparison
  marginTop?: number
  renderable: Renderable
  tableContentCache?: TableContentCache
  tracksInterBlockMargin?: boolean
  /** Whether built-in reconciliation can update this renderable without replacing it. */
  canUpdateInPlace: boolean
}

export type { ParseState }

interface MarkdownRenderBlock {
  token: MarkedToken
  sourceTokenEnd: number
  marginTop: number
}

function cloneTableOptions(options: MarkdownTableOptions | undefined): MarkdownTableOptions | undefined {
  if (!options) return undefined
  return {
    ...options,
    borderColor: options.borderColor ? RGBA.clone(parseColor(options.borderColor)) : undefined,
  }
}

interface ListItemRenderInput {
  item: Tokens.ListItem
  marker: string
  markerWidth: number
  id: string
}

export class MarkdownRenderable extends Renderable {
  static override readonly nativeIntegration: NativeRenderableIntegration = {
    ...Renderable.nativeIntegration,
  }
  private static _capabilitySubscriptions = new WeakMap<
    RenderContext,
    { renderables: Set<MarkdownRenderable>; listener: (capabilities: TerminalCapabilities) => void }
  >()
  private _content: string = ""
  private _syntaxStyle: SyntaxStyle
  private _fg?: RGBA
  private _bg?: RGBA
  private _conceal: boolean
  private _concealCode: boolean
  private _treeSitterClient?: TreeSitterClient
  private _tableOptions?: MarkdownTableOptions
  private _renderNode?: MarkdownOptions["renderNode"]
  private _internalBlockMode: "coalesced" | "top-level"

  _parseState: ParseState | null = null
  private _streaming: boolean = false
  _blockStates: BlockState[] = []
  _stableBlockCount = 0
  private _styleDirty: boolean = false
  private readonly applyStyleChanges = () => this.rerenderDirtyStyles()
  private _highlightMarkdownLinks: OnHighlightCallback = (highlights, context) =>
    this.addMarkdownLinkHighlights(highlights, context.content)
  // Every prose block's chunk callback: link detection, then the inline hook.
  private _linkifyMarkdownChunks: OnChunksCallback = (chunks, context) => this.hookHighlightedChunks(chunks, context)
  private _ownedStructuredRenderables = new WeakSet<Renderable>()
  // The base highlight of the block whose preview is being built (quote text).
  private _previewBase?: string
  private _inlineHook?: MarkdownInlineHook
  private _inlineHookFilter?: readonly string[]
  // Preview and table chunks drawn as code spans.
  private _codeChunks = new WeakSet<TextChunk>()
  private _proseClient?: TreeSitterClient
  // The kind of block each list item or quote child shows, so a child is updated only for a block of its kind.
  private _childKinds = new WeakMap<Renderable, string>()

  private handleCapabilities(): void {
    if (!this._renderNode && !this._content.includes("]")) return

    const previousHighlight = this._highlightMarkdownLinks
    this._highlightMarkdownLinks = (highlights, context) => this.addMarkdownLinkHighlights(highlights, context.content)

    this.visitShownBlocks((renderable, token, state) => {
      if (this.isOwnedTable(renderable, token)) {
        this.refreshTable(renderable, token, state)
        return false
      }

      if (
        renderable instanceof CodeRenderable &&
        renderable.filetype === "markdown" &&
        renderable.onChunks === this._linkifyMarkdownChunks &&
        renderable.onHighlight === previousHighlight
      ) {
        if (this._streaming && token) {
          const preview = this.createInitialStyledText(token, renderable.baseHighlight)
          renderable.initialStyledText = this.hookPreview(preview, renderable.content)
        }
        renderable.onHighlight = this._highlightMarkdownLinks
      }
      return true
    })

    this.requestRender()
  }

  private isOwnedTable(renderable: Renderable, token: MarkedToken | undefined): token is Tokens.Table {
    return (
      renderable instanceof TextTableRenderable &&
      token?.type === "table" &&
      this._ownedStructuredRenderables.has(renderable)
    )
  }

  /** Builds an owned table's cells again, for a change their tokens do not show. */
  private refreshTable(renderable: Renderable, token: Tokens.Table, state: BlockState): void {
    const { cache } = this.buildTableContentCache(
      token,
      renderable === state.renderable ? state.tableContentCache : undefined,
      true,
    )
    if (!cache) return
    ;(renderable as TextTableRenderable).content = cache.content
    if (renderable === state.renderable) state.tableContentCache = cache
  }

  /** Visits every renderable the blocks show, with the token it shows; `visit` returns false to skip its children. */
  private visitShownBlocks(
    visit: (renderable: Renderable, token: MarkedToken | undefined, state: BlockState) => boolean,
  ): void {
    for (const state of this._blockStates) {
      const renderables: Array<[Renderable, MarkedToken?]> = [[state.renderable, state.token]]
      while (renderables.length > 0) {
        const [renderable, token] = renderables.pop()!
        if (!visit(renderable, token, state)) continue

        const owned = this._ownedStructuredRenderables.has(renderable)
        if (token?.type === "list" && owned) {
          const items = (token as Tokens.List).items
          const rows = renderable.getChildren()
          for (let index = 0; index < items.length; index++) {
            const children = rows[index]?.getChildren()[1]?.getChildren() ?? []
            const tokens = this.getChildBlockTokens(items[index]!.tokens)
            children.forEach((child, childIndex) => renderables.push([child, tokens[childIndex]]))
          }
          continue
        }

        if (token?.type === "blockquote" && owned) {
          const tokens = this.getChildBlockTokens(token.tokens)
          renderable.getChildren().forEach((child, index) => renderables.push([child, tokens[index]]))
          continue
        }

        for (const child of renderable.getChildren()) renderables.push([child, token])
      }
    }
  }

  protected _contentDefaultOptions = {
    content: "",
    conceal: true,
    concealCode: false,
    streaming: false,
    internalBlockMode: "coalesced",
  } satisfies Partial<MarkdownOptions>

  constructor(ctx: RenderContext, options: MarkdownOptions) {
    super(ctx, {
      ...options,
      flexDirection: "column",
      flexShrink: options.flexShrink ?? 0,
    })

    try {
      this._syntaxStyle = options.syntaxStyle
      this._fg = options.fg ? RGBA.clone(parseColor(options.fg)) : undefined
      this._bg = options.bg ? RGBA.clone(parseColor(options.bg)) : undefined
      this._conceal = options.conceal ?? this._contentDefaultOptions.conceal
      this._concealCode = options.concealCode ?? this._contentDefaultOptions.concealCode
      this._content = options.content ?? this._contentDefaultOptions.content
      this._treeSitterClient = options.treeSitterClient
      this._tableOptions = cloneTableOptions(options.tableOptions)
      this._renderNode = options.renderNode
      this._streaming = options.streaming ?? this._contentDefaultOptions.streaming
      this._internalBlockMode = options.internalBlockMode ?? this._contentDefaultOptions.internalBlockMode
      this._inlineHook = options.inlineHook
      this._inlineHookFilter = options.inlineHookFilter

      this.updateBlocks()
      this.onLifecyclePass = this.applyStyleChanges

      let subscription = MarkdownRenderable._capabilitySubscriptions.get(ctx)
      if (!subscription) {
        const renderables = new Set<MarkdownRenderable>()
        let hyperlinksSupported = ctx.capabilities?.hyperlinks === true
        subscription = {
          renderables,
          listener: (capabilities) => {
            if (hyperlinksSupported === (capabilities.hyperlinks === true)) return
            hyperlinksSupported = capabilities.hyperlinks === true
            for (const renderable of renderables) renderable.handleCapabilities()
          },
        }
        ctx.on("capabilities", subscription.listener)
        MarkdownRenderable._capabilitySubscriptions.set(ctx, subscription)
      }
      subscription.renderables.add(this)
    } catch (error) {
      try {
        this.destroyRecursively()
      } catch {
        // Preserve the construction failure.
      }
      throw error
    }
  }

  get content(): string {
    return this._content
  }

  set content(value: string) {
    if (this.isDestroyed) return
    if (this._content !== value) {
      this.assertMutable()
      this._content = value
      this.updateBlocks()
      this.requestRender()
    }
  }

  get syntaxStyle(): SyntaxStyle {
    return this._syntaxStyle
  }

  set syntaxStyle(value: SyntaxStyle) {
    if (this._syntaxStyle !== value) {
      this._syntaxStyle = value
      this.markStyleDirty()
    }
  }

  get fg(): RGBA | undefined {
    return this._fg ? RGBA.clone(this._fg) : undefined
  }

  set fg(value: ColorInput | undefined) {
    const next = value ? RGBA.clone(parseColor(value)) : undefined
    if (!colorsEqual(this._fg, next)) {
      this._fg = next
      this.markStyleDirty()
    }
  }

  get bg(): RGBA | undefined {
    return this._bg ? RGBA.clone(this._bg) : undefined
  }

  set bg(value: ColorInput | undefined) {
    const next = value ? RGBA.clone(parseColor(value)) : undefined
    if (!colorsEqual(this._bg, next)) {
      this._bg = next
      this.markStyleDirty()
    }
  }

  get conceal(): boolean {
    return this._conceal
  }

  set conceal(value: boolean) {
    if (this._conceal !== value) {
      this._conceal = value
      this.markStyleDirty()
    }
  }

  get concealCode(): boolean {
    return this._concealCode
  }

  set concealCode(value: boolean) {
    if (this._concealCode !== value) {
      this._concealCode = value
      this.markStyleDirty()
    }
  }

  get streaming(): boolean {
    return this._streaming
  }

  set streaming(value: boolean) {
    if (this.isDestroyed) return
    if (this._streaming !== value) {
      this.assertMutable()
      this._streaming = value
      this._parseState = parseMarkdownIncremental(this._content, this._parseState, value ? 2 : 0)
      this.updateBlocks(true)
    }
  }

  get tableOptions(): MarkdownTableOptions | undefined {
    return cloneTableOptions(this._tableOptions)
  }

  set tableOptions(value: MarkdownTableOptions | undefined) {
    this._tableOptions = cloneTableOptions(value)
    this.applyTableOptionsToBlocks()
  }

  get renderNode(): MarkdownOptions["renderNode"] | undefined {
    return this._renderNode
  }

  set renderNode(value: MarkdownOptions["renderNode"] | undefined) {
    if (this.isDestroyed || this._renderNode === value) return
    this.assertMutable()
    this._renderNode = value
    this.clearBlockStates()
    this._parseState = null
    this.updateBlocks(true)
    this.requestRender()
  }

  get internalBlockMode(): "coalesced" | "top-level" {
    return this._internalBlockMode
  }

  set internalBlockMode(value: "coalesced" | "top-level") {
    if (this.isDestroyed || this._internalBlockMode === value) return
    this.assertMutable()
    this._internalBlockMode = value
    this.updateBlocks(true)
    this.requestRender()
  }

  get inlineHook(): MarkdownInlineHook | undefined {
    return this._inlineHook
  }

  set inlineHook(value: MarkdownInlineHook | undefined) {
    if (this._inlineHook === value) return
    this._inlineHook = value
    this.rehook()
  }

  get inlineHookFilter(): readonly string[] | undefined {
    return this._inlineHookFilter
  }

  set inlineHookFilter(value: readonly string[] | undefined) {
    if (this._inlineHookFilter === value) return
    this._inlineHookFilter = value
    this.rehook()
  }

  /**
   * Runs the inline hook again on the shown blocks and table cells whose source `select` accepts, for a change only
   * the hook knows about, such as a new title for an ID it links. Nothing is parsed again; a block keeps its text
   * until its new text is ready. Does nothing without a hook.
   */
  public rerunInlineHook(select: (source: string) => boolean): void {
    if (!this._inlineHook) return
    this.visitShownBlocks((renderable, token, state) => {
      if (this.isOwnedTable(renderable, token)) {
        const cells = [...token.header, ...token.rows.flat()]
        if (cells.some((cell) => select(cell.text))) this.refreshTable(renderable, token, state)
        return false
      }
      if (
        renderable instanceof CodeRenderable &&
        renderable.onChunks === this._linkifyMarkdownChunks &&
        select(renderable.content)
      ) {
        // A new callback marks the block for a new highlight; it keeps its text until that lands.
        renderable.onChunks = undefined
        renderable.onChunks = this._linkifyMarkdownChunks
      }
      return true
    })
    this.requestRender()
  }

  // Lists in coalesced mode render on their own while a hook is set, so the blocks are built again, as for a style.
  private rehook(): void {
    const previous = this._linkifyMarkdownChunks
    this._linkifyMarkdownChunks = (chunks, context) => this.hookHighlightedChunks(chunks, context)
    this.visitShownBlocks((renderable) => {
      if (renderable instanceof CodeRenderable && renderable.onChunks === previous) {
        renderable.onChunks = this._linkifyMarkdownChunks
      }
      return true
    })
    this.markStyleDirty()
  }

  private hookHighlightedChunks(chunks: TextChunk[], context: ChunkRenderContext): TextChunk[] {
    const linked = detectLinks(chunks, context)
    if (!this.hooks(context.content)) return linked
    const raw = context.highlights.filter(([, , group]) => group === "markup.raw" || group.startsWith("markup.raw."))
    const code = new Set<TextChunk>()
    chunks.forEach((chunk, index) => {
      const source = context.sourceRanges?.[index]
      if (source && raw.some(([start, end]) => start <= source.start && source.end <= end)) code.add(chunk)
    })
    return this.runInlineHook(linked, context.content, false, (chunk) => code.has(chunk))
  }

  private hooks(source: string): boolean {
    if (!this._inlineHook) return false
    return !this._inlineHookFilter || this._inlineHookFilter.some((text) => source.includes(text))
  }

  /** `chunks` of `source` as the inline hook rewrites them. */
  private runInlineHook(
    chunks: TextChunk[],
    source: string,
    tableCell: boolean,
    code: (chunk: TextChunk, index: number) => boolean = (chunk) => this._codeChunks.has(chunk),
  ): TextChunk[] {
    if (!this.hooks(source)) return chunks
    const spans = chunks.map((chunk, index) => {
      const { text, fg, bg, attributes, link } = chunk
      return { text, fg, bg, attributes, link, code: code(chunk, index) }
    })
    const context = { source, conceal: this._conceal, syntaxStyle: this._syntaxStyle, tableCell }
    return this._inlineHook!(spans, context).map(({ text, fg, bg, attributes, link }) => {
      return { __isChunk: true, text, fg, bg, attributes, link }
    })
  }

  private hookPreview(preview: StyledText | undefined, source: string): StyledText | undefined {
    return preview && this.hooks(source) ? new StyledText(this.runInlineHook(preview.chunks, source, false)) : preview
  }

  private getStyle(group: string): StyleDefinition | undefined {
    // The solid reconciler applies props via setters in JSX declaration order.
    // If `content` is set before `syntaxStyle`, updateBlocks() runs before
    // _syntaxStyle is initialized.
    if (!this._syntaxStyle) return undefined
    let style = this._syntaxStyle.getStyle(group)
    if (!style && group.includes(".")) {
      const baseName = group.split(".")[0]
      style = this._syntaxStyle.getStyle(baseName)
    }
    return style
  }

  private createChunk(text: string, group: string, link?: { url: string }): TextChunk {
    const chunk = this.createStyledChunk(text, group, link)
    if (group === "markup.raw") this._codeChunks.add(chunk)
    return chunk
  }

  private createStyledChunk(text: string, group: string, link?: { url: string }): TextChunk {
    if (this._previewBase) {
      // A block's base highlight lies under its groups, as the highlighted text has it.
      const style = this._syntaxStyle.mergeStyles(this._previewBase, ...(group === "default" ? [] : [group]))
      return { __isChunk: true, text, fg: style.fg, bg: style.bg, attributes: style.attributes, link }
    }
    const style = this.getStyle(group) || this.getStyle("default")
    return {
      __isChunk: true,
      text,
      fg: style?.fg,
      bg: style?.bg,
      attributes: style
        ? createTextAttributes({
            bold: style.bold,
            italic: style.italic,
            underline: style.underline,
            dim: style.dim,
          })
        : 0,
      link,
    }
  }

  private createDefaultChunk(text: string, link?: { url: string }): TextChunk {
    return this.createChunk(text, "default", link)
  }

  private createInitialStyledText(token: MarkedToken, baseHighlight?: string): StyledText | undefined {
    if (!this._streaming) return undefined

    const chunks: TextChunk[] = []
    this._previewBase = baseHighlight
    try {
      if ("tokens" in token && Array.isArray(token.tokens)) {
        this.renderInlineContent(token.tokens, chunks)
      }

      if (chunks.length === 0 && "text" in token && typeof token.text === "string") {
        this.renderInlineContent(Lexer.lexInline(token.text), chunks)
      }
    } finally {
      this._previewBase = undefined
    }

    return chunks.length > 0 ? new StyledText(chunks) : undefined
  }

  private renderInlineContent(tokens: Token[], chunks: TextChunk[], link?: { url: string }): void {
    for (const token of tokens) {
      this.renderInlineToken(token as MarkedToken, chunks, link)
    }
  }

  private renderInlineToken(token: MarkedToken, chunks: TextChunk[], link?: { url: string }): void {
    switch (token.type) {
      case "text":
        chunks.push(this.createDefaultChunk(token.text, link))
        break

      case "escape":
        // The highlighted text keeps the backslash too.
        chunks.push(this.createDefaultChunk(token.raw, link))
        break

      case "codespan":
        if (this._conceal) {
          chunks.push(this.createChunk(token.text, "markup.raw"))
        } else {
          chunks.push(this.createChunk("`", "markup.raw"))
          chunks.push(this.createChunk(token.text, "markup.raw"))
          chunks.push(this.createChunk("`", "markup.raw"))
        }
        break

      case "strong":
        if (!this._conceal) {
          chunks.push(this.createChunk("**", "markup.strong", link))
        }
        for (const child of token.tokens) {
          this.renderInlineTokenWithStyle(child as MarkedToken, chunks, "markup.strong", link)
        }
        if (!this._conceal) {
          chunks.push(this.createChunk("**", "markup.strong", link))
        }
        break

      case "em":
        if (!this._conceal) {
          chunks.push(this.createChunk("*", "markup.italic", link))
        }
        for (const child of token.tokens) {
          this.renderInlineTokenWithStyle(child as MarkedToken, chunks, "markup.italic", link)
        }
        if (!this._conceal) {
          chunks.push(this.createChunk("*", "markup.italic", link))
        }
        break

      case "del":
        if (!this._conceal) {
          chunks.push(this.createChunk("~~", "markup.strikethrough", link))
        }
        for (const child of token.tokens) {
          this.renderInlineTokenWithStyle(child as MarkedToken, chunks, "markup.strikethrough", link)
        }
        if (!this._conceal) {
          chunks.push(this.createChunk("~~", "markup.strikethrough", link))
        }
        break

      case "link": {
        const linkHref = { url: token.href }
        if (this._conceal) {
          for (const child of token.tokens) {
            this.renderInlineTokenWithStyle(child as MarkedToken, chunks, "markup.link.label", linkHref)
          }
          if (
            (this.ctx.capabilities?.hyperlinks !== true || !isSupportedLinkTarget(token.href)) &&
            token.text !== token.href &&
            token.raw !== token.text &&
            token.raw !== `<${token.text}>`
          ) {
            chunks.push(this.createChunk(" (", "markup.link", linkHref))
            chunks.push(this.createChunk(token.href, "markup.link.url", linkHref))
            chunks.push(this.createChunk(")", "markup.link", linkHref))
          }
        } else if (token.raw === token.text || token.raw === `<${token.text}>`) {
          if (token.raw.startsWith("<")) chunks.push(this.createChunk("<", "markup.link", linkHref))
          for (const child of token.tokens) {
            this.renderInlineTokenWithStyle(child as MarkedToken, chunks, "markup.link.label", linkHref)
          }
          if (token.raw.startsWith("<")) chunks.push(this.createChunk(">", "markup.link", linkHref))
        } else {
          chunks.push(this.createChunk("[", "markup.link", linkHref))
          for (const child of token.tokens) {
            this.renderInlineTokenWithStyle(child as MarkedToken, chunks, "markup.link.label", linkHref)
          }
          chunks.push(this.createChunk("](", "markup.link", linkHref))
          chunks.push(this.createChunk(token.href, "markup.link.url", linkHref))
          chunks.push(this.createChunk(")", "markup.link", linkHref))
        }
        break
      }

      case "image": {
        const imageHref = link ?? { url: token.href }
        if (this._conceal) {
          chunks.push(this.createChunk(token.text || "image", "markup.link.label", imageHref))
        } else {
          chunks.push(this.createChunk("![", "markup.link", imageHref))
          chunks.push(this.createChunk(token.text || "", "markup.link.label", imageHref))
          chunks.push(this.createChunk("](", "markup.link", imageHref))
          chunks.push(this.createChunk(token.href, "markup.link.url", imageHref))
          chunks.push(this.createChunk(")", "markup.link", imageHref))
        }
        break
      }

      case "br":
        chunks.push(this.createDefaultChunk("\n", link))
        break

      default:
        if ("tokens" in token && Array.isArray(token.tokens)) {
          this.renderInlineContent(token.tokens, chunks, link)
        } else if ("text" in token && typeof token.text === "string") {
          chunks.push(this.createDefaultChunk(token.text, link))
        }
        break
    }
  }

  private renderInlineTokenWithStyle(
    token: MarkedToken,
    chunks: TextChunk[],
    styleGroup: string,
    link?: { url: string },
  ): void {
    switch (token.type) {
      case "text":
        chunks.push(this.createChunk(token.text, styleGroup, link))
        break

      case "escape":
        chunks.push(this.createChunk(token.raw, styleGroup, link))
        break

      case "codespan":
        if (this._conceal) {
          chunks.push(this.createChunk(token.text, "markup.raw", link))
        } else {
          chunks.push(this.createChunk("`", "markup.raw", link))
          chunks.push(this.createChunk(token.text, "markup.raw", link))
          chunks.push(this.createChunk("`", "markup.raw", link))
        }
        break

      default:
        this.renderInlineToken(token, chunks, link)
        break
    }
  }

  private addMarkdownLinkHighlights(highlights: SimpleHighlight[], content: string): SimpleHighlight[] {
    if (!highlights.some(([, , group]) => group === "markup.link.url" || group === "string.special.url")) {
      return highlights
    }

    const modified = [...highlights]
    const labels = new Map<number, SimpleHighlight>()
    const bracketConceals = new Map<number, number>()
    const closings: SimpleHighlight[] = []

    for (let index = 0; index < highlights.length; index++) {
      const highlight = highlights[index]!
      const [start, end, group, meta] = highlight
      if (group === "markup.link.label" && start < end && !labels.has(end)) labels.set(end, highlight)
      if (end === start + 1 && meta?.conceal === " " && !bracketConceals.has(start)) {
        bracketConceals.set(start, index)
      }
      if (group === "markup.link" && content.slice(start, end) === ")") closings.push(highlight)
    }

    let closingIndex = 0
    for (let index = 0; index < highlights.length; index++) {
      const [start, end, group, meta] = highlights[index]!
      if (group !== "markup.link.url" && group !== "string.special.url") continue

      let urlStart = start
      let urlEnd = end
      if (content[start] === "<" && content[end - 1] === ">") {
        urlStart++
        urlEnd--
        modified[index] = [urlStart, urlEnd, group, meta]
        if (this._conceal) {
          modified.push([start, start + 1, "conceal", { conceal: "", isInjection: true }])
          modified.push([end - 1, end, "conceal", { conceal: "", isInjection: true }])
        }
      }

      let destinationStart = start
      while (destinationStart > 0 && /\s/.test(content[destinationStart - 1]!)) destinationStart--
      if (!this._conceal || content[destinationStart - 1] !== "(" || content[destinationStart - 2] !== "]") continue

      const label = labels.get(destinationStart - 2)
      if (!label) continue
      const destination = content.slice(urlStart, urlEnd)
      const url = group === "markup.link.url" ? normalizeMarkdownLinkTarget(destination) : destination
      if (
        (this.ctx.capabilities?.hyperlinks !== true || !isSupportedLinkTarget(url)) &&
        content.slice(label[0], label[1]) !== url
      ) {
        continue
      }

      while (closingIndex < closings.length && closings[closingIndex]![0] < end) closingIndex++
      const close = closings[closingIndex]
      if (!close) continue

      const bracketConcealIndex = bracketConceals.get(destinationStart - 2)
      if (bracketConcealIndex !== undefined) {
        const [bracketStart, bracketEnd, bracketGroup, bracketMeta] = modified[bracketConcealIndex]!
        modified[bracketConcealIndex] = [bracketStart, bracketEnd, bracketGroup, { ...bracketMeta, conceal: "" }]
      }

      modified.push([destinationStart - 1, close[1], "conceal", { conceal: "", isInjection: true }])
    }

    return modified
  }

  private applyMargins(renderable: Renderable, marginTop: number, marginBottom: number): void {
    renderable.marginTop = marginTop
    renderable.marginBottom = marginBottom
  }

  private createMarkdownCodeRenderable(
    content: string,
    id: string,
    marginBottom: number = 0,
    onChunks: OnChunksCallback = this._linkifyMarkdownChunks,
    baseHighlight?: string,
    preview?: StyledText,
  ): CodeRenderable {
    const initialStyledText = this.hookPreview(preview, content)
    const renderable = new CodeRenderable(this.ctx, {
      id,
      content,
      filetype: "markdown",
      syntaxStyle: this._syntaxStyle,
      fg: this._fg,
      bg: this._bg,
      conceal: this._conceal,
      drawUnstyledText: initialStyledText !== undefined,
      streaming: true,
      initialStyledText,
      baseHighlight,
      onHighlight: this._highlightMarkdownLinks,
      onChunks,
      treeSitterClient: this.getProseClient(),
      width: "100%",
      marginBottom,
    })
    return renderable
  }

  /**
   * The highlighter for prose, which gets each `$` as `%`, punctuation as well (`\%` is an escape as `\$` is): two
   * dollars would make tree-sitter-markdown read a LaTeX span and drop every style between them, as the preview never
   * does.
   */
  private getProseClient(): TreeSitterClient {
    this._proseClient ??= new Proxy(this._treeSitterClient ?? getTreeSitterClient(), {
      get: (target, property) => {
        if (property === "highlightOnce") {
          return (content: string, filetype: string) => target.highlightOnce(content.replaceAll("$", "%"), filetype)
        }
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    return this._proseClient
  }

  private getBlockquoteBorderColor(): ColorInput {
    return this.getStyle("conceal")?.fg ?? this.getStyle("default")?.fg ?? this._fg ?? "#FFFFFF"
  }

  private createBlockquoteRenderable(token: MarkedToken, id: string, marginBottom: number = 0): BoxRenderable {
    const renderable = new BoxRenderable(this.ctx, {
      id,
      width: "100%",
      // An empty quote still shows its bar.
      minHeight: 1,
      border: ["left"],
      borderColor: this.getBlockquoteBorderColor(),
      paddingLeft: 1,
      flexShrink: 0,
      marginBottom,
    })
    this._ownedStructuredRenderables.add(renderable)

    try {
      this.applyChildBlocks(renderable, (token as Tokens.Blockquote).tokens, [], id, "markup.quote")
      return renderable
    } catch (error) {
      try {
        renderable.destroyRecursively()
      } catch {
        // Preserve the construction failure.
      }
      throw error
    }
  }

  private createListRenderable(token: Tokens.List, id: string, marginBottom: number = 0): BoxRenderable {
    const list = new BoxRenderable(this.ctx, {
      id,
      width: "100%",
      flexDirection: "column",
      flexShrink: 0,
      marginBottom,
    })
    this._ownedStructuredRenderables.add(list)

    try {
      for (const item of this.getListItemInputs(token, id)) {
        list.add(this.createListItemRenderable(item))
      }
      return list
    } catch (error) {
      try {
        list.destroyRecursively()
      } catch {
        // Preserve the construction failure.
      }
      throw error
    }
  }

  private getListItemInputs(token: Tokens.List, id: string): ListItemRenderInput[] {
    const items = token.items ?? []
    const start = token.start === "" || token.start === undefined || token.start === null ? 1 : Number(token.start)
    const markerWidth = Math.max(1, ...items.map((_, index) => (token.ordered ? `${start + index}.` : "-").length))

    return items.map((item, index) => ({
      item,
      marker: token.ordered ? `${start + index}.` : "-",
      markerWidth,
      id: `${id}-item-${index}`,
    }))
  }

  private applyListRenderable(
    renderable: Renderable,
    token: Tokens.List,
    previousToken: Tokens.List | undefined,
    id: string,
    marginBottom: number = 0,
  ): boolean {
    if (!(renderable instanceof BoxRenderable)) return false

    renderable.marginBottom = marginBottom

    const inputs = this.getListItemInputs(token, id)
    const previousItems = previousToken?.items ?? []
    const rows = renderable.getChildren()

    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index]
      const existing = rows[index]

      if (existing instanceof BoxRenderable && this.applyListItemRenderable(existing, input, previousItems[index])) {
        continue
      }

      existing?.destroyRecursively()
      renderable.add(this.createListItemRenderable(input), index)
    }

    for (let index = rows.length - 1; index >= inputs.length; index -= 1) {
      rows[index]?.destroyRecursively()
    }

    return true
  }

  private createListItemRenderable(input: ListItemRenderInput): BoxRenderable {
    const row = new BoxRenderable(this.ctx, {
      id: input.id,
      width: "100%",
      flexDirection: "row",
      flexShrink: 0,
      marginBottom: /\n[ \t]*\n$/.test(input.item.raw) ? 1 : 0,
    })
    try {
      row.add(
        new TextRenderable(this.ctx, {
          id: `${input.id}-marker`,
          content: new StyledText([this.createChunk(input.marker.padStart(input.markerWidth) + " ", "markup.list")]),
          width: input.markerWidth + 1,
          flexShrink: 0,
        }),
      )

      const content = new BoxRenderable(this.ctx, {
        id: `${input.id}-content`,
        flexDirection: "column",
        flexGrow: 1,
        flexShrink: 1,
      })
      row.add(content)
      this.applyChildBlocks(content, input.item.tokens, [], input.id)
      return row
    } catch (error) {
      try {
        row.destroyRecursively()
      } catch {
        // Preserve the construction failure.
      }
      throw error
    }
  }

  private applyListItemRenderable(
    row: BoxRenderable,
    input: ListItemRenderInput,
    previousItem: Tokens.ListItem | undefined,
  ): boolean {
    this.applyListItemMarker(row, input, previousItem)

    const content = row.getChildren()[1]
    if (!(content instanceof BoxRenderable)) return false

    if (previousItem && previousItem.raw === input.item.raw) {
      return true
    }

    return this.applyChildBlocks(content, input.item.tokens, previousItem?.tokens ?? [], input.id)
  }

  /**
   * Shows `tokens`, a list item's or quote's blocks, as the children of `content`, updating each existing child in
   * place where it can. `previousTokens` are the tokens the children show now; prose children get `baseHighlight`.
   */
  private applyChildBlocks(
    content: Renderable,
    tokens: Token[],
    previousTokens: Token[],
    id: string,
    baseHighlight?: string,
  ): true {
    const previous = this.getChildBlockTokens(previousTokens)
    const children = content.getChildren()
    let childIndex = 0
    let pendingMarginTop = 0

    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
      const token = tokens[tokenIndex] as MarkedToken
      if (token.type === "checkbox") continue
      if (token.type === "space") {
        pendingMarginTop = 1
        continue
      }

      const existing = children[childIndex]
      const childId = `${id}-child-${tokenIndex}`
      const child =
        (existing && this.applyChildBlock(existing, token, previous[childIndex], childId, baseHighlight)) ??
        this.createChildBlock(token, childId, baseHighlight)
      if (!child) continue
      if (child !== existing) {
        existing?.destroyRecursively()
        content.add(child, childIndex)
      }
      this._childKinds.set(child, this.getBlockKind(token))
      child.marginTop = token.type === "list" ? 0 : pendingMarginTop
      pendingMarginTop = 0
      childIndex += 1
    }

    for (let i = children.length - 1; i >= childIndex; i -= 1) {
      children[i]?.destroyRecursively()
    }
    return true
  }

  private getChildBlockTokens(tokens: Token[]): MarkedToken[] {
    return (tokens as MarkedToken[]).filter((token) => token.type !== "checkbox" && token.type !== "space")
  }

  /** The child that shows `token` after updating `renderable` for it, or undefined to build a new one. */
  private applyChildBlock(
    renderable: Renderable,
    token: MarkedToken,
    previousToken: MarkedToken | undefined,
    id: string,
    baseHighlight?: string,
  ): Renderable | undefined {
    if (this._childKinds.get(renderable) !== this.getBlockKind(token)) return undefined

    // The kind says what the child is: prose is a CodeRenderable, a list or quote a box.
    if (this.getBlockKind(token) === "prose") {
      this.applyMarkdownCodeRenderable(
        renderable as CodeRenderable,
        this.normalizeScrollbackMarkdownBlockRaw(token.raw),
        0,
        baseHighlight,
        this.createInitialStyledText(token, baseHighlight),
      )
      return renderable
    }

    if (token.type === "list") {
      this.applyListRenderable(renderable, token as Tokens.List, previousToken as Tokens.List | undefined, id)
      return renderable
    }

    if (token.type === "code") {
      const custom = this.renderNestedCode(token, id)
      if (custom || !(renderable instanceof CodeRenderable)) return custom
      this.applyCodeBlockRenderable(renderable, token, 0)
      return renderable
    }

    if (token.type === "blockquote") {
      this.applyBlockquoteRenderable(renderable, token, previousToken, 0)
      return renderable
    }

    return previousToken?.raw === token.raw ? renderable : undefined
  }

  private createChildBlock(token: MarkedToken, id: string, baseHighlight?: string): Renderable | null {
    if (token.type === "list") return this.createListRenderable(token as Tokens.List, id)
    if (token.type === "code") return this.renderNestedCode(token, id) ?? this.createCodeRenderable(token, id)
    if (token.type === "blockquote") return this.createBlockquoteRenderable(token, id)
    if (token.type === "hr") return this.createHorizontalRuleRenderable(id)
    if (token.type === "table") return this.createTableBlock(token as Tokens.Table, id).renderable
    // Anything else is prose, as `getBlockKind` says.
    const raw = this.normalizeScrollbackMarkdownBlockRaw(token.raw)
    if (!raw) return null
    const preview = this.createInitialStyledText(token, baseHighlight)
    return this.createMarkdownCodeRenderable(raw, id, 0, this._linkifyMarkdownChunks, baseHighlight, preview)
  }

  private getBlockKind(token: MarkedToken): string {
    return ["list", "code", "blockquote", "hr", "table"].includes(token.type) ? token.type : "prose"
  }

  /** A code-block renderer's result for a fence inside a list or quote, as top-level fences get it. */
  private renderNestedCode(token: Tokens.Code, id: string): Renderable | undefined {
    if (!this.isCodeBlockOnlyRenderer()) return undefined
    const custom = this.renderCustomNode(token, () => ({ renderable: this.createCodeRenderable(token, id) }))
    if (custom.renderable !== custom.defaultResult?.renderable) return custom.renderable
    // The default code block is updated in place instead.
    custom.renderable?.destroyRecursively()
    return undefined
  }

  private applyListItemMarker(row: BoxRenderable, input: ListItemRenderInput, previousItem?: Tokens.ListItem): void {
    const marker = row.getChildren()[0]
    if (!(marker instanceof TextRenderable)) return
    const marginBottom = /\n[ \t]*\n$/.test(input.item.raw) ? 1 : 0
    const markerWidth = input.markerWidth + 1
    const markerText = input.marker.padStart(input.markerWidth) + " "

    if (row.marginBottom !== marginBottom) row.marginBottom = marginBottom
    if (marker.width !== markerWidth) marker.width = markerWidth
    if (!previousItem || marker.chunks[0]?.text !== markerText) {
      marker.content = new StyledText([this.createChunk(markerText, "markup.list")])
    }
  }

  private getHorizontalRuleColor(): ColorInput {
    return this.getStyle("conceal")?.fg ?? this._fg ?? "#888888"
  }

  private createHorizontalRuleRenderable(id: string, marginBottom: number = 0): BoxRenderable {
    return new BoxRenderable(this.ctx, {
      id,
      width: "100%",
      height: 1,
      border: ["top"],
      borderColor: this.getHorizontalRuleColor(),
      flexShrink: 0,
      marginBottom,
    })
  }

  private createCodeRenderable(token: Tokens.Code, id: string, marginBottom: number = 0): Renderable {
    return new CodeRenderable(this.ctx, {
      id,
      content: token.text,
      filetype: infoStringToFiletype(token.lang ?? ""),
      syntaxStyle: this._syntaxStyle,
      fg: this._fg,
      bg: this._bg,
      conceal: this._concealCode,
      drawUnstyledText: !this._streaming,
      streaming: this._streaming,
      treeSitterClient: this._treeSitterClient,
      width: "100%",
      marginBottom,
    })
  }

  private applyMarkdownCodeRenderable(
    renderable: CodeRenderable,
    content: string,
    marginBottom: number,
    baseHighlight?: string,
    preview?: StyledText,
  ): void {
    const initialStyledText = this.hookPreview(preview, content)
    if (initialStyledText && renderable.streaming && renderable.drawUnstyledText && renderable.isHighlighting) {
      renderable.updateStreamingPreview(content, initialStyledText)
    } else {
      renderable.initialStyledText = initialStyledText
    }
    renderable.filetype = "markdown"
    renderable.syntaxStyle = this._syntaxStyle
    renderable.fg = this._fg
    renderable.bg = this._bg
    renderable.conceal = this._conceal
    renderable.drawUnstyledText = initialStyledText !== undefined
    renderable.streaming = true
    renderable.baseHighlight = baseHighlight
    renderable.onHighlight = this._highlightMarkdownLinks
    renderable.content = content
    renderable.marginBottom = marginBottom
  }

  private applyBlockquoteRenderable(
    renderable: Renderable,
    token: MarkedToken,
    previousToken: MarkedToken | undefined,
    marginBottom: number,
  ): void {
    if (!(renderable instanceof BoxRenderable)) return

    renderable.borderColor = this.getBlockquoteBorderColor()
    renderable.marginBottom = marginBottom
    const previous = previousToken?.type === "blockquote" ? previousToken.tokens : []
    this.applyChildBlocks(renderable, (token as Tokens.Blockquote).tokens, previous, renderable.id, "markup.quote")
  }

  private applyCodeBlockRenderable(renderable: Renderable, token: Tokens.Code, marginBottom: number): void {
    if (!(renderable instanceof CodeRenderable)) return

    renderable.filetype = infoStringToFiletype(token.lang ?? "")
    renderable.syntaxStyle = this._syntaxStyle
    renderable.fg = this._fg
    renderable.bg = this._bg
    renderable.conceal = this._concealCode
    renderable.drawUnstyledText = !this._streaming
    renderable.streaming = this._streaming
    renderable.content = token.text
    renderable.marginBottom = marginBottom
  }

  private shouldRenderSeparately(token: MarkedToken): boolean {
    // While a hook is set, a list is never prose: its fences stay code and the hook sees its items.
    if (token.type === "list") return this._inlineHook !== undefined
    return token.type === "code" || token.type === "table" || token.type === "blockquote" || token.type === "hr"
  }

  private getInterBlockMargin(token: MarkedToken, nextToken: MarkedToken | undefined): number {
    if (!nextToken) return 0
    if (this.shouldRenderSeparately(token)) return 1
    if (!this.shouldRenderSeparately(nextToken)) return 0
    return TRAILING_MARKDOWN_BLOCK_NEWLINES_RE.test(token.raw) ? 0 : 1
  }

  private applyInterBlockMargin(state: BlockState, token: MarkedToken, nextToken: MarkedToken | undefined): void {
    if (state.tracksInterBlockMargin === false) return
    state.renderable.marginBottom = this.getInterBlockMargin(token, nextToken)
  }

  private createMarkdownBlockToken(raw: string): MarkedToken {
    return {
      type: "paragraph",
      raw,
      text: raw,
      tokens: [],
    } as MarkedToken
  }

  private normalizeMarkdownBlockRaw(raw: string): string {
    return raw.replace(TRAILING_MARKDOWN_BLOCK_BREAKS_RE, "\n")
  }

  private normalizeScrollbackMarkdownBlockRaw(raw: string): string {
    return raw.replace(TRAILING_MARKDOWN_BLOCK_NEWLINES_RE, "")
  }

  private isCodeBlockOnlyRenderer(): boolean {
    return (this._renderNode as MarkdownRenderNode | undefined)?.codeBlockOnly === true
  }

  private buildRenderableTokens(tokens: MarkedToken[]): MarkedToken[] {
    if (this._renderNode && !this.isCodeBlockOnlyRenderer()) {
      return tokens.filter((token) => token.type !== "space")
    }

    const renderTokens: MarkedToken[] = []
    let markdownRaw = ""

    const flushMarkdownRaw = (): void => {
      if (markdownRaw.length === 0) return
      const normalizedRaw = this.normalizeMarkdownBlockRaw(markdownRaw)
      if (normalizedRaw.length > 0) {
        renderTokens.push(this.createMarkdownBlockToken(normalizedRaw))
      }
      markdownRaw = ""
    }

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]

      if (token.type === "space") {
        if (markdownRaw.length === 0) {
          continue
        }

        let nextIndex = i + 1
        while (nextIndex < tokens.length && tokens[nextIndex].type === "space") {
          nextIndex += 1
        }

        const nextToken = tokens[nextIndex]
        if (nextToken && !this.shouldRenderSeparately(nextToken)) {
          markdownRaw += token.raw
        }
        continue
      }

      if (this.shouldRenderSeparately(token)) {
        flushMarkdownRaw()
        renderTokens.push(token)
        continue
      }

      markdownRaw += token.raw
    }

    flushMarkdownRaw()

    return renderTokens
  }

  private buildTopLevelRenderBlocks(tokens: MarkedToken[]): MarkdownRenderBlock[] {
    const blocks: MarkdownRenderBlock[] = []
    let gapBefore = ""

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]
      if (token.type === "space") {
        gapBefore += token.raw
        continue
      }

      const prev = blocks[blocks.length - 1]
      const marginTop = prev && this.shouldAddTopLevelMargin(prev.token, token, gapBefore) ? 1 : 0

      blocks.push({
        token,
        sourceTokenEnd: i + 1,
        marginTop,
      })
      gapBefore = ""
    }

    return blocks
  }

  private shouldAddTopLevelMargin(prev: MarkedToken, current: MarkedToken, gapBefore: string): boolean {
    if (this.isSeparatedTopLevelBlock(prev) || this.isSeparatedTopLevelBlock(current)) return true
    if (prev.type !== "paragraph" || current.type !== "paragraph") return false
    return TRAILING_MARKDOWN_BLOCK_BREAKS_RE.test(prev.raw + gapBefore)
  }

  private isSeparatedTopLevelBlock(token: MarkedToken): boolean {
    return token.type === "heading" || token.type === "list" || this.shouldRenderSeparately(token)
  }

  private getTableRowsToRender(table: Tokens.Table): Tokens.TableCell[][] {
    return table.rows
  }

  private hashString(value: string, seed: number): number {
    let hash = seed >>> 0
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
  }

  private hashTableToken(token: MarkedToken, seed: number, depth: number = 0): number {
    let hash = this.hashString(token.type, seed)

    if ("raw" in token && typeof token.raw === "string") {
      return this.hashString(token.raw, hash)
    }

    if ("text" in token && typeof token.text === "string") {
      hash = this.hashString(token.text, hash)
    }

    if (depth < 2 && "tokens" in token && Array.isArray(token.tokens)) {
      for (const child of token.tokens) {
        hash = this.hashTableToken(child as MarkedToken, hash, depth + 1)
      }
    }

    return hash >>> 0
  }

  private getTableCellKey(cell: Tokens.TableCell | undefined, isHeader: boolean): number {
    const seed = isHeader ? 2902232141 : 1371922141
    if (!cell) {
      return seed
    }

    if (typeof cell.text === "string") {
      return this.hashString(cell.text, seed)
    }

    if (Array.isArray(cell.tokens) && cell.tokens.length > 0) {
      let hash = seed ^ cell.tokens.length
      for (const token of cell.tokens) {
        hash = this.hashTableToken(token as MarkedToken, hash)
      }
      return hash >>> 0
    }

    return (seed ^ 2654435769) >>> 0
  }

  private createTableDataCellChunks(cell: Tokens.TableCell | undefined): TextChunk[] {
    const chunks: TextChunk[] = []
    if (cell) {
      this.renderInlineContent(cell.tokens, chunks)
    }
    return chunks.length > 0 ? this.runInlineHook(chunks, cell!.text, true) : [this.createDefaultChunk(" ")]
  }

  private createTableHeaderCellChunks(cell: Tokens.TableCell): TextChunk[] {
    const chunks: TextChunk[] = []
    this.renderInlineContent(cell.tokens, chunks)

    const baseChunks = chunks.length > 0 ? chunks : [this.createDefaultChunk(" ")]
    const headingStyle = this.getStyle("markup.heading") || this.getStyle("default")
    const headingAttributes = createTextAttributes({
      bold: headingStyle?.bold,
      italic: headingStyle?.italic,
      underline: headingStyle?.underline,
      dim: headingStyle?.dim,
    })
    const headed = headingStyle
      ? baseChunks.map((chunk) => ({
          ...chunk,
          fg: headingStyle.fg ?? chunk.fg,
          bg: headingStyle.bg ?? chunk.bg,
          attributes: headingAttributes,
        }))
      : baseChunks
    // The hook sees a header cell's content in the header style, as Rust's does.
    if (chunks.length === 0) return headed
    return this.runInlineHook(headed, cell.text, true, (_, index) => this._codeChunks.has(chunks[index]!))
  }

  private buildTableContentCache(
    table: Tokens.Table,
    previous?: TableContentCache,
    forceRegenerate: boolean = false,
  ): { cache: TableContentCache | null; changed: boolean } {
    const colCount = table.header.length
    const rowsToRender = this.getTableRowsToRender(table)
    if (colCount === 0 || rowsToRender.length === 0) {
      return { cache: null, changed: previous !== undefined }
    }

    const content: TextTableContent = []
    const cellKeys: Uint32Array[] = []
    const totalRows = rowsToRender.length + 1

    let changed = forceRegenerate || !previous

    for (let rowIndex = 0; rowIndex < totalRows; rowIndex += 1) {
      const rowContent: TextTableCellContent[] = []
      const rowKeys = new Uint32Array(colCount)

      for (let colIndex = 0; colIndex < colCount; colIndex += 1) {
        const isHeader = rowIndex === 0
        const cell = isHeader ? table.header[colIndex] : rowsToRender[rowIndex - 1]?.[colIndex]
        const cellKey = this.getTableCellKey(cell, isHeader)
        rowKeys[colIndex] = cellKey

        const previousCellKey = previous?.cellKeys[rowIndex]?.[colIndex]
        const previousCellContent = previous?.content[rowIndex]?.[colIndex]

        if (!forceRegenerate && previousCellKey === cellKey && Array.isArray(previousCellContent)) {
          rowContent.push(previousCellContent)
          continue
        }

        changed = true
        rowContent.push(
          isHeader ? this.createTableHeaderCellChunks(table.header[colIndex]) : this.createTableDataCellChunks(cell),
        )
      }

      content.push(rowContent)
      cellKeys.push(rowKeys)
    }

    if (previous && !changed) {
      if (previous.content.length !== content.length) {
        changed = true
      } else {
        for (let rowIndex = 0; rowIndex < content.length; rowIndex += 1) {
          if ((previous.content[rowIndex]?.length ?? 0) !== content[rowIndex].length) {
            changed = true
            break
          }
        }
      }
    }

    return {
      cache: {
        content,
        cellKeys,
      },
      changed,
    }
  }

  private resolveTableStyle(options: MarkdownTableOptions | undefined = this._tableOptions): MarkdownTableStyle {
    if (options?.style === "columns") {
      return "columns"
    }

    if (options?.style === "grid") {
      return "grid"
    }

    return this._internalBlockMode === "top-level" ? "columns" : "grid"
  }

  private usesBorderlessColumnSpacing(options: MarkdownTableOptions | undefined = this._tableOptions): boolean {
    const style = this.resolveTableStyle(options)
    const borders = options?.borders ?? style === "grid"

    return style === "columns" && !borders
  }

  private resolveTableRenderableOptions(): ResolvedTableRenderableOptions {
    const style = this.resolveTableStyle()
    const borders = this._tableOptions?.borders ?? style === "grid"

    return {
      columnWidthMode: this._tableOptions?.widthMode ?? (style === "columns" ? "content" : "full"),
      columnFitter: this._tableOptions?.columnFitter ?? "proportional",
      wrapMode: this._tableOptions?.wrapMode ?? "word",
      cellPadding: this._tableOptions?.cellPadding ?? 0,
      cellPaddingX: this._tableOptions?.cellPaddingX ?? this._tableOptions?.cellPadding ?? 0,
      cellPaddingY: this._tableOptions?.cellPaddingY ?? this._tableOptions?.cellPadding ?? 0,
      columnGap: this.usesBorderlessColumnSpacing() ? 2 : 0,
      border: borders,
      outerBorder: this._tableOptions?.outerBorder ?? borders,
      showBorders: borders,
      borderStyle: this._tableOptions?.borderStyle ?? "single",
      borderColor: this._tableOptions?.borderColor ?? this.getStyle("conceal")?.fg ?? "#888888",
      fg: this._fg,
      selectable: this._tableOptions?.selectable ?? true,
    }
  }

  private applyTableRenderableOptions(
    tableRenderable: TextTableRenderable,
    options: ResolvedTableRenderableOptions,
  ): void {
    tableRenderable.columnWidthMode = options.columnWidthMode
    tableRenderable.columnFitter = options.columnFitter
    tableRenderable.wrapMode = options.wrapMode
    tableRenderable.cellPaddingX = options.cellPaddingX
    tableRenderable.cellPaddingY = options.cellPaddingY
    tableRenderable.columnGap = options.columnGap
    tableRenderable.border = options.border
    tableRenderable.outerBorder = options.outerBorder
    tableRenderable.showBorders = options.showBorders
    tableRenderable.borderStyle = options.borderStyle
    tableRenderable.borderColor = options.borderColor
    tableRenderable.fg = options.fg
    tableRenderable.selectable = options.selectable
  }

  private applyTableOptionsToBlocks(): void {
    const options = this.resolveTableRenderableOptions()
    let updated = false

    for (const state of this._blockStates) {
      if (state.renderable instanceof TextTableRenderable) {
        this.applyTableRenderableOptions(state.renderable, options)
        updated = true
      }
    }

    if (updated) {
      this.requestRender()
    }
  }

  private createTextTableRenderable(
    content: TextTableContent,
    id: string,
    marginBottom: number = 0,
  ): TextTableRenderable {
    const options = this.resolveTableRenderableOptions()
    const table = new TextTableRenderable(this.ctx, {
      id,
      content,
      width: "100%",
      marginBottom,
      columnWidthMode: options.columnWidthMode,
      columnFitter: options.columnFitter,
      wrapMode: options.wrapMode,
      cellPadding: options.cellPadding,
      cellPaddingX: options.cellPaddingX,
      cellPaddingY: options.cellPaddingY,
      columnGap: options.columnGap,
      border: options.border,
      outerBorder: options.outerBorder,
      showBorders: options.showBorders,
      borderStyle: options.borderStyle,
      borderColor: options.borderColor,
      fg: options.fg,
      selectable: options.selectable,
    })
    this._ownedStructuredRenderables.add(table)
    return table
  }

  private createTableBlock(
    table: Tokens.Table,
    id: string,
    marginBottom: number = 0,
    previousCache?: TableContentCache,
    forceRegenerate: boolean = false,
  ): { renderable: Renderable; tableContentCache?: TableContentCache } {
    const { cache } = this.buildTableContentCache(table, previousCache, forceRegenerate)

    if (!cache) {
      return {
        renderable: this.createMarkdownCodeRenderable(table.raw, id, marginBottom),
      }
    }

    return {
      renderable: this.createTextTableRenderable(cache.content, id, marginBottom),
      tableContentCache: cache,
    }
  }

  private getStableBlockCount(blocks: MarkdownRenderBlock[], stableTokenCount: number): number {
    if (this._internalBlockMode !== "top-level") {
      return 0
    }

    let stableBlockCount = 0
    for (const block of blocks) {
      if (block.sourceTokenEnd <= stableTokenCount) {
        stableBlockCount += 1
        continue
      }

      break
    }

    return stableBlockCount
  }

  private syncTopLevelBlockState(
    state: BlockState,
    block: MarkdownRenderBlock,
    tableContentCache: TableContentCache | undefined = state.tableContentCache,
  ): void {
    state.token = block.token
    state.tokenRaw = block.token.raw
    state.marginTop = block.marginTop
    state.tableContentCache = tableContentCache
  }

  private getTopLevelBlockRaw(token: MarkedToken): string | undefined {
    if (!token.raw) {
      return undefined
    }

    return this.shouldRenderSeparately(token) ? token.raw : this.normalizeScrollbackMarkdownBlockRaw(token.raw)
  }

  private createTopLevelDefaultRenderable(
    block: MarkdownRenderBlock,
    index: number,
  ): { renderable: Renderable | undefined; tableContentCache?: TableContentCache; canUpdateInPlace: boolean } {
    const { token, marginTop } = block
    const id = `${this.id}-block-${index}`

    if (token.type === "code") {
      const renderable = this.createCodeRenderable(token, id)
      renderable.marginTop = marginTop
      return { renderable, canUpdateInPlace: true }
    }

    if (token.type === "table") {
      const next = this.createTableBlock(token, id)
      next.renderable.marginTop = marginTop
      return { ...next, canUpdateInPlace: true }
    }

    if (token.type === "blockquote") {
      const renderable = this.createBlockquoteRenderable(token, id)
      renderable.marginTop = marginTop
      return { renderable, canUpdateInPlace: true }
    }

    if (token.type === "list") {
      const renderable = this.createListRenderable(token, id)
      renderable.marginTop = marginTop
      return { renderable, canUpdateInPlace: true }
    }

    if (token.type === "hr") {
      const renderable = this.createHorizontalRuleRenderable(id)
      renderable.marginTop = marginTop
      return { renderable, canUpdateInPlace: true }
    }

    const markdownRaw = this.getTopLevelBlockRaw(token)
    if (!markdownRaw) {
      return { renderable: undefined, canUpdateInPlace: true }
    }

    const renderable = this.createMarkdownCodeRenderable(
      markdownRaw,
      id,
      0,
      this._linkifyMarkdownChunks,
      undefined,
      this.createInitialStyledText(token),
    )
    renderable.marginTop = marginTop
    return { renderable, canUpdateInPlace: true }
  }

  private createTopLevelRenderable(
    block: MarkdownRenderBlock,
    index: number,
  ): { renderable: Renderable | undefined; tableContentCache?: TableContentCache; canUpdateInPlace: boolean } {
    if (!this._renderNode) {
      return this.createTopLevelDefaultRenderable(block, index)
    }

    const custom = this.createTopLevelCustomRenderable(block, index)
    if (!custom.renderable) return this.createTopLevelDefaultRenderable(block, index)

    const marginTop =
      typeof custom.renderable.marginTop === "number"
        ? Math.max(custom.renderable.marginTop, block.marginTop)
        : block.marginTop
    this.applyMargins(custom.renderable, marginTop, 0)

    return {
      renderable: custom.renderable,
      tableContentCache: custom.tableContentCache,
      canUpdateInPlace: custom.canUpdateInPlace,
    }
  }

  private createDefaultRenderable(token: MarkedToken, index: number, nextToken?: MarkedToken): Renderable | null {
    const id = `${this.id}-block-${index}`
    const marginBottom = this.getInterBlockMargin(token, nextToken)

    if (token.type === "code") {
      return this.createCodeRenderable(token, id, marginBottom)
    }

    if (token.type === "blockquote") {
      return this.createBlockquoteRenderable(token, id, marginBottom)
    }

    if (token.type === "list") {
      return this.createListRenderable(token as Tokens.List, id, marginBottom)
    }

    if (token.type === "hr") {
      return this.createHorizontalRuleRenderable(id, marginBottom)
    }

    if (token.type === "table") {
      return this.createTableBlock(token, id, marginBottom).renderable
    }

    if (token.type === "space") {
      return null
    }

    if (!token.raw) {
      return null
    }

    return this.createMarkdownCodeRenderable(
      token.raw,
      id,
      marginBottom,
      this._linkifyMarkdownChunks,
      undefined,
      this.createInitialStyledText(token),
    )
  }

  private createCustomRenderable(
    token: MarkedToken,
    index: number,
    nextToken: MarkedToken | undefined,
  ): CustomRenderableResult {
    const custom = this.renderCustomNode(token, () => {
      return { renderable: this.createDefaultRenderable(token, index, nextToken) }
    })
    if (!custom.renderable) {
      return { tracksInterBlockMargin: true, canUpdateInPlace: true }
    }

    const canUpdateInPlace = custom.renderable === custom.defaultResult?.renderable

    return {
      renderable: custom.renderable,
      tracksInterBlockMargin: canUpdateInPlace,
      canUpdateInPlace,
    }
  }

  private createTopLevelCustomRenderable(block: MarkdownRenderBlock, index: number): CustomRenderableResult {
    const custom = this.renderCustomNode(block.token, () => {
      return this.createTopLevelDefaultRenderable(block, index)
    })
    if (!custom.renderable) {
      return { tracksInterBlockMargin: true, canUpdateInPlace: true }
    }

    const canUpdateInPlace = custom.renderable === custom.defaultResult?.renderable

    return {
      renderable: custom.renderable,
      tableContentCache: canUpdateInPlace ? custom.defaultResult?.tableContentCache : undefined,
      tracksInterBlockMargin: canUpdateInPlace,
      canUpdateInPlace,
    }
  }

  private renderCustomNode(token: MarkedToken, createDefault: () => CustomRenderDefaultResult): RenderNodeResult {
    if (!this._renderNode) return {}

    let defaultResult: CustomRenderDefaultResult | undefined
    let custom: Renderable | null | undefined
    try {
      custom = this._renderNode(token, {
        syntaxStyle: this._syntaxStyle,
        conceal: this._conceal,
        concealCode: this._concealCode,
        treeSitterClient: this._treeSitterClient,
        defaultRender: () => {
          defaultResult = createDefault()
          return defaultResult.renderable ?? null
        },
      })
    } catch (error) {
      try {
        this.destroyUnusedDefaultRenderable(defaultResult?.renderable)
      } catch {
        // Preserve the custom renderer failure.
      }
      throw error
    }

    this.destroyUnusedDefaultRenderable(defaultResult?.renderable, custom ?? undefined)

    return custom ? { renderable: custom, defaultResult } : {}
  }

  private destroyUnusedDefaultRenderable(renderable: Renderable | null | undefined, usedRenderable?: Renderable): void {
    if (!renderable || renderable === usedRenderable || renderable.parent) return
    renderable.destroyRecursively()
  }

  private updateBlockRenderable(
    state: BlockState,
    token: MarkedToken,
    index: number,
    nextToken: MarkedToken | undefined,
    forceRefresh: boolean = false,
  ): void {
    const marginBottom = this.getInterBlockMargin(token, nextToken)

    if (token.type === "code") {
      this.applyCodeBlockRenderable(state.renderable, token as Tokens.Code, marginBottom)
      return
    }

    if (token.type === "blockquote") {
      this.applyBlockquoteRenderable(state.renderable, token, forceRefresh ? undefined : state.token, marginBottom)
      return
    }

    if (token.type === "list") {
      if (
        !this.applyListRenderable(
          state.renderable,
          token as Tokens.List,
          forceRefresh ? undefined : (state.token as Tokens.List),
          `${this.id}-block-${index}`,
          marginBottom,
        )
      ) {
        state.renderable.destroyRecursively()
        state.renderable = this.createListRenderable(token as Tokens.List, `${this.id}-block-${index}`, marginBottom)
        this.add(state.renderable, index)
      }
      return
    }

    if (token.type === "hr") {
      if (state.renderable instanceof BoxRenderable) state.renderable.borderColor = this.getHorizontalRuleColor()
      state.renderable.marginBottom = marginBottom
      return
    }

    if (token.type === "table") {
      const tableToken = token as Tokens.Table
      const { cache, changed } = this.buildTableContentCache(tableToken, state.tableContentCache, forceRefresh)

      if (!cache) {
        if (state.renderable instanceof CodeRenderable) {
          this.applyMarkdownCodeRenderable(state.renderable, tableToken.raw, marginBottom)
          state.tableContentCache = undefined
          return
        }

        state.renderable.destroyRecursively()
        const fallbackRenderable = this.createMarkdownCodeRenderable(
          tableToken.raw,
          `${this.id}-block-${index}`,
          marginBottom,
        )
        this.add(fallbackRenderable, index)
        state.renderable = fallbackRenderable
        state.tableContentCache = undefined
        return
      }

      if (state.renderable instanceof TextTableRenderable) {
        if (changed) {
          state.renderable.content = cache.content
        }
        this.applyTableRenderableOptions(state.renderable, this.resolveTableRenderableOptions())
        state.renderable.marginBottom = marginBottom
        state.tableContentCache = cache
        return
      }

      state.renderable.destroyRecursively()
      const tableRenderable = this.createTextTableRenderable(cache.content, `${this.id}-block-${index}`, marginBottom)
      this.add(tableRenderable, index)
      state.renderable = tableRenderable
      state.tableContentCache = cache
      return
    }

    const raw = this._internalBlockMode === "top-level" ? (this.getTopLevelBlockRaw(token) ?? token.raw) : token.raw
    if (state.renderable instanceof CodeRenderable) {
      this.applyMarkdownCodeRenderable(
        state.renderable,
        raw,
        marginBottom,
        undefined,
        this.createInitialStyledText(token),
      )
      return
    }

    state.renderable.destroyRecursively()
    const markdownRenderable = this.createMarkdownCodeRenderable(
      raw,
      `${this.id}-block-${index}`,
      marginBottom,
      this._linkifyMarkdownChunks,
      undefined,
      this.createInitialStyledText(token),
    )
    this.add(markdownRenderable, index)
    state.renderable = markdownRenderable
  }

  private updateTopLevelBlocks(tokens: MarkedToken[], forceTableRefresh: boolean): void {
    const blocks = this.buildTopLevelRenderBlocks(tokens)
    this._stableBlockCount = this.getStableBlockCount(blocks, this._parseState?.stableTokenCount ?? 0)

    let blockIndex = 0
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i]
      const existing = this._blockStates[blockIndex]

      if (existing && existing.token === block.token && !forceTableRefresh) {
        if (existing.marginTop !== block.marginTop) {
          this.applyMargins(existing.renderable, block.marginTop, 0)
        }
        this.syncTopLevelBlockState(existing, block)
        blockIndex++
        continue
      }

      if (
        existing &&
        existing.tokenRaw === block.token.raw &&
        existing.token.type === block.token.type &&
        !forceTableRefresh
      ) {
        if (existing.marginTop !== block.marginTop) {
          this.applyMargins(existing.renderable, block.marginTop, 0)
        }
        this.syncTopLevelBlockState(existing, block)
        blockIndex++
        continue
      }

      if (
        existing &&
        existing.canUpdateInPlace &&
        existing.token.type === block.token.type &&
        (block.token.type !== "table" ||
          block.token.rows.length > 0 === existing.renderable instanceof TextTableRenderable)
      ) {
        if (this._renderNode) {
          const custom = this.createTopLevelCustomRenderable(block, blockIndex)
          if (custom.renderable && !custom.canUpdateInPlace) {
            const marginTop =
              typeof custom.renderable.marginTop === "number"
                ? Math.max(custom.renderable.marginTop, block.marginTop)
                : block.marginTop
            this.applyMargins(custom.renderable, marginTop, 0)
            if (custom.renderable !== existing.renderable) {
              existing.renderable.destroyRecursively()
              this.add(custom.renderable, blockIndex)
            }
            this._blockStates[blockIndex] = {
              token: block.token,
              tokenRaw: block.token.raw,
              marginTop: block.marginTop,
              renderable: custom.renderable,
              tableContentCache: custom.tableContentCache,
              canUpdateInPlace: custom.canUpdateInPlace,
            }
            blockIndex++
            continue
          }
          this.destroyUnusedDefaultRenderable(custom.renderable)
        }

        // A forced refresh restyles lists even when their items are unchanged, matching coalesced mode.
        this.updateBlockRenderable(existing, block.token, blockIndex, blocks[i + 1]?.token, forceTableRefresh)
        existing.renderable.marginBottom = 0
        if (existing.marginTop !== block.marginTop) {
          this.applyMargins(existing.renderable, block.marginTop, 0)
        }
        this.syncTopLevelBlockState(existing, block)
        blockIndex++
        continue
      }

      if (existing) {
        existing.renderable.destroyRecursively()
      }

      const next = this.createTopLevelRenderable(block, blockIndex)
      if (next.renderable) {
        this.add(next.renderable, blockIndex)
        this._blockStates[blockIndex] = {
          token: block.token,
          tokenRaw: block.token.raw,
          marginTop: block.marginTop,
          renderable: next.renderable,
          tableContentCache: next.tableContentCache,
          canUpdateInPlace: next.canUpdateInPlace,
        }
      }
      blockIndex++
    }

    while (this._blockStates.length > blockIndex) {
      const removed = this._blockStates.pop()!
      removed.renderable.destroyRecursively()
    }
  }

  private updateBlocks(forceTableRefresh: boolean = false): void {
    if (this.isDestroyed) return
    if (!this._content) {
      this.clearBlockStates()
      this._parseState = null
      this._stableBlockCount = 0
      return
    }

    // A style change keeps the parse: a re-lex of the tail alone loses earlier link definitions.
    if (this._parseState?.content !== this._content) {
      this._parseState = parseMarkdownIncremental(this._content, this._parseState, this._streaming ? 2 : 0)
    }

    const tokens = this._parseState.tokens

    if (tokens.length === 0 && this._content.length > 0) {
      this.clearBlockStates()
      this._stableBlockCount = 0
      const fallback = this.createMarkdownCodeRenderable(this._content, `${this.id}-fallback`)
      this.add(fallback)
      this._blockStates = [
        {
          token: { type: "text", raw: this._content, text: this._content } as MarkedToken,
          tokenRaw: this._content,
          marginTop: 0,
          renderable: fallback,
          tracksInterBlockMargin: true,
          canUpdateInPlace: true,
        },
      ]
      return
    }

    if (this._internalBlockMode === "top-level") {
      this.updateTopLevelBlocks(tokens, forceTableRefresh)
      return
    }

    this._stableBlockCount = 0
    const blockTokens = this.buildRenderableTokens(tokens)
    let blockIndex = 0
    for (let i = 0; i < blockTokens.length; i++) {
      const token = blockTokens[i]
      const nextToken = blockTokens[i + 1]
      const existing = this._blockStates[blockIndex]

      // A forced refresh of a custom node falls through to the create arm, so renderNode runs again.
      if (
        existing &&
        existing.tokenRaw === token.raw &&
        existing.token.type === token.type &&
        (existing.canUpdateInPlace || !forceTableRefresh)
      ) {
        existing.token = token
        if (forceTableRefresh) {
          this.updateBlockRenderable(existing, token, blockIndex, nextToken, true)
        } else {
          this.applyInterBlockMargin(existing, token, nextToken)
        }
        blockIndex++
        continue
      }

      if (existing && existing.canUpdateInPlace && existing.token.type === token.type) {
        const custom = this.createCustomRenderable(token, blockIndex, nextToken)
        if (custom.renderable && !custom.canUpdateInPlace) {
          if (custom.renderable !== existing.renderable) {
            existing.renderable.destroyRecursively()
            this.add(custom.renderable, blockIndex)
          }
          this._blockStates[blockIndex] = {
            token,
            tokenRaw: token.raw,
            renderable: custom.renderable,
            tracksInterBlockMargin: custom.tracksInterBlockMargin,
            canUpdateInPlace: custom.canUpdateInPlace,
          }
          blockIndex++
          continue
        }
        this.destroyUnusedDefaultRenderable(custom.renderable)

        this.updateBlockRenderable(existing, token, blockIndex, nextToken)
        existing.token = token
        existing.tokenRaw = token.raw
        existing.tracksInterBlockMargin = true
        blockIndex++
        continue
      }

      if (existing) {
        existing.renderable.destroyRecursively()
      }

      let renderable: Renderable | undefined
      let tableContentCache: TableContentCache | undefined
      let tracksInterBlockMargin = true
      let canUpdateInPlace = true

      const custom = this.createCustomRenderable(token, blockIndex, nextToken)
      if (custom.renderable) {
        renderable = custom.renderable
        tracksInterBlockMargin = custom.tracksInterBlockMargin
        canUpdateInPlace = custom.canUpdateInPlace
      }

      if (!renderable) {
        if (token.type === "table") {
          const tableBlock = this.createTableBlock(
            token,
            `${this.id}-block-${blockIndex}`,
            this.getInterBlockMargin(token, nextToken),
          )
          renderable = tableBlock.renderable
          tableContentCache = tableBlock.tableContentCache
        } else {
          renderable = this.createDefaultRenderable(token, blockIndex, nextToken) ?? undefined
        }
      }

      if (token.type === "table" && !tableContentCache && renderable instanceof TextTableRenderable) {
        const { cache } = this.buildTableContentCache(token as Tokens.Table)
        tableContentCache = cache ?? undefined
      }

      if (renderable) {
        this.add(renderable, blockIndex)
        this._blockStates[blockIndex] = {
          token,
          tokenRaw: token.raw,
          renderable,
          tableContentCache,
          tracksInterBlockMargin,
          canUpdateInPlace,
        }
      }
      blockIndex++
    }

    while (this._blockStates.length > blockIndex) {
      const removed = this._blockStates.pop()!
      removed.renderable.destroyRecursively()
    }
  }

  private clearBlockStates(): void {
    for (const state of this._blockStates) {
      state.renderable.destroyRecursively()
    }
    this._blockStates = []
    this._stableBlockCount = 0
  }

  public clearCache(): void {
    this._parseState = null
    this.clearBlockStates()
    this.updateBlocks()
    this.requestRender()
  }

  public refreshStyles(): void {
    this._styleDirty = false
    this._ctx.nativeScene.lifecyclePasses.refresh(this)
    this.updateBlocks(true)
    this.requestRender()
  }

  // Style changes rebuild blocks before layout, so new blocks paint in the same frame.
  private markStyleDirty(): void {
    this._styleDirty = true
    this._ctx.nativeScene.lifecyclePasses.refresh(this)
  }

  private rerenderDirtyStyles(): void {
    if (!this._styleDirty) return
    this._styleDirty = false
    this._ctx.nativeScene.lifecyclePasses.refresh(this)
    this.updateBlocks(true)
  }

  override _needsLifecyclePass(): boolean {
    if (this.onLifecyclePass !== this.applyStyleChanges) return super._needsLifecyclePass()
    return this._styleDirty
  }

  protected destroySelf(): void {
    const subscription = MarkdownRenderable._capabilitySubscriptions.get(this.ctx)
    if (subscription) {
      subscription.renderables.delete(this)
      if (subscription.renderables.size === 0) {
        this.ctx.off("capabilities", subscription.listener)
        MarkdownRenderable._capabilitySubscriptions.delete(this.ctx)
      }
    }
    super.destroySelf()
  }
}
