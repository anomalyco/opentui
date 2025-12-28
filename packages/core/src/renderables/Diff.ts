import { Renderable, type RenderableOptions } from "../Renderable"
import type { RenderContext } from "../types"
import { CodeRenderable, type CodeOptions } from "./Code"
import {
  LineNumberRenderable,
  type LineSign,
  type LineColorConfig,
  type LineInlineHighlight,
} from "./LineNumberRenderable"
import { RGBA, parseColor } from "../lib/RGBA"
import { SyntaxStyle } from "../syntax-style"
import { parsePatch, diffWordsWithSpace, type StructuredPatch } from "diff"
import { TextRenderable } from "./Text"
import type { TreeSitterClient } from "../lib/tree-sitter"

/** Represents a highlighted span within a line for word-level diff */
interface InlineHighlight {
  startCol: number
  endCol: number
  type: "added-word" | "removed-word"
}

/** Computes similarity between two strings (0.0 to 1.0) using word-level diff */
export function computeLineSimilarity(a: string, b: string): number {
  if (a === b) return 1.0
  if (a.length === 0 && b.length === 0) return 1.0
  if (a.length === 0 || b.length === 0) return 0.0

  const changes = diffWordsWithSpace(a, b)
  let unchangedLength = 0
  for (const change of changes) {
    if (!change.added && !change.removed) {
      unchangedLength += change.value.length
    }
  }
  return unchangedLength / Math.max(a.length, b.length)
}

/** Computes word-level inline highlights for two strings */
export function computeInlineHighlights(
  oldContent: string,
  newContent: string,
): { oldHighlights: InlineHighlight[]; newHighlights: InlineHighlight[] } {
  const changes = diffWordsWithSpace(oldContent, newContent)

  const oldHighlights: InlineHighlight[] = []
  const newHighlights: InlineHighlight[] = []
  let oldCol = 0
  let newCol = 0

  for (const change of changes) {
    const displayWidth = Bun.stringWidth(change.value)
    if (change.added) {
      newHighlights.push({ startCol: newCol, endCol: newCol + displayWidth, type: "added-word" })
      newCol += displayWidth
    } else if (change.removed) {
      oldHighlights.push({ startCol: oldCol, endCol: oldCol + displayWidth, type: "removed-word" })
      oldCol += displayWidth
    } else {
      oldCol += displayWidth
      newCol += displayWidth
    }
  }

  return { oldHighlights, newHighlights }
}

interface LogicalLine {
  content: string
  lineNum?: number
  hideLineNumber?: boolean
  color?: string | RGBA
  sign?: LineSign
  type: "context" | "add" | "remove" | "empty"
  inlineHighlights?: InlineHighlight[]
}

export interface DiffRenderableOptions extends RenderableOptions<DiffRenderable> {
  diff?: string
  view?: "unified" | "split"

  // CodeRenderable options
  fg?: string | RGBA
  filetype?: string
  syntaxStyle?: SyntaxStyle
  wrapMode?: "word" | "char" | "none"
  conceal?: boolean
  selectionBg?: string | RGBA
  selectionFg?: string | RGBA
  treeSitterClient?: TreeSitterClient

  // LineNumberRenderable options
  showLineNumbers?: boolean
  lineNumberFg?: string | RGBA
  lineNumberBg?: string | RGBA

  // Diff styling
  addedBg?: string | RGBA
  removedBg?: string | RGBA
  contextBg?: string | RGBA
  addedContentBg?: string | RGBA
  removedContentBg?: string | RGBA
  contextContentBg?: string | RGBA
  addedSignColor?: string | RGBA
  removedSignColor?: string | RGBA
  addedLineNumberBg?: string | RGBA
  removedLineNumberBg?: string | RGBA
  /**
   * Disable word-level highlighting within modified lines.
   * When false (default), individual words/characters that changed are highlighted.
   * @default false
   */
  disableWordHighlights?: boolean
  /**
   * Background color for added words within modified lines.
   * @default addedBg brightened 1.5x with +0.15 opacity
   */
  addedWordBg?: string | RGBA
  /**
   * Background color for removed words within modified lines.
   * @default removedBg brightened 1.5x with +0.15 opacity
   */
  removedWordBg?: string | RGBA
  /**
   * Minimum similarity threshold (0.0 to 1.0) for pairing lines.
   * Lines with similarity below this threshold are treated as separate add/remove.
   * @default 0.4
   */
  lineSimilarityThreshold?: number
}

export class DiffRenderable extends Renderable {
  private _diff: string
  private _view: "unified" | "split"
  private _parsedDiff: StructuredPatch | null = null
  private _parseError: Error | null = null

  // CodeRenderable options
  private _fg?: RGBA
  private _filetype?: string
  private _syntaxStyle?: SyntaxStyle
  private _wrapMode?: "word" | "char" | "none"
  private _conceal: boolean
  private _selectionBg?: RGBA
  private _selectionFg?: RGBA
  private _treeSitterClient?: TreeSitterClient

  // LineNumberRenderable options
  private _showLineNumbers: boolean
  private _lineNumberFg: RGBA
  private _lineNumberBg: RGBA

  // Diff styling
  private _addedBg: RGBA
  private _removedBg: RGBA
  private _contextBg: RGBA
  private _addedContentBg: RGBA | null
  private _removedContentBg: RGBA | null
  private _contextContentBg: RGBA | null
  private _addedSignColor: RGBA
  private _removedSignColor: RGBA
  private _addedLineNumberBg: RGBA
  private _removedLineNumberBg: RGBA
  private _disableWordHighlights: boolean
  private _addedWordBg: RGBA
  private _removedWordBg: RGBA
  private _lineSimilarityThreshold: number

