import { EventEmitter } from "events"
import Yoga, { Direction, Display, Edge, FlexDirection, type Node as YogaNode } from "./yoga.js"
import { OptimizedBuffer } from "./buffer.js"
import type { KeyEvent, PasteEvent } from "./lib/KeyHandler.js"
import type { MouseEventType } from "./lib/parse.mouse.js"
import type { Selection } from "./lib/selection.js"
import {
  parseAlign,
  parseAlignItems,
  parseFlexDirection,
  parseJustify,
  parseOverflow,
  parsePositionType,
  parseWrap,
  type AlignString,
  type FlexDirectionString,
  type JustifyString,
  type OverflowString,
  type PositionTypeString,
  type WrapString,
} from "./lib/yoga.options.js"
import { maybeMakeRenderable, type VNode } from "./renderables/composition/vnode.js"
import type { MouseEvent } from "./renderer.js"
import type { RenderContext } from "./types.js"
import {
  validateOptions,
  isPositionType,
  isDimensionType,
  isFlexBasisType,
  isSizeType,
  isMarginType,
  isPaddingType,
  isPositionTypeType,
  isOverflowType,
} from "./lib/renderable.validations.js"

const BrandedRenderable: unique symbol = Symbol.for("@opentui/core/Renderable")

export enum LayoutEvents {
  LAYOUT_CHANGED = "layout-changed",
  ADDED = "added",
  REMOVED = "removed",
  RESIZED = "resized",
}

export enum RenderableEvents {
  FOCUSED = "focused",
  BLURRED = "blurred",
  DESTROYED = "destroyed",
}

export interface Position {
  top?: number | "auto" | `${number}%`
  right?: number | "auto" | `${number}%`
  bottom?: number | "auto" | `${number}%`
  left?: number | "auto" | `${number}%`
}

export interface BaseRenderableOptions {
  id?: string
}

export interface LayoutOptions extends BaseRenderableOptions {
  flexGrow?: number
  flexShrink?: number
  flexDirection?: FlexDirectionString
  flexWrap?: WrapString
  alignItems?: AlignString
  justifyContent?: JustifyString
  alignSelf?: AlignString
  flexBasis?: number | "auto" | undefined
  position?: PositionTypeString
  overflow?: OverflowString
  top?: number | "auto" | `${number}%`
  right?: number | "auto" | `${number}%`
  bottom?: number | "auto" | `${number}%`
  left?: number | "auto" | `${number}%`
  minWidth?: number | "auto" | `${number}%`
  minHeight?: number | "auto" | `${number}%`
  maxWidth?: number | "auto" | `${number}%`
  maxHeight?: number | "auto" | `${number}%`
  margin?: number | "auto" | `${number}%`
  marginX?: number | "auto" | `${number}%`
  marginY?: number | "auto" | `${number}%`
  marginTop?: number | "auto" | `${number}%`
  marginRight?: number | "auto" | `${number}%`
  marginBottom?: number | "auto" | `${number}%`
  marginLeft?: number | "auto" | `${number}%`
  padding?: number | `${number}%`
  paddingX?: number | `${number}%`
  paddingY?: number | `${number}%`
  paddingTop?: number | `${number}%`
  paddingRight?: number | `${number}%`
  paddingBottom?: number | `${number}%`
  paddingLeft?: number | `${number}%`
  enableLayout?: boolean
}

export interface RenderableOptions<T extends BaseRenderable = BaseRenderable> extends Partial<LayoutOptions> {
  width?: number | "auto" | `${number}%`
  height?: number | "auto" | `${number}%`
  zIndex?: number
  visible?: boolean
  buffered?: boolean
  live?: boolean
  opacity?: number

  // Draw-only hooks for custom rendering/decorations. They run after layout
  // and viewport culling, so do not mutate layout, children, or reactive state here.
  // Culled children do not run these hooks.
  renderBefore?: (this: T, buffer: OptimizedBuffer, deltaTime: number) => void
  renderAfter?: (this: T, buffer: OptimizedBuffer, deltaTime: number) => void

  // catch all
  onMouse?: (this: T, event: MouseEvent) => void

  onMouseDown?: (this: T, event: MouseEvent) => void
  onMouseUp?: (this: T, event: MouseEvent) => void
  onMouseMove?: (this: T, event: MouseEvent) => void
  onMouseDrag?: (this: T, event: MouseEvent) => void
  onMouseDragEnd?: (this: T, event: MouseEvent) => void
  onMouseDrop?: (this: T, event: MouseEvent) => void
  onMouseOver?: (this: T, event: MouseEvent) => void
  onMouseOut?: (this: T, event: MouseEvent) => void
  onMouseScroll?: (this: T, event: MouseEvent) => void

  onPaste?: (this: T, event: PasteEvent) => void

  onKeyDown?: (key: KeyEvent) => void

  onSizeChange?: (this: T) => void
}

export function isRenderable(obj: any): obj is Renderable {
  return !!obj?.[BrandedRenderable]
}

export abstract class BaseRenderable extends EventEmitter {
  [BrandedRenderable] = true

  private static renderableNumber = 1
  protected _id: string
  public readonly num: number
  protected _dirty: boolean = false
  public parent: BaseRenderable | null = null
  protected _visible: boolean = true

  constructor(options: BaseRenderableOptions) {
    super()
    this.num = BaseRenderable.renderableNumber++
    this._id = options.id ?? `renderable-${this.num}`
  }

  public abstract add(obj: BaseRenderable | unknown, index?: number): number
  public abstract remove(id: string): void
  public abstract insertBefore(obj: BaseRenderable | unknown, anchor: BaseRenderable | unknown): void
  public abstract getChildren(): BaseRenderable[]
  public abstract getChildrenCount(): number
  public abstract getRenderable(id: string): BaseRenderable | undefined
  public abstract requestRender(): void
  public abstract findDescendantById(id: string): BaseRenderable | undefined

  public get id(): string {
    return this._id
  }

  public set id(value: string) {
    this._id = value
  }

  public get isDirty(): boolean {
    return this._dirty
  }

  protected markClean(): void {
    this._dirty = false
  }

  protected markDirty(): void {
    this._dirty = true
  }

  public destroy(): void {
    // Default implementation: do nothing
    // Override this method to provide custom removal logic
  }

  public destroyRecursively(): void {
    // Default implementation: do nothing
    // Override this method to provide custom destruction logic
  }

  public get visible(): boolean {
    return this._visible
  }

  public set visible(value: boolean) {
    this._visible = value
  }
}

interface LayoutGenerationContext extends RenderContext {
  __otuiLayoutGeneration?: number
  __otuiRenderListRevision?: number
}

function getLayoutGeneration(ctx: RenderContext): number {
  return (ctx as LayoutGenerationContext).__otuiLayoutGeneration ?? 0
}

function bumpLayoutGeneration(ctx: RenderContext): number {
  const next = getLayoutGeneration(ctx) + 1
  const generationContext = ctx as LayoutGenerationContext
  generationContext.__otuiLayoutGeneration = next
  return next
}

