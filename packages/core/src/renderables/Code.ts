import { type RenderContext } from "../types"
import { StyledText } from "../lib/styled-text"
import { SyntaxStyle } from "../syntax-style"
import { getTreeSitterClient, treeSitterToStyledText, TreeSitterClient } from "../lib/tree-sitter"
import { TextBufferRenderable, type TextBufferOptions } from "./TextBufferRenderable"
import type { OptimizedBuffer } from "../buffer"
import type { SimpleHighlight } from "../lib/tree-sitter/types"
import { treeSitterToTextChunks } from "../lib/tree-sitter-styled-text"

export interface CodeOptions extends TextBufferOptions {
  content?: string
  filetype?: string
  syntaxStyle: SyntaxStyle
  treeSitterClient?: TreeSitterClient
  conceal?: boolean
  drawUnstyledText?: boolean
  streaming?: boolean
}

export class CodeRenderable extends TextBufferRenderable {
  private _content: string
  private _filetype?: string
  private _syntaxStyle: SyntaxStyle
  private _isHighlighting: boolean = false
  private _treeSitterClient: TreeSitterClient
  private _highlightsDirty: boolean = false
  private _highlightSnapshotId: number = 0
  private _highlightQueued: boolean = false
  private _conceal: boolean
  private _drawUnstyledText: boolean
  private _shouldRenderTextBuffer: boolean = true
  private _streaming: boolean
  private _hadInitialContent: boolean = false
  private _lastHighlights: SimpleHighlight[] = []

  protected _contentDefaultOptions = {
    content: "",
    conceal: true,
    drawUnstyledText: true,
    streaming: false,
  } satisfies Partial<CodeOptions>

  constructor(ctx: RenderContext, options: CodeOptions) {
    super(ctx, options)

    this._content = options.content ?? this._contentDefaultOptions.content
    this._filetype = options.filetype
    this._syntaxStyle = options.syntaxStyle
    this._treeSitterClient = options.treeSitterClient ?? getTreeSitterClient()
    this._conceal = options.conceal ?? this._contentDefaultOptions.conceal
    this._drawUnstyledText = options.drawUnstyledText ?? this._contentDefaultOptions.drawUnstyledText
    this._streaming = options.streaming ?? this._contentDefaultOptions.streaming

    if (this._content.length > 0) {
      this.textBuffer.setText(this._content, { reset: true })
      this.updateTextInfo()
      this._shouldRenderTextBuffer = this._drawUnstyledText || !this._filetype
    }

    this._highlightsDirty = this._content.length > 0
  }

  get content(): string {
    return this._content
  }

  set content(value: string) {
    if (this._content !== value) {
      this._content = value
      this._highlightsDirty = true
      this._highlightSnapshotId++

      if (this._streaming && !this._drawUnstyledText && this._filetype) {
        return
      }

      this.textBuffer.setText(value, { reset: true })
      this.updateTextInfo()
    }
  }

  get filetype(): string | undefined {
    return this._filetype
  }

  set filetype(value: string) {
    if (this._filetype !== value) {
      this._filetype = value
      this._highlightsDirty = true
    }
  }

  get syntaxStyle(): SyntaxStyle {
    return this._syntaxStyle
  }

  set syntaxStyle(value: SyntaxStyle) {
    if (this._syntaxStyle !== value) {
      this._syntaxStyle = value
      this._highlightsDirty = true
    }
  }

  get conceal(): boolean {
    return this._conceal
  }

  set conceal(value: boolean) {
    if (this._conceal !== value) {
      this._conceal = value
      this._highlightsDirty = true
    }
  }

  get drawUnstyledText(): boolean {
    return this._drawUnstyledText
  }

  set drawUnstyledText(value: boolean) {
    if (this._drawUnstyledText !== value) {
      this._drawUnstyledText = value
      this._highlightsDirty = true
    }
  }

