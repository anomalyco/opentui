import { Renderable, type RenderableOptions } from "../Renderable"
import type { RenderContext } from "../types"
import { CodeRenderable, type CodeOptions } from "./Code"
import { LineNumberRenderable, type LineSign, type LineColorConfig } from "./LineNumberRenderable"
import { RGBA, parseColor } from "../lib/RGBA"
import { SyntaxStyle } from "../syntax-style"
import { parsePatch, type StructuredPatch } from "diff"
import { TextRenderable } from "./Text"
import type { TreeSitterClient } from "../lib/tree-sitter"

interface LogicalLine {
  content: string
  lineNum?: number
  hideLineNumber?: boolean
  color?: string | RGBA
  sign?: LineSign
  type: "context" | "add" | "remove" | "empty"
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
  private _ownedSyntaxStyle: SyntaxStyle | null = null
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

  private leftSide: LineNumberRenderable | null = null
  private rightSide: LineNumberRenderable | null = null

  private leftSideAdded: boolean = false
  private rightSideAdded: boolean = false

  private leftCodeRenderable: CodeRenderable | null = null
  private rightCodeRenderable: CodeRenderable | null = null

  private pendingRebuild: boolean = false
  private _lastWidth: number = 0

  private errorTextRenderable: TextRenderable | null = null
  private errorCodeRenderable: CodeRenderable | null = null

  private _waitingForHighlight: boolean = false
  private _lineInfoChangeHandler: (() => void) | null = null
  private _cleanupDone: boolean = false

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
    this.ensureSyntaxStyle()
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

