import { Renderable, type RenderableOptions } from "../Renderable"
import { type RenderContext } from "../types"
import { SyntaxStyle, type StyleDefinition } from "../syntax-style"
import { StyledText } from "../lib/styled-text"
import type { TextChunk } from "../text-buffer"
import { createTextAttributes } from "../utils"
import { Lexer, type MarkedToken, type Token, type Tokens } from "marked"
import { TextRenderable } from "./Text"
import { CodeRenderable } from "./Code"
import { BoxRenderable } from "./Box"
import type { TreeSitterClient } from "../lib/tree-sitter"
import { parseMarkdownIncremental, type ParseState } from "./markdown-parser"
import type { OptimizedBuffer } from "../buffer"

export interface MarkdownOptions extends RenderableOptions<MarkdownRenderable> {
  content?: string
  syntaxStyle: SyntaxStyle
  conceal?: boolean
  treeSitterClient?: TreeSitterClient
  /**
   * Enable streaming mode for incremental content updates.
   * When true, trailing tokens are kept unstable to handle incomplete content.
   */
  streaming?: boolean
  /**
   * Custom node renderer. Return a Renderable to override default rendering,
   * or undefined/null to use default rendering.
   */
  renderNode?: (token: Token, context: RenderNodeContext) => Renderable | undefined | null
}

export interface RenderNodeContext {
  syntaxStyle: SyntaxStyle
  conceal: boolean
  treeSitterClient?: TreeSitterClient
  /** Creates default renderable for this token */
  defaultRender: () => Renderable | null
}

export interface BlockState {
  token: MarkedToken
  tokenRaw: string // Cache raw for comparison
  renderable: Renderable
}

export type { ParseState }

export class MarkdownRenderable extends Renderable {
  private _content: string = ""
  private _syntaxStyle: SyntaxStyle
  private _conceal: boolean
  private _treeSitterClient?: TreeSitterClient
  private _renderNode?: MarkdownOptions["renderNode"]

  _parseState: ParseState | null = null
  private _streaming: boolean = false
  _blockStates: BlockState[] = []
  private _styleDirty: boolean = false

  protected _contentDefaultOptions = {
    content: "",
    conceal: true,
    streaming: false,
  } satisfies Partial<MarkdownOptions>

  constructor(ctx: RenderContext, options: MarkdownOptions) {
    super(ctx, {
      ...options,
      flexDirection: "column",
    })

    this._syntaxStyle = options.syntaxStyle
    this._conceal = options.conceal ?? this._contentDefaultOptions.conceal
    this._content = options.content ?? this._contentDefaultOptions.content
    this._treeSitterClient = options.treeSitterClient
    this._renderNode = options.renderNode
    this._streaming = options.streaming ?? this._contentDefaultOptions.streaming

    this.updateBlocks()
  }

  get content(): string {
    return this._content
  }

  set content(value: string) {
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

  get streaming(): boolean {
    return this._streaming
  }

  set streaming(value: boolean) {
    if (this._streaming !== value) {
      this._streaming = value
      // Don't clear parseState - incremental parser handles streaming correctly
      this.updateBlocks()
      this.requestRender()
    }
  }

  private getStyle(group: string): StyleDefinition | undefined {
    let style = this._syntaxStyle.getStyle(group)
    if (!style && group.includes(".")) {
      const baseName = group.split(".")[0]
      style = this._syntaxStyle.getStyle(baseName)
    }
    return style
  }

  private createChunk(text: string, group: string): TextChunk {
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
    }
  }