function getRenderListRevision(ctx: RenderContext): number {
  return (ctx as LayoutGenerationContext).__otuiRenderListRevision ?? 0
}

function bumpRenderListRevision(ctx: RenderContext): void {
  const generationContext = ctx as LayoutGenerationContext
  generationContext.__otuiRenderListRevision = getRenderListRevision(ctx) + 1
}

export abstract class Renderable extends BaseRenderable {
  static renderablesByNumber: Map<number, Renderable> = new Map()

  protected _isDestroyed: boolean = false
  protected _ctx: RenderContext
  protected _translateX: number = 0
  protected _translateY: number = 0
  protected _x: number = 0
  protected _y: number = 0
  // Render hot paths only need absolute terminal coordinates. Cache them during
  // layout so render-time code does not keep walking parent chains via x/y.
  protected _screenX: number = 0
  protected _screenY: number = 0
  protected _width: number | "auto" | `${number}%`
  protected _height: number | "auto" | `${number}%`
  protected _widthValue: number = 0
  protected _heightValue: number = 0
  private _zIndex: number
  public selectable: boolean = false
  protected buffered: boolean
  protected frameBuffer: OptimizedBuffer | null = null

  protected _focusable: boolean = false
  protected _focused: boolean = false
  protected _hasFocusedDescendant: boolean = false
  protected keypressHandler: ((key: KeyEvent) => void) | null = null
  protected pasteHandler: ((event: PasteEvent) => void) | null = null

  private _live: boolean = false
  protected _liveCount: number = 0

  private _sizeChangeListener: (() => void) | undefined = undefined
  private _mouseListener: ((event: MouseEvent) => void) | null = null
  private _mouseListeners: Partial<Record<MouseEventType, (event: MouseEvent) => void>> = {}
  private _pasteListener: ((event: PasteEvent) => void) | undefined = undefined
  private _keyListeners: Partial<Record<"down", (key: KeyEvent) => void>> = {}

  protected yogaNode: YogaNode
  protected _positionType: PositionTypeString = "relative"
  protected _overflow: OverflowString = "visible"
  protected _position: Position = {}
  protected _opacity: number = 1.0
  private _flexShrink: number = 1

  private renderableMapById: Map<string, Renderable> = new Map()
  protected _childrenInLayoutOrder: Renderable[] = []
  protected _childrenInZIndexOrder: Renderable[] = []
  private needsZIndexSort: boolean = false
  public parent: Renderable | null = null

  private childrenPrimarySortDirty: boolean = true
  private childrenSortedByPrimaryAxis: Renderable[] = []
  private _shouldUpdateBefore: Set<Renderable> = new Set()

  // Frame id of the last updateFromLayout(); -1 ensures the first call runs.
  private _lastLayoutFrame: number = -1

  public onLifecyclePass: (() => void) | null = null

  public renderBefore?: (this: Renderable, buffer: OptimizedBuffer, deltaTime: number) => void
  public renderAfter?: (this: Renderable, buffer: OptimizedBuffer, deltaTime: number) => void

  constructor(ctx: RenderContext, options: RenderableOptions<any>) {
    super(options)

    this._ctx = ctx
    Renderable.renderablesByNumber.set(this.num, this)

    validateOptions(this.id, options)

    this.renderBefore = options.renderBefore
    this.renderAfter = options.renderAfter

    this._width = options.width ?? "auto"
    this._height = options.height ?? "auto"

    if (typeof this._width === "number") {
      this._widthValue = this._width
    }
    if (typeof this._height === "number") {
      this._heightValue = this._height
    }

    this._zIndex = options.zIndex ?? 0
    this._visible = options.visible !== false
    this.buffered = options.buffered ?? false
    this._live = options.live ?? false
    this._liveCount = this._live && this._visible ? 1 : 0
    this._opacity = options.opacity !== undefined ? Math.max(0, Math.min(1, options.opacity)) : 1.0

    this.yogaNode = Yoga.Node.createForOpenTUI()
    this.yogaNode.setDisplay(this._visible ? Display.Flex : Display.None)
    this.setupYogaProperties(options)

    this.applyEventOptions(options)

    if (this.buffered) {
      this.createFrameBuffer()
    }
  }

  public override get id() {
    return this._id
  }

  public override set id(value: string) {
    if (this.parent) {
      this.parent.renderableMapById.delete(this.id)
      this.parent.renderableMapById.set(value, this)
    }
    super.id = value
  }

  public get focusable(): boolean {
    return this._focusable
  }

  public set focusable(value: boolean) {
    this._focusable = value
  }

  public get ctx(): RenderContext {
    return this._ctx
  }

  public get visible(): boolean {
    return this._visible
  }

  public get primaryAxis(): "row" | "column" {
    const dir = this.yogaNode.getFlexDirection()
    return dir === 2 || dir === 3 ? "row" : "column"
  }

  public set visible(value: boolean) {
    if (this._visible === value) return

    const wasVisible = this._visible
    this._visible = value
    this.yogaNode.setDisplay(value ? Display.Flex : Display.None)
    bumpRenderListRevision(this._ctx)

    if (this._live) {
      if (!wasVisible && value) {
        this.propagateLiveCount(1)
      } else if (wasVisible && !value) {
        this.propagateLiveCount(-1)
      }
    }

    if (this._focused) {
      this.blur()
    }
    this.requestRender()
  }

  public get opacity(): number {
    return this._opacity
  }

  public set opacity(value: number) {
    const clamped = Math.max(0, Math.min(1, value))
    if (this._opacity !== clamped) {
      this._opacity = clamped
      bumpRenderListRevision(this._ctx)
      this.requestRender()
    }
  }

  public hasSelection(): boolean {
    return false
  }

  public onSelectionChanged(selection: Selection | null): boolean {
    // Default implementation: do nothing
    // Override this method to provide custom selection handling
    return false
  }

  public getSelectedText(): string {
    return ""
  }

  public shouldStartSelection(x: number, y: number): boolean {
    return false
  }

  public focus(): void {
    if (this._isDestroyed || this._focused || !this._focusable) return

    this._focused = true
    this._ctx.focusRenderable(this)
    this.requestRender()

    this.keypressHandler = (key: KeyEvent) => {
      if (this._isDestroyed) return
      this._keyListeners["down"]?.(key)
      // Check again after user listener - it might have destroyed the renderable
      if (this._isDestroyed) return
      if (!key.defaultPrevented && this.handleKeyPress) {
        this.handleKeyPress(key)
      }
    }

    this.pasteHandler = (event: PasteEvent) => {
      if (this._isDestroyed) return
      this._pasteListener?.call(this, event)
      // Check again after user listener - it might have destroyed the renderable
      if (this._isDestroyed) return
      if (!event.defaultPrevented && this.handlePaste) {
        this.handlePaste(event)
      }
    }

    this.ctx._internalKeyInput.onInternal("keypress", this.keypressHandler)
    this.ctx._internalKeyInput.onInternal("paste", this.pasteHandler)
    this.propagateFocusChange(true)
    this.emit(RenderableEvents.FOCUSED)
  }