  // Child renderables - reused for both unified and split views
  // Unified view uses only leftSide, split view uses both leftSide and rightSide
  private leftSide: LineNumberRenderable | null = null
  private rightSide: LineNumberRenderable | null = null

  // Track whether renderables are currently in the render tree
  private leftSideAdded: boolean = false
  private rightSideAdded: boolean = false

  // Reusable CodeRenderables (not recreated on rebuild)
  // These are created once and updated with new content to avoid expensive recreation
  private leftCodeRenderable: CodeRenderable | null = null
  private rightCodeRenderable: CodeRenderable | null = null

  // Lazy rebuild strategy: For split view, use microtask to coalesce rebuilds.
  // This avoids expensive re-parsing and re-rendering on rapid changes (e.g., width changes).
  // CodeRenderables are reused and only their content is updated.
  private pendingRebuild: boolean = false
  private _lastWidth: number = 0

  // Error renderables for displaying parse errors
  private errorTextRenderable: TextRenderable | null = null
  private errorCodeRenderable: CodeRenderable | null = null

  constructor(ctx: RenderContext, options: DiffRenderableOptions) {
    super(ctx, {
      ...options,
      flexDirection: options.view === "split" ? "row" : "column",
    })

    this._diff = options.diff ?? ""
    this._view = options.view ?? "unified"

    // CodeRenderable options
    this._fg = options.fg ? parseColor(options.fg) : undefined
    this._filetype = options.filetype
    this._syntaxStyle = options.syntaxStyle
    this._wrapMode = options.wrapMode
    this._conceal = options.conceal ?? false
    this._selectionBg = options.selectionBg ? parseColor(options.selectionBg) : undefined
    this._selectionFg = options.selectionFg ? parseColor(options.selectionFg) : undefined
    this._treeSitterClient = options.treeSitterClient

    // LineNumberRenderable options
    this._showLineNumbers = options.showLineNumbers ?? true
    this._lineNumberFg = parseColor(options.lineNumberFg ?? "#888888")
    this._lineNumberBg = parseColor(options.lineNumberBg ?? "transparent")

    // Diff styling
    this._addedBg = parseColor(options.addedBg ?? "#1a4d1a")
    this._removedBg = parseColor(options.removedBg ?? "#4d1a1a")
    this._contextBg = parseColor(options.contextBg ?? "transparent")
    this._addedContentBg = options.addedContentBg ? parseColor(options.addedContentBg) : null
    this._removedContentBg = options.removedContentBg ? parseColor(options.removedContentBg) : null
    this._contextContentBg = options.contextContentBg ? parseColor(options.contextContentBg) : null
    this._addedSignColor = parseColor(options.addedSignColor ?? "#22c55e")
    this._removedSignColor = parseColor(options.removedSignColor ?? "#ef4444")
    this._addedLineNumberBg = parseColor(options.addedLineNumberBg ?? "transparent")
    this._removedLineNumberBg = parseColor(options.removedLineNumberBg ?? "transparent")
    this._disableWordHighlights = options.disableWordHighlights ?? false
    this._lineSimilarityThreshold = options.lineSimilarityThreshold ?? 0.5
    this._addedWordBg = options.addedWordBg
      ? parseColor(options.addedWordBg)
      : this.brightenAndIncreaseOpacity(this._addedBg, 1.5, 0.15)
    this._removedWordBg = options.removedWordBg
      ? parseColor(options.removedWordBg)
      : this.brightenAndIncreaseOpacity(this._removedBg, 1.5, 0.15)

    // Only parse and build if diff is provided
    if (this._diff) {
      this.parseDiff()
      this.buildView()
    }
  }

  private brightenAndIncreaseOpacity(color: RGBA, brightenFactor: number, opacityIncrease: number): RGBA {
    return RGBA.fromValues(
      Math.min(1, color.r * brightenFactor),
      Math.min(1, color.g * brightenFactor),
      Math.min(1, color.b * brightenFactor),
      Math.min(1, color.a + opacityIncrease),
    )
  }

  private toLineHighlights(highlights: InlineHighlight[], bg: RGBA): LineInlineHighlight[] {
    return highlights.map((h) => ({ startCol: h.startCol, endCol: h.endCol, bg }))
  }

  // Skip word highlights for blocks larger than this
  private static readonly MAX_WORD_HIGHLIGHT_BLOCK_SIZE = 50

  private processChangeBlockWithHighlights(
    removes: { content: string; lineNum: number }[],
    adds: { content: string; lineNum: number }[],
  ): { leftLines: LogicalLine[]; rightLines: LogicalLine[] } {
    const leftLines: LogicalLine[] = []
    const rightLines: LogicalLine[] = []

    const maxLength = Math.max(removes.length, adds.length)
    const blockSize = removes.length + adds.length
    const shouldComputeWordHighlights =
      !this._disableWordHighlights && blockSize <= DiffRenderable.MAX_WORD_HIGHLIGHT_BLOCK_SIZE

    for (let j = 0; j < maxLength; j++) {
      const remove = j < removes.length ? removes[j] : null
      const add = j < adds.length ? adds[j] : null

      let leftHighlights: InlineHighlight[] = []
      let rightHighlights: InlineHighlight[] = []

      if (shouldComputeWordHighlights && remove && add) {
        const similarity = computeLineSimilarity(remove.content, add.content)
        if (similarity >= this._lineSimilarityThreshold) {
          const highlights = computeInlineHighlights(remove.content, add.content)
          leftHighlights = highlights.oldHighlights
          rightHighlights = highlights.newHighlights
        }
      }

      if (remove) {
        leftLines.push({
          content: remove.content,
          lineNum: remove.lineNum,
          color: this._removedBg,
          sign: {
            after: " -",
            afterColor: this._removedSignColor,
          },
          type: "remove",
          inlineHighlights: leftHighlights,
        })
      } else {
        leftLines.push({
          content: "",
          hideLineNumber: true,
          type: "empty",
        })
      }

      if (add) {
        rightLines.push({
          content: add.content,
          lineNum: add.lineNum,
          color: this._addedBg,
          sign: {
            after: " +",
            afterColor: this._addedSignColor,
          },
          type: "add",
          inlineHighlights: rightHighlights,
        })
      } else {
        rightLines.push({
          content: "",
          hideLineNumber: true,
          type: "empty",
        })
      }
    }

    return { leftLines, rightLines }
  }