  private createDefaultChunk(text: string): TextChunk {
    return this.createChunk(text, "default")
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

      case "link":
        if (this._conceal) {
          for (const child of token.tokens) {
            this.renderInlineTokenWithStyle(child as MarkedToken, chunks, "markup.link.label")
          }
          chunks.push(this.createChunk(" (", "markup.link"))
          chunks.push(this.createChunk(token.href, "markup.link.url"))
          chunks.push(this.createChunk(")", "markup.link"))
        } else {
          chunks.push(this.createChunk("[", "markup.link"))
          for (const child of token.tokens) {
            this.renderInlineTokenWithStyle(child as MarkedToken, chunks, "markup.link.label")
          }
          chunks.push(this.createChunk("](", "markup.link"))
          chunks.push(this.createChunk(token.href, "markup.link.url"))
          chunks.push(this.createChunk(")", "markup.link"))
        }
        break

      case "image":
        if (this._conceal) {
          chunks.push(this.createChunk(token.text || "image", "markup.link.label"))
        } else {
          chunks.push(this.createChunk("![", "markup.link"))
          chunks.push(this.createChunk(token.text || "", "markup.link.label"))
          chunks.push(this.createChunk("](", "markup.link"))
          chunks.push(this.createChunk(token.href, "markup.link.url"))
          chunks.push(this.createChunk(")", "markup.link"))
        }
        break

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

  private renderInlineTokenWithStyle(token: MarkedToken, chunks: TextChunk[], styleGroup: string): void {
    switch (token.type) {
      case "text":
        chunks.push(this.createChunk(token.text, styleGroup))
        break

      case "escape":
        chunks.push(this.createChunk(token.text, styleGroup))
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

      default:
        this.renderInlineToken(token, chunks)
        break
    }
  }

  private renderHeadingChunks(token: Tokens.Heading): TextChunk[] {
    const chunks: TextChunk[] = []
    const group = `markup.heading.${token.depth}`
    const marker = "#".repeat(token.depth) + " "

    if (!this._conceal) {
      chunks.push(this.createChunk(marker, group))
    }

    for (const child of token.tokens) {
      this.renderInlineTokenWithStyle(child as MarkedToken, chunks, group)
    }

    return chunks
  }

  private renderParagraphChunks(token: Tokens.Paragraph): TextChunk[] {
    const chunks: TextChunk[] = []
    this.renderInlineContent(token.tokens, chunks)
    return chunks
  }

  private renderBlockquoteChunks(token: Tokens.Blockquote): TextChunk[] {
    const chunks: TextChunk[] = []
    for (const child of token.tokens) {
      chunks.push(this.createChunk("> ", "punctuation.special"))
      const childChunks = this.renderTokenToChunks(child as MarkedToken)
      chunks.push(...childChunks)
      chunks.push(this.createDefaultChunk("\n"))
    }
    return chunks
  }

  private renderListChunks(token: Tokens.List): TextChunk[] {
    const chunks: TextChunk[] = []
    let index = typeof token.start === "number" ? token.start : 1

    for (const item of token.items) {
      if (token.ordered) {
        chunks.push(this.createChunk(`${index}. `, "markup.list"))
        index++
      } else {
        chunks.push(this.createChunk("- ", "markup.list"))
      }

      for (let i = 0; i < item.tokens.length; i++) {
        const child = item.tokens[i]
        if (child.type === "text" && i === 0 && "tokens" in child && child.tokens) {
          this.renderInlineContent(child.tokens, chunks)
          chunks.push(this.createDefaultChunk("\n"))
        } else if (child.type === "paragraph" && i === 0) {
          this.renderInlineContent((child as Tokens.Paragraph).tokens, chunks)
          chunks.push(this.createDefaultChunk("\n"))
        } else {
          const childChunks = this.renderTokenToChunks(child as MarkedToken)
          chunks.push(...childChunks)
          chunks.push(this.createDefaultChunk("\n"))
        }
      }
    }

    return chunks
  }

  private renderThematicBreakChunks(): TextChunk[] {
    return [this.createChunk("---", "punctuation.special")]
  }

  private renderTokenToChunks(token: MarkedToken): TextChunk[] {
    switch (token.type) {
      case "heading":
        return this.renderHeadingChunks(token)
      case "paragraph":
        return this.renderParagraphChunks(token)
      case "blockquote":
        return this.renderBlockquoteChunks(token)
      case "list":
        return this.renderListChunks(token)
      case "hr":
        return this.renderThematicBreakChunks()
      case "space":
        return []
      default:
        if ("raw" in token && token.raw) {
          return [this.createDefaultChunk(token.raw)]
        }
        return []
    }
  }

  private createTextRenderable(chunks: TextChunk[], id: string, marginBottom: number = 0): TextRenderable {
    return new TextRenderable(this.ctx, {
      id,
      content: new StyledText(chunks),
      width: "100%",
      marginBottom,
    })
  }

  private createCodeRenderable(token: Tokens.Code, id: string, marginBottom: number = 0): Renderable {
    return new CodeRenderable(this.ctx, {
      id,
      content: token.text,
      filetype: token.lang || undefined,
      syntaxStyle: this._syntaxStyle,
      conceal: this._conceal,
      treeSitterClient: this._treeSitterClient,
      width: "100%",
      marginBottom,
    })
  }

  /**
   * Update an existing table renderable in-place for style/conceal changes.
   * Much faster than rebuilding the entire table structure.
   */
  private updateTableRenderable(tableBox: Renderable, table: Tokens.Table, marginBottom: number): void {
    tableBox.marginBottom = marginBottom
    const borderColor = this.getStyle("punctuation.special")?.fg ?? "#888888"
    const headingStyle = this.getStyle("markup.heading") || this.getStyle("default")

    const rowsToRender = this._streaming && table.rows.length > 0 ? table.rows.slice(0, -1) : table.rows
    const colCount = table.header.length

    // Traverse existing table structure: tableBox -> columnBoxes -> cells
    const columns = (tableBox as any)._childrenInLayoutOrder as Renderable[]
    for (let col = 0; col < colCount; col++) {
      const columnBox = columns[col]
      if (!columnBox) continue

      // Update column border colors
      if (columnBox instanceof BoxRenderable) {
        columnBox.borderColor = borderColor
      }

      const columnChildren = (columnBox as any)._childrenInLayoutOrder as Renderable[]

      // Update header (first child of column)
      const headerBox = columnChildren[0]
      if (headerBox instanceof BoxRenderable) {
        headerBox.borderColor = borderColor
        const headerChildren = (headerBox as any)._childrenInLayoutOrder as Renderable[]
        const headerText = headerChildren[0]
        if (headerText instanceof TextRenderable) {
          const headerCell = table.header[col]
          const headerChunks: TextChunk[] = []
          this.renderInlineContent(headerCell.tokens, headerChunks)
          const styledHeaderChunks = headerChunks.map((chunk) => ({
            ...chunk,
            fg: headingStyle?.fg ?? chunk.fg,
            bg: headingStyle?.bg ?? chunk.bg,
            attributes: headingStyle
              ? createTextAttributes({
                  bold: headingStyle.bold,
                  italic: headingStyle.italic,
                  underline: headingStyle.underline,
                  dim: headingStyle.dim,
                })
              : chunk.attributes,
          }))
          headerText.content = new StyledText(styledHeaderChunks)
        }
      }

      // Update data rows (remaining children)
      for (let row = 0; row < rowsToRender.length; row++) {
        const childIndex = row + 1 // +1 because header is first child
        const cellContainer = columnChildren[childIndex]

        let cellText: TextRenderable | undefined
        if (cellContainer instanceof BoxRenderable) {
          // Cell has a border box wrapper
          cellContainer.borderColor = borderColor
          const cellChildren = (cellContainer as any)._childrenInLayoutOrder as Renderable[]
          cellText = cellChildren[0] as TextRenderable
        } else if (cellContainer instanceof TextRenderable) {
          // Last row, no border box
          cellText = cellContainer
        }

        if (cellText) {
          const cell = rowsToRender[row][col]
          const cellChunks: TextChunk[] = []
          if (cell) {
            this.renderInlineContent(cell.tokens, cellChunks)
          }
          cellText.content = new StyledText(cellChunks.length > 0 ? cellChunks : [this.createDefaultChunk(" ")])
        }
      }
    }
  }

  private createTableRenderable(table: Tokens.Table, id: string, marginBottom: number = 0): Renderable {
    const colCount = table.header.length

    // During streaming, skip the last row (might be incomplete)
    const rowsToRender = this._streaming && table.rows.length > 0 ? table.rows.slice(0, -1) : table.rows

    if (colCount === 0 || rowsToRender.length === 0) {
      return this.createTextRenderable([this.createDefaultChunk(table.raw)], id, marginBottom)
    }

    const tableBox = new BoxRenderable(this.ctx, {
      id,
      flexDirection: "row",
      marginBottom,
    })

    const borderColor = this.getStyle("punctuation.special")?.fg ?? "#888888"

    for (let col = 0; col < colCount; col++) {
      const isFirstCol = col === 0
      const isLastCol = col === colCount - 1

      const columnBox = new BoxRenderable(this.ctx, {
        id: `${id}-col-${col}`,
        flexDirection: "column",
        border: isLastCol ? true : ["top", "bottom", "left"],
        borderColor,
        // Use T-joins for non-first columns to connect with previous column
        customBorderChars: isFirstCol
          ? undefined
          : {
              topLeft: "┬",
              topRight: "┐",
              bottomLeft: "┴",
              bottomRight: "┘",
              horizontal: "─",
              vertical: "│",
              topT: "┬",
              bottomT: "┴",
              leftT: "├",
              rightT: "┤",
              cross: "┼",
            },
      })

      const headerCell = table.header[col]
      const headerChunks: TextChunk[] = []
      this.renderInlineContent(headerCell.tokens, headerChunks)
      const headingStyle = this.getStyle("markup.heading") || this.getStyle("default")
      const styledHeaderChunks = headerChunks.map((chunk) => ({
        ...chunk,
        fg: headingStyle?.fg ?? chunk.fg,
        bg: headingStyle?.bg ?? chunk.bg,
        attributes: headingStyle
          ? createTextAttributes({
              bold: headingStyle.bold,
              italic: headingStyle.italic,
              underline: headingStyle.underline,
              dim: headingStyle.dim,
            })
          : chunk.attributes,
      }))

      const headerBox = new BoxRenderable(this.ctx, {
        id: `${id}-col-${col}-header-box`,
        border: ["bottom"],
        borderColor,
      })
      headerBox.add(
        new TextRenderable(this.ctx, {
          id: `${id}-col-${col}-header`,
          content: new StyledText(styledHeaderChunks),
          height: 1,
          overflow: "hidden",
          paddingLeft: 1,
          paddingRight: 1,
        }),
      )
      columnBox.add(headerBox)

      for (let row = 0; row < rowsToRender.length; row++) {
        const cell = rowsToRender[row][col]
        const cellChunks: TextChunk[] = []
        if (cell) {
          this.renderInlineContent(cell.tokens, cellChunks)
        }

        const isLastRow = row === rowsToRender.length - 1
        const cellText = new TextRenderable(this.ctx, {
          id: `${id}-col-${col}-row-${row}`,
          content: new StyledText(cellChunks.length > 0 ? cellChunks : [this.createDefaultChunk(" ")]),
          height: 1,
          overflow: "hidden",
          paddingLeft: 1,
          paddingRight: 1,
        })

        if (isLastRow) {
          columnBox.add(cellText)
        } else {
          const cellBox = new BoxRenderable(this.ctx, {
            id: `${id}-col-${col}-row-${row}-box`,
            border: ["bottom"],
            borderColor,
          })
          cellBox.add(cellText)
          columnBox.add(cellBox)
        }
      }

      tableBox.add(columnBox)
    }

    return tableBox
  }

  private createDefaultRenderable(token: MarkedToken, index: number, hasNextToken: boolean = false): Renderable | null {
    const id = `${this.id}-block-${index}`
    const marginBottom = hasNextToken ? 1 : 0

    if (token.type === "code") {
      return this.createCodeRenderable(token, id, marginBottom)
    }

    if (token.type === "table") {
      return this.createTableRenderable(token, id, marginBottom)
    }

    if (token.type === "space") {
      return null
    }

    const chunks = this.renderTokenToChunks(token)
    if (chunks.length === 0) {
      return null
    }

    return this.createTextRenderable(chunks, id, marginBottom)
  }

  private updateBlockRenderable(state: BlockState, token: MarkedToken, index: number, hasNextToken: boolean): void {
    const marginBottom = hasNextToken ? 1 : 0

    if (token.type === "code") {
      const codeRenderable = state.renderable as CodeRenderable
      const codeToken = token as Tokens.Code
      codeRenderable.content = codeToken.text
      if (codeToken.lang) {
        codeRenderable.filetype = codeToken.lang
      }
      codeRenderable.marginBottom = marginBottom
      return
    }

    if (token.type === "table") {
      const prevTable = state.token as Tokens.Table
      const newTable = token as Tokens.Table

      // During streaming, only rebuild when complete row count changes (skip incomplete last row)
      if (this._streaming) {
        const prevCompleteRows = Math.max(0, prevTable.rows.length - 1)
        const newCompleteRows = Math.max(0, newTable.rows.length - 1)

        // Check if both previous and new are in raw fallback mode (no complete rows to render)
        const prevIsRawFallback = prevTable.header.length === 0 || prevCompleteRows === 0
        const newIsRawFallback = newTable.header.length === 0 || newCompleteRows === 0

        if (prevCompleteRows === newCompleteRows && prevTable.header.length === newTable.header.length) {
          // If both are in raw fallback mode and the raw content changed, update the TextRenderable
          if (prevIsRawFallback && newIsRawFallback && prevTable.raw !== newTable.raw) {
            const textRenderable = state.renderable as TextRenderable
            textRenderable.content = new StyledText([this.createDefaultChunk(newTable.raw)])
            textRenderable.marginBottom = marginBottom
          }
          return
        }
      }

      this.remove(state.renderable.id)
      const newRenderable = this.createTableRenderable(newTable, `${this.id}-block-${index}`, marginBottom)
      this.add(newRenderable)
      state.renderable = newRenderable
      return
    }

    // Text-based renderables (paragraph, heading, list, blockquote, hr)
    const textRenderable = state.renderable as TextRenderable
    const chunks = this.renderTokenToChunks(token)
    textRenderable.content = new StyledText(chunks)
    textRenderable.marginBottom = marginBottom
  }

  private updateBlocks(): void {
    if (!this._content) {
      for (const state of this._blockStates) {
        this.remove(state.renderable.id)
      }
      this._blockStates = []
      this._parseState = null
      return
    }

    const trailingUnstable = this._streaming ? 2 : 0
    this._parseState = parseMarkdownIncremental(this._content, this._parseState, trailingUnstable)

    const tokens = this._parseState.tokens

    // Parse failure fallback
    if (tokens.length === 0 && this._content.length > 0) {
      for (const state of this._blockStates) {
        this.remove(state.renderable.id)
      }
      const text = this.createTextRenderable([this.createDefaultChunk(this._content)], `${this.id}-fallback`)
      this.add(text)
      this._blockStates = [
        {
          token: { type: "text", raw: this._content, text: this._content } as MarkedToken,
          tokenRaw: this._content,
          renderable: text,
        },
      ]
      return
    }

    const blockTokens: Array<{ token: MarkedToken; originalIndex: number }> = []
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "space") {
        blockTokens.push({ token: tokens[i], originalIndex: i })
      }
    }