  protected propagateFocusChange(hasFocus: boolean): void {
    let parent = this.parent
    while (parent) {
      if (parent._hasFocusedDescendant !== hasFocus) {
        parent._hasFocusedDescendant = hasFocus
        parent.markDirty()
      }
      parent = parent.parent
    }

    this.requestRender()
  }

  public blur(): void {
    if (!this._focused || !this._focusable) return

    this._ctx.blurRenderable(this)
    this._focused = false
    this.requestRender()

    if (this.keypressHandler) {
      this.ctx._internalKeyInput.offInternal("keypress", this.keypressHandler)
      this.keypressHandler = null
    }

    if (this.pasteHandler) {
      this.ctx._internalKeyInput.offInternal("paste", this.pasteHandler)
      this.pasteHandler = null
    }

    this.propagateFocusChange(false)
    this.emit(RenderableEvents.BLURRED)
  }

  public get focused(): boolean {
    return this._focused
  }

  public get hasFocusedDescendant(): boolean {
    return this._hasFocusedDescendant
  }

  public get live(): boolean {
    return this._live
  }

  public get liveCount(): number {
    return this._liveCount
  }

  public set live(value: boolean) {
    if (this._live === value) return

    this._live = value

    if (this._visible) {
      const delta = value ? 1 : -1
      this.propagateLiveCount(delta)
    }
  }

  protected propagateLiveCount(delta: number): void {
    this._liveCount += delta
    this.parent?.propagateLiveCount(delta)
  }

  public handleKeyPress?(key: KeyEvent): boolean
  public handlePaste?(event: PasteEvent): void

  public findDescendantById(id: string): Renderable | undefined {
    for (const child of this._childrenInLayoutOrder) {
      if (child.id === id) return child
      if (isRenderable(child)) {
        const found = child.findDescendantById(id)
        if (found) return found
      }
    }
    return undefined
  }

  public requestRender() {
    this.markDirty()
    this._ctx.requestRender()
  }

  public get translateX(): number {
    return this._translateX
  }

  // Translate updates bypass layout, so keep the absolute screen cache current
  // here to make same-frame sort/cull/render reads observe the new position.
  public set translateX(value: number) {
    if (this._translateX === value) return
    this._translateX = value
    const parentScreenX = this.parent ? this.parent._screenX : 0
    this._screenX = parentScreenX + this._x + this._translateX
    if (this.parent) this.parent.childrenPrimarySortDirty = true
    bumpRenderListRevision(this._ctx)
    this.requestRender()
  }

  public get translateY(): number {
    return this._translateY
  }

  public set translateY(value: number) {
    if (this._translateY === value) return
    this._translateY = value
    const parentScreenY = this.parent ? this.parent._screenY : 0
    this._screenY = parentScreenY + this._y + this._translateY
    if (this.parent) this.parent.childrenPrimarySortDirty = true
    bumpRenderListRevision(this._ctx)
    this.requestRender()
  }

  // Use the cached parent screen position plus this node's current local offset.
  // That keeps culling/sorting in sync even before this node refreshes _screenX/Y.
  public get screenX(): number {
    const parentScreenX = this.parent ? this.parent._screenX : 0
    return parentScreenX + this._x + this._translateX
  }

  public get screenY(): number {
    const parentScreenY = this.parent ? this.parent._screenY : 0
    return parentScreenY + this._y + this._translateY
  }

  public get x(): number {
    if (this.parent) {
      return this.parent.x + this._x + this._translateX
    }
    return this._x + this._translateX
  }

  public set x(value: number) {
    this.left = value
  }

  public get top(): number | "auto" | `${number}%` | undefined {
    return this._position.top
  }

  public set top(value: number | "auto" | `${number}%` | undefined) {
    if (isPositionType(value) || value === undefined) {
      this.setPosition({ top: value })
    }
  }

  public get right(): number | "auto" | `${number}%` | undefined {
    return this._position.right
  }

  public set right(value: number | "auto" | `${number}%` | undefined) {
    if (isPositionType(value) || value === undefined) {
      this.setPosition({ right: value })
    }
  }

  public get bottom(): number | "auto" | `${number}%` | undefined {
    return this._position.bottom
  }

  public set bottom(value: number | "auto" | `${number}%` | undefined) {
    if (isPositionType(value) || value === undefined) {
      this.setPosition({ bottom: value })
    }
  }

  public get left(): number | "auto" | `${number}%` | undefined {
    return this._position.left
  }

  public set left(value: number | "auto" | `${number}%` | undefined) {
    if (isPositionType(value) || value === undefined) {
      this.setPosition({ left: value })
    }
  }

  public get y(): number {
    if (this.parent) {
      return this.parent.y + this._y + this._translateY
    }
    return this._y + this._translateY
  }

  public set y(value: number) {
    this.top = value
  }

  public get width(): number {
    return this._widthValue
  }

  public set width(value: number | "auto" | `${number}%`) {
    if (!isDimensionType(value) || this._width === value) {
      return
    }

    this._width = value
    this.yogaNode.setWidth(value)

    if (typeof value === "number" && this._flexShrink === 1) {
      this._flexShrink = 0
      this.yogaNode.setFlexShrink(0)
    }

    this.requestRender()
  }

  public get height(): number {
    return this._heightValue
  }

  public set height(value: number | "auto" | `${number}%`) {
    if (!isDimensionType(value) || this._height === value) {
      return
    }

    this._height = value
    this.yogaNode.setHeight(value)

    if (typeof value === "number" && this._flexShrink === 1) {
      this._flexShrink = 0
      this.yogaNode.setFlexShrink(0)
    }

    this.requestRender()
  }

  public get zIndex(): number {
    return this._zIndex
  }

  public set zIndex(value: number) {
    if (this._zIndex !== value) {
      this._zIndex = value
      this.parent?.requestZIndexSort()
      bumpRenderListRevision(this._ctx)
      this.requestRender()
    }
  }

  private requestZIndexSort(): void {
    this.needsZIndexSort = true
  }

  private ensureZIndexSorted(): void {
    if (this.needsZIndexSort) {
      this._childrenInZIndexOrder.sort((a, b) => (a.zIndex > b.zIndex ? 1 : a.zIndex < b.zIndex ? -1 : 0))
      this.needsZIndexSort = false
    }
  }

  public getChildrenSortedByPrimaryAxis(): Renderable[] {
    if (
      !this.childrenPrimarySortDirty &&
      this.childrenSortedByPrimaryAxis.length === this._childrenInLayoutOrder.length
    ) {
      return this.childrenSortedByPrimaryAxis
    }

    const dir = this.yogaNode.getFlexDirection()
    const axis: "x" | "y" = dir === 2 || dir === 3 ? "x" : "y"

    const sorted = [...this._childrenInLayoutOrder]
    sorted.sort((a, b) => {
      // Viewport culling compares against screen-space bounds, so primary-axis
      // ordering has to use absolute positions instead of parent-relative x/y.
      const va = axis === "y" ? a.screenY : a.screenX
      const vb = axis === "y" ? b.screenY : b.screenX
      return va - vb
    })

    this.childrenSortedByPrimaryAxis = sorted
    this.childrenPrimarySortDirty = false
    return this.childrenSortedByPrimaryAxis
  }

