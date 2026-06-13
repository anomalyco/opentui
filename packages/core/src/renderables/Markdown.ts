import { Renderable, type RenderableOptions } from "../Renderable.js"
import { type RenderContext } from "../types.js"
import { SyntaxStyle, type StyleDefinition } from "../syntax-style.js"
import type { TextChunk } from "../text-buffer.js"
import { createTextAttributes } from "../utils.js"
import type { BorderStyle } from "../lib/border.js"
import { RGBA, parseColor, type ColorInput } from "../lib/RGBA.js"
import { Lexer, type MarkedToken, type Token, type Tokens } from "marked"
import { CodeRenderable, type OnChunksCallback } from "./Code.js"
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
import type { TreeSitterClient } from "../lib/tree-sitter/index.js"
import { infoStringToFiletype } from "../lib/tree-sitter/resolve-ft.js"
import { parseMarkdownIncremental, type ParseState } from "./markdown-parser.js"
import type { OptimizedBuffer } from "../buffer.js"
import { detectLinks } from "../lib/detect-links.js"

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
}

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
  selectable: boolean
}

const TRAILING_MARKDOWN_BLOCK_BREAKS_RE = /(?:\r?\n){2,}$/
const TRAILING_MARKDOWN_BLOCK_NEWLINES_RE = /(?:\r?\n)+$/

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

interface ListItemRenderInput {
  item: Tokens.ListItem
  marker: string
  markerWidth: number
  id: string
}

export class MarkdownRenderable extends Renderable {
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
  private _linkifyMarkdownChunks: OnChunksCallback = (chunks, context) =>
    detectLinks(chunks, {
      content: context.content,
      highlights: context.highlights,
    })

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

    this._syntaxStyle = options.syntaxStyle
    this._fg = options.fg ? parseColor(options.fg) : undefined
    this._bg = options.bg ? parseColor(options.bg) : undefined
    this._conceal = options.conceal ?? this._contentDefaultOptions.conceal
    this._concealCode = options.concealCode ?? this._contentDefaultOptions.concealCode
    this._content = options.content ?? this._contentDefaultOptions.content
    this._treeSitterClient = options.treeSitterClient
    this._tableOptions = options.tableOptions
    this._renderNode = options.renderNode
    this._streaming = options.streaming ?? this._contentDefaultOptions.streaming
    this._internalBlockMode = options.internalBlockMode ?? this._contentDefaultOptions.internalBlockMode

