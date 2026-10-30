import { Renderable, type RenderableOptions } from "../Renderable.js"
import { OptimizedBuffer } from "../buffer.js"
import { RGBA, parseColor, type ColorInput } from "../lib/RGBA.js"
import type { KeyEvent } from "../lib/KeyHandler.js"
import type { RenderContext } from "../types.js"
import {
  type KeyBinding as BaseKeyBinding,
  mergeKeyBindings,
  buildKeyBindingsMap,
  getKeyBindingAction,
  defaultKeyAliases,
  mergeKeyAliases,
} from "../lib/keybinding.internal.js"

type KeyAliasMap = Record<string, string>

const transparent = RGBA.fromValues(0, 0, 0, 0)
const arrowColor = parseColor("#AAAAAA")

export interface TabSelectOption {
  name: string
  description: string
  value?: any
}

export type TabSelectAction = "move-left" | "move-right" | "select-current"

export type TabSelectKeyBinding = BaseKeyBinding<TabSelectAction>

const defaultTabSelectKeybindings: TabSelectKeyBinding[] = [
  { name: "left", action: "move-left" },
  { name: "[", action: "move-left" },
  { name: "right", action: "move-right" },
  { name: "]", action: "move-right" },
  { name: "return", action: "select-current" },
  { name: "linefeed", action: "select-current" },
]

export interface TabSelectRenderableOptions extends Omit<RenderableOptions<TabSelectRenderable>, "height"> {
  height?: number
  options?: TabSelectOption[]
  tabWidth?: number
  backgroundColor?: ColorInput
  textColor?: ColorInput
  focusedBackgroundColor?: ColorInput
  focusedTextColor?: ColorInput
  selectedBackgroundColor?: ColorInput
  selectedTextColor?: ColorInput
  selectedDescriptionColor?: ColorInput
  showScrollArrows?: boolean
  showDescription?: boolean
  showUnderline?: boolean
  wrapSelection?: boolean
  keyBindings?: TabSelectKeyBinding[]
  keyAliasMap?: KeyAliasMap
}

export enum TabSelectRenderableEvents {
  SELECTION_CHANGED = "selectionChanged",
  ITEM_SELECTED = "itemSelected",
}

function calculateDynamicHeight(showUnderline: boolean, showDescription: boolean): number {
  let height = 1

  if (showUnderline) {
    height += 1
  }

  if (showDescription) {
    height += 1
  }

  return height
}

const defaultColors = {
  backgroundColor: "transparent",
  textColor: "#FFFFFF",
  focusedBackgroundColor: "#1a1a1a",
  selectedBackgroundColor: "#334455",
  selectedTextColor: "#FFFF00",
  selectedDescriptionColor: "#CCCCCC",
}

export class TabSelectRenderable extends Renderable {
  protected static override readonly defaultFocusable = true

  private _options: TabSelectOption[] = []
  private selectedIndex: number = 0
  private scrollOffset: number = 0
  private _tabWidth: number
  private maxVisibleTabs: number

  private _backgroundColor: RGBA
  private _hasBackgroundColor: boolean
  private _textColor: RGBA
  private _focusedBackgroundColor: RGBA
  private _focusedTextColor: RGBA
  private _selectedBackgroundColor: RGBA
  private _selectedTextColor: RGBA
  private _selectedDescriptionColor: RGBA
  private _showScrollArrows: boolean
  private _showDescription: boolean
  private _showUnderline: boolean
  private _wrapSelection: boolean
  private _keyBindingsMap: Map<string, TabSelectAction>
  private _keyAliasMap: KeyAliasMap
  private _keyBindings: TabSelectKeyBinding[]