  private setupYogaProperties(options: RenderableOptions<Renderable>): void {
    const node = this.yogaNode

    if (isFlexBasisType(options.flexBasis)) {
      node.setFlexBasis(options.flexBasis)
    }

    if (isSizeType(options.minWidth)) {
      node.setMinWidth(options.minWidth)
    }
    if (isSizeType(options.minHeight)) {
      node.setMinHeight(options.minHeight)
    }

    if (options.flexGrow !== undefined) {
      node.setFlexGrow(options.flexGrow)
    } else {
      node.setFlexGrow(0)
    }

    if (options.flexShrink !== undefined) {
      this._flexShrink = options.flexShrink
      node.setFlexShrink(options.flexShrink)
    } else {
      // If explicit numeric width is set, don't shrink by default
      // Otherwise follow web default of 1
      const hasExplicitWidth = typeof options.width === "number"
      const hasExplicitHeight = typeof options.height === "number"
      this._flexShrink = hasExplicitWidth || hasExplicitHeight ? 0 : 1
      node.setFlexShrink(this._flexShrink)
    }

    node.setFlexDirection(parseFlexDirection(options.flexDirection))
    node.setFlexWrap(parseWrap(options.flexWrap))
    node.setAlignItems(parseAlignItems(options.alignItems))
    node.setJustifyContent(parseJustify(options.justifyContent))
    node.setAlignSelf(parseAlign(options.alignSelf))

    if (isDimensionType(options.width)) {
      this._width = options.width
      this.yogaNode.setWidth(options.width)
    }
    if (isDimensionType(options.height)) {
      this._height = options.height
      this.yogaNode.setHeight(options.height)
    }

    this._positionType = options.position === "absolute" ? "absolute" : "relative"
    if (this._positionType !== "relative") {
      node.setPositionType(parsePositionType(this._positionType))
    }

    this._overflow = options.overflow === "hidden" ? "hidden" : options.overflow === "scroll" ? "scroll" : "visible"
    if (this._overflow !== "visible") {
      node.setOverflow(parseOverflow(this._overflow))
    }

    // TODO: flatten position properties internally as well
    const hasPositionProps =
      options.top !== undefined ||
      options.right !== undefined ||
      options.bottom !== undefined ||
      options.left !== undefined
    if (hasPositionProps) {
      this._position = {
        top: options.top,
        right: options.right,
        bottom: options.bottom,
        left: options.left,
      }
      this.updateYogaPosition(this._position)
    }

    if (isSizeType(options.maxWidth)) {
      node.setMaxWidth(options.maxWidth)
    }
    if (isSizeType(options.maxHeight)) {
      node.setMaxHeight(options.maxHeight)
    }

    this.setupMarginAndPadding(options)
  }

  private setupMarginAndPadding(options: RenderableOptions<Renderable>): void {
    const node = this.yogaNode

    if (isMarginType(options.margin)) {
      node.setMargin(Edge.All, options.margin)
    }

    if (isMarginType(options.marginX)) {
      node.setMargin(Edge.Horizontal, options.marginX)
    }
    if (isMarginType(options.marginY)) {
      node.setMargin(Edge.Vertical, options.marginY)
    }
    if (isMarginType(options.marginTop)) {
      node.setMargin(Edge.Top, options.marginTop)
    }
    if (isMarginType(options.marginRight)) {
      node.setMargin(Edge.Right, options.marginRight)
    }
    if (isMarginType(options.marginBottom)) {
      node.setMargin(Edge.Bottom, options.marginBottom)
    }
    if (isMarginType(options.marginLeft)) {
      node.setMargin(Edge.Left, options.marginLeft)
    }

    if (isPaddingType(options.padding)) {
      node.setPadding(Edge.All, options.padding)
    }

    if (isPaddingType(options.paddingX)) {
      node.setPadding(Edge.Horizontal, options.paddingX)
    }
    if (isPaddingType(options.paddingY)) {
      node.setPadding(Edge.Vertical, options.paddingY)
    }
    if (isPaddingType(options.paddingTop)) {
      node.setPadding(Edge.Top, options.paddingTop)
    }
    if (isPaddingType(options.paddingRight)) {
      node.setPadding(Edge.Right, options.paddingRight)
    }
    if (isPaddingType(options.paddingBottom)) {
      node.setPadding(Edge.Bottom, options.paddingBottom)
    }
    if (isPaddingType(options.paddingLeft)) {
      node.setPadding(Edge.Left, options.paddingLeft)
    }
  }

  set position(positionType: PositionTypeString | null | undefined) {
    if (!isPositionTypeType(positionType) || this._positionType === positionType) return

    this._positionType = positionType
    this.yogaNode.setPositionType(parsePositionType(positionType))
    this.requestRender()
  }

  get overflow(): OverflowString {
    return this._overflow
  }

  set overflow(overflow: OverflowString | null | undefined) {
    if (!isOverflowType(overflow) || this._overflow === overflow) return

    this._overflow = overflow
    this.yogaNode.setOverflow(parseOverflow(overflow))
    bumpRenderListRevision(this._ctx)
    this.requestRender()
  }

  public setPosition(position: Position): void {
    this._position = { ...this._position, ...position }
    this.updateYogaPosition(position)
  }

  private updateYogaPosition(position: Position): void {
    const node = this.yogaNode
    const { top, right, bottom, left } = position

    if (isPositionType(top)) {
      if (top === "auto") {
        node.setPositionAuto(Edge.Top)
      } else {
        node.setPosition(Edge.Top, top)
      }
    }
    if (isPositionType(right)) {
      if (right === "auto") {
        node.setPositionAuto(Edge.Right)
      } else {
        node.setPosition(Edge.Right, right)
      }
    }
    if (isPositionType(bottom)) {
      if (bottom === "auto") {
        node.setPositionAuto(Edge.Bottom)
      } else {
        node.setPosition(Edge.Bottom, bottom)
      }
    }
    if (isPositionType(left)) {
      if (left === "auto") {
        node.setPositionAuto(Edge.Left)
      } else {
        node.setPosition(Edge.Left, left)
      }
    }
    this.requestRender()
  }

  public set flexGrow(grow: number | null | undefined) {
    if (grow == null) {
      this.yogaNode.setFlexGrow(0)
    } else {
      this.yogaNode.setFlexGrow(grow)
    }
    this.requestRender()
  }

  public set flexShrink(shrink: number | null | undefined) {
    const value = shrink == null ? 1 : shrink
    this._flexShrink = value
    this.yogaNode.setFlexShrink(value)
    this.requestRender()
  }

  public set flexDirection(direction: FlexDirectionString | null | undefined) {
    this.yogaNode.setFlexDirection(parseFlexDirection(direction))
    this.requestRender()
  }

  public set flexWrap(wrap: WrapString | null | undefined) {
    this.yogaNode.setFlexWrap(parseWrap(wrap))
    this.requestRender()
  }