  get streaming(): boolean {
    return this._streaming
  }

  set streaming(value: boolean) {
    if (this._streaming !== value) {
      this._streaming = value
      this._hadInitialContent = false
      this._lastHighlights = []
      this._highlightsDirty = true
    }
  }

  get treeSitterClient(): TreeSitterClient {
    return this._treeSitterClient
  }

  set treeSitterClient(value: TreeSitterClient) {
    if (this._treeSitterClient !== value) {
      this._treeSitterClient = value
      this._highlightsDirty = true
    }
  }

  get isHighlighting(): boolean {
    return this._isHighlighting
  }

  private ensureVisibleTextBeforeHighlight(): void {
    if (this.isDestroyed) return

    const content = this._content

    if (!this._filetype) {
      this._shouldRenderTextBuffer = true
      return
    }

    const isInitialContent = this._streaming && !this._hadInitialContent
    const shouldDrawUnstyledNow = this._streaming ? isInitialContent && this._drawUnstyledText : this._drawUnstyledText

    if (this._streaming && !isInitialContent) {
      this._shouldRenderTextBuffer = true
    } else if (shouldDrawUnstyledNow) {
      this.textBuffer.setText(content, { reset: true })
      this._shouldRenderTextBuffer = true
    } else {
      this._shouldRenderTextBuffer = false
    }
  }

  private async startHighlight(): Promise<void> {
    if (this._isHighlighting) {
      this._highlightQueued = true
      return
    }

    const content = this._content
    const filetype = this._filetype
    const snapshotId = ++this._highlightSnapshotId

    if (!filetype) return

    const isInitialContent = this._streaming && !this._hadInitialContent
    if (isInitialContent) {
      this._hadInitialContent = true
    }

    this._isHighlighting = true

    try {
      const result = await this._treeSitterClient.highlightOnce(content, filetype)

      if (snapshotId !== this._highlightSnapshotId) {
        return
      }

      if (this.isDestroyed) return

      if (result.highlights && result.highlights.length > 0) {
        if (this._streaming) {
          this._lastHighlights = result.highlights
        }

        const chunks = treeSitterToTextChunks(content, result.highlights, this._syntaxStyle, {
          enabled: this._conceal,
        })
        const styledText = new StyledText(chunks)
        this.textBuffer.setStyledText(styledText)
      } else {
        this.textBuffer.setText(content, { reset: true })
      }

      this._shouldRenderTextBuffer = true
      this._highlightsDirty = false
      this.updateTextInfo()
      this.requestRender()
    } catch (error) {
      if (snapshotId !== this._highlightSnapshotId) {
        return
      }

      console.warn("Code highlighting failed, falling back to plain text:", error)
      if (this.isDestroyed) return
      this.textBuffer.setText(content, { reset: true })
      this._shouldRenderTextBuffer = true
      this._highlightsDirty = false
      this.updateTextInfo()
      this.requestRender()
    } finally {
      this._isHighlighting = false

      if (this._highlightQueued && !this.isDestroyed) {
        this._highlightQueued = false

        if (this._content.length === 0 || !this._filetype) {
          return
        }

        this.ensureVisibleTextBeforeHighlight()
        this._highlightsDirty = false
        void this.startHighlight()
      }
    }
  }

  public getLineHighlights(lineIdx: number) {
    return this.textBuffer.getLineHighlights(lineIdx)
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (this._highlightsDirty) {
      if (this.isDestroyed) return

      if (this._content.length === 0) {
        this._shouldRenderTextBuffer = false
        this._highlightsDirty = false
      } else if (!this._filetype) {
        this._shouldRenderTextBuffer = true
        this._highlightsDirty = false
      } else {
        this.ensureVisibleTextBeforeHighlight()
        this._highlightsDirty = false
        this.startHighlight()
      }
    }

    if (!this._shouldRenderTextBuffer) return
    super.renderSelf(buffer)
  }
}