    const lastBlockIndex = blockTokens.length - 1

    let blockIndex = 0
    for (let i = 0; i < blockTokens.length; i++) {
      const { token } = blockTokens[i]
      const hasNextToken = i < lastBlockIndex
      const existing = this._blockStates[blockIndex]

      // Same token object reference means unchanged
      if (existing && existing.token === token) {
        blockIndex++
        continue
      }

      // Same content, update reference
      if (existing && existing.tokenRaw === token.raw && existing.token.type === token.type) {
        existing.token = token
        blockIndex++
        continue
      }

      // Same type, different content - update in place
      if (existing && existing.token.type === token.type) {
        this.updateBlockRenderable(existing, token, blockIndex, hasNextToken)
        existing.token = token
        existing.tokenRaw = token.raw
        blockIndex++
        continue
      }

      // Different type or new block
      if (existing) {
        this.remove(existing.renderable.id)
      }

      let renderable: Renderable | undefined

      if (this._renderNode) {
        const context: RenderNodeContext = {
          syntaxStyle: this._syntaxStyle,
          conceal: this._conceal,
          treeSitterClient: this._treeSitterClient,
          defaultRender: () => this.createDefaultRenderable(token, blockIndex, hasNextToken),
        }
        const custom = this._renderNode(token, context)
        if (custom) {
          renderable = custom
        }
      }

      if (!renderable) {
        renderable = this.createDefaultRenderable(token, blockIndex, hasNextToken) ?? undefined
      }

      if (renderable) {
        this.add(renderable)
        this._blockStates[blockIndex] = {
          token,
          tokenRaw: token.raw,
          renderable,
        }
      }
      blockIndex++
    }