  constructor(ctx: RenderContext, options: TabSelectRenderableOptions) {
    const calculatedHeight = calculateDynamicHeight(options.showUnderline ?? true, options.showDescription ?? true)

    super(ctx, { ...options, height: calculatedHeight })

    try {
      this._backgroundColor = RGBA.clone(parseColor(options.backgroundColor || defaultColors.backgroundColor))
      this._hasBackgroundColor = !!options.backgroundColor
      this._textColor = RGBA.clone(parseColor(options.textColor || defaultColors.textColor))
      this._focusedBackgroundColor = RGBA.clone(
        parseColor(options.focusedBackgroundColor || options.backgroundColor || defaultColors.focusedBackgroundColor),
      )
      this._focusedTextColor = RGBA.clone(parseColor(options.focusedTextColor || this._textColor))
      this._options = options.options || []
      this._tabWidth = options.tabWidth || 20
      this._showDescription = options.showDescription ?? true
      this._showUnderline = options.showUnderline ?? true
      this._showScrollArrows = options.showScrollArrows ?? true
      this._wrapSelection = options.wrapSelection ?? false

      this.maxVisibleTabs = Math.max(1, Math.floor(this.width / this._tabWidth))

      this._selectedBackgroundColor = RGBA.clone(
        parseColor(options.selectedBackgroundColor || defaultColors.selectedBackgroundColor),
      )
      this._selectedTextColor = RGBA.clone(parseColor(options.selectedTextColor || defaultColors.selectedTextColor))
      this._selectedDescriptionColor = RGBA.clone(
        parseColor(options.selectedDescriptionColor || defaultColors.selectedDescriptionColor),
      )

      this._keyAliasMap = mergeKeyAliases(defaultKeyAliases, options.keyAliasMap || {})
      this._keyBindings = options.keyBindings || []
      const mergedBindings = mergeKeyBindings(defaultTabSelectKeybindings, this._keyBindings)
      this._keyBindingsMap = buildKeyBindingsMap(mergedBindings, this._keyAliasMap)
    } catch (error) {
      this.abortConstruction(error)
    }
  }

  private calculateDynamicHeight(): number {
    return calculateDynamicHeight(this._showUnderline, this._showDescription)
  }

  protected override defaultDimension(kind: "width" | "height"): number | "auto" | `${number}%` {
    return kind === "height" ? this.calculateDynamicHeight() : super.defaultDimension(kind)
  }

  // Draws at the paint origin every frame, only inside the node, so it needs no scissor. An opaque selected tab and
  // its underline get no background fill, and glyphs blend over the fills with a transparent background, so the
  // frame matches the composed buffer of `buffered: true`.
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    const [x, y] = this._paintOrigin(buffer)
    const width = this._paintWidth
    const height = this._paintHeight
    const bgColor = this._focused ? this._focusedBackgroundColor : this._backgroundColor
    const selectedX = (this.selectedIndex - this.scrollOffset) * this._tabWidth
    const selectedWidth = Math.min(this._tabWidth, width - selectedX)
    const selectedRows = this._showUnderline && height >= 2 ? 2 : 1
    const hole = this._options.length > 0 && selectedX < width && this._selectedBackgroundColor.a === 1
    const rows = hole ? selectedRows : 0

    if (buffer === this.frameBuffer) buffer.clear(bgColor)
    else {
      buffer.fillRect(x, y, selectedX, rows, bgColor)
      buffer.fillRect(x + selectedX + selectedWidth, y, width - selectedX - selectedWidth, rows, bgColor)
      buffer.fillRect(x, y + rows, width, height - rows, bgColor)
    }

    const visibleOptions = this._options.slice(this.scrollOffset, this.scrollOffset + this.maxVisibleTabs)
    for (let i = 0; i < visibleOptions.length; i++) {
      const option = visibleOptions[i]
      const isSelected = this.scrollOffset + i === this.selectedIndex
      const tabX = x + i * this._tabWidth

      if (tabX >= x + width) break

      const actualTabWidth = Math.min(this._tabWidth, width - i * this._tabWidth)
      const baseTextColor = this._focused ? this._focusedTextColor : this._textColor
      const nameColor = isSelected ? this._selectedTextColor : baseTextColor

      if (isSelected) {
        buffer.fillRect(tabX, y, actualTabWidth, selectedRows, this._selectedBackgroundColor)
      }
      buffer.drawTextFit(option.name, tabX + 1, y, actualTabWidth - 2, nameColor, transparent, true)
      if (isSelected && selectedRows === 2) {
        buffer.drawText("▬".repeat(actualTabWidth), tabX, y + 1, nameColor, transparent)
      }
    }