  public set alignItems(alignItems: AlignString | null | undefined) {
    this.yogaNode.setAlignItems(parseAlignItems(alignItems))
    this.requestRender()
  }

  public set justifyContent(justifyContent: JustifyString | null | undefined) {
    this.yogaNode.setJustifyContent(parseJustify(justifyContent))
    this.requestRender()
  }

  public set alignSelf(alignSelf: AlignString | null | undefined) {
    this.yogaNode.setAlignSelf(parseAlign(alignSelf))
    this.requestRender()
  }

  public set flexBasis(basis: number | "auto" | null | undefined) {
    if (isFlexBasisType(basis)) {
      this.yogaNode.setFlexBasis(basis)
      this.requestRender()
    }
  }

  public set minWidth(minWidth: number | `${number}%` | null | undefined) {
    if (isSizeType(minWidth)) {
      this.yogaNode.setMinWidth(minWidth)
      this.requestRender()
    }
  }

  public set maxWidth(maxWidth: number | `${number}%` | null | undefined) {
    if (isSizeType(maxWidth)) {
      this.yogaNode.setMaxWidth(maxWidth)
      this.requestRender()
    }
  }

  public set minHeight(minHeight: number | `${number}%` | null | undefined) {
    if (isSizeType(minHeight)) {
      this.yogaNode.setMinHeight(minHeight)
      this.requestRender()
    }
  }

  public set maxHeight(maxHeight: number | `${number}%` | null | undefined) {
    if (isSizeType(maxHeight)) {
      this.yogaNode.setMaxHeight(maxHeight)
      this.requestRender()
    }
  }