  private parseDiff(): void {
    if (!this._diff) {
      this._parsedDiff = null
      this._parseError = null
      return
    }

    try {
      // Use jsdiff's parsePatch to parse the diff string
      const patches = parsePatch(this._diff)

      if (patches.length === 0) {
        this._parsedDiff = null
        this._parseError = null
        return
      }

      // Use the first patch (most diffs have only one file)
      this._parsedDiff = patches[0]
      this._parseError = null
    } catch (error) {
      // Catch parsing errors from invalid diff format
      this._parsedDiff = null
      this._parseError = error instanceof Error ? error : new Error(String(error))
    }
  }

  private buildView(): void {
    // Never destroy anything - just update existing renderables or create new ones
    // Unified view uses leftSide only, split view uses both leftSide and rightSide

    // If there's a parse error, show error message instead
    if (this._parseError) {
      this.buildErrorView()
      return
    }

    if (!this._parsedDiff || this._parsedDiff.hunks.length === 0) {
      return
    }

    if (this._view === "unified") {
      this.buildUnifiedView()
    } else {
      this.buildSplitView()
    }
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height)

    // Only rebuild on width changes to avoid endless loops (height is a consequence of wrapping, not an input)
    if (this._view === "split" && this._wrapMode !== "none" && this._wrapMode !== undefined) {
      if (this._lastWidth !== width) {
        this._lastWidth = width
        this.requestRebuild()
      }
    }
  }

  private requestRebuild(): void {
    if (this.pendingRebuild) {
      return
    }

    this.pendingRebuild = true
    queueMicrotask(() => {
      if (!this.isDestroyed && this.pendingRebuild) {
        this.pendingRebuild = false
        this.buildView()
        this.requestRender()
      }
    })
  }

  private rebuildView(): void {
    // Use microtask rebuild for split view, immediate for unified
    if (this._view === "split") {
      this.requestRebuild()
    } else {
      this.buildView()
    }
  }

  public override destroyRecursively(): void {
    this.pendingRebuild = false
    this.leftSideAdded = false
    this.rightSideAdded = false
    super.destroyRecursively()
  }

  /**
   * Create or update a CodeRenderable with the given content and options.
   * Reuses existing instances to avoid expensive recreation.
   */
  private buildErrorView(): void {
    // Ensure column layout for error view
    this.flexDirection = "column"

    // Remove any existing diff view renderables
    if (this.leftSide && this.leftSideAdded) {
      super.remove(this.leftSide.id)
      this.leftSideAdded = false
    }
    if (this.rightSide && this.rightSideAdded) {
      super.remove(this.rightSide.id)
      this.rightSideAdded = false
    }

    // Create or update error text renderable
    const errorMessage = `Error parsing diff: ${this._parseError?.message || "Unknown error"}\n`
    if (!this.errorTextRenderable) {
      this.errorTextRenderable = new TextRenderable(this.ctx, {
        id: this.id ? `${this.id}-error-text` : undefined,
        content: errorMessage,
        fg: "#ef4444",
        width: "100%",
        flexShrink: 0,
      })
      super.add(this.errorTextRenderable)
    } else {
      this.errorTextRenderable.content = errorMessage
      // Ensure it's in the render tree
      const errorTextIndex = this.getChildren().indexOf(this.errorTextRenderable)
      if (errorTextIndex === -1) {
        super.add(this.errorTextRenderable)
      }
    }

    // Create or update error code renderable to show the raw diff
    if (!this.errorCodeRenderable) {
      this.errorCodeRenderable = new CodeRenderable(this.ctx, {
        id: this.id ? `${this.id}-error-code` : undefined,
        content: this._diff,
        filetype: "diff",
        syntaxStyle: this._syntaxStyle ?? SyntaxStyle.create(),
        wrapMode: this._wrapMode,
        conceal: this._conceal,
        width: "100%",
        flexGrow: 1,
        flexShrink: 1,
        ...(this._treeSitterClient !== undefined && { treeSitterClient: this._treeSitterClient }),
      })
      super.add(this.errorCodeRenderable)
    } else {
      this.errorCodeRenderable.content = this._diff
      this.errorCodeRenderable.wrapMode = this._wrapMode ?? "none"
      if (this._syntaxStyle) {
        this.errorCodeRenderable.syntaxStyle = this._syntaxStyle
      }
      // Ensure it's in the render tree
      const errorCodeIndex = this.getChildren().indexOf(this.errorCodeRenderable)
      if (errorCodeIndex === -1) {
        super.add(this.errorCodeRenderable)
      }
    }
  }

  private createOrUpdateCodeRenderable(
    side: "left" | "right",
    content: string,
    wrapMode: "word" | "char" | "none" | undefined,
    drawUnstyledText?: boolean,
  ): CodeRenderable {
    const existingRenderable = side === "left" ? this.leftCodeRenderable : this.rightCodeRenderable

    if (!existingRenderable) {
      // Create new CodeRenderable
      const codeOptions: CodeOptions = {
        id: this.id ? `${this.id}-${side}-code` : undefined,
        content,
        filetype: this._filetype,
        wrapMode,
        conceal: this._conceal,
        syntaxStyle: this._syntaxStyle ?? SyntaxStyle.create(),
        width: "100%",
        height: "100%",
        ...(this._fg !== undefined && { fg: this._fg }),
        ...(drawUnstyledText !== undefined && { drawUnstyledText }),
        ...(this._selectionBg !== undefined && { selectionBg: this._selectionBg }),
        ...(this._selectionFg !== undefined && { selectionFg: this._selectionFg }),
        ...(this._treeSitterClient !== undefined && { treeSitterClient: this._treeSitterClient }),
      }
      const newRenderable = new CodeRenderable(this.ctx, codeOptions)

      if (side === "left") {
        this.leftCodeRenderable = newRenderable
      } else {
        this.rightCodeRenderable = newRenderable
      }

      return newRenderable
    } else {
      // Update existing CodeRenderable
      existingRenderable.content = content
      existingRenderable.wrapMode = wrapMode ?? "none"
      existingRenderable.conceal = this._conceal
      if (drawUnstyledText !== undefined) {
        existingRenderable.drawUnstyledText = drawUnstyledText
      }
      if (this._filetype !== undefined) {
        existingRenderable.filetype = this._filetype
      }
      if (this._syntaxStyle !== undefined) {
        existingRenderable.syntaxStyle = this._syntaxStyle
      }
      if (this._selectionBg !== undefined) {
        existingRenderable.selectionBg = this._selectionBg
      }
      if (this._selectionFg !== undefined) {
        existingRenderable.selectionFg = this._selectionFg
      }
      if (this._fg !== undefined) {
        existingRenderable.fg = this._fg
      }

      return existingRenderable
    }
  }

  /**
   * Create or update a LineNumberRenderable side panel.
   * Handles both creation and updates, ensuring the side is properly added to the render tree.
   */
  private createOrUpdateSide(
    side: "left" | "right",
    target: CodeRenderable,
    lineColors: Map<number, string | RGBA | LineColorConfig>,
    lineSigns: Map<number, LineSign>,
    lineNumbers: Map<number, number>,
    hideLineNumbers: Set<number>,
    width: "50%" | "100%",
    inlineHighlights?: Map<number, LineInlineHighlight[]>,
  ): void {
    const sideRef = side === "left" ? this.leftSide : this.rightSide
    const addedFlag = side === "left" ? this.leftSideAdded : this.rightSideAdded

    if (!sideRef) {
      // Create new LineNumberRenderable
      const newSide = new LineNumberRenderable(this.ctx, {
        id: this.id ? `${this.id}-${side}` : undefined,
        target,
        fg: this._lineNumberFg,
        bg: this._lineNumberBg,
        lineColors,
        lineSigns,
        lineNumbers,
        lineNumberOffset: 0,
        hideLineNumbers,
        inlineHighlights,
        width,
        height: "100%",
      })
      newSide.showLineNumbers = this._showLineNumbers
      super.add(newSide)

      if (side === "left") {
        this.leftSide = newSide
        this.leftSideAdded = true
      } else {
        this.rightSide = newSide
        this.rightSideAdded = true
      }
    } else {
      // Update existing LineNumberRenderable
      sideRef.width = width
      sideRef.setLineColors(lineColors)
      sideRef.setLineSigns(lineSigns)
      sideRef.setLineNumbers(lineNumbers)
      sideRef.setHideLineNumbers(hideLineNumbers)
      if (inlineHighlights) {
        sideRef.setInlineHighlights(inlineHighlights)
      } else {
        sideRef.clearInlineHighlights()
      }

      // Ensure side is added if not already
      if (!addedFlag) {
        super.add(sideRef)
        if (side === "left") {
          this.leftSideAdded = true
        } else {
          this.rightSideAdded = true
        }
      }
    }
  }

  private buildUnifiedView(): void {
    if (!this._parsedDiff) return

    // Ensure column layout for unified view
    this.flexDirection = "column"

    // Remove error renderables if they exist
    if (this.errorTextRenderable) {
      const errorTextIndex = this.getChildren().indexOf(this.errorTextRenderable)
      if (errorTextIndex !== -1) {
        super.remove(this.errorTextRenderable.id)
      }
    }
    if (this.errorCodeRenderable) {
      const errorCodeIndex = this.getChildren().indexOf(this.errorCodeRenderable)
      if (errorCodeIndex !== -1) {
        super.remove(this.errorCodeRenderable.id)
      }
    }

    const contentLines: string[] = []
    const lineColors = new Map<number, string | RGBA | LineColorConfig>()
    const lineSigns = new Map<number, LineSign>()
    const lineNumbers = new Map<number, number>()
    const inlineHighlights = new Map<number, LineInlineHighlight[]>()

    let lineIndex = 0

    // Process each hunk
    for (const hunk of this._parsedDiff.hunks) {
      let oldLineNum = hunk.oldStart
      let newLineNum = hunk.newStart

      let i = 0
      while (i < hunk.lines.length) {
        const line = hunk.lines[i]
        const firstChar = line[0]
        const content = line.slice(1)

        if (firstChar === " ") {
          // Context line
          contentLines.push(content)
          const config: LineColorConfig = {
            gutter: this._lineNumberBg,
          }
          if (this._contextContentBg) {
            config.content = this._contextContentBg
          } else {
            config.content = this._contextBg
          }
          lineColors.set(lineIndex, config)
          lineNumbers.set(lineIndex, newLineNum)
          oldLineNum++
          newLineNum++
          lineIndex++
          i++
        } else if (firstChar === "\\") {
          // Skip "\ No newline at end of file"
          i++
        } else {
          // Collect consecutive removes and adds as a block
          const removes: { content: string; lineNum: number }[] = []
          const adds: { content: string; lineNum: number }[] = []

          while (i < hunk.lines.length) {
            const currentLine = hunk.lines[i]
            const currentChar = currentLine[0]

            if (currentChar === " " || currentChar === "\\") {
              break
            }

            const currentContent = currentLine.slice(1)

            if (currentChar === "-") {
              removes.push({ content: currentContent, lineNum: oldLineNum })
              oldLineNum++
            } else if (currentChar === "+") {
              adds.push({ content: currentContent, lineNum: newLineNum })
              newLineNum++
            }
            i++
          }

          const processedBlock = this.processChangeBlockWithHighlights(removes, adds)

          for (const line of processedBlock.leftLines) {
            if (line.type === "empty") continue
            contentLines.push(line.content)
            lineColors.set(lineIndex, {
              gutter: this._removedLineNumberBg,
              content: this._removedContentBg ?? this._removedBg,
            })
            lineSigns.set(lineIndex, { after: " -", afterColor: this._removedSignColor })
            if (line.lineNum !== undefined) lineNumbers.set(lineIndex, line.lineNum)
            if (line.inlineHighlights?.length) {
              inlineHighlights.set(lineIndex, this.toLineHighlights(line.inlineHighlights, this._removedWordBg))
            }
            lineIndex++
          }

          for (const line of processedBlock.rightLines) {
            if (line.type === "empty") continue
            contentLines.push(line.content)
            lineColors.set(lineIndex, {
              gutter: this._addedLineNumberBg,
              content: this._addedContentBg ?? this._addedBg,
            })
            lineSigns.set(lineIndex, { after: " +", afterColor: this._addedSignColor })
            if (line.lineNum !== undefined) lineNumbers.set(lineIndex, line.lineNum)
            if (line.inlineHighlights?.length) {
              inlineHighlights.set(lineIndex, this.toLineHighlights(line.inlineHighlights, this._addedWordBg))
            }
            lineIndex++
          }
        }
      }
    }

    const content = contentLines.join("\n")

    // Create or update CodeRenderable for left side (used for unified view)
    const codeRenderable = this.createOrUpdateCodeRenderable("left", content, this._wrapMode)

    // Create or update LineNumberRenderable (leftSide used for unified view)
    this.createOrUpdateSide(
      "left",
      codeRenderable,
      lineColors,
      lineSigns,
      lineNumbers,
      new Set<number>(),
      "100%",
      inlineHighlights.size > 0 ? inlineHighlights : undefined,
    )

    // Remove rightSide from render tree for unified view
    if (this.rightSide && this.rightSideAdded) {
      super.remove(this.rightSide.id)
      this.rightSideAdded = false
    }
  }

  private buildSplitView(): void {
    if (!this._parsedDiff) return

    // Ensure row layout for split view
    this.flexDirection = "row"

    // Remove error renderables if they exist
    if (this.errorTextRenderable) {
      const errorTextIndex = this.getChildren().indexOf(this.errorTextRenderable)
      if (errorTextIndex !== -1) {
        super.remove(this.errorTextRenderable.id)
      }
    }
    if (this.errorCodeRenderable) {
      const errorCodeIndex = this.getChildren().indexOf(this.errorCodeRenderable)
      if (errorCodeIndex !== -1) {
        super.remove(this.errorCodeRenderable.id)
      }
    }

    // Step 1: Build initial content without wrapping alignment
    const leftLogicalLines: LogicalLine[] = []
    const rightLogicalLines: LogicalLine[] = []

    // Process each hunk to build logical lines
    for (const hunk of this._parsedDiff.hunks) {
      let oldLineNum = hunk.oldStart
      let newLineNum = hunk.newStart

      let i = 0
      while (i < hunk.lines.length) {
        const line = hunk.lines[i]
        const firstChar = line[0]

        if (firstChar === " ") {
          // Context line - add to both sides
          const content = line.slice(1)
          leftLogicalLines.push({
            content,
            lineNum: oldLineNum,
            color: this._contextBg,
            type: "context",
          })
          rightLogicalLines.push({
            content,
            lineNum: newLineNum,
            color: this._contextBg,
            type: "context",
          })
          oldLineNum++
          newLineNum++
          i++
        } else if (firstChar === "\\") {
          // Skip "\ No newline at end of file"
          i++
        } else {
          // Collect consecutive removes and adds as a block
          const removes: { content: string; lineNum: number }[] = []
          const adds: { content: string; lineNum: number }[] = []

          while (i < hunk.lines.length) {
            const currentLine = hunk.lines[i]
            const currentChar = currentLine[0]

            if (currentChar === " " || currentChar === "\\") {
              break
            }

            const content = currentLine.slice(1)

            if (currentChar === "-") {
              removes.push({ content, lineNum: oldLineNum })
              oldLineNum++
            } else if (currentChar === "+") {
              adds.push({ content, lineNum: newLineNum })
              newLineNum++
            }
            i++
          }

          // Process the change block with word-level highlighting
          const processedBlock = this.processChangeBlockWithHighlights(removes, adds)

          // Add processed lines to output
          for (const leftLine of processedBlock.leftLines) {
            leftLogicalLines.push(leftLine)
          }
          for (const rightLine of processedBlock.rightLines) {
            rightLogicalLines.push(rightLine)
          }
        }
      }
    }

    // Step 2: Determine if we can do wrap-aware alignment
    // We need valid widths for wrap calculation, which requires a layout pass
    // On first build (from constructor), widths are 0, so we skip wrap alignment
    // and schedule a rebuild after layout
    const canDoWrapAlignment = this.width > 0 && (this._wrapMode === "word" || this._wrapMode === "char")

    const preLeftContent = leftLogicalLines.map((l) => l.content).join("\n")
    const preRightContent = rightLogicalLines.map((l) => l.content).join("\n")

    // Don't draw unstyled text when using wrap+conceal to avoid race conditions where sides wrap differently
    const needsConsistentConcealing =
      (this._wrapMode === "word" || this._wrapMode === "char") && this._conceal && this._filetype
    const drawUnstyledText = !needsConsistentConcealing
    const leftCodeRenderable = this.createOrUpdateCodeRenderable(
      "left",
      preLeftContent,
      this._wrapMode,
      drawUnstyledText,
    )
    const rightCodeRenderable = this.createOrUpdateCodeRenderable(
      "right",
      preRightContent,
      this._wrapMode,
      drawUnstyledText,
    )

    // Step 3: Align lines using lineInfo (if we can)
    let finalLeftLines: LogicalLine[]
    let finalRightLines: LogicalLine[]

    if (canDoWrapAlignment) {
      const leftLineInfo = leftCodeRenderable.lineInfo
      const rightLineInfo = rightCodeRenderable.lineInfo

      const leftSources = leftLineInfo.lineSources || []
      const rightSources = rightLineInfo.lineSources || []

      // Build visual count per logical line
      const leftVisualCounts = new Map<number, number>()
      const rightVisualCounts = new Map<number, number>()

      for (const logicalLine of leftSources) {
        leftVisualCounts.set(logicalLine, (leftVisualCounts.get(logicalLine) || 0) + 1)
      }
      for (const logicalLine of rightSources) {
        rightVisualCounts.set(logicalLine, (rightVisualCounts.get(logicalLine) || 0) + 1)
      }

      // Align by inserting padding to ensure both sides stay synchronized
      // Each logical line should start at the same visual position on both sides
      finalLeftLines = []
      finalRightLines = []

      let leftVisualPos = 0
      let rightVisualPos = 0

      for (let i = 0; i < leftLogicalLines.length; i++) {
        const leftLine = leftLogicalLines[i]
        const rightLine = rightLogicalLines[i]

        const leftVisualCount = leftVisualCounts.get(i) || 1
        const rightVisualCount = rightVisualCounts.get(i) || 1

        // Both logical lines should start at the same visual position
        // If they don't, add padding to whichever side is behind
        if (leftVisualPos < rightVisualPos) {
          const pad = rightVisualPos - leftVisualPos
          for (let p = 0; p < pad; p++) {
            finalLeftLines.push({ content: "", hideLineNumber: true, type: "empty" })
          }
          leftVisualPos += pad
        } else if (rightVisualPos < leftVisualPos) {
          const pad = leftVisualPos - rightVisualPos
          for (let p = 0; p < pad; p++) {
            finalRightLines.push({ content: "", hideLineNumber: true, type: "empty" })
          }
          rightVisualPos += pad
        }

        // Now add the actual content line
        finalLeftLines.push(leftLine)
        finalRightLines.push(rightLine)

        // Update visual positions
        leftVisualPos += leftVisualCount
        rightVisualPos += rightVisualCount
      }

      // Final padding to make totals equal
      if (leftVisualPos < rightVisualPos) {
        const pad = rightVisualPos - leftVisualPos
        for (let p = 0; p < pad; p++) {
          finalLeftLines.push({ content: "", hideLineNumber: true, type: "empty" })
        }
      } else if (rightVisualPos < leftVisualPos) {
        const pad = leftVisualPos - rightVisualPos
        for (let p = 0; p < pad; p++) {
          finalRightLines.push({ content: "", hideLineNumber: true, type: "empty" })
        }
      }
    } else {
      // Can't do wrap alignment yet (no width), use logical lines as-is
      finalLeftLines = leftLogicalLines
      finalRightLines = rightLogicalLines

      // If wrapMode is set but we can't align yet, onResize will trigger a rebuild
      // once widths are available (no manual scheduling needed here)
    }

    // Step 4: Build final content and metadata
    const leftLineColors = new Map<number, string | RGBA | LineColorConfig>()
    const rightLineColors = new Map<number, string | RGBA | LineColorConfig>()
    const leftLineSigns = new Map<number, LineSign>()
    const rightLineSigns = new Map<number, LineSign>()
    const leftHideLineNumbers = new Set<number>()
    const rightHideLineNumbers = new Set<number>()
    const leftLineNumbers = new Map<number, number>()
    const rightLineNumbers = new Map<number, number>()
    const leftInlineHighlights = new Map<number, LineInlineHighlight[]>()
    const rightInlineHighlights = new Map<number, LineInlineHighlight[]>()

    finalLeftLines.forEach((line, index) => {
      if (line.lineNum !== undefined) {
        leftLineNumbers.set(index, line.lineNum)
      }
      if (line.hideLineNumber) {
        leftHideLineNumbers.add(index)
      }
      if (line.type === "remove") {
        const config: LineColorConfig = {
          gutter: this._removedLineNumberBg,
        }
        if (this._removedContentBg) {
          config.content = this._removedContentBg
        } else {
          config.content = this._removedBg
        }
        leftLineColors.set(index, config)
      } else if (line.type === "context") {
        const config: LineColorConfig = {
          gutter: this._lineNumberBg,
        }
        if (this._contextContentBg) {
          config.content = this._contextContentBg
        } else {
          config.content = this._contextBg
        }
        leftLineColors.set(index, config)
      }
      if (line.sign) {
        leftLineSigns.set(index, line.sign)
      }
      if (line.inlineHighlights?.length) {
        leftInlineHighlights.set(index, this.toLineHighlights(line.inlineHighlights, this._removedWordBg))
      }
    })

    finalRightLines.forEach((line, index) => {
      if (line.lineNum !== undefined) {
        rightLineNumbers.set(index, line.lineNum)
      }
      if (line.hideLineNumber) {
        rightHideLineNumbers.add(index)
      }
      if (line.type === "add") {
        const config: LineColorConfig = {
          gutter: this._addedLineNumberBg,
        }
        if (this._addedContentBg) {
          config.content = this._addedContentBg
        } else {
          config.content = this._addedBg
        }
        rightLineColors.set(index, config)
      } else if (line.type === "context") {
        const config: LineColorConfig = {
          gutter: this._lineNumberBg,
        }
        if (this._contextContentBg) {
          config.content = this._contextContentBg
        } else {
          config.content = this._contextBg
        }
        rightLineColors.set(index, config)
      }
      if (line.sign) {
        rightLineSigns.set(index, line.sign)
      }
      if (line.inlineHighlights?.length) {
        rightInlineHighlights.set(index, this.toLineHighlights(line.inlineHighlights, this._addedWordBg))
      }
    })

    const leftContentFinal = finalLeftLines.map((l) => l.content).join("\n")
    const rightContentFinal = finalRightLines.map((l) => l.content).join("\n")

    // Step 5: Update CodeRenderables with final content
    leftCodeRenderable.content = leftContentFinal
    rightCodeRenderable.content = rightContentFinal

    // Create or update LineNumberRenderables (they wrap the CodeRenderables)
    // leftSide might already exist from unified view, so we reuse it
    this.createOrUpdateSide(
      "left",
      leftCodeRenderable,
      leftLineColors,
      leftLineSigns,
      leftLineNumbers,
      leftHideLineNumbers,
      "50%",
      leftInlineHighlights.size > 0 ? leftInlineHighlights : undefined,
    )
    this.createOrUpdateSide(
      "right",
      rightCodeRenderable,
      rightLineColors,
      rightLineSigns,
      rightLineNumbers,
      rightHideLineNumbers,
      "50%",
      rightInlineHighlights.size > 0 ? rightInlineHighlights : undefined,
    )
  }

  // Getters and setters
  public get diff(): string {
    return this._diff
  }

  public set diff(value: string) {
    if (this._diff !== value) {
      this._diff = value
      this.parseDiff()
      this.rebuildView()
    }
  }

  public get view(): "unified" | "split" {
    return this._view
  }

  public set view(value: "unified" | "split") {
    if (this._view !== value) {
      this._view = value
      this.flexDirection = value === "split" ? "row" : "column"
      // Always rebuild immediately when changing view mode
      this.buildView()
    }
  }

  public get filetype(): string | undefined {
    return this._filetype
  }

  public set filetype(value: string | undefined) {
    if (this._filetype !== value) {
      this._filetype = value
      this.rebuildView()
    }
  }

  public get syntaxStyle(): SyntaxStyle | undefined {
    return this._syntaxStyle
  }

  public set syntaxStyle(value: SyntaxStyle | undefined) {
    if (this._syntaxStyle !== value) {
      this._syntaxStyle = value
      this.rebuildView()
    }
  }

  public get wrapMode(): "word" | "char" | "none" | undefined {
    return this._wrapMode
  }

  public set wrapMode(value: "word" | "char" | "none" | undefined) {
    if (this._wrapMode !== value) {
      this._wrapMode = value

      // For unified view, directly update wrapMode on the CodeRenderable
      if (this._view === "unified" && this.leftCodeRenderable) {
        this.leftCodeRenderable.wrapMode = value ?? "none"
      } else if (this._view === "split") {
        // For split view, wrapMode affects alignment, so rebuild
        this.requestRebuild()
      }
    }
  }

  public get showLineNumbers(): boolean {
    return this._showLineNumbers
  }

  public set showLineNumbers(value: boolean) {
    if (this._showLineNumbers !== value) {
      this._showLineNumbers = value
      if (this.leftSide) {
        this.leftSide.showLineNumbers = value
      }
      if (this.rightSide) {
        this.rightSide.showLineNumbers = value
      }
    }
  }

  public get addedBg(): RGBA {
    return this._addedBg
  }

  public set addedBg(value: string | RGBA) {
    const parsed = parseColor(value)
    if (this._addedBg !== parsed) {
      this._addedBg = parsed
      this.rebuildView()
    }
  }

  public get removedBg(): RGBA {
    return this._removedBg
  }

  public set removedBg(value: string | RGBA) {
    const parsed = parseColor(value)
    if (this._removedBg !== parsed) {
      this._removedBg = parsed
      this.rebuildView()
    }
  }

  public get contextBg(): RGBA {
    return this._contextBg
  }

  public set contextBg(value: string | RGBA) {
    const parsed = parseColor(value)
    if (this._contextBg !== parsed) {
      this._contextBg = parsed
      this.rebuildView()
    }
  }

  public get addedSignColor(): RGBA {
    return this._addedSignColor
  }

  public set addedSignColor(value: string | RGBA) {
    const parsed = parseColor(value)
    if (this._addedSignColor !== parsed) {
      this._addedSignColor = parsed
      this.rebuildView()
    }
  }

  public get removedSignColor(): RGBA {
    return this._removedSignColor
  }

  public set removedSignColor(value: string | RGBA) {
    const parsed = parseColor(value)
    if (this._removedSignColor !== parsed) {
      this._removedSignColor = parsed
      this.rebuildView()
    }
  }

  public get addedLineNumberBg(): RGBA {
    return this._addedLineNumberBg
  }

  public set addedLineNumberBg(value: string | RGBA) {
    const parsed = parseColor(value)
    if (this._addedLineNumberBg !== parsed) {
      this._addedLineNumberBg = parsed
      this.rebuildView()
    }
  }

  public get removedLineNumberBg(): RGBA {
    return this._removedLineNumberBg
  }

  public set removedLineNumberBg(value: string | RGBA) {
    const parsed = parseColor(value)
    if (this._removedLineNumberBg !== parsed) {
      this._removedLineNumberBg = parsed
      this.rebuildView()
    }
  }

  public get lineNumberFg(): RGBA {
    return this._lineNumberFg
  }

  public set lineNumberFg(value: string | RGBA) {
    const parsed = parseColor(value)
    if (this._lineNumberFg !== parsed) {
      this._lineNumberFg = parsed
      this.rebuildView()
    }
  }

  public get lineNumberBg(): RGBA {
    return this._lineNumberBg
  }

  public set lineNumberBg(value: string | RGBA) {
    const parsed = parseColor(value)
    if (this._lineNumberBg !== parsed) {
      this._lineNumberBg = parsed
      this.rebuildView()
    }
  }

  public get addedContentBg(): RGBA | null {
    return this._addedContentBg
  }

  public set addedContentBg(value: string | RGBA | null) {
    const parsed = value ? parseColor(value) : null
    if (this._addedContentBg !== parsed) {
      this._addedContentBg = parsed
      this.rebuildView()
    }
  }

  public get removedContentBg(): RGBA | null {
    return this._removedContentBg
  }

  public set removedContentBg(value: string | RGBA | null) {
    const parsed = value ? parseColor(value) : null
    if (this._removedContentBg !== parsed) {
      this._removedContentBg = parsed
      this.rebuildView()
    }
  }

  public get contextContentBg(): RGBA | null {
    return this._contextContentBg
  }

  public set contextContentBg(value: string | RGBA | null) {
    const parsed = value ? parseColor(value) : null
    if (this._contextContentBg !== parsed) {
      this._contextContentBg = parsed
      this.rebuildView()
    }
  }

  public get selectionBg(): RGBA | undefined {
    return this._selectionBg
  }

  public set selectionBg(value: string | RGBA | undefined) {
    const parsed = value ? parseColor(value) : undefined
    if (this._selectionBg !== parsed) {
      this._selectionBg = parsed
      if (this.leftCodeRenderable) {
        this.leftCodeRenderable.selectionBg = parsed
      }
      if (this.rightCodeRenderable) {
        this.rightCodeRenderable.selectionBg = parsed
      }
    }
  }

  public get selectionFg(): RGBA | undefined {
    return this._selectionFg
  }

  public set selectionFg(value: string | RGBA | undefined) {
    const parsed = value ? parseColor(value) : undefined
    if (this._selectionFg !== parsed) {
      this._selectionFg = parsed
      if (this.leftCodeRenderable) {
        this.leftCodeRenderable.selectionFg = parsed
      }
      if (this.rightCodeRenderable) {
        this.rightCodeRenderable.selectionFg = parsed
      }
    }
  }

  public get conceal(): boolean {
    return this._conceal
  }

  public set conceal(value: boolean) {
    if (this._conceal !== value) {
      this._conceal = value
      this.rebuildView()
    }
  }

  public get fg(): RGBA | undefined {
    return this._fg
  }

  public set fg(value: string | RGBA | undefined) {
    const parsed = value ? parseColor(value) : undefined
    if (this._fg !== parsed) {
      this._fg = parsed
      if (this.leftCodeRenderable) {
        this.leftCodeRenderable.fg = parsed
      }
      if (this.rightCodeRenderable) {
        this.rightCodeRenderable.fg = parsed
      }
    }
  }

  public get disableWordHighlights(): boolean {
    return this._disableWordHighlights
  }

  public set disableWordHighlights(value: boolean) {
    if (this._disableWordHighlights !== value) {
      this._disableWordHighlights = value
      this.rebuildView()
    }
  }

  public get addedWordBg(): RGBA {
    return this._addedWordBg
  }

  public set addedWordBg(value: string | RGBA) {
    const parsed = parseColor(value)
    if (this._addedWordBg !== parsed) {
      this._addedWordBg = parsed
      this.rebuildView()
    }
  }

  public get removedWordBg(): RGBA {
    return this._removedWordBg
  }

  public set removedWordBg(value: string | RGBA) {
    const parsed = parseColor(value)
    if (this._removedWordBg !== parsed) {
      this._removedWordBg = parsed
      this.rebuildView()
    }
  }

  public get lineSimilarityThreshold(): number {
    return this._lineSimilarityThreshold
  }

  public set lineSimilarityThreshold(value: number) {
    if (this._lineSimilarityThreshold !== value) {
      this._lineSimilarityThreshold = Math.max(0, Math.min(1, value))
      this.rebuildView()
    }
  }
}