    if (this._diff) {
      this.parseDiff()
      this.buildView()
    }
  }

  private parseDiff(): void {
    if (!this._diff) {
      this._parsedDiff = null
      this._parseError = null
      return
    }

    try {
      const patches = parsePatch(this._diff)

      if (patches.length === 0) {
        this._parsedDiff = null
        this._parseError = null
        return
      }

      this._parsedDiff = patches[0]
      this._parseError = null
    } catch (error) {
      this._parsedDiff = null
      this._parseError = error instanceof Error ? error : new Error(String(error))
    }
  }

  private buildView(): void {
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
    if (this._view === "split") {
      this.requestRebuild()
    } else {
      this.buildView()
    }
  }

  private handleLineInfoChange = (): void => {
    if (!this._waitingForHighlight) return
    if (!this.leftCodeRenderable || !this.rightCodeRenderable) return

    const leftIsHighlighting = this.leftCodeRenderable.isHighlighting
    const rightIsHighlighting = this.rightCodeRenderable.isHighlighting

    if (!leftIsHighlighting && !rightIsHighlighting) {
      this._waitingForHighlight = false
      this.requestRebuild()
    }
  }

  private attachLineInfoListeners(): void {
    if (this._lineInfoChangeHandler) return
    if (!this.leftCodeRenderable || !this.rightCodeRenderable) return

    this._lineInfoChangeHandler = this.handleLineInfoChange
    this.leftCodeRenderable.on("line-info-change", this._lineInfoChangeHandler)
    this.rightCodeRenderable.on("line-info-change", this._lineInfoChangeHandler)
  }

  private detachLineInfoListeners(): void {
    if (!this._lineInfoChangeHandler) return

    if (this.leftCodeRenderable) {
      this.leftCodeRenderable.off("line-info-change", this._lineInfoChangeHandler)
    }
    if (this.rightCodeRenderable) {
      this.rightCodeRenderable.off("line-info-change", this._lineInfoChangeHandler)
    }
    this._lineInfoChangeHandler = null
  }

  private ensureSyntaxStyle(): SyntaxStyle {
    if (this._syntaxStyle) return this._syntaxStyle

    if (!this._ownedSyntaxStyle) {
      this._ownedSyntaxStyle = SyntaxStyle.create()
    }

    this._syntaxStyle = this._ownedSyntaxStyle
    return this._syntaxStyle
  }

  private cleanupResources(): void {
    if (this._cleanupDone) return
    this._cleanupDone = true

    this.detachLineInfoListeners()
    this.pendingRebuild = false
    this.leftSideAdded = false
    this.rightSideAdded = false

    if (this._ownedSyntaxStyle) {
      this._ownedSyntaxStyle.destroy()
      this._ownedSyntaxStyle = null
    }
  }

  public override destroyRecursively(): void {
    this.cleanupResources()
    super.destroyRecursively()
  }

  protected override destroySelf(): void {
    this.cleanupResources()
  }

  private buildErrorView(): void {
    this.flexDirection = "column"

    if (this.leftSide && this.leftSideAdded) {
      super.remove(this.leftSide.id)
      this.leftSideAdded = false
    }
    if (this.rightSide && this.rightSideAdded) {
      super.remove(this.rightSide.id)
      this.rightSideAdded = false
    }

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
      const errorTextIndex = this.getChildren().indexOf(this.errorTextRenderable)
      if (errorTextIndex === -1) {
        super.add(this.errorTextRenderable)
      }
    }

    if (!this.errorCodeRenderable) {
      const syntaxStyle = this.ensureSyntaxStyle()
      this.errorCodeRenderable = new CodeRenderable(this.ctx, {
        id: this.id ? `${this.id}-error-code` : undefined,
        content: this._diff,
        filetype: "diff",
        syntaxStyle,
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

    const syntaxStyle = this.ensureSyntaxStyle()

    if (!existingRenderable) {
      const codeOptions: CodeOptions = {
        id: this.id ? `${this.id}-${side}-code` : undefined,
        content,
        filetype: this._filetype,
        wrapMode,
        conceal: this._conceal,
        syntaxStyle,
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

  private createOrUpdateSide(
    side: "left" | "right",
    target: CodeRenderable,
    lineColors: Map<number, string | RGBA | LineColorConfig>,
    lineSigns: Map<number, LineSign>,
    lineNumbers: Map<number, number>,
    hideLineNumbers: Set<number>,
    width: "50%" | "100%",
  ): void {
    const sideRef = side === "left" ? this.leftSide : this.rightSide
    const addedFlag = side === "left" ? this.leftSideAdded : this.rightSideAdded

    if (!sideRef) {
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
      sideRef.width = width
      sideRef.setLineColors(lineColors)
      sideRef.setLineSigns(lineSigns)
      sideRef.setLineNumbers(lineNumbers)
      sideRef.setHideLineNumbers(hideLineNumbers)

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

    this.flexDirection = "column"

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

    let lineIndex = 0

    for (const hunk of this._parsedDiff.hunks) {
      let oldLineNum = hunk.oldStart
      let newLineNum = hunk.newStart

      for (const line of hunk.lines) {
        const firstChar = line[0]
        const content = line.slice(1)

        if (firstChar === "+") {
          contentLines.push(content)
          const config: LineColorConfig = {
            gutter: this._addedLineNumberBg,
          }
          if (this._addedContentBg) {
            config.content = this._addedContentBg
          } else {
            config.content = this._addedBg
          }
          lineColors.set(lineIndex, config)
          lineSigns.set(lineIndex, {
            after: " +",
            afterColor: this._addedSignColor,
          })
          lineNumbers.set(lineIndex, newLineNum)
          newLineNum++
          lineIndex++
        } else if (firstChar === "-") {
          contentLines.push(content)
          const config: LineColorConfig = {
            gutter: this._removedLineNumberBg,
          }
          if (this._removedContentBg) {
            config.content = this._removedContentBg
          } else {
            config.content = this._removedBg
          }
          lineColors.set(lineIndex, config)
          lineSigns.set(lineIndex, {
            after: " -",
            afterColor: this._removedSignColor,
          })
          lineNumbers.set(lineIndex, oldLineNum)
          oldLineNum++
          lineIndex++
        } else if (firstChar === " ") {
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
        }
      }
    }

    const content = contentLines.join("\n")

    const codeRenderable = this.createOrUpdateCodeRenderable("left", content, this._wrapMode)

    this.createOrUpdateSide("left", codeRenderable, lineColors, lineSigns, lineNumbers, new Set<number>(), "100%")

    if (this.rightSide && this.rightSideAdded) {
      super.remove(this.rightSide.id)
      this.rightSideAdded = false
    }
  }

  private buildSplitView(): void {
    if (!this._parsedDiff) return

    this.flexDirection = "row"

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

    const leftLogicalLines: LogicalLine[] = []
    const rightLogicalLines: LogicalLine[] = []

    for (const hunk of this._parsedDiff.hunks) {
      let oldLineNum = hunk.oldStart
      let newLineNum = hunk.newStart

      let i = 0
      while (i < hunk.lines.length) {
        const line = hunk.lines[i]
        const firstChar = line[0]

        if (firstChar === " ") {
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
          i++
        } else {
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

          const maxLength = Math.max(removes.length, adds.length)

          for (let j = 0; j < maxLength; j++) {
            if (j < removes.length) {
              leftLogicalLines.push({
                content: removes[j].content,
                lineNum: removes[j].lineNum,
                color: this._removedBg,
                sign: {
                  after: " -",
                  afterColor: this._removedSignColor,
                },
                type: "remove",
              })
            } else {
              leftLogicalLines.push({
                content: "",
                hideLineNumber: true,
                type: "empty",
              })
            }

            if (j < adds.length) {
              rightLogicalLines.push({
                content: adds[j].content,
                lineNum: adds[j].lineNum,
                color: this._addedBg,
                sign: {
                  after: " +",
                  afterColor: this._addedSignColor,
                },
                type: "add",
              })
            } else {
              rightLogicalLines.push({
                content: "",
                hideLineNumber: true,
                type: "empty",
              })
            }
          }
        }
      }
    }

    const canDoWrapAlignment = this.width > 0 && (this._wrapMode === "word" || this._wrapMode === "char")

    const preLeftContent = leftLogicalLines.map((l) => l.content).join("\n")
    const preRightContent = rightLogicalLines.map((l) => l.content).join("\n")

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

    let finalLeftLines: LogicalLine[]
    let finalRightLines: LogicalLine[]

    const leftIsHighlighting = leftCodeRenderable.isHighlighting
    const rightIsHighlighting = rightCodeRenderable.isHighlighting
    const highlightingInProgress = needsConsistentConcealing && (leftIsHighlighting || rightIsHighlighting)

    if (highlightingInProgress) {
      this._waitingForHighlight = true
      this.attachLineInfoListeners()
    }

    const shouldDoAlignment = canDoWrapAlignment && !highlightingInProgress

    if (shouldDoAlignment) {
      const leftLineInfo = leftCodeRenderable.lineInfo
      const rightLineInfo = rightCodeRenderable.lineInfo

      const leftSources = leftLineInfo.lineSources || []
      const rightSources = rightLineInfo.lineSources || []

      const leftVisualCounts = new Map<number, number>()
      const rightVisualCounts = new Map<number, number>()

      for (const logicalLine of leftSources) {
        leftVisualCounts.set(logicalLine, (leftVisualCounts.get(logicalLine) || 0) + 1)
      }
      for (const logicalLine of rightSources) {
        rightVisualCounts.set(logicalLine, (rightVisualCounts.get(logicalLine) || 0) + 1)
      }

      finalLeftLines = []
      finalRightLines = []

      let leftVisualPos = 0
      let rightVisualPos = 0

      for (let i = 0; i < leftLogicalLines.length; i++) {
        const leftLine = leftLogicalLines[i]
        const rightLine = rightLogicalLines[i]

        const leftVisualCount = leftVisualCounts.get(i) || 1
        const rightVisualCount = rightVisualCounts.get(i) || 1

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

        finalLeftLines.push(leftLine)
        finalRightLines.push(rightLine)

        leftVisualPos += leftVisualCount
        rightVisualPos += rightVisualCount
      }

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
      finalLeftLines = leftLogicalLines
      finalRightLines = rightLogicalLines
    }

    const leftLineColors = new Map<number, string | RGBA | LineColorConfig>()
    const rightLineColors = new Map<number, string | RGBA | LineColorConfig>()
    const leftLineSigns = new Map<number, LineSign>()
    const rightLineSigns = new Map<number, LineSign>()
    const leftHideLineNumbers = new Set<number>()
    const rightHideLineNumbers = new Set<number>()
    const leftLineNumbers = new Map<number, number>()
    const rightLineNumbers = new Map<number, number>()

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
    })

    const leftContentFinal = finalLeftLines.map((l) => l.content).join("\n")
    const rightContentFinal = finalRightLines.map((l) => l.content).join("\n")

    leftCodeRenderable.content = leftContentFinal
    rightCodeRenderable.content = rightContentFinal

    this.createOrUpdateSide(
      "left",
      leftCodeRenderable,
      leftLineColors,
      leftLineSigns,
      leftLineNumbers,
      leftHideLineNumbers,
      "50%",
    )
    this.createOrUpdateSide(
      "right",
      rightCodeRenderable,
      rightLineColors,
      rightLineSigns,
      rightLineNumbers,
      rightHideLineNumbers,
      "50%",
    )
  }

  public get diff(): string {
    return this._diff
  }

  public set diff(value: string) {
    if (this._diff !== value) {
      this._diff = value
      this._waitingForHighlight = false
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
      if (value) {
        if (this._ownedSyntaxStyle && value !== this._ownedSyntaxStyle) {
          this._ownedSyntaxStyle.destroy()
          this._ownedSyntaxStyle = null
        }
        this._syntaxStyle = value
      } else {
        this._syntaxStyle = undefined
        this.ensureSyntaxStyle()
      }
      this.rebuildView()
    }
  }

  public get wrapMode(): "word" | "char" | "none" | undefined {
    return this._wrapMode
  }

  public set wrapMode(value: "word" | "char" | "none" | undefined) {
    if (this._wrapMode !== value) {
      this._wrapMode = value

      if (this._view === "unified" && this.leftCodeRenderable) {
        this.leftCodeRenderable.wrapMode = value ?? "none"
      } else if (this._view === "split") {
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
}