  public set margin(margin: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(margin)) {
      this.yogaNode.setMargin(Edge.All, margin)
      this.requestRender()
    }
  }

  public set marginX(marginX: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(marginX)) {
      this.yogaNode.setMargin(Edge.Horizontal, marginX)
      this.requestRender()
    }
  }

  public set marginY(marginY: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(marginY)) {
      this.yogaNode.setMargin(Edge.Vertical, marginY)
      this.requestRender()
    }
  }

  public set marginTop(margin: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(margin)) {
      this.yogaNode.setMargin(Edge.Top, margin)
      this.requestRender()
    }
  }

  public get marginTop(): number | "auto" | `${number}%` {
    const margin = this.yogaNode.getMargin(Edge.Top) as unknown
    if (typeof margin === "number") return margin
    if (typeof margin === "object" && margin && "value" in margin && typeof margin.value === "number")
      return margin.value
    return 0
  }

  public set marginRight(margin: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(margin)) {
      this.yogaNode.setMargin(Edge.Right, margin)
      this.requestRender()
    }
  }

  public set marginBottom(margin: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(margin)) {
      this.yogaNode.setMargin(Edge.Bottom, margin)
      this.requestRender()
    }
  }

  public set marginLeft(margin: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(margin)) {
      this.yogaNode.setMargin(Edge.Left, margin)
      this.requestRender()
    }
  }

  public set padding(padding: number | `${number}%` | null | undefined) {
    if (isPaddingType(padding)) {
      this.yogaNode.setPadding(Edge.All, padding)
      this.requestRender()
    }
  }

  public set paddingX(paddingX: number | `${number}%` | null | undefined) {
    if (isPaddingType(paddingX)) {
      this.yogaNode.setPadding(Edge.Horizontal, paddingX)
      this.requestRender()
    }
  }

  public set paddingY(paddingY: number | `${number}%` | null | undefined) {
    if (isPaddingType(paddingY)) {
      this.yogaNode.setPadding(Edge.Vertical, paddingY)
      this.requestRender()
    }
  }

  public set paddingTop(padding: number | `${number}%` | null | undefined) {
    if (isPaddingType(padding)) {
      this.yogaNode.setPadding(Edge.Top, padding)
      this.requestRender()
    }
  }

  public set paddingRight(padding: number | `${number}%` | null | undefined) {
    if (isPaddingType(padding)) {
      this.yogaNode.setPadding(Edge.Right, padding)
      this.requestRender()
    }
  }

  public set paddingBottom(padding: number | `${number}%` | null | undefined) {
    if (isPaddingType(padding)) {
      this.yogaNode.setPadding(Edge.Bottom, padding)
      this.requestRender()
    }
  }

  public set paddingLeft(padding: number | `${number}%` | null | undefined) {
    if (isPaddingType(padding)) {
      this.yogaNode.setPadding(Edge.Left, padding)
      this.requestRender()
    }
  }

  public getLayoutNode(): YogaNode {
    return this.yogaNode
  }

  public updateFromLayout(): void {
    // Yoga layout is stable within a frame; skip the FFI round-trip on repeat calls.
    const frameId = this._ctx.frameId
    if (this._lastLayoutFrame === frameId) return
    this._lastLayoutFrame = frameId

    const layout = this.yogaNode.getComputedLayout()

    const oldX = this._x
    const oldY = this._y
    const oldWidth = this._widthValue
    const oldHeight = this._heightValue

    this._x = layout.left
    this._y = layout.top
    // Layout is updated top-down, so the parent cache is already current here.
    // Recomputing once per layout pass keeps render-time coordinate reads cheap.
    const parentScreenX = this.parent ? this.parent._screenX : 0
    const parentScreenY = this.parent ? this.parent._screenY : 0
    this._screenX = parentScreenX + this._x + this._translateX
    this._screenY = parentScreenY + this._y + this._translateY

    const newWidth = Math.max(layout.width, 1)
    const newHeight = Math.max(layout.height, 1)
    const sizeChanged = oldWidth !== newWidth || oldHeight !== newHeight

    this._widthValue = newWidth
    this._heightValue = newHeight

    if (sizeChanged) {
      this.onLayoutResize(newWidth, newHeight)
    }

    const positionChanged = oldX !== this._x || oldY !== this._y
    if (positionChanged) {
      if (this.parent) this.parent.childrenPrimarySortDirty = true
    }
  }

  protected onLayoutResize(width: number, height: number): void {
    if (this._visible) {
      // TODO: Should probably .markDirty()
      this.handleFrameBufferResize(width, height)
      this.onResize(width, height)
      this.requestRender()
    }
  }

  protected handleFrameBufferResize(width: number, height: number): void {
    if (!this.buffered) return

    if (width <= 0 || height <= 0) {
      return
    }

    if (this.frameBuffer) {
      this.frameBuffer.resize(width, height)
    } else {
      this.createFrameBuffer()
    }
  }

  protected createFrameBuffer(): void {
    const w = this.width
    const h = this.height

    if (w <= 0 || h <= 0) {
      return
    }

    try {
      const widthMethod = this._ctx.widthMethod
      this.frameBuffer = OptimizedBuffer.create(w, h, widthMethod, {
        respectAlpha: true,
        id: `framebuffer-${this.id}`,
      })
    } catch (error) {
      console.error(`Failed to create frame buffer for ${this.id}:`, error)
      this.frameBuffer = null
    }
  }

  /**
   * This will be called during a render pass.
   * Requesting a render during a render pass will drop the requested render.
   * If you need to request a render during a render pass, use process.nextTick.
   */
  protected onResize(width: number, height: number): void {
    this.onSizeChange?.()
    this.emit("resize")
    // Override in subclasses for additional resize logic
  }

  private replaceParent(obj: Renderable) {
    if (obj.parent) {
      obj.parent.remove(obj.id)
    }
    obj.parent = this
  }

  public add(obj: Renderable | VNode<any, any[]> | unknown, index?: number): number {
    if (!obj) {
      return -1
    }

    const renderable = maybeMakeRenderable(this._ctx, obj)
    if (!renderable) {
      return -1
    }

    if (renderable.isDestroyed) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`Renderable with id ${renderable.id} was already destroyed, skipping add`)
      }
      return -1
    }

    const anchorRenderable = index !== undefined ? this._childrenInLayoutOrder[index] : undefined

    if (anchorRenderable) {
      return this.insertBefore(renderable, anchorRenderable)
    }

    if (renderable.parent === this) {
      this.yogaNode.removeChild(renderable.getLayoutNode())
      this._childrenInLayoutOrder.splice(this._childrenInLayoutOrder.indexOf(renderable), 1)
    } else {
      this.replaceParent(renderable)
      this.needsZIndexSort = true
      this.renderableMapById.set(renderable.id, renderable)
      this._childrenInZIndexOrder.push(renderable)

      if (typeof renderable.onLifecyclePass === "function") {
        this._ctx.registerLifecyclePass(renderable)
      }

      if (renderable._liveCount > 0) {
        this.propagateLiveCount(renderable._liveCount)
      }
    }

    const childLayoutNode = renderable.getLayoutNode()
    const insertedIndex = this._childrenInLayoutOrder.length
    this._childrenInLayoutOrder.push(renderable)
    this.yogaNode.insertChild(childLayoutNode, insertedIndex)

    this.childrenPrimarySortDirty = true
    this._shouldUpdateBefore.add(renderable)
    bumpRenderListRevision(this._ctx)

    this.requestRender()

    return insertedIndex
  }

  insertBefore(obj: Renderable | VNode<any, any[]> | unknown, anchor?: Renderable | unknown): number {
    if (!anchor) {
      return this.add(obj)
    }

    if (!obj) {
      return -1
    }

    const renderable = maybeMakeRenderable(this._ctx, obj)
    if (!renderable) {
      return -1
    }

    if (renderable.isDestroyed) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`Renderable with id ${renderable.id} was already destroyed, skipping insertBefore`)
      }
      return -1
    }

    if (!isRenderable(anchor)) {
      throw new Error("Anchor must be a Renderable")
    }

    if (anchor.isDestroyed) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`Anchor with id ${anchor.id} was already destroyed, skipping insertBefore`)
      }
      return -1
    }

    if (!this.renderableMapById.has(anchor.id)) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`Anchor with id ${anchor.id} does not exist within the parent ${this.id}, skipping insertBefore`)
      }
      return -1
    }

    if (renderable === anchor || renderable.id === anchor.id) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`Anchor is the same as the node ${renderable.id} being inserted, skipping insertBefore`)
      }
      return -1
    }

    if (renderable.parent === this) {
      this.yogaNode.removeChild(renderable.getLayoutNode())
      this._childrenInLayoutOrder.splice(this._childrenInLayoutOrder.indexOf(renderable), 1)
    } else {
      this.replaceParent(renderable)
      this.needsZIndexSort = true
      this.renderableMapById.set(renderable.id, renderable)
      this._childrenInZIndexOrder.push(renderable)

      if (typeof renderable.onLifecyclePass === "function") {
        this._ctx.registerLifecyclePass(renderable)
      }

      if (renderable._liveCount > 0) {
        this.propagateLiveCount(renderable._liveCount)
      }
    }

    this.childrenPrimarySortDirty = true

    const anchorIndex = this._childrenInLayoutOrder.indexOf(anchor)
    const insertedIndex = Math.max(0, Math.min(anchorIndex, this._childrenInLayoutOrder.length))

    this._childrenInLayoutOrder.splice(insertedIndex, 0, renderable)
    this.yogaNode.insertChild(renderable.getLayoutNode(), insertedIndex)

    this._shouldUpdateBefore.add(renderable)
    bumpRenderListRevision(this._ctx)

    this.requestRender()

    return insertedIndex
  }

  // TODO: that naming is meh
  public getRenderable(id: string): Renderable | undefined {
    return this.renderableMapById.get(id)
  }

  public remove(id: string): void {
    if (!id) {
      return
    }

    if (this.renderableMapById.has(id)) {
      const obj = this.renderableMapById.get(id)
      if (obj) {
        if (obj._liveCount > 0) {
          this.propagateLiveCount(-obj._liveCount)
        }

        const childLayoutNode = obj.getLayoutNode()
        this.yogaNode.removeChild(childLayoutNode)
        this.requestRender()

        obj.onRemove()
        obj.parent = null
        this._ctx.unregisterLifecyclePass(obj)
        this.renderableMapById.delete(id)

        const index = this._childrenInLayoutOrder.findIndex((obj) => obj.id === id)
        if (index !== -1) {
          this._childrenInLayoutOrder.splice(index, 1)
        }

        const zIndexIndex = this._childrenInZIndexOrder.findIndex((obj) => obj.id === id)
        if (zIndexIndex !== -1) {
          this._childrenInZIndexOrder.splice(zIndexIndex, 1)
        }

        this.childrenPrimarySortDirty = true
        bumpRenderListRevision(this._ctx)
      }
    }
  }

  protected onRemove(): void {
    // Default implementation: do nothing
    // Override this method to provide custom removal logic
  }

  public getChildren(): Renderable[] {
    return [...this._childrenInLayoutOrder]
  }

  public getChildrenCount(): number {
    return this._childrenInLayoutOrder.length
  }

  public updateLayout(deltaTime: number, renderList: RenderCommand[] = []): void {
    if (!this.visible) return

    this.onUpdate(deltaTime)

    // If destroyed during onUpdate, don't add to render list
    if (this._isDestroyed) return

    // NOTE: worst case updateFromLayout is called throughout the whole tree,
    // which currently still has yoga performance issues.
    // This can be mitigated at some point when the layout tree moved to native,
    // as in the native yoga tree we can use events during the calculateLayout phase,
    // and anctually know if a child has changed or not.
    // That would allow us to to generate optimised render commands,
    // including the layout updates, in one pass.
    this.updateFromLayout()

    // Update newly added children before getting visible children
    // This ensures their positions are current when culling happens
    if (this._shouldUpdateBefore.size > 0) {
      for (const child of this._shouldUpdateBefore) {
        if (!child.isDestroyed) {
          child.updateFromLayout()
        }
      }
      this._shouldUpdateBefore.clear()
    }

    // Check again after updateFromLayout, which calls onResize/onSizeChange
    if (this._isDestroyed) return

    // Push opacity BEFORE rendering this element so it affects this element and all children
    const shouldPushOpacity = this._opacity < 1.0
    if (shouldPushOpacity) {
      renderList.push({ action: "pushOpacity", opacity: this._opacity })
    }

    renderList.push({ action: "render", renderable: this })

    this.ensureZIndexSorted()

    const shouldPushScissor = this._overflow !== "visible" && this.width > 0 && this.height > 0
    if (shouldPushScissor) {
      const scissorRect = this.getScissorRect()
      renderList.push({
        action: "pushScissorRect",
        x: scissorRect.x,
        y: scissorRect.y,
        width: scissorRect.width,
        height: scissorRect.height,
        screenX: this._screenX,
        screenY: this._screenY,
      })
    }
    // Most renderables expose all children. Skip building a visible-child list
    // unless a subclass actually performs viewport/style-based child filtering.
    if (!this._hasVisibleChildFilter()) {
      for (const child of this._childrenInZIndexOrder) {
        child.updateLayout(deltaTime, renderList)
      }
    } else {
      // Refresh every child's layout before culling reads their screen
      // coordinates; otherwise culling runs against last frame's positions
      // and drops content that shifted this frame. The per-frame guard in
      // updateFromLayout keeps this at one FFI call per child per frame.
      for (const child of this._childrenInZIndexOrder) {
        if (child.isDestroyed) continue
        child.updateFromLayout()
      }
      const visibleChildren = this._getVisibleChildren()
      const visibleChildSet = new Set(visibleChildren)
      for (const child of this._childrenInZIndexOrder) {
        if (!visibleChildSet.has(child.num)) continue
        child.updateLayout(deltaTime, renderList)
      }
    }

    if (shouldPushScissor) {
      renderList.push({ action: "popScissorRect" })
    }
    if (shouldPushOpacity) {
      renderList.push({ action: "popOpacity" })
    }
  }

  public render(buffer: OptimizedBuffer, deltaTime: number): void {
    let renderBuffer = buffer
    if (this.buffered && this.frameBuffer) {
      renderBuffer = this.frameBuffer
    }

    // Layout and culling are already finalized for this frame. These hooks are
    // only safe for drawing into the buffer; avoid renderable/reactive mutations.
    if (this.renderBefore) {
      this.renderBefore.call(this, renderBuffer, deltaTime)
    }

    this.renderSelf(renderBuffer, deltaTime)

    if (this.renderAfter) {
      this.renderAfter.call(this, renderBuffer, deltaTime)
    }

    // Hooks may move the renderable mid-frame, so sample the cached absolute
    // position after they run before hit-grid writes or framebuffer compositing.
    const screenX = this._screenX
    const screenY = this._screenY

    this.markClean()
    this._ctx.addToHitGrid(screenX, screenY, this.width, this.height, this.num)

    if (this.buffered && this.frameBuffer) {
      buffer.drawFrameBuffer(screenX, screenY, this.frameBuffer)
    }
  }

  protected _hasVisibleChildFilter(): boolean {
    // Presume an override of _getVisibleChildren means this subclass is using
    // the legacy filtering hook, so existing custom renderables keep working.
    return this._getVisibleChildren !== Renderable.prototype._getVisibleChildren
  }

  protected _getVisibleChildren(): number[] {
    return this._childrenInZIndexOrder.map((child) => child.num)
  }

  public canReuseRenderCommandList(): boolean {
    return (
      this.onUpdate === Renderable.prototype.onUpdate &&
      (this._overflow === "visible" || this.getScissorRect === Renderable.prototype.getScissorRect) &&
      !this._hasVisibleChildFilter()
    )
  }

  protected onUpdate(deltaTime: number): void {
    // Default implementation: do nothing
    // Override this method to provide custom rendering
  }

  protected getScissorRect(): {
    x: number
    y: number
    width: number
    height: number
  } {
    return {
      x: this.buffered ? 0 : this._screenX,
      y: this.buffered ? 0 : this._screenY,
      width: this.width,
      height: this.height,
    }
  }

  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    // Default implementation: do nothing
    // Override this method to provide custom rendering
  }

  public get isDestroyed(): boolean {
    return this._isDestroyed
  }

  public destroy(): void {
    if (this._isDestroyed) {
      return
    }

    this._isDestroyed = true
    this.emit(RenderableEvents.DESTROYED)

    if (this.parent) {
      this.parent.remove(this.id)
    }

    if (this.frameBuffer) {
      this.frameBuffer.destroy()
      this.frameBuffer = null
    }

    for (const child of this._childrenInLayoutOrder) {
      this.remove(child.id)
    }

    this._childrenInLayoutOrder = []
    this.renderableMapById.clear()
    Renderable.renderablesByNumber.delete(this.num)

    this.blur()
    this.removeAllListeners()

    this.destroySelf()

    try {
      this.yogaNode.free()
    } catch (e) {
      // Might be already freed and will throw an error if we try to free it again
    }
  }

  public destroyRecursively(): void {
    // Destroy children first to ensure removal as destroy clears child array
    // Make a copy of the children array to avoid iteration issues when children are destroyed
    const children = [...this._childrenInLayoutOrder]
    for (const child of children) {
      child.destroyRecursively()
    }
    this.destroy()
  }

  protected destroySelf(): void {
    // Default implementation: do nothing else
    // Override this method to provide custom cleanup
  }

  public processMouseEvent(event: MouseEvent): void {
    this._mouseListener?.call(this, event)
    this._mouseListeners[event.type]?.call(this, event)
    this.onMouseEvent(event)

    if (this.parent && !event.propagationStopped) {
      this.parent.processMouseEvent(event)
    }
  }

  protected onMouseEvent(event: MouseEvent): void {
    // Default implementation: do nothing
    // Override this method to provide custom event handling
  }

  public set onMouse(handler: ((event: MouseEvent) => void) | undefined) {
    if (handler) this._mouseListener = handler
    else this._mouseListener = null
  }

  public set onMouseDown(handler: ((event: MouseEvent) => void) | undefined) {
    if (handler) this._mouseListeners["down"] = handler
    else delete this._mouseListeners["down"]
  }

  public set onMouseUp(handler: ((event: MouseEvent) => void) | undefined) {
    if (handler) this._mouseListeners["up"] = handler
    else delete this._mouseListeners["up"]
  }

  public set onMouseMove(handler: ((event: MouseEvent) => void) | undefined) {
    if (handler) this._mouseListeners["move"] = handler
    else delete this._mouseListeners["move"]
  }

  public set onMouseDrag(handler: ((event: MouseEvent) => void) | undefined) {
    if (handler) this._mouseListeners["drag"] = handler
    else delete this._mouseListeners["drag"]
  }

  public set onMouseDragEnd(handler: ((event: MouseEvent) => void) | undefined) {
    if (handler) this._mouseListeners["drag-end"] = handler
    else delete this._mouseListeners["drag-end"]
  }

  public set onMouseDrop(handler: ((event: MouseEvent) => void) | undefined) {
    if (handler) this._mouseListeners["drop"] = handler
    else delete this._mouseListeners["drop"]
  }

  public set onMouseOver(handler: ((event: MouseEvent) => void) | undefined) {
    if (handler) this._mouseListeners["over"] = handler
    else delete this._mouseListeners["over"]
  }

  public set onMouseOut(handler: ((event: MouseEvent) => void) | undefined) {
    if (handler) this._mouseListeners["out"] = handler
    else delete this._mouseListeners["out"]
  }

  public set onMouseScroll(handler: ((event: MouseEvent) => void) | undefined) {
    if (handler) this._mouseListeners["scroll"] = handler
    else delete this._mouseListeners["scroll"]
  }

  public set onPaste(handler: ((event: PasteEvent) => void) | undefined) {
    this._pasteListener = handler
  }
  public get onPaste(): ((event: PasteEvent) => void) | undefined {
    return this._pasteListener
  }

  public set onKeyDown(handler: ((key: KeyEvent) => void) | undefined) {
    if (handler) this._keyListeners["down"] = handler
    else delete this._keyListeners["down"]
  }
  public get onKeyDown(): ((key: KeyEvent) => void) | undefined {
    return this._keyListeners["down"]
  }

  public set onSizeChange(handler: (() => void) | undefined) {
    this._sizeChangeListener = handler
  }
  public get onSizeChange(): (() => void) | undefined {
    return this._sizeChangeListener
  }

  private applyEventOptions(options: RenderableOptions<Renderable>): void {
    this.onMouse = options.onMouse
    this.onMouseDown = options.onMouseDown
    this.onMouseUp = options.onMouseUp
    this.onMouseMove = options.onMouseMove
    this.onMouseDrag = options.onMouseDrag
    this.onMouseDragEnd = options.onMouseDragEnd
    this.onMouseDrop = options.onMouseDrop
    this.onMouseOver = options.onMouseOver
    this.onMouseOut = options.onMouseOut
    this.onMouseScroll = options.onMouseScroll
    this.onPaste = options.onPaste
    this.onKeyDown = options.onKeyDown
    this.onSizeChange = options.onSizeChange
  }
}