    this.updateBlocks()
  }

  get content(): string {
    return this._content
  }

  set content(value: string) {
    if (this.isDestroyed) return
    if (this._content !== value) {
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
      // Mark dirty - actual re-render happens in renderSelf
      this._styleDirty = true
    }
  }

  get fg(): RGBA | undefined {
    return this._fg
  }

  set fg(value: ColorInput | undefined) {
    const next = value ? parseColor(value) : undefined
    if (!colorsEqual(this._fg, next)) {
      this._fg = next
      this._styleDirty = true
    }
  }

  get bg(): RGBA | undefined {
    return this._bg
  }

  set bg(value: ColorInput | undefined) {
    const next = value ? parseColor(value) : undefined
    if (!colorsEqual(this._bg, next)) {
      this._bg = next
      this._styleDirty = true
    }
  }

  get conceal(): boolean {
    return this._conceal
  }

  set conceal(value: boolean) {
    if (this._conceal !== value) {
      this._conceal = value
      // Mark dirty - actual re-render happens in renderSelf
      this._styleDirty = true
    }
  }

  get concealCode(): boolean {
    return this._concealCode
  }

  set concealCode(value: boolean) {
    if (this._concealCode !== value) {
      this._concealCode = value
      // Mark dirty - actual re-render happens in renderSelf
      this._styleDirty = true
    }
  }

  get streaming(): boolean {
    return this._streaming
  }

  set streaming(value: boolean) {
    if (this.isDestroyed) return
    if (this._streaming !== value) {
      this._streaming = value
      this.updateBlocks(true)
    }
  }

  get tableOptions(): MarkdownTableOptions | undefined {
    return this._tableOptions
  }

  set tableOptions(value: MarkdownTableOptions | undefined) {
    this._tableOptions = value
    this.applyTableOptionsToBlocks()
  }

  get renderNode(): MarkdownOptions["renderNode"] | undefined {
    return this._renderNode
  }

  set renderNode(value: MarkdownOptions["renderNode"] | undefined) {
    if (this._renderNode === value) return
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
    if (this._internalBlockMode === value) return
    this._internalBlockMode = value
    this.updateBlocks(true)
    this.requestRender()
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

  private createDefaultChunk(text: string): TextChunk {
    return this.createChunk(text, "default")
  }

  private createInitialStyledText(token: MarkedToken): StyledText | undefined {
    if (!this._streaming) return undefined

    const chunks: TextChunk[] = []
    if ("tokens" in token && Array.isArray(token.tokens)) {
      this.renderInlineContent(token.tokens, chunks)
    }

    if (chunks.length === 0 && "text" in token && typeof token.text === "string") {
      this.renderInlineContent(Lexer.lexInline(token.text), chunks)
    }

    return chunks.length > 0 ? new StyledText(chunks) : undefined
  }

  private renderInlineContent(tokens: Token[], chunks: TextChunk[]): void {
    for (const token of tokens) {
      this.renderInlineToken(token as MarkedToken, chunks)
    }
  }

  private renderInlineToken(token: MarkedToken, chunks: TextChunk[]): void {
    switch (token.type) {
      case "text":
        chunks.push(this.createDefaultChunk(token.text))
        break

      case "escape":
        chunks.push(this.createDefaultChunk(token.text))
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
          chunks.push(this.createChunk("**", "markup.strong"))
        }
        for (const child of token.tokens) {
          this.renderInlineTokenWithStyle(child as MarkedToken, chunks, "markup.strong")
        }
        if (!this._conceal) {
          chunks.push(this.createChunk("**", "markup.strong"))
        }
        break

      case "em":
        if (!this._conceal) {
          chunks.push(this.createChunk("*", "markup.italic"))
        }
        for (const child of token.tokens) {
          this.renderInlineTokenWithStyle(child as MarkedToken, chunks, "markup.italic")
        }
        if (!this._conceal) {
          chunks.push(this.createChunk("*", "markup.italic"))
        }
        break

      case "del":
        if (!this._conceal) {
          chunks.push(this.createChunk("~~", "markup.strikethrough"))
        }
        for (const child of token.tokens) {
          this.renderInlineTokenWithStyle(child as MarkedToken, chunks, "markup.strikethrough")
        }
        if (!this._conceal) {
          chunks.push(this.createChunk("~~", "markup.strikethrough"))
        }
        break

      case "link": {
        const linkHref = { url: token.href }
        if (this._conceal) {
          for (const child of token.tokens) {
            this.renderInlineTokenWithStyle(child as MarkedToken, chunks, "markup.link.label", linkHref)
          }
          chunks.push(this.createChunk(" (", "markup.link", linkHref))
          chunks.push(this.createChunk(token.href, "markup.link.url", linkHref))
          chunks.push(this.createChunk(")", "markup.link", linkHref))
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
        const imageHref = { url: token.href }
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
        chunks.push(this.createDefaultChunk("\n"))
        break

      default:
        if ("tokens" in token && Array.isArray(token.tokens)) {
          this.renderInlineContent(token.tokens, chunks)
        } else if ("text" in token && typeof token.text === "string") {
          chunks.push(this.createDefaultChunk(token.text))
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
        chunks.push(this.createChunk(token.text, styleGroup, link))
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
        this.renderInlineToken(token, chunks)
        break
    }
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
    initialStyledText?: StyledText,
  ): CodeRenderable {
    return new CodeRenderable(this.ctx, {
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
      onChunks,
      treeSitterClient: this._treeSitterClient,
      width: "100%",
      marginBottom,
    })
  }

  private getBlockquoteContent(token: MarkedToken): string {
    return "text" in token && typeof token.text === "string" && token.text ? token.text : " "
  }

  private getBlockquoteBorderColor(): ColorInput {
    return this.getStyle("conceal")?.fg ?? this.getStyle("default")?.fg ?? this._fg ?? "#FFFFFF"
  }

  private createBlockquoteRenderable(token: MarkedToken, id: string, marginBottom: number = 0): BoxRenderable {
    const renderable = new BoxRenderable(this.ctx, {
      id,
      width: "100%",
      border: ["left"],
      borderColor: this.getBlockquoteBorderColor(),
      paddingLeft: 1,
      flexShrink: 0,
      marginBottom,
    })

    renderable.add(
      this.createMarkdownCodeRenderable(
        this.getBlockquoteContent(token),
        `${id}-content`,
        0,
        this._linkifyMarkdownChunks,
        "markup.quote",
      ),
    )

    return renderable
  }

  private createListRenderable(token: Tokens.List, id: string, marginBottom: number = 0): BoxRenderable {
    const list = new BoxRenderable(this.ctx, {
      id,
      width: "100%",
      flexDirection: "column",
      flexShrink: 0,
      marginBottom,
    })

    for (const item of this.getListItemInputs(token, id)) {
      list.add(this.createListItemRenderable(item))
    }

    return list
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

    let pendingMarginTop = 0
    for (let index = 0; index < input.item.tokens.length; index += 1) {
      const child = input.item.tokens[index] as MarkedToken | undefined
      if (!child) continue
      if (child.type === "checkbox") continue
      if (child.type === "space") {
        pendingMarginTop = Math.max(pendingMarginTop, 1)
        continue
      }
      const renderable = this.createListChildRenderable(child, `${input.id}-child-${index}`)
      if (!renderable) continue
      renderable.marginTop = child.type === "list" ? 0 : pendingMarginTop
      pendingMarginTop = 0
      content.add(renderable)
    }

    return row
  }

  private applyListItemRenderable(
    row: BoxRenderable,
    input: ListItemRenderInput,
    previousItem: Tokens.ListItem | undefined,
  ): boolean {
    this.applyListItemMarker(row, input)

    const content = row.getChildren()[1]
    if (!(content instanceof BoxRenderable)) return false

    if (previousItem && previousItem.raw === input.item.raw) {
      return true
    }

    return this.applyListItemChildren(content, input.item, previousItem, input.id)
  }

  private applyListItemChildren(
    content: BoxRenderable,
    item: Tokens.ListItem,
    previousItem: Tokens.ListItem | undefined,
    id: string,
  ): boolean {
    const previousTokens = previousItem ? this.getRenderableListItemTokens(previousItem) : []
    const children = content.getChildren()
    let childIndex = 0
    let pendingMarginTop = 0

    for (let tokenIndex = 0; tokenIndex < item.tokens.length; tokenIndex += 1) {
      const token = item.tokens[tokenIndex] as MarkedToken | undefined
      if (!token) continue
      if (token.type === "checkbox") continue
      if (token.type === "space") {
        pendingMarginTop = Math.max(pendingMarginTop, 1)
        continue
      }

      const existing = children[childIndex]
      const childId = `${id}-child-${tokenIndex}`

      const marginTop = token.type === "list" ? 0 : pendingMarginTop
      pendingMarginTop = 0

      if (!existing) {
        const renderable = this.createListChildRenderable(token, childId)
        if (!renderable) return false
        renderable.marginTop = marginTop
        content.add(renderable, childIndex)
        childIndex += 1
        continue
      }

      if (!this.applyListChildRenderable(existing, token, previousTokens[childIndex], childId)) {
        return false
      }
      existing.marginTop = marginTop
      childIndex += 1
    }

    this.destroyListItemChildrenAfter(content, childIndex)
    return true
  }

  private getRenderableListItemTokens(item: Tokens.ListItem): MarkedToken[] {
    const tokens: MarkedToken[] = []

    for (const token of item.tokens as MarkedToken[]) {
      if (token.type === "checkbox" || token.type === "space") continue
      tokens.push(token)
    }

    return tokens
  }

  private applyListChildRenderable(
    renderable: Renderable,
    token: MarkedToken,
    previousToken: MarkedToken | undefined,
    id: string,
  ): boolean {
    if ((token.type === "text" || token.type === "paragraph") && renderable instanceof CodeRenderable) {
      this.applyMarkdownCodeRenderable(renderable, this.normalizeScrollbackMarkdownBlockRaw(token.raw), 0)
      return true
    }

    if (token.type === "list" && renderable instanceof BoxRenderable) {
      return this.applyListRenderable(renderable, token as Tokens.List, previousToken as Tokens.List | undefined, id)
    }

    if (token.type === "code" && renderable instanceof CodeRenderable) {
      this.applyCodeBlockRenderable(renderable, token as Tokens.Code, 0)
      return true
    }

    return previousToken?.raw === token.raw
  }

  private destroyListItemChildrenAfter(content: BoxRenderable, index: number): void {
    const children = content.getChildren()
    for (let i = children.length - 1; i >= index; i -= 1) {
      children[i]?.destroyRecursively()
    }
  }

  private applyListItemMarker(row: BoxRenderable, input: ListItemRenderInput): void {
    const marker = row.getChildren()[0]
    if (!(marker instanceof TextRenderable)) return
    const marginBottom = /\n[ \t]*\n$/.test(input.item.raw) ? 1 : 0
    const markerWidth = input.markerWidth + 1
    const markerText = input.marker.padStart(input.markerWidth) + " "

    if (row.marginBottom !== marginBottom) row.marginBottom = marginBottom
    if (marker.width !== markerWidth) marker.width = markerWidth
    if (marker.chunks[0]?.text !== markerText) {
      marker.content = new StyledText([this.createChunk(markerText, "markup.list")])
    }
  }

  private createListChildRenderable(token: MarkedToken, id: string): Renderable | null {
    if (token.type === "text" || token.type === "paragraph") {
      return this.createMarkdownCodeRenderable(
        this.normalizeScrollbackMarkdownBlockRaw(token.raw),
        id,
        0,
        this._linkifyMarkdownChunks,
        undefined,
        this.createInitialStyledText(token),
      )
    }
    if (token.type === "list") return this.createListRenderable(token as Tokens.List, id)
    if (token.type === "code") return this.createCodeRenderable(token as Tokens.Code, id)
    if (token.type === "blockquote") return this.createBlockquoteRenderable(token, id)
    if (token.type === "hr") return this.createHorizontalRuleRenderable(id)
    if (token.type === "table") return this.createTableBlock(token as Tokens.Table, id).renderable
    return token.raw
      ? this.createMarkdownCodeRenderable(
          token.raw,
          id,
          0,
          this._linkifyMarkdownChunks,
          undefined,
          this.createInitialStyledText(token),
        )
      : null
  }

  private createHorizontalRuleRenderable(id: string, marginBottom: number = 0): BoxRenderable {
    return new BoxRenderable(this.ctx, {
      id,
      width: "100%",
      height: 1,
      border: ["top"],
      borderColor: this.getStyle("conceal")?.fg ?? this._fg ?? "#888888",
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
    initialStyledText?: StyledText,
  ): void {
    renderable.initialStyledText = initialStyledText
    renderable.filetype = "markdown"
    renderable.syntaxStyle = this._syntaxStyle
    renderable.fg = this._fg
    renderable.bg = this._bg
    renderable.conceal = this._conceal
    renderable.drawUnstyledText = initialStyledText !== undefined
    renderable.streaming = true
    renderable.baseHighlight = baseHighlight
    renderable.content = content
    renderable.marginBottom = marginBottom
  }

  private applyBlockquoteRenderable(renderable: Renderable, token: MarkedToken, marginBottom: number): void {
    if (!(renderable instanceof BoxRenderable)) return

    renderable.borderColor = this.getBlockquoteBorderColor()
    renderable.marginBottom = marginBottom

    const child = renderable.getChildren()[0]
    if (child instanceof CodeRenderable) {
      this.applyMarkdownCodeRenderable(child, this.getBlockquoteContent(token), 0, "markup.quote")
      return
    }

    for (const existing of renderable.getChildren()) {
      existing.destroyRecursively()
    }
    renderable.add(
      this.createMarkdownCodeRenderable(
        this.getBlockquoteContent(token),
        `${renderable.id}-content`,
        0,
        this._linkifyMarkdownChunks,
        "markup.quote",
      ),
    )
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
    return chunks.length > 0 ? chunks : [this.createDefaultChunk(" ")]
  }

  private createTableHeaderCellChunks(cell: Tokens.TableCell): TextChunk[] {
    const chunks: TextChunk[] = []
    this.renderInlineContent(cell.tokens, chunks)

    const baseChunks = chunks.length > 0 ? chunks : [this.createDefaultChunk(" ")]
    const headingStyle = this.getStyle("markup.heading") || this.getStyle("default")
    if (!headingStyle) {
      return baseChunks
    }

    const headingAttributes = createTextAttributes({
      bold: headingStyle.bold,
      italic: headingStyle.italic,
      underline: headingStyle.underline,
      dim: headingStyle.dim,
    })

    return baseChunks.map((chunk) => ({
      ...chunk,
      fg: headingStyle.fg ?? chunk.fg,
      bg: headingStyle.bg ?? chunk.bg,
      attributes: headingAttributes,
    }))
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
    return new TextTableRenderable(this.ctx, {
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
      selectable: options.selectable,
    })
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
    const custom = this._renderNode(token, {
      syntaxStyle: this._syntaxStyle,
      conceal: this._conceal,
      concealCode: this._concealCode,
      treeSitterClient: this._treeSitterClient,
      defaultRender: () => {
        defaultResult = createDefault()
        return defaultResult.renderable ?? null
      },
    })

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
    forceListRefresh: boolean = false,
  ): void {
    const marginBottom = this.getInterBlockMargin(token, nextToken)

    if (token.type === "code") {
      this.applyCodeBlockRenderable(state.renderable, token as Tokens.Code, marginBottom)
      return
    }

    if (token.type === "blockquote") {
      this.applyBlockquoteRenderable(state.renderable, token, marginBottom)
      return
    }

    if (token.type === "list") {
      if (
        !this.applyListRenderable(
          state.renderable,
          token as Tokens.List,
          forceListRefresh ? undefined : (state.token as Tokens.List),
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
      state.renderable.marginBottom = marginBottom
      return
    }

    if (token.type === "table") {
      const tableToken = token as Tokens.Table
      const { cache, changed } = this.buildTableContentCache(tableToken, state.tableContentCache)

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

    if (state.renderable instanceof CodeRenderable) {
      this.applyMarkdownCodeRenderable(
        state.renderable,
        this.getTopLevelBlockRaw(token) ?? token.raw,
        marginBottom,
        undefined,
        this.createInitialStyledText(token),
      )
      return
    }

    state.renderable.destroyRecursively()
    const markdownRenderable = this.createMarkdownCodeRenderable(
      this.getTopLevelBlockRaw(token) ?? token.raw,
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
        !forceTableRefresh &&
        existing.canUpdateInPlace &&
        existing.token.type === block.token.type &&
        this.canUpdateBlockRenderable(existing.renderable, block.token)
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

        this.updateBlockRenderable(existing, block.token, blockIndex, blocks[i + 1]?.token)
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

  private canUpdateBlockRenderable(renderable: Renderable, token: MarkedToken): boolean {
    if (token.type === "code") return renderable instanceof CodeRenderable

    if (token.type === "table") return renderable instanceof TextTableRenderable
    if (token.type === "blockquote") return renderable instanceof BoxRenderable
    if (token.type === "list") return renderable instanceof BoxRenderable
    if (token.type === "hr") return renderable instanceof BoxRenderable
    return renderable instanceof CodeRenderable
  }

  private updateBlocks(forceTableRefresh: boolean = false): void {
    if (this.isDestroyed) return
    if (!this._content) {
      this.clearBlockStates()
      this._parseState = null
      this._stableBlockCount = 0
      return
    }

    const trailingUnstable = this._streaming ? 2 : 0
    this._parseState = parseMarkdownIncremental(this._content, this._parseState, trailingUnstable)

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

      const shouldForceRefresh = forceTableRefresh

      if (existing && existing.token === token) {
        if (shouldForceRefresh) {
          this.updateBlockRenderable(existing, token, blockIndex, nextToken)
          existing.tokenRaw = token.raw
        } else {
          this.applyInterBlockMargin(existing, token, nextToken)
        }
        blockIndex++
        continue
      }

      if (existing && existing.tokenRaw === token.raw && existing.token.type === token.type) {
        existing.token = token
        if (shouldForceRefresh) {
          this.updateBlockRenderable(existing, token, blockIndex, nextToken)
          existing.tokenRaw = token.raw
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

  /**
   * Re-render existing blocks without rebuilding the parse state or block structure.
   * Used when only style/conceal changes - much faster than full rebuild.
   */
  private rerenderBlocks(): void {
    if (this._internalBlockMode === "top-level") {
      this.updateBlocks(true)
      return
    }

    for (let i = 0; i < this._blockStates.length; i++) {
      const state = this._blockStates[i]
      const marginBottom = this.getInterBlockMargin(state.token, this._blockStates[i + 1]?.token)

      if (state.token.type === "code") {
        this.applyCodeBlockRenderable(state.renderable, state.token as Tokens.Code, marginBottom)
        continue
      }

      if (state.token.type === "blockquote") {
        this.applyBlockquoteRenderable(state.renderable, state.token, marginBottom)
        continue
      }

      if (state.token.type === "list") {
        this.updateBlockRenderable(state, state.token, i, this._blockStates[i + 1]?.token, true)
        continue
      }

      if (state.token.type === "hr") {
        state.renderable.marginBottom = marginBottom
        continue
      }

      if (state.token.type === "table") {
        const tableToken = state.token as Tokens.Table
        const { cache } = this.buildTableContentCache(tableToken, state.tableContentCache, true)

        if (!cache) {
          if (state.renderable instanceof CodeRenderable) {
            this.applyMarkdownCodeRenderable(state.renderable, tableToken.raw, marginBottom)
          } else {
            state.renderable.destroyRecursively()
            const fallbackRenderable = this.createMarkdownCodeRenderable(
              tableToken.raw,
              `${this.id}-block-${i}`,
              marginBottom,
            )
            this.add(fallbackRenderable, i)
            state.renderable = fallbackRenderable
          }
          state.tableContentCache = undefined
          continue
        }

        if (state.renderable instanceof TextTableRenderable) {
          state.renderable.content = cache.content
          this.applyTableRenderableOptions(state.renderable, this.resolveTableRenderableOptions())
          state.renderable.marginBottom = marginBottom
          state.tableContentCache = cache
          continue
        }

        state.renderable.destroyRecursively()
        const tableRenderable = this.createTextTableRenderable(cache.content, `${this.id}-block-${i}`, marginBottom)
        this.add(tableRenderable, i)
        state.renderable = tableRenderable
        state.tableContentCache = cache
        continue
      }

      if (state.renderable instanceof CodeRenderable) {
        this.applyMarkdownCodeRenderable(
          state.renderable,
          this.getTopLevelBlockRaw(state.token) ?? state.token.raw,
          marginBottom,
          undefined,
          this.createInitialStyledText(state.token),
        )
        continue
      }

      state.renderable.destroyRecursively()
      const markdownRenderable = this.createMarkdownCodeRenderable(
        this.getTopLevelBlockRaw(state.token) ?? state.token.raw,
        `${this.id}-block-${i}`,
        marginBottom,
        this._linkifyMarkdownChunks,
        undefined,
        this.createInitialStyledText(state.token),
      )
      this.add(markdownRenderable, i)
      state.renderable = markdownRenderable
    }
  }

  public clearCache(): void {
    this._parseState = null
    this.clearBlockStates()
    this.updateBlocks()
    this.requestRender()
  }

  public refreshStyles(): void {
    this._styleDirty = false
    this.rerenderBlocks()
    this.requestRender()
  }

  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    // Check if style/conceal changed - re-render blocks before rendering
    if (this._styleDirty) {
      this._styleDirty = false
      this.rerenderBlocks()
    }
    super.renderSelf(buffer, deltaTime)
  }
}