    const selectedOption = this.getSelectedOption()
    if (selectedOption && this._showDescription && height >= (this._showUnderline ? 3 : 2)) {
      const descriptionY = y + (this._showUnderline ? 2 : 1)
      const description = selectedOption.description
      buffer.drawTextFit(description, x + 1, descriptionY, width - 2, this._selectedDescriptionColor, transparent, true)
    }

    if (this._showScrollArrows && this._options.length > this.maxVisibleTabs) {
      if (this.scrollOffset > 0) buffer.drawText("‹", x, y, arrowColor, transparent)
      if (this.scrollOffset + this.maxVisibleTabs < this._options.length) {
        buffer.drawText("›", x + width - 1, y, arrowColor, transparent)
      }
    }
  }

  public setOptions(options: TabSelectOption[]): void {
    this._options = options
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, options.length - 1))
    this.updateScrollOffset()
    this.requestRender()
  }

  public getSelectedOption(): TabSelectOption | null {
    return this._options[this.selectedIndex] || null
  }

  public getSelectedIndex(): number {
    return this.selectedIndex
  }

  public moveLeft(): void {
    if (this.selectedIndex > 0) {
      this.selectedIndex--
    } else if (this._wrapSelection && this._options.length > 0) {
      this.selectedIndex = this._options.length - 1
    } else {
      return
    }

    this.updateScrollOffset()
    this.requestRender()
    this.emit(TabSelectRenderableEvents.SELECTION_CHANGED, this.selectedIndex, this.getSelectedOption())
  }

  public moveRight(): void {
    if (this.selectedIndex < this._options.length - 1) {
      this.selectedIndex++
    } else if (this._wrapSelection && this._options.length > 0) {
      this.selectedIndex = 0
    } else {
      return
    }

    this.updateScrollOffset()
    this.requestRender()
    this.emit(TabSelectRenderableEvents.SELECTION_CHANGED, this.selectedIndex, this.getSelectedOption())
  }

  public selectCurrent(): void {
    const selected = this.getSelectedOption()
    if (selected) {
      this.emit(TabSelectRenderableEvents.ITEM_SELECTED, this.selectedIndex, selected)
    }
  }

  public setSelectedIndex(index: number): void {
    if (index >= 0 && index < this._options.length) {
      this.selectedIndex = index
      this.updateScrollOffset()
      this.requestRender()
      this.emit(TabSelectRenderableEvents.SELECTION_CHANGED, this.selectedIndex, this.getSelectedOption())
    }
  }

  private updateScrollOffset(): void {
    const halfVisible = Math.floor(this.maxVisibleTabs / 2)
    const newScrollOffset = Math.max(
      0,
      Math.min(this.selectedIndex - halfVisible, this._options.length - this.maxVisibleTabs),
    )

    if (newScrollOffset !== this.scrollOffset) {
      this.scrollOffset = newScrollOffset
      this.requestRender()
    }
  }

  protected onResize(width: number, height: number): void {
    this.maxVisibleTabs = Math.max(1, Math.floor(width / this._tabWidth))
    this.updateScrollOffset()
    this.requestRender()
  }

  public setTabWidth(tabWidth: number): void {
    if (this._tabWidth === tabWidth) return

    this._tabWidth = tabWidth
    this.maxVisibleTabs = Math.max(1, Math.floor(this.width / this._tabWidth))

    this.updateScrollOffset()
    this.requestRender()
  }

  public getTabWidth(): number {
    return this._tabWidth
  }

  public handleKeyPress(key: KeyEvent): boolean {
    const action = getKeyBindingAction(this._keyBindingsMap, key)

    if (action) {
      switch (action) {
        case "move-left":
          this.moveLeft()
          return true
        case "move-right":
          this.moveRight()
          return true
        case "select-current":
          this.selectCurrent()
          return true
      }
    }

    return false
  }

  public get options(): TabSelectOption[] {
    return this._options
  }

  public set options(options: TabSelectOption[]) {
    this.setOptions(options)
  }

  public set backgroundColor(color: ColorInput) {
    this._backgroundColor = RGBA.clone(parseColor(color ?? defaultColors.backgroundColor))
    this._hasBackgroundColor = color != null
    this.requestRender()
  }

  public set textColor(color: ColorInput) {
    this._textColor = RGBA.clone(parseColor(color ?? defaultColors.textColor))
    this.requestRender()
  }

  public set focusedBackgroundColor(color: ColorInput) {
    // Like the constructor: an unset focused background follows an explicit background color.
    const fallback = this._hasBackgroundColor ? this._backgroundColor : defaultColors.focusedBackgroundColor
    this._focusedBackgroundColor = RGBA.clone(parseColor(color ?? fallback))
    this.requestRender()
  }

  public set focusedTextColor(color: ColorInput) {
    this._focusedTextColor = RGBA.clone(parseColor(color ?? this._textColor))
    this.requestRender()
  }

  public set selectedBackgroundColor(color: ColorInput) {
    this._selectedBackgroundColor = RGBA.clone(parseColor(color ?? defaultColors.selectedBackgroundColor))
    this.requestRender()
  }

  public set selectedTextColor(color: ColorInput) {
    this._selectedTextColor = RGBA.clone(parseColor(color ?? defaultColors.selectedTextColor))
    this.requestRender()
  }

  public set selectedDescriptionColor(color: ColorInput) {
    this._selectedDescriptionColor = RGBA.clone(parseColor(color ?? defaultColors.selectedDescriptionColor))
    this.requestRender()
  }

  public get showDescription(): boolean {
    return this._showDescription
  }

  public set showDescription(show: boolean) {
    if (this._showDescription !== show) {
      this._showDescription = show
      const newHeight = this.calculateDynamicHeight()
      this.height = newHeight
      this.requestRender()
    }
  }

  public get showUnderline(): boolean {
    return this._showUnderline
  }

  public set showUnderline(show: boolean) {
    if (this._showUnderline !== show) {
      this._showUnderline = show
      const newHeight = this.calculateDynamicHeight()
      this.height = newHeight
      this.requestRender()
    }
  }

  public get showScrollArrows(): boolean {
    return this._showScrollArrows
  }

  public set showScrollArrows(show: boolean) {
    if (this._showScrollArrows !== show) {
      this._showScrollArrows = show
      this.requestRender()
    }
  }

  public get wrapSelection(): boolean {
    return this._wrapSelection
  }

  public set wrapSelection(wrap: boolean) {
    this._wrapSelection = wrap
  }

  public get tabWidth(): number {
    return this._tabWidth
  }

  public set tabWidth(tabWidth: number) {
    this.setTabWidth(tabWidth)
  }

  public set keyBindings(bindings: TabSelectKeyBinding[]) {
    this._keyBindings = bindings
    const mergedBindings = mergeKeyBindings(defaultTabSelectKeybindings, bindings)
    this._keyBindingsMap = buildKeyBindingsMap(mergedBindings, this._keyAliasMap)
  }

  public set keyAliasMap(aliases: KeyAliasMap) {
    this._keyAliasMap = mergeKeyAliases(defaultKeyAliases, aliases)
    const mergedBindings = mergeKeyBindings(defaultTabSelectKeybindings, this._keyBindings)
    this._keyBindingsMap = buildKeyBindingsMap(mergedBindings, this._keyAliasMap)
  }
}
