import { MeasureMode } from "../yoga.js"
import { type RenderableOptions, Renderable } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import { type BorderStyle, BorderCharArrays, parseBorderStyle } from "../lib/border.js"
import { convertGlobalToLocalSelection, type Selection, type LocalSelectionBounds } from "../lib/selection.js"
import { StyledText, stringToStyledText } from "../lib/styled-text.js"
import { RGBA, parseColor, type ColorInput } from "../lib/RGBA.js"
import { SyntaxStyle } from "../syntax-style.js"
import { type TextChunk, TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import type { RenderContext } from "../types.js"

// Large sentinel height for text measurement. The Zig measure path currently
// ignores height, but we pass an effectively unbounded value so if height-aware
// measuring is introduced later, table sizing remains stable.
const MEASURE_HEIGHT = 10_000

export type TextTableCellContent = TextChunk[] | null | undefined
export type TextTableContent = TextTableCellContent[][]
export type TextTableColumnWidthMode = "content" | "full"
export type TextTableColumnFitter = "proportional" | "balanced"

interface ResolvedTableBorderLayout {
  left: boolean
  right: boolean
  top: boolean
  bottom: boolean
  innerVertical: boolean
  innerHorizontal: boolean
}

interface TextTableCellState {
  textBuffer: TextBuffer
  textBufferView: TextBufferView
  syntaxStyle: SyntaxStyle
}

interface TextTableLayout {
  columnWidths: number[]
  rowHeights: number[]
  columnOffsets: number[]
  rowOffsets: number[]
  columnOffsetsI32: Int32Array
  rowOffsetsI32: Int32Array
  tableWidth: number
  tableHeight: number
}

interface CellPosition {
  rowIdx: number
  colIdx: number
}

interface RowRange {
  firstRow: number
  lastRow: number
}

type TableSelectionMode = "single-cell" | "column-locked" | "grid"

interface SelectionResolution {
  mode: TableSelectionMode
  anchorCell: CellPosition | null
  anchorColumn: number | null
}

interface CellSelectionCoords {
  anchorX: number
  anchorY: number
  focusX: number
  focusY: number
}

export interface TextTableOptions extends RenderableOptions<TextTableRenderable> {
  content?: TextTableContent
  wrapMode?: "none" | "char" | "word"
  columnWidthMode?: TextTableColumnWidthMode
  columnFitter?: TextTableColumnFitter
  cellPadding?: number
  cellPaddingX?: number
  cellPaddingY?: number
  columnGap?: number
  showBorders?: boolean
  border?: boolean
  outerBorder?: boolean
  selectable?: boolean
  selectionBg?: ColorInput
  selectionFg?: ColorInput
  borderStyle?: BorderStyle
  borderColor?: ColorInput
  borderBackgroundColor?: ColorInput
  backgroundColor?: ColorInput
  fg?: ColorInput
  bg?: ColorInput
  attributes?: number
}

export class TextTableRenderable extends Renderable {
  private _content: TextTableContent
  private _wrapMode: "none" | "char" | "word"
  private _columnWidthMode: TextTableColumnWidthMode
  private _columnFitter: TextTableColumnFitter
  private _cellPaddingX: number
  private _cellPaddingY: number
  private _columnGap: number
  private _showBorders: boolean
  private _border: boolean
  private _outerBorder: boolean
  private _hasExplicitOuterBorder: boolean
  private _borderStyle: BorderStyle
  private _borderColor: RGBA
  private _borderBackgroundColor: RGBA
  private _backgroundColor: RGBA
  private _defaultFg: RGBA
  private _defaultBg: RGBA
  private _defaultAttributes: number
  private _selectionBg: RGBA | undefined
  private _selectionFg: RGBA | undefined
  private _lastLocalSelection: LocalSelectionBounds | null = null
  private _lastSelectionMode: TableSelectionMode | null = null

  private _cells: TextTableCellState[][] = []
  private _prevCellContent: TextTableCellContent[][] = []
  private _rowCount: number = 0
  private _columnCount: number = 0

  private _layout: TextTableLayout = this.createEmptyLayout()
  private _layoutDirty: boolean = true
  private _rasterDirty: boolean = true

  private _cachedMeasureLayout: TextTableLayout | null = null
  private _cachedMeasureWidth: number | undefined = undefined

  private readonly _defaultOptions = {
    content: [] as TextTableContent,
    wrapMode: "word" as "none" | "char" | "word",
    columnWidthMode: "full" as TextTableColumnWidthMode,
    columnFitter: "proportional" as TextTableColumnFitter,
    cellPadding: 0,
    cellPaddingX: undefined as number | undefined,
    cellPaddingY: undefined as number | undefined,
    columnGap: 0,
    showBorders: true,
    border: true,
    outerBorder: true,
    selectable: true,
    selectionBg: undefined as ColorInput | undefined,
    selectionFg: undefined as ColorInput | undefined,
    borderStyle: "single" as BorderStyle,
    borderColor: "#FFFFFF",
    borderBackgroundColor: "transparent",
    backgroundColor: "transparent",
    fg: "#FFFFFF",
    bg: "transparent",
    attributes: 0,
  } satisfies Partial<TextTableOptions>

  constructor(ctx: RenderContext, options: TextTableOptions = {}) {
    super(ctx, { ...options, flexShrink: options.flexShrink ?? 0, buffered: true })

    this._content = options.content ?? this._defaultOptions.content
    this._wrapMode = options.wrapMode ?? this._defaultOptions.wrapMode
    this._columnWidthMode = options.columnWidthMode ?? this._defaultOptions.columnWidthMode
    this._columnFitter = this.resolveColumnFitter(options.columnFitter)
    this._cellPaddingX = this.resolveCellPadding(options.cellPaddingX ?? options.cellPadding)
    this._cellPaddingY = this.resolveCellPadding(options.cellPaddingY ?? options.cellPadding)
    this._columnGap = this.resolveColumnGap(options.columnGap)
    this._showBorders = options.showBorders ?? this._defaultOptions.showBorders
    this._border = options.border ?? this._defaultOptions.border
    this._hasExplicitOuterBorder = options.outerBorder !== undefined
    this._outerBorder = options.outerBorder ?? this._border
    this.selectable = options.selectable ?? this._defaultOptions.selectable
    this._selectionBg = options.selectionBg ? parseColor(options.selectionBg) : undefined
    this._selectionFg = options.selectionFg ? parseColor(options.selectionFg) : undefined
    this._borderStyle = parseBorderStyle(options.borderStyle, this._defaultOptions.borderStyle)
    this._borderColor = parseColor(options.borderColor ?? this._defaultOptions.borderColor)
    this._borderBackgroundColor = parseColor(
      options.borderBackgroundColor ?? this._defaultOptions.borderBackgroundColor,
    )
    this._backgroundColor = parseColor(options.backgroundColor ?? this._defaultOptions.backgroundColor)
    this._defaultFg = parseColor(options.fg ?? this._defaultOptions.fg)
    this._defaultBg = parseColor(options.bg ?? this._defaultOptions.bg)
    this._defaultAttributes = options.attributes ?? this._defaultOptions.attributes

    this.setupMeasureFunc()
    this.rebuildCells()
  }

  public get content(): TextTableContent {
    return this._content
  }

  public set content(value: TextTableContent) {
    this._content = value ?? []
    this.rebuildCells()
  }

  public get wrapMode(): "none" | "char" | "word" {
    return this._wrapMode
  }

  public set wrapMode(value: "none" | "char" | "word") {
    if (this._wrapMode === value) return
    this._wrapMode = value
    for (const row of this._cells) {
      for (const cell of row) {
        cell.textBufferView.setWrapMode(value)
      }
    }
    this.invalidateLayoutAndRaster()
  }

  public get columnWidthMode(): TextTableColumnWidthMode {
    return this._columnWidthMode
  }

  public set columnWidthMode(value: TextTableColumnWidthMode) {
    if (this._columnWidthMode === value) return
    this._columnWidthMode = value
    this.invalidateLayoutAndRaster()
  }

  public get columnFitter(): TextTableColumnFitter {
    return this._columnFitter
  }

  public set columnFitter(value: TextTableColumnFitter) {
    const next = this.resolveColumnFitter(value)
    if (this._columnFitter === next) return
    this._columnFitter = next
    this.invalidateLayoutAndRaster()
  }

  public get cellPadding(): number {
    return this._cellPaddingX === this._cellPaddingY ? this._cellPaddingX : 0
  }

  public set cellPadding(value: number) {
    const next = this.resolveCellPadding(value)
    if (this._cellPaddingX === next && this._cellPaddingY === next) return
    this._cellPaddingX = next
    this._cellPaddingY = next
    this.invalidateLayoutAndRaster()
  }

  public get cellPaddingX(): number {
    return this._cellPaddingX
  }

  public set cellPaddingX(value: number) {
    const next = this.resolveCellPadding(value)
    if (this._cellPaddingX === next) return
    this._cellPaddingX = next
    this.invalidateLayoutAndRaster()
  }

  public get cellPaddingY(): number {
    return this._cellPaddingY
  }

  public set cellPaddingY(value: number) {
    const next = this.resolveCellPadding(value)
    if (this._cellPaddingY === next) return
    this._cellPaddingY = next
    this.invalidateLayoutAndRaster()
  }

  public get columnGap(): number {
    return this._columnGap
  }

  public set columnGap(value: number) {
    const next = this.resolveColumnGap(value)
    if (this._columnGap === next) return
    this._columnGap = next
    this.invalidateLayoutAndRaster()
  }

  public get showBorders(): boolean {
    return this._showBorders
  }

  public set showBorders(value: boolean) {
    if (this._showBorders === value) return
    this._showBorders = value
    this.invalidateRasterOnly()
  }

  public get outerBorder(): boolean {
    return this._outerBorder
  }

  public set outerBorder(value: boolean) {
    if (this._outerBorder === value) return

    this._hasExplicitOuterBorder = true
    this._outerBorder = value
    this.invalidateLayoutAndRaster()
  }

  public get border(): boolean {
    return this._border
  }

  public set border(value: boolean) {
    if (this._border === value) return

    this._border = value

    if (!this._hasExplicitOuterBorder) {
      this._outerBorder = value
    }

    this.invalidateLayoutAndRaster()
  }

  public get borderStyle(): BorderStyle {
    return this._borderStyle
  }

  public set borderStyle(value: BorderStyle) {
    const next = parseBorderStyle(value, this._defaultOptions.borderStyle)
    if (this._borderStyle === next) return
    this._borderStyle = next
    this.invalidateRasterOnly()
  }

  public get borderColor(): RGBA {
    return this._borderColor
  }

  public set borderColor(value: ColorInput) {
    const next = parseColor(value)
    if (this._borderColor === next) return
    this._borderColor = next
    this.invalidateRasterOnly()
  }

  public shouldStartSelection(x: number, y: number): boolean {
    if (!this.selectable) return false

    this.ensureLayoutReady()

    const localX = x - this.x
    const localY = y - this.y
    return this.getCellAtLocalPosition(localX, localY) !== null
  }

  public onSelectionChanged(selection: Selection | null): boolean {
    this.ensureLayoutReady()

    const previousLocalSelection = this._lastLocalSelection
    const localSelection = convertGlobalToLocalSelection(selection, this.x, this.y)
    this._lastLocalSelection = localSelection
    const dirtyRows = this.getDirtySelectionRowRange(previousLocalSelection, localSelection)

    if (!localSelection?.isActive) {
      this.resetCellSelections()
      this._lastSelectionMode = null
    } else {
      this.applySelectionToCells(localSelection, selection?.isStart ?? false)
    }

    if (dirtyRows !== null) {
      this.redrawSelectionRows(dirtyRows.firstRow, dirtyRows.lastRow)
    }

    return this.hasSelection()
  }

  public hasSelection(): boolean {
    for (const row of this._cells) {
      for (const cell of row) {
        if (cell.textBufferView.hasSelection()) {
          return true
        }
      }
    }

    return false
  }

  public getSelection(): { start: number; end: number } | null {
    for (const row of this._cells) {
      for (const cell of row) {
        const selection = cell.textBufferView.getSelection()
        if (selection) {
          return selection
        }
      }
    }

    return null
  }

  public getSelectedText(): string {
    const selectedRows: string[] = []

    for (let rowIdx = 0; rowIdx < this._rowCount; rowIdx++) {
      const rowSelections: string[] = []

      for (let colIdx = 0; colIdx < this._columnCount; colIdx++) {
        const cell = this._cells[rowIdx]?.[colIdx]
        if (!cell || !cell.textBufferView.hasSelection()) continue

        const selectedText = cell.textBufferView.getSelectedText()
        if (selectedText.length > 0) {
          rowSelections.push(selectedText)
        }
      }

      if (rowSelections.length > 0) {
        selectedRows.push(rowSelections.join("\t"))
      }
    }

    return selectedRows.join("\n")
  }

  protected onResize(width: number, height: number): void {
    this.invalidateLayoutAndRaster(false)
    super.onResize(width, height)
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (!this.visible || this.isDestroyed) return

    if (this._layoutDirty) {
      this.rebuildLayoutForCurrentWidth()
    }

    if (!this._rasterDirty) return

    buffer.clear(this._backgroundColor)

    if (this._rowCount === 0 || this._columnCount === 0) {
      this._rasterDirty = false
      return
    }

    this.drawBorders(buffer)
    this.drawCells(buffer)

    this._rasterDirty = false
  }

  protected destroySelf(): void {
    this.destroyCells()
    super.destroySelf()
  }

  private setupMeasureFunc(): void {
    const measureFunc = (
      width: number,
      widthMode: MeasureMode,
      _height: number,
      _heightMode: MeasureMode,
    ): { width: number; height: number } => {
      const hasWidthConstraint = widthMode !== MeasureMode.Undefined && Number.isFinite(width)
      const rawWidthConstraint = hasWidthConstraint ? Math.max(1, Math.floor(width)) : undefined
      const widthConstraint = this.resolveLayoutWidthConstraint(rawWidthConstraint)
      const measuredLayout = this.computeLayout(widthConstraint)
      this._cachedMeasureLayout = measuredLayout
      this._cachedMeasureWidth = widthConstraint

      let measuredWidth = measuredLayout.tableWidth > 0 ? measuredLayout.tableWidth : 1
      let measuredHeight = measuredLayout.tableHeight > 0 ? measuredLayout.tableHeight : 1

      if (widthMode === MeasureMode.AtMost && rawWidthConstraint !== undefined && this._positionType !== "absolute") {
        measuredWidth = Math.min(rawWidthConstraint, measuredWidth)
      }

      // Keep intrinsic height even under AtMost constraints. Clamping here can under-report
      // content height during Yoga measure passes and leave parent scroll extents stale.
      return {
        width: measuredWidth,
        height: measuredHeight,
      }
    }

    this.yogaNode.setMeasureFunc(measureFunc)
  }

  private rebuildCells(): void {
    const newRowCount = this._content.length
    const newColumnCount = this._content.reduce((max, row) => Math.max(max, row.length), 0)

    if (this._cells.length === 0) {
      this._rowCount = newRowCount
      this._columnCount = newColumnCount
      this._cells = []
      this._prevCellContent = []

      for (let rowIdx = 0; rowIdx < newRowCount; rowIdx++) {
        const row = this._content[rowIdx] ?? []
        const rowCells: TextTableCellState[] = []
        const rowRefs: TextTableCellContent[] = []

        for (let colIdx = 0; colIdx < newColumnCount; colIdx++) {
          const cellContent = row[colIdx]
          rowCells.push(this.createCell(cellContent))
          rowRefs.push(cellContent)
        }

        this._cells.push(rowCells)
        this._prevCellContent.push(rowRefs)
      }

      this.invalidateLayoutAndRaster()
      return
    }

    this.updateCellsDiff(newRowCount, newColumnCount)
    this.invalidateLayoutAndRaster()
  }

  private updateCellsDiff(newRowCount: number, newColumnCount: number): void {
    const oldRowCount = this._rowCount
    const oldColumnCount = this._columnCount
    const keepRows = Math.min(oldRowCount, newRowCount)
    const keepCols = Math.min(oldColumnCount, newColumnCount)

    for (let rowIdx = 0; rowIdx < keepRows; rowIdx++) {
      const newRow = this._content[rowIdx] ?? []
      const cellRow = this._cells[rowIdx]
      const refRow = this._prevCellContent[rowIdx]

      for (let colIdx = 0; colIdx < keepCols; colIdx++) {
        const cellContent = newRow[colIdx]
        if (cellContent === refRow[colIdx]) continue

        const oldCell = cellRow[colIdx]
        oldCell.textBufferView.destroy()
        oldCell.textBuffer.destroy()
        oldCell.syntaxStyle.destroy()

        cellRow[colIdx] = this.createCell(cellContent)
        refRow[colIdx] = cellContent
      }

      if (newColumnCount > oldColumnCount) {
        for (let colIdx = oldColumnCount; colIdx < newColumnCount; colIdx++) {
          const cellContent = newRow[colIdx]
          cellRow.push(this.createCell(cellContent))
          refRow.push(cellContent)
        }
      } else if (newColumnCount < oldColumnCount) {
        for (let colIdx = newColumnCount; colIdx < oldColumnCount; colIdx++) {
          const cell = cellRow[colIdx]
          cell.textBufferView.destroy()
          cell.textBuffer.destroy()
          cell.syntaxStyle.destroy()
        }
        cellRow.length = newColumnCount
        refRow.length = newColumnCount
      }
    }

    if (newRowCount > oldRowCount) {
      for (let rowIdx = oldRowCount; rowIdx < newRowCount; rowIdx++) {
        const newRow = this._content[rowIdx] ?? []
        const rowCells: TextTableCellState[] = []
        const rowRefs: TextTableCellContent[] = []

        for (let colIdx = 0; colIdx < newColumnCount; colIdx++) {
          const cellContent = newRow[colIdx]
          rowCells.push(this.createCell(cellContent))
          rowRefs.push(cellContent)
        }

        this._cells.push(rowCells)
        this._prevCellContent.push(rowRefs)
      }
    } else if (newRowCount < oldRowCount) {
      for (let rowIdx = newRowCount; rowIdx < oldRowCount; rowIdx++) {
        const row = this._cells[rowIdx]
        for (const cell of row) {
          cell.textBufferView.destroy()
          cell.textBuffer.destroy()
          cell.syntaxStyle.destroy()
        }
      }
      this._cells.length = newRowCount
      this._prevCellContent.length = newRowCount
    }

    this._rowCount = newRowCount
    this._columnCount = newColumnCount
  }

  private createCell(content: TextTableCellContent): TextTableCellState {
    const styledText = this.toStyledText(content)
    const textBuffer = TextBuffer.create(this._ctx.widthMethod)
    const syntaxStyle = SyntaxStyle.create()

    textBuffer.setDefaultFg(this._defaultFg)
    textBuffer.setDefaultBg(this._defaultBg)
    textBuffer.setDefaultAttributes(this._defaultAttributes)
    textBuffer.setSyntaxStyle(syntaxStyle)
    textBuffer.setStyledText(styledText)

    const textBufferView = TextBufferView.create(textBuffer)
    textBufferView.setWrapMode(this._wrapMode)

    return { textBuffer, textBufferView, syntaxStyle }
  }

  private toStyledText(content: TextTableCellContent): StyledText {
    if (Array.isArray(content)) {
      return new StyledText(content)
    }

    if (content === null || content === undefined) {
      return stringToStyledText("")
    }

    return stringToStyledText(String(content))
  }

  private destroyCells(): void {
    for (const row of this._cells) {
      for (const cell of row) {
        cell.textBufferView.destroy()
        cell.textBuffer.destroy()
        cell.syntaxStyle.destroy()
      }
    }

    this._cells = []
    this._prevCellContent = []
    this._rowCount = 0
    this._columnCount = 0
    this._layout = this.createEmptyLayout()
  }

  private rebuildLayoutForCurrentWidth(): void {
    const maxTableWidth = this.resolveLayoutWidthConstraint(this.width)

    let layout: TextTableLayout
    if (this._cachedMeasureLayout !== null && this._cachedMeasureWidth === maxTableWidth) {
      layout = this._cachedMeasureLayout
    } else {
      layout = this.computeLayout(maxTableWidth)
    }
    this._cachedMeasureLayout = null
    this._cachedMeasureWidth = undefined

    this._layout = layout
    this.applyLayoutToViews(layout)
    this._layoutDirty = false

    if (this._lastLocalSelection?.isActive) {
      this.applySelectionToCells(this._lastLocalSelection, true)
    }
  }

  private computeLayout(maxTableWidth?: number): TextTableLayout {
    if (this._rowCount === 0 || this._columnCount === 0) {
      return this.createEmptyLayout()
    }

    const borderLayout = this.resolveBorderLayout()
    const columnWidths = this.computeColumnWidths(maxTableWidth, borderLayout)
    const rowHeights = this.computeRowHeights(columnWidths)
    const columnOffsets = this.computeOffsets(
      columnWidths,
      borderLayout.left,
      borderLayout.right,
      borderLayout.innerVertical,
      this.getInterColumnGap(borderLayout),
    )
    const rowOffsets = this.computeOffsets(
      rowHeights,
      borderLayout.top,
      borderLayout.bottom,
      borderLayout.innerHorizontal,
    )
    return {
      columnWidths,
      rowHeights,
      columnOffsets,
      rowOffsets,
      columnOffsetsI32: new Int32Array(columnOffsets),
      rowOffsetsI32: new Int32Array(rowOffsets),
      tableWidth: (columnOffsets[columnOffsets.length - 1] ?? 0) + 1,
      tableHeight: (rowOffsets[rowOffsets.length - 1] ?? 0) + 1,
    }
  }

  private isFullWidthMode(): boolean {
    return this._columnWidthMode === "full"
  }

  private computeColumnWidths(maxTableWidth: number | undefined, borderLayout: ResolvedTableBorderLayout): number[] {
    const horizontalPadding = this.getHorizontalCellPadding()
    const intrinsicWidths = new Array(this._columnCount).fill(1 + horizontalPadding)

    for (let rowIdx = 0; rowIdx < this._rowCount; rowIdx++) {
      for (let colIdx = 0; colIdx < this._columnCount; colIdx++) {
        const cell = this._cells[rowIdx]?.[colIdx]
        if (!cell) continue

        const measure = cell.textBufferView.measureForDimensions(0, MEASURE_HEIGHT)
        const measuredWidth = Math.max(1, measure?.widthColsMax ?? 0) + horizontalPadding
        intrinsicWidths[colIdx] = Math.max(intrinsicWidths[colIdx], measuredWidth)
      }
    }

    if (maxTableWidth === undefined || !Number.isFinite(maxTableWidth) || maxTableWidth <= 0) {
      return intrinsicWidths
    }

    const maxContentWidth = Math.max(
      1,
      Math.floor(maxTableWidth) - this.getVerticalBorderCount(borderLayout) - this.getTotalInterColumnGap(borderLayout),
    )
    const currentWidth = intrinsicWidths.reduce((sum, width) => sum + width, 0)

    if (currentWidth === maxContentWidth) {
      return intrinsicWidths
    }

    if (currentWidth < maxContentWidth) {
      if (this.isFullWidthMode()) {
        return this.expandColumnWidths(intrinsicWidths, maxContentWidth)
      }

      return intrinsicWidths
    }

    if (this._wrapMode === "none") {
      return intrinsicWidths
    }

    return this.fitColumnWidths(intrinsicWidths, maxContentWidth)
  }

  private expandColumnWidths(widths: number[], targetContentWidth: number): number[] {
    const baseWidths = widths.map((width) => Math.max(1, Math.floor(width)))
    const totalBaseWidth = baseWidths.reduce((sum, width) => sum + width, 0)

    if (totalBaseWidth >= targetContentWidth) {
      return baseWidths
    }

    const expanded = [...baseWidths]
    const columns = expanded.length
    const extraWidth = targetContentWidth - totalBaseWidth
    const sharedWidth = Math.floor(extraWidth / columns)
    const remainder = extraWidth % columns

    for (let idx = 0; idx < columns; idx++) {
      expanded[idx] += sharedWidth
      if (idx < remainder) {
        expanded[idx] += 1
      }
    }

    return expanded
  }

  private fitColumnWidths(widths: number[], targetContentWidth: number): number[] {
    if (this._columnFitter === "balanced") {
      return this.fitColumnWidthsBalanced(widths, targetContentWidth)
    }

    return this.fitColumnWidthsProportional(widths, targetContentWidth)
  }

  private fitColumnWidthsProportional(widths: number[], targetContentWidth: number): number[] {
    const minWidth = 1 + this.getHorizontalCellPadding()
    const hardMinWidths = new Array(widths.length).fill(minWidth)
    const baseWidths = widths.map((width) => Math.max(1, Math.floor(width)))

    const preferredMinWidths = baseWidths.map((width) => Math.min(width, minWidth + 1))
    const preferredMinTotal = preferredMinWidths.reduce((sum, width) => sum + width, 0)

    const floorWidths = preferredMinTotal <= targetContentWidth ? preferredMinWidths : hardMinWidths
    const floorTotal = floorWidths.reduce((sum, width) => sum + width, 0)
    const clampedTarget = Math.max(floorTotal, targetContentWidth)

    const totalBaseWidth = baseWidths.reduce((sum, width) => sum + width, 0)

    if (totalBaseWidth <= clampedTarget) {
      return baseWidths
    }

    const shrinkable = baseWidths.map((width, idx) => width - floorWidths[idx])
    const totalShrinkable = shrinkable.reduce((sum, value) => sum + value, 0)
    if (totalShrinkable <= 0) {
      return [...floorWidths]
    }

    const targetShrink = totalBaseWidth - clampedTarget
    const integerShrink = new Array(baseWidths.length).fill(0)
    const fractions = new Array(baseWidths.length).fill(0)
    let usedShrink = 0

    for (let idx = 0; idx < baseWidths.length; idx++) {
      if (shrinkable[idx] <= 0) continue

      const exact = (shrinkable[idx] / totalShrinkable) * targetShrink
      const whole = Math.min(shrinkable[idx], Math.floor(exact))
      integerShrink[idx] = whole
      fractions[idx] = exact - whole
      usedShrink += whole
    }

    let remainingShrink = targetShrink - usedShrink

    while (remainingShrink > 0) {
      let bestIdx = -1
      let bestFraction = -1

      for (let idx = 0; idx < baseWidths.length; idx++) {
        if (shrinkable[idx] - integerShrink[idx] <= 0) continue
        if (fractions[idx] > bestFraction) {
          bestFraction = fractions[idx]
          bestIdx = idx
        }
      }

      if (bestIdx === -1) break

      integerShrink[bestIdx] += 1
      fractions[bestIdx] = 0
      remainingShrink -= 1
    }

    return baseWidths.map((width, idx) => Math.max(floorWidths[idx], width - integerShrink[idx]))
  }

  private fitColumnWidthsBalanced(widths: number[], targetContentWidth: number): number[] {
    const minWidth = 1 + this.getHorizontalCellPadding()
    const hardMinWidths = new Array(widths.length).fill(minWidth)
    const baseWidths = widths.map((width) => Math.max(1, Math.floor(width)))
    const totalBaseWidth = baseWidths.reduce((sum, width) => sum + width, 0)
    const columns = baseWidths.length

    if (columns === 0 || totalBaseWidth <= targetContentWidth) {
      return baseWidths
    }

    const evenShare = Math.max(minWidth, Math.floor(targetContentWidth / columns))
    const preferredMinWidths = baseWidths.map((width) => Math.min(width, evenShare))
    const preferredMinTotal = preferredMinWidths.reduce((sum, width) => sum + width, 0)
    const floorWidths = preferredMinTotal <= targetContentWidth ? preferredMinWidths : hardMinWidths
    const floorTotal = floorWidths.reduce((sum, width) => sum + width, 0)
    const clampedTarget = Math.max(floorTotal, targetContentWidth)

    if (totalBaseWidth <= clampedTarget) {
      return baseWidths
    }

    const shrinkable = baseWidths.map((width, idx) => width - floorWidths[idx])
    const totalShrinkable = shrinkable.reduce((sum, value) => sum + value, 0)
    if (totalShrinkable <= 0) {
      return [...floorWidths]
    }

    const targetShrink = totalBaseWidth - clampedTarget
    const shrink = this.allocateShrinkByWeight(shrinkable, targetShrink, "sqrt")

    return baseWidths.map((width, idx) => Math.max(floorWidths[idx], width - shrink[idx]))
  }

  private allocateShrinkByWeight(shrinkable: number[], targetShrink: number, mode: "linear" | "sqrt"): number[] {
    const shrink = new Array(shrinkable.length).fill(0)

    if (targetShrink <= 0) {
      return shrink
    }

    const weights = shrinkable.map((value) => {
      if (value <= 0) {
        return 0
      }

      return mode === "sqrt" ? Math.sqrt(value) : value
    })
    const totalWeight = weights.reduce((sum, value) => sum + value, 0)

    if (totalWeight <= 0) {
      return shrink
    }

    const fractions = new Array(shrinkable.length).fill(0)
    let usedShrink = 0

    for (let idx = 0; idx < shrinkable.length; idx++) {
      if (shrinkable[idx] <= 0 || weights[idx] <= 0) continue

      const exact = (weights[idx] / totalWeight) * targetShrink
      const whole = Math.min(shrinkable[idx], Math.floor(exact))
      shrink[idx] = whole
      fractions[idx] = exact - whole
      usedShrink += whole
    }

    let remainingShrink = targetShrink - usedShrink

    while (remainingShrink > 0) {
      let bestIdx = -1
      let bestFraction = -1

      for (let idx = 0; idx < shrinkable.length; idx++) {
        if (shrinkable[idx] - shrink[idx] <= 0) continue

        if (
          bestIdx === -1 ||
          fractions[idx] > bestFraction ||
          (fractions[idx] === bestFraction && shrinkable[idx] > shrinkable[bestIdx])
        ) {
          bestIdx = idx
          bestFraction = fractions[idx]
        }
      }

      if (bestIdx === -1) {
        break
      }

      shrink[bestIdx] += 1
      fractions[bestIdx] = 0
      remainingShrink -= 1
    }

    return shrink
  }

  private computeRowHeights(columnWidths: number[]): number[] {
    const horizontalPadding = this.getHorizontalCellPadding()
    const verticalPadding = this.getVerticalCellPadding()
    const rowHeights = new Array(this._rowCount).fill(1 + verticalPadding)

    for (let rowIdx = 0; rowIdx < this._rowCount; rowIdx++) {
      for (let colIdx = 0; colIdx < this._columnCount; colIdx++) {
        const cell = this._cells[rowIdx]?.[colIdx]
        if (!cell) continue

        const width = Math.max(1, (columnWidths[colIdx] ?? 1) - horizontalPadding)
        const measure = cell.textBufferView.measureForDimensions(width, MEASURE_HEIGHT)
        const lineCount = Math.max(1, measure?.lineCount ?? 1)
        rowHeights[rowIdx] = Math.max(rowHeights[rowIdx], lineCount + verticalPadding)
      }
    }

    return rowHeights
  }

  private computeOffsets(
    parts: number[],
    startBoundary: boolean,
    endBoundary: boolean,
    includeInnerBoundaries: boolean,
    innerGap: number = 0,
  ): number[] {
    const offsets: number[] = [startBoundary ? 0 : -1]
    let cursor = offsets[0] ?? 0

    for (let idx = 0; idx < parts.length; idx++) {
      const size = parts[idx] ?? 1
      const separatorAfter = idx < parts.length - 1 ? (includeInnerBoundaries ? 1 : innerGap) : endBoundary ? 1 : 0
      cursor += size + separatorAfter
      offsets.push(cursor)
    }

    return offsets
  }

  private getInterColumnGap(borderLayout: ResolvedTableBorderLayout): number {
    if (borderLayout.innerVertical) {
      return 0
    }

    return this._columnGap
  }

  private getTotalInterColumnGap(borderLayout: ResolvedTableBorderLayout): number {
    return Math.max(0, this._columnCount - 1) * this.getInterColumnGap(borderLayout)
  }

  private applyLayoutToViews(layout: TextTableLayout): void {
    const horizontalPadding = this.getHorizontalCellPadding()
    const verticalPadding = this.getVerticalCellPadding()

    for (let rowIdx = 0; rowIdx < this._rowCount; rowIdx++) {
      for (let colIdx = 0; colIdx < this._columnCount; colIdx++) {
        const cell = this._cells[rowIdx]?.[colIdx]
        if (!cell) continue

        const colWidth = layout.columnWidths[colIdx] ?? 1
        const rowHeight = layout.rowHeights[rowIdx] ?? 1
        const contentWidth = Math.max(1, colWidth - horizontalPadding)
        const contentHeight = Math.max(1, rowHeight - verticalPadding)

        if (this._wrapMode === "none") {
          cell.textBufferView.setWrapWidth(null)
        } else {
          cell.textBufferView.setWrapWidth(contentWidth)
        }

        cell.textBufferView.setViewport(0, 0, contentWidth, contentHeight)
      }
    }
  }

  private resolveBorderLayout(): ResolvedTableBorderLayout {
    return {
      left: this._outerBorder,
      right: this._outerBorder,
      top: this._outerBorder,
      bottom: this._outerBorder,
      innerVertical: this._border && this._columnCount > 1,
      innerHorizontal: this._border && this._rowCount > 1,
    }
  }

  private getVerticalBorderCount(borderLayout: ResolvedTableBorderLayout): number {
    return (
      (borderLayout.left ? 1 : 0) +
      (borderLayout.right ? 1 : 0) +
      (borderLayout.innerVertical ? Math.max(0, this._columnCount - 1) : 0)
    )
  }

  private getHorizontalBorderCount(borderLayout: ResolvedTableBorderLayout): number {
    return (
      (borderLayout.top ? 1 : 0) +
      (borderLayout.bottom ? 1 : 0) +
      (borderLayout.innerHorizontal ? Math.max(0, this._rowCount - 1) : 0)
    )
  }

  private drawBorders(buffer: OptimizedBuffer): void {
    if (!this._showBorders) {
      return
    }

    const borderLayout = this.resolveBorderLayout()

    if (this.getVerticalBorderCount(borderLayout) === 0 && this.getHorizontalBorderCount(borderLayout) === 0) {
      return
    }

    buffer.drawGrid({
      borderChars: BorderCharArrays[this._borderStyle],
      borderFg: this._borderColor,
      borderBg: this._borderBackgroundColor,
      columnOffsets: this._layout.columnOffsetsI32,
      rowOffsets: this._layout.rowOffsetsI32,
      drawInner: this._border,
      drawOuter: this._outerBorder,
    })
  }

  private drawCells(buffer: OptimizedBuffer): void {
    this.drawCellRange(buffer, 0, this._rowCount - 1)
  }

  private drawCellRange(buffer: OptimizedBuffer, firstRow: number, lastRow: number): void {
    const colOffsets = this._layout.columnOffsets
    const rowOffsets = this._layout.rowOffsets
    const cellPaddingX = this._cellPaddingX
    const cellPaddingY = this._cellPaddingY

    for (let rowIdx = firstRow; rowIdx <= lastRow; rowIdx++) {
      const cellY = (rowOffsets[rowIdx] ?? 0) + 1 + cellPaddingY

      for (let colIdx = 0; colIdx < this._columnCount; colIdx++) {
        const cell = this._cells[rowIdx]?.[colIdx]
        if (!cell) continue
        buffer.drawTextBuffer(cell.textBufferView, (colOffsets[colIdx] ?? 0) + 1 + cellPaddingX, cellY)
      }
    }
  }

  private redrawSelectionRows(firstRow: number, lastRow: number): void {
    if (firstRow > lastRow) return

    if (this._backgroundColor.a < 1) {
      this.invalidateRasterOnly()
      return
    }

    const buffer = this.frameBuffer
    if (!buffer) return

    this.clearCellRange(buffer, firstRow, lastRow)
    this.drawCellRange(buffer, firstRow, lastRow)
    this.requestRender()
  }

  private clearCellRange(buffer: OptimizedBuffer, firstRow: number, lastRow: number): void {
    const colWidths = this._layout.columnWidths
    const rowHeights = this._layout.rowHeights
    const colOffsets = this._layout.columnOffsets
    const rowOffsets = this._layout.rowOffsets

    for (let rowIdx = firstRow; rowIdx <= lastRow; rowIdx++) {
      const cellY = (rowOffsets[rowIdx] ?? 0) + 1
      const rowHeight = rowHeights[rowIdx] ?? 1

      for (let colIdx = 0; colIdx < this._columnCount; colIdx++) {
        const cellX = (colOffsets[colIdx] ?? 0) + 1
        const colWidth = colWidths[colIdx] ?? 1
        if (this._backgroundColor.a < 1) {
          for (let y = cellY; y < cellY + rowHeight; y++) {
            for (let x = cellX; x < cellX + colWidth; x++) {
              buffer.setCell(x, y, " ", this._defaultFg, this._backgroundColor, this._defaultAttributes)
            }
          }
        } else {
          buffer.fillRect(cellX, cellY, colWidth, rowHeight, this._backgroundColor)
        }
      }
    }
  }

  private ensureLayoutReady(): void {
    if (!this._layoutDirty) return
    this.rebuildLayoutForCurrentWidth()
  }

  private getCellAtLocalPosition(localX: number, localY: number): CellPosition | null {
    if (this._rowCount === 0 || this._columnCount === 0) return null
    if (localX < 0 || localY < 0 || localX >= this._layout.tableWidth || localY >= this._layout.tableHeight) {
      return null
    }

    let rowIdx = -1
    for (let idx = 0; idx < this._rowCount; idx++) {
      const top = (this._layout.rowOffsets[idx] ?? 0) + 1
      const bottom = top + (this._layout.rowHeights[idx] ?? 1) - 1
      if (localY >= top && localY <= bottom) {
        rowIdx = idx
        break
      }
    }

    if (rowIdx < 0) return null

    let colIdx = -1
    for (let idx = 0; idx < this._columnCount; idx++) {
      const left = (this._layout.columnOffsets[idx] ?? 0) + 1
      const right = left + (this._layout.columnWidths[idx] ?? 1) - 1
      if (localX >= left && localX <= right) {
        colIdx = idx
        break
      }
    }

    if (colIdx < 0) return null

    return { rowIdx, colIdx }
  }

  private applySelectionToCells(localSelection: LocalSelectionBounds, isStart: boolean): void {
    if (localSelection.anchorX === localSelection.focusX && localSelection.anchorY === localSelection.focusY) {
      this.resetCellSelections()
      this._lastSelectionMode = null
      return
    }

    const minSelY = Math.min(localSelection.anchorY, localSelection.focusY)
    const maxSelY = Math.max(localSelection.anchorY, localSelection.focusY)

    const firstRow = this.findRowForLocalY(minSelY)
    const lastRow = this.findRowForLocalY(maxSelY)
    const selection = this.resolveSelectionResolution(localSelection)
    const modeChanged = this._lastSelectionMode !== selection.mode
    this._lastSelectionMode = selection.mode
    const lockToAnchorColumn = selection.mode === "column-locked" && selection.anchorColumn !== null

    for (let rowIdx = 0; rowIdx < this._rowCount; rowIdx++) {
      if (rowIdx < firstRow || rowIdx > lastRow) {
        this.resetRowSelection(rowIdx)
        continue
      }

      const cellTop = (this._layout.rowOffsets[rowIdx] ?? 0) + 1 + this._cellPaddingY

      for (let colIdx = 0; colIdx < this._columnCount; colIdx++) {
        const cell = this._cells[rowIdx]?.[colIdx]
        if (!cell) continue

        if (lockToAnchorColumn && colIdx !== selection.anchorColumn) {
          cell.textBufferView.resetLocalSelection()
          continue
        }

        const cellLeft = (this._layout.columnOffsets[colIdx] ?? 0) + 1 + this._cellPaddingX
        let coords: CellSelectionCoords = {
          anchorX: localSelection.anchorX - cellLeft,
          anchorY: localSelection.anchorY - cellTop,
          focusX: localSelection.focusX - cellLeft,
          focusY: localSelection.focusY - cellTop,
        }

        const isAnchorCell =
          selection.anchorCell !== null &&
          selection.anchorCell.rowIdx === rowIdx &&
          selection.anchorCell.colIdx === colIdx

        if (selection.mode === "single-cell" && !isAnchorCell) {
          cell.textBufferView.resetLocalSelection()
          continue
        }

        const forceSet = isAnchorCell && selection.mode !== "single-cell"

        if (forceSet) {
          coords = this.getFullCellSelectionCoords(rowIdx, colIdx)
        }

        const shouldUseSet = isStart || modeChanged || forceSet

        if (shouldUseSet) {
          cell.textBufferView.setLocalSelection(
            coords.anchorX,
            coords.anchorY,
            coords.focusX,
            coords.focusY,
            this._selectionBg,
            this._selectionFg,
          )
        } else {
          cell.textBufferView.updateLocalSelection(
            coords.anchorX,
            coords.anchorY,
            coords.focusX,
            coords.focusY,
            this._selectionBg,
            this._selectionFg,
          )
        }
      }
    }
  }

  private resolveSelectionResolution(localSelection: LocalSelectionBounds): SelectionResolution {
    const anchorCell = this.getCellAtLocalPosition(localSelection.anchorX, localSelection.anchorY)
    const focusCell = this.getCellAtLocalPosition(localSelection.focusX, localSelection.focusY)
    const anchorColumn = anchorCell?.colIdx ?? this.getColumnAtLocalX(localSelection.anchorX)

    if (
      anchorCell !== null &&
      focusCell !== null &&
      anchorCell.rowIdx === focusCell.rowIdx &&
      anchorCell.colIdx === focusCell.colIdx
    ) {
      return {
        mode: "single-cell",
        anchorCell,
        anchorColumn,
      }
    }

    const focusColumn = this.getColumnAtLocalX(localSelection.focusX)
    if (anchorColumn !== null && focusColumn === anchorColumn) {
      return {
        mode: "column-locked",
        anchorCell,
        anchorColumn,
      }
    }

    return {
      mode: "grid",
      anchorCell,
      anchorColumn,
    }
  }

  private getColumnAtLocalX(localX: number): number | null {
    if (this._columnCount === 0) return null
    if (localX < 0 || localX >= this._layout.tableWidth) return null

    for (let colIdx = 0; colIdx < this._columnCount; colIdx++) {
      const colStart = (this._layout.columnOffsets[colIdx] ?? 0) + 1
      const colEnd = colStart + (this._layout.columnWidths[colIdx] ?? 1) - 1
      if (localX >= colStart && localX <= colEnd) {
        return colIdx
      }
    }

    return null
  }

  private getFullCellSelectionCoords(rowIdx: number, colIdx: number): CellSelectionCoords {
    const colWidth = this._layout.columnWidths[colIdx] ?? 1
    const rowHeight = this._layout.rowHeights[rowIdx] ?? 1
    const contentWidth = Math.max(1, colWidth - this.getHorizontalCellPadding())
    const contentHeight = Math.max(1, rowHeight - this.getVerticalCellPadding())

    return {
      anchorX: -1,
      anchorY: 0,
      focusX: contentWidth,
      focusY: contentHeight,
    }
  }

  private findRowForLocalY(localY: number): number {
    if (this._rowCount === 0) return 0
    if (localY < 0) return 0

    for (let rowIdx = 0; rowIdx < this._rowCount; rowIdx++) {
      const rowStart = (this._layout.rowOffsets[rowIdx] ?? 0) + 1
      const rowEnd = rowStart + (this._layout.rowHeights[rowIdx] ?? 1) - 1
      if (localY <= rowEnd) return rowIdx
    }

    return this._rowCount - 1
  }

  private getSelectionRowRange(selection: LocalSelectionBounds | null): RowRange | null {
    if (!selection?.isActive || this._rowCount === 0) return null

    const minSelY = Math.min(selection.anchorY, selection.focusY)
    const maxSelY = Math.max(selection.anchorY, selection.focusY)

    return {
      firstRow: this.findRowForLocalY(minSelY),
      lastRow: this.findRowForLocalY(maxSelY),
    }
  }

  private getDirtySelectionRowRange(
    previousSelection: LocalSelectionBounds | null,
    currentSelection: LocalSelectionBounds | null,
  ): RowRange | null {
    const previousRange = this.getSelectionRowRange(previousSelection)
    const currentRange = this.getSelectionRowRange(currentSelection)

    if (previousRange === null) return currentRange
    if (currentRange === null) return previousRange

    return {
      firstRow: Math.min(previousRange.firstRow, currentRange.firstRow),
      lastRow: Math.max(previousRange.lastRow, currentRange.lastRow),
    }
  }

  private resetRowSelection(rowIdx: number): void {
    const row = this._cells[rowIdx]
    if (!row) return

    for (const cell of row) {
      cell.textBufferView.resetLocalSelection()
    }
  }

  private resetCellSelections(): void {
    for (let rowIdx = 0; rowIdx < this._rowCount; rowIdx++) {
      this.resetRowSelection(rowIdx)
    }
  }

  private createEmptyLayout(): TextTableLayout {
    return {
      columnWidths: [],
      rowHeights: [],
      columnOffsets: [0],
      rowOffsets: [0],
      columnOffsetsI32: new Int32Array([0]),
      rowOffsetsI32: new Int32Array([0]),
      tableWidth: 0,
      tableHeight: 0,
    }
  }

  private resolveLayoutWidthConstraint(width: number | undefined): number | undefined {
    if (width === undefined || !Number.isFinite(width) || width <= 0) {
      return undefined
    }

    if (this._wrapMode !== "none" || this.isFullWidthMode()) {
      return Math.max(1, Math.floor(width))
    }

    return undefined
  }

  private getHorizontalCellPadding(): number {
    return this._cellPaddingX * 2
  }

  private getVerticalCellPadding(): number {
    return this._cellPaddingY * 2
  }

  private resolveColumnFitter(value: TextTableColumnFitter | undefined): TextTableColumnFitter {
    if (value === undefined) {
      return this._defaultOptions.columnFitter
    }

    return value === "balanced" ? "balanced" : "proportional"
  }

  private resolveCellPadding(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
      return this._defaultOptions.cellPadding
    }

    return Math.max(0, Math.floor(value))
  }

  private resolveColumnGap(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
      return this._defaultOptions.columnGap
    }

    return Math.max(0, Math.floor(value))
  }

  private invalidateLayoutAndRaster(markYogaDirty: boolean = true): void {
    this._layoutDirty = true
    this._rasterDirty = true
    this._cachedMeasureLayout = null
    this._cachedMeasureWidth = undefined

    if (markYogaDirty) {
      this.yogaNode.markDirty()
    }

    this.requestRender()
  }

  private invalidateRasterOnly(): void {
    this._rasterDirty = true
    this.requestRender()
  }
}