    while (this._blockStates.length > blockIndex) {
      const removed = this._blockStates.pop()!
      this.remove(removed.renderable.id)
    }
  }

  private clearBlockStates(): void {
    for (const state of this._blockStates) {
      this.remove(state.renderable.id)
    }
    this._blockStates = []
  }

  /**
   * Re-render existing blocks without rebuilding the parse state or block structure.
   * Used when only style/conceal changes - much faster than full rebuild.
   */
  private rerenderBlocks(): void {
    for (let i = 0; i < this._blockStates.length; i++) {
      const state = this._blockStates[i]
      const hasNextToken = i < this._blockStates.length - 1

      if (state.token.type === "code") {
        // CodeRenderable handles style/conceal changes efficiently
        const codeRenderable = state.renderable as CodeRenderable
        codeRenderable.syntaxStyle = this._syntaxStyle
        codeRenderable.conceal = this._conceal
      } else if (state.token.type === "table") {
        // Tables - update in place for better performance
        const marginBottom = hasNextToken ? 1 : 0
        this.updateTableRenderable(state.renderable, state.token as Tokens.Table, marginBottom)
      } else {
        // TextRenderable blocks - regenerate chunks with new style/conceal
        const textRenderable = state.renderable as TextRenderable
        const chunks = this.renderTokenToChunks(state.token)
        if (chunks.length > 0) {
          textRenderable.content = new StyledText(chunks)
        }
      }
    }
  }

  public clearCache(): void {
    this._parseState = null
    this.clearBlockStates()
    this.updateBlocks()
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