interface RenderCommandBase {
  action: "render" | "pushScissorRect" | "popScissorRect" | "pushOpacity" | "popOpacity"
}

interface RenderCommandPushScissorRect extends RenderCommandBase {
  action: "pushScissorRect"
  x: number
  y: number
  width: number
  height: number
  screenX: number
  screenY: number
}

interface RenderCommandPopScissorRect extends RenderCommandBase {
  action: "popScissorRect"
}

interface RenderCommandRender extends RenderCommandBase {
  action: "render"
  renderable: Renderable
}

interface RenderCommandPushOpacity extends RenderCommandBase {
  action: "pushOpacity"
  opacity: number
}

interface RenderCommandPopOpacity extends RenderCommandBase {
  action: "popOpacity"
}

export type RenderCommand =
  | RenderCommandPushScissorRect
  | RenderCommandPopScissorRect
  | RenderCommandRender
  | RenderCommandPushOpacity
  | RenderCommandPopOpacity

export class RootRenderable extends Renderable {
  private renderList: RenderCommand[] = []
  private appliedLayoutGeneration: number = -1
  private appliedRenderListRevision: number = -1
  private renderListReusable: boolean = false

  constructor(ctx: RenderContext) {
    super(ctx, {
      id: "__root__",
      zIndex: 0,
      visible: true,
      width: ctx.width,
      height: ctx.height,
      enableLayout: true,
    })

    if (this.yogaNode) {
      this.yogaNode.free()
    }

    this.yogaNode = Yoga.Node.createForOpenTUI()
    this.yogaNode.setWidth(ctx.width)
    this.yogaNode.setHeight(ctx.height)
    this.yogaNode.setFlexDirection(FlexDirection.Column)

    this.calculateLayout()
  }

  public render(buffer: OptimizedBuffer, deltaTime: number): void {
    if (!this.visible) return

    // 0. Run lifecycle pass
    for (const renderable of this._ctx.getLifecyclePasses()) {
      renderable.onLifecyclePass?.call(renderable)
    }

    // NOTE: Strictly speaking, this is a 3-pass rendering process:
    // 1. Calculate layout from root
    // 2. Update layout throughout the tree and collect render list
    // 3. Render all collected renderables
    // Should be 2-pass by hooking into the calculateLayout phase,
    // but that's only possible if we move the layout tree to native.

    // 1. Calculate layout from root
    if (this.yogaNode.isDirty()) {
      this.calculateLayout()
    } else {
      this.syncExternalLayoutGeneration()
    }

    // 2. Update layout throughout the tree and collect render list
    const layoutGeneration = getLayoutGeneration(this._ctx)
    const renderListRevision = getRenderListRevision(this._ctx)
    const canReuseRenderList =
      this.renderListReusable &&
      this.appliedLayoutGeneration === layoutGeneration &&
      this.appliedRenderListRevision === renderListRevision

    if (!canReuseRenderList) {
      this.renderList.length = 0
      super.updateLayout(deltaTime, this.renderList)
      this.appliedLayoutGeneration = layoutGeneration
      this.appliedRenderListRevision = getRenderListRevision(this._ctx)
      this.renderListReusable = this.canReuseCurrentRenderList()
    }

    // 3. Render all collected renderables
    this._ctx.clearHitGridScissorRects()
    for (let i = 1; i < this.renderList.length; i++) {
      const command = this.renderList[i]
      switch (command.action) {
        case "render":
          // Skip if renderable was destroyed during a previous render callback
          if (!command.renderable.isDestroyed) {
            command.renderable.render(buffer, deltaTime)
          }
          break
        case "pushScissorRect":
          buffer.pushScissorRect(command.x, command.y, command.width, command.height)
          this._ctx.pushHitGridScissorRect(command.screenX, command.screenY, command.width, command.height)
          break
        case "popScissorRect":
          buffer.popScissorRect()
          this._ctx.popHitGridScissorRect()
          break
        case "pushOpacity":
          buffer.pushOpacity(command.opacity)
          break
        case "popOpacity":
          buffer.popOpacity()
          break
      }
    }
  }

  protected propagateLiveCount(delta: number): void {
    const oldCount = this._liveCount
    this._liveCount += delta

    if (oldCount === 0 && this._liveCount > 0) {
      this._ctx.requestLive()
    } else if (oldCount > 0 && this._liveCount === 0) {
      this._ctx.dropLive()
    }
  }

  public calculateLayout(): void {
    this.yogaNode.calculateLayout(this.width, this.height, Direction.LTR)
    bumpLayoutGeneration(this._ctx)
    this.yogaNode.markLayoutSeen()
    this.emit(LayoutEvents.LAYOUT_CHANGED)
  }

  private syncExternalLayoutGeneration(): void {
    if (!this.yogaNode.hasNewLayout()) return
    bumpLayoutGeneration(this._ctx)
    this.yogaNode.markLayoutSeen()
  }

  private canReuseCurrentRenderList(): boolean {
    if (this._liveCount > 0) return false

    for (const command of this.renderList) {
      if (command.action !== "render") continue
      if (!command.renderable.canReuseRenderCommandList()) return false
    }

    return true
  }

  public resize(width: number, height: number): void {
    this.width = width
    this.height = height

    this.emit(LayoutEvents.RESIZED, { width, height })
  }
}
