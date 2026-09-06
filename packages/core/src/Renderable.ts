import { EventEmitter } from "events"
import {
  Dimension,
  Display,
  Edge,
  FlexDirection,
  type Node as YogaNode,
  type Layout,
  type MeasureFunction,
} from "./yoga.js"
import { getYogaNode, setYogaNode } from "./lib/renderable-layout.js"
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
import { isVNode, maybeMakeRenderable, type VNode } from "./renderables/composition/vnode.js"
import type { MouseEvent } from "./renderer.js"
import type { RenderContext } from "./types.js"
import { RGBA } from "./lib/RGBA.js"
import type { NativeSceneFrameRequest, NativeSceneLayout, NativeScenePaint } from "./zig.js"
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
const lookupGetter = Reflect.get(Object.prototype, "__lookupGetter__") as (this: object, key: string) => unknown
const nativeSceneMethodNames = [
  "renderSelf",
  "onResize",
  "onLayoutResize",
  "onUpdate",
  "renderBefore",
  "renderAfter",
  "onLifecyclePass",
  "selectable",
] as const

export enum LayoutEvents {
  LAYOUT_CHANGED = "layout-changed",
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
  public abstract remove(child: BaseRenderable): void
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

interface CleanupContext extends RenderContext {
  __otuiActiveCleanupOwners?: Set<Renderable>
}

export abstract class Renderable extends BaseRenderable {
  static renderablesByNumber: Map<number, Renderable> = new Map()

  protected _isDestroyed: boolean = false
  private _cleanupInProgress: boolean = false
  private _childCleanupInProgress: boolean = false
  private _deferredCleanup?: (() => void)[]
  protected _ctx: RenderContext
  protected _translateX: number = 0
  protected _translateY: number = 0
  protected _x: number = 0
  protected _y: number = 0
  // Supported paint hooks use the prepared position, even after same-frame reparenting.
  protected _screenX: number = 0
  protected _screenY: number = 0
  protected _width: number | "auto" | `${number}%`
  protected _height: number | "auto" | `${number}%`
  protected _widthValue: number = 0
  protected _heightValue: number = 0
  protected _zIndex: number
  declare public selectable: boolean
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
  private _nativeSceneHookFlags = 0
  protected _nativeSceneHookGeneration = 0n
  private _nativeSceneHooksRegistered = false
  private _nativeSceneResize = false
  private _nativeSceneResizeCallbacks?: { onResize: unknown; onLayoutResize: unknown }
  private _nativeScenePaintBuffer?: { frameId: bigint; buffer: OptimizedBuffer }
  private _nativeSceneHookLayout?: { revision: number; layout?: NativeSceneLayout }
  private _nativeSceneMethods: Partial<Record<(typeof nativeSceneMethodNames)[number], unknown>> = {
    selectable: false,
    onLifecyclePass: null,
    renderBefore: undefined,
    renderAfter: undefined,
  }
  private _nativeSceneInitialFields = 0
  private _nativeSceneMethodsPending = false
  private _mouseListener: ((event: MouseEvent) => void) | null = null
  private _mouseListeners: Partial<Record<MouseEventType, (event: MouseEvent) => void>> = {}
  private _pasteListener: ((event: PasteEvent) => void) | undefined = undefined
  private _keyListeners: Partial<Record<"down", (key: KeyEvent) => void>> = {}

  protected _positionType: PositionTypeString = "relative"
  protected _overflow: OverflowString = "visible"
  protected _position: Position = {}
  protected _opacity: number = 1.0
  private _flexShrink: number = 1

  protected _childrenInLayoutOrder: Renderable[] = []
  public parent: Renderable | null = null

  declare public onLifecyclePass: (() => void) | null

  declare public renderBefore?: (this: Renderable, buffer: OptimizedBuffer, deltaTime: number) => void
  declare public renderAfter?: (this: Renderable, buffer: OptimizedBuffer, deltaTime: number) => void

  constructor(ctx: RenderContext, options: RenderableOptions<any>) {
    super(options)

    this._ctx = ctx
    Renderable.renderablesByNumber.set(this.num, this)

    let yogaNode: YogaNode | null = null
    try {
      // Replacing data fields with accessors puts the whole wrapper in dictionary storage on V8.
      for (const method of Renderable.nativeSceneMethods) {
        if (method.name in this._nativeSceneMethods) {
          this._nativeSceneInitialFields |= method.mask
          Object.defineProperty(this, method.name, { ...method.descriptor, enumerable: true })
        }
      }
      validateOptions(this.id, options)

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

      yogaNode = ctx.nativeScene.createNode(this, options)
      setYogaNode(this, yogaNode)
      this._nativeSceneResizeCallbacks = { onResize: this.onResize, onLayoutResize: this.onLayoutResize }
      this.renderBefore = options.renderBefore
      this.renderAfter = options.renderAfter
      this.refreshNativeSceneMethods()
      getYogaNode(this).setDisplay(this._visible ? Display.Flex : Display.None)
      this.setupYogaProperties(options)
      // Native create already has default z-index, opacity, and translations.
      // Subclasses publish their real paint; keep this write for non-default values.
      if (this._zIndex !== 0 || this._opacity !== 1 || this._focusable) {
        ctx.nativeScene.setPaint(this, Renderable.prototype.getNativeScenePaint.call(this))
      }

      this.applyEventOptions(options)

      if (this.buffered) {
        this.createFrameBuffer()
      }
      // Derived ECMAScript fields run after super(), including constructors that attach early.
      ctx.nativeScene.scheduleHookScan(this)
    } catch (error) {
      try {
        this.destroyLayoutBacking(undefined, yogaNode)
      } catch {
        // Preserve the first construction failure.
      }
      Renderable.renderablesByNumber.delete(this.num)
      throw error
    }
  }

  protected abortConstruction(error: unknown, cleanup?: (run: (step: () => void) => void) => void): never {
    try {
      this.destroyLayoutBacking((run) => {
        this._isDestroyed = true
        Renderable.renderablesByNumber.delete(this.num)
        if (cleanup) run(() => cleanup(run))
        if (this.frameBuffer) {
          const frameBuffer = this.frameBuffer
          this.frameBuffer = null
          run(() => frameBuffer.destroy())
        }
      })
    } catch {
      // Preserve the construction failure.
    }
    throw error
  }

  /** Completed base layers need full cleanup despite pending errors or uninitialized subclass destroy overrides. */
  protected rollbackConstruction(error: unknown): never {
    try {
      const lib = this._ctx.nativeScene.driver.renderLib
      this.runCleanup((run) => {
        run(() => lib.getYogaHost().throwCallbackError())
        run(() => Renderable.prototype.destroy.call(this))
      })
    } catch {
      // Preserve the construction failure.
    }
    throw error
  }

  protected runCleanup(steps: (run: (step: () => void) => void) => void): void {
    let failure: { error: unknown } | undefined
    const run = (step: () => void) => {
      try {
        step()
      } catch (error) {
        failure ??= { error }
      }
    }
    // A raw worker failure must not replace an earlier cleanup failure.
    try {
      steps(run)
    } catch (error) {
      if (!failure) throw error
    }
    if (failure) throw failure.error
  }

  protected assignOptions(target: Renderable, options: object | undefined): void {
    if (options == null || this._isDestroyed || target._isDestroyed) return
    getYogaNode(this).assertMutable()
    // Preserve Object.assign's getter/setter order, but stop when a callback removes either owner.
    for (const key of Reflect.ownKeys(options)) {
      if (this._isDestroyed || target._isDestroyed) return
      if (!Object.getOwnPropertyDescriptor(options, key)?.enumerable) continue
      if (this._isDestroyed || target._isDestroyed) return
      const value = Reflect.get(options, key)
      if (this._isDestroyed || target._isDestroyed) return
      ;(target as unknown as Record<PropertyKey, unknown>)[key] = value
    }
  }

  public get focusable(): boolean {
    return this._focusable
  }

  public set focusable(value: boolean) {
    if (this._focusable === value) return
    this.setNativeScenePaint({ focusable: value })
    this._focusable = value
    this.runCleanup((run) => {
      if (!value) run(() => this.blur())
      run(() => this.requestRender())
    })
  }

  public get ctx(): RenderContext {
    return this._ctx
  }

  public get visible(): boolean {
    return this._visible
  }

  public get primaryAxis(): "row" | "column" {
    const dir = getYogaNode(this).getFlexDirection()
    return dir === 2 || dir === 3 ? "row" : "column"
  }

  public set visible(value: boolean) {
    if (this._visible === value) return

    getYogaNode(this).runMutation(() => {
      const wasVisible = this._visible
      getYogaNode(this).setDisplay(value ? Display.Flex : Display.None)
      this._visible = value

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
    })
  }

  public get opacity(): number {
    return this._opacity
  }

  public set opacity(value: number) {
    const clamped = Math.max(0, Math.min(1, value))
    if (this._opacity !== clamped) {
      this.setNativeScenePaint({ opacity: clamped })
      this._opacity = clamped
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

    this._ctx.nativeScene.setFocus(this, true)
    this._focused = true
    this.runCleanup((run) => {
      run(() => this._ctx.focusRenderable(this))
      run(() => this.requestRender())
      if (this._isDestroyed || !this._focused || this._ctx.currentFocusedRenderable !== this) return
      // A renderer observer may already have blurred and refocused this node.
      if (this.keypressHandler) return

      this.keypressHandler = (key: KeyEvent) => {
        if (this._isDestroyed || !this._focused || this._ctx.currentFocusedRenderable !== this) return
        this._keyListeners["down"]?.(key)
        // Check again after user listener - it might have destroyed the renderable
        if (this._isDestroyed) return
        if (!key.defaultPrevented && this.handleKeyPress) {
          this.handleKeyPress(key)
        }
      }

      this.pasteHandler = (event: PasteEvent) => {
        if (this._isDestroyed || !this._focused || this._ctx.currentFocusedRenderable !== this) return
        this._pasteListener?.call(this, event)
        // Check again after user listener - it might have destroyed the renderable
        if (this._isDestroyed) return
        if (!event.defaultPrevented && this.handlePaste) {
          this.handlePaste(event)
        }
      }

      this.ctx._internalKeyInput.onInternal("keypress", this.keypressHandler)
      this.ctx._internalKeyInput.onInternal("paste", this.pasteHandler)
      run(() => this.propagateFocusChange(true))
      run(() => this.emit(RenderableEvents.FOCUSED))
    })
  }

  protected propagateFocusChange(hasFocus: boolean): void {
    let parent = this.parent
    while (parent) {
      if (!hasFocus) {
        hasFocus = parent._childrenInLayoutOrder.some(
          (child) => !child._isDestroyed && (child._focused || child._hasFocusedDescendant),
        )
      }
      if (parent._hasFocusedDescendant !== hasFocus) {
        parent._hasFocusedDescendant = hasFocus
        parent.markDirty()
      }
      hasFocus ||= parent._focused
      parent = parent.parent
    }

    this.requestRender()
  }

  public blur(): void {
    if (!this._focused) return

    this._ctx.nativeScene.setFocus(this, false)
    this._focused = false
    const keypress = this.keypressHandler
    const paste = this.pasteHandler
    this.keypressHandler = null
    this.pasteHandler = null
    this.runCleanup((run) => {
      if (keypress) run(() => this.ctx._internalKeyInput.offInternal("keypress", keypress))
      if (paste) run(() => this.ctx._internalKeyInput.offInternal("paste", paste))
      run(() => this.propagateFocusChange(false))
      if (!this._focused) run(() => this._ctx.blurRenderable(this))
      if (!this._focused) run(() => this.emit(RenderableEvents.BLURRED))
    })
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

  protected onLiveCountChanged(previous: number): void {}

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

  /** @internal Native built-ins may suspend lifecycle work without losing their registration position. */
  _needsLifecyclePass(): boolean {
    return this.onLifecyclePass !== null
  }

  public get translateX(): number {
    return this._translateX
  }

  // Translation during a paint hook also moves this node's buffered composition.
  public set translateX(value: number) {
    if (this._translateX === value) return
    this.setNativeScenePaint({ translateX: value })
    this._translateX = value
    this._screenX = this._ctx.nativeScene.getLayout(getYogaNode(this), "paint").screenX
    this.requestRender()
  }

  public get translateY(): number {
    return this._translateY
  }

  public set translateY(value: number) {
    if (this._translateY === value) return
    this.setNativeScenePaint({ translateY: value })
    this._translateY = value
    this._screenY = this._ctx.nativeScene.getLayout(getYogaNode(this), "paint").screenY
    this.requestRender()
  }

  public get screenX(): number {
    return this._isDestroyed ? this._screenX : this.getNativeSceneLayout().screenX
  }

  public get screenY(): number {
    return this._isDestroyed ? this._screenY : this.getNativeSceneLayout().screenY
  }

  public get x(): number {
    if (!this._isDestroyed) return this.getNativeSceneLayout().screenX
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
    if (!this._isDestroyed) return this.getNativeSceneLayout().screenY
    if (this.parent) {
      return this.parent.y + this._y + this._translateY
    }
    return this._y + this._translateY
  }

  public set y(value: number) {
    this.top = value
  }

  public get width(): number {
    if (!this._isDestroyed) {
      const layout = this.getNativeSceneLayout()
      // Native snapshots use zero before layout; completed dimensions are at least one cell.
      return layout.width === 0 ? this._widthValue : layout.width
    }
    return this._widthValue
  }

  public set width(value: number | "auto" | `${number}%`) {
    if (!isDimensionType(value) || this._width === value) {
      return
    }

    this.setDimension(Dimension.Width, value)
  }

  public get height(): number {
    if (!this._isDestroyed) {
      const layout = this.getNativeSceneLayout()
      return layout.height === 0 ? this._heightValue : layout.height
    }
    return this._heightValue
  }

  private getNativeSceneLayout(): NativeSceneLayout {
    const scene = this._ctx.nativeScene
    const cached = this._nativeSceneHookLayout
    const revision = scene.currentGeometryRevision
    if (cached?.layout && cached.revision === revision) return cached.layout
    const layout = scene.getLayout(getYogaNode(this))
    if (cached) {
      cached.revision = revision
      cached.layout = layout
    }
    return layout
  }

  public set height(value: number | "auto" | `${number}%`) {
    if (!isDimensionType(value) || this._height === value) {
      return
    }

    this.setDimension(Dimension.Height, value)
  }

  private setDimension(dimension: Dimension, value: number | "auto" | `${number}%`): void {
    getYogaNode(this).runMutation(() => {
      const key = dimension === Dimension.Width ? "_width" : "_height"
      const disableShrink = typeof value === "number" && this._flexShrink === 1
      getYogaNode(this).setDimension(dimension, value, disableShrink)
      this[key] = value
      if (disableShrink) this._flexShrink = 0
      this.requestRender()
    })
  }

  public get zIndex(): number {
    return this._zIndex
  }

  public set zIndex(value: number | undefined) {
    value = value ?? 0
    if (this._zIndex !== value) {
      this.setNativeScenePaint({ zIndex: value })
      this._zIndex = value
      this.requestRender()
    }
  }

  public getChildrenSortedByPrimaryAxis(): Renderable[] {
    const dir = getYogaNode(this).getFlexDirection()
    const axis = dir === 2 || dir === 3 ? "screenX" : "screenY"
    if (this._childrenInLayoutOrder.length < 2) return [...this._childrenInLayoutOrder]
    // Selection traverses children in screen order, including ancestor translations.
    const children = this._childrenInLayoutOrder.map((child) => ({ child, coordinate: child[axis] }))
    children.sort((a, b) => a.coordinate - b.coordinate)
    return children.map(({ child }) => child)
  }

  private setupYogaProperties(options: RenderableOptions<Renderable>): void {
    const node = getYogaNode(this)

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
      node.setWidth(options.width)
    }
    if (isDimensionType(options.height)) {
      this._height = options.height
      node.setHeight(options.height)
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
      this.requestRender()
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
    const node = getYogaNode(this)

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

    getYogaNode(this).runMutation(() => {
      getYogaNode(this).setPositionType(parsePositionType(positionType))
      this._positionType = positionType
      this.requestRender()
    })
  }

  get overflow(): OverflowString {
    return this._overflow
  }

  set overflow(overflow: OverflowString | null | undefined) {
    if (!isOverflowType(overflow) || this._overflow === overflow) return

    getYogaNode(this).runMutation(() => {
      getYogaNode(this).setOverflow(parseOverflow(overflow))
      this._overflow = overflow
      this.requestRender()
    })
  }

  public setPosition(position: Position): void {
    getYogaNode(this).runMutation(() => {
      this.updateYogaPosition(position)
      this._position = { ...this._position, ...position }
      this.requestRender()
    })
  }

  private updateYogaPosition(position: Position): void {
    const { top, right, bottom, left } = position
    getYogaNode(this).setPositions([
      isPositionType(left) ? left : undefined,
      isPositionType(top) ? top : undefined,
      isPositionType(right) ? right : undefined,
      isPositionType(bottom) ? bottom : undefined,
    ])
  }

  public set flexGrow(grow: number | null | undefined) {
    if (grow == null) {
      getYogaNode(this).setFlexGrow(0)
    } else {
      getYogaNode(this).setFlexGrow(grow)
    }
    this.requestRender()
  }

  public set flexShrink(shrink: number | null | undefined) {
    const value = shrink == null ? 1 : shrink
    getYogaNode(this).runMutation(() => {
      getYogaNode(this).setFlexShrink(value)
      this._flexShrink = value
      this.requestRender()
    })
  }

  public set flexDirection(direction: FlexDirectionString | null | undefined) {
    getYogaNode(this).setFlexDirection(parseFlexDirection(direction))
    this.requestRender()
  }

  public set flexWrap(wrap: WrapString | null | undefined) {
    getYogaNode(this).setFlexWrap(parseWrap(wrap))
    this.requestRender()
  }

  public set alignItems(alignItems: AlignString | null | undefined) {
    getYogaNode(this).setAlignItems(parseAlignItems(alignItems))
    this.requestRender()
  }

  public set justifyContent(justifyContent: JustifyString | null | undefined) {
    getYogaNode(this).setJustifyContent(parseJustify(justifyContent))
    this.requestRender()
  }

  public set alignSelf(alignSelf: AlignString | null | undefined) {
    getYogaNode(this).setAlignSelf(parseAlign(alignSelf))
    this.requestRender()
  }

  public set flexBasis(basis: number | "auto" | null | undefined) {
    if (isFlexBasisType(basis)) {
      getYogaNode(this).setFlexBasis(basis)
      this.requestRender()
    }
  }

  public set minWidth(minWidth: number | `${number}%` | null | undefined) {
    if (isSizeType(minWidth)) {
      getYogaNode(this).setMinWidth(minWidth)
      this.requestRender()
    }
  }

  public set maxWidth(maxWidth: number | `${number}%` | null | undefined) {
    if (isSizeType(maxWidth)) {
      getYogaNode(this).setMaxWidth(maxWidth)
      this.requestRender()
    }
  }

  public set minHeight(minHeight: number | `${number}%` | null | undefined) {
    if (isSizeType(minHeight)) {
      getYogaNode(this).setMinHeight(minHeight)
      this.requestRender()
    }
  }

  public set maxHeight(maxHeight: number | `${number}%` | null | undefined) {
    if (isSizeType(maxHeight)) {
      getYogaNode(this).setMaxHeight(maxHeight)
      this.requestRender()
    }
  }

  public set margin(margin: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(margin)) {
      getYogaNode(this).setMargin(Edge.All, margin)
      this.requestRender()
    }
  }

  public set marginX(marginX: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(marginX)) {
      getYogaNode(this).setMargin(Edge.Horizontal, marginX)
      this.requestRender()
    }
  }

  public set marginY(marginY: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(marginY)) {
      getYogaNode(this).setMargin(Edge.Vertical, marginY)
      this.requestRender()
    }
  }

  public set marginTop(margin: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(margin)) {
      getYogaNode(this).setMargin(Edge.Top, margin)
      this.requestRender()
    }
  }

  public get marginTop(): number | "auto" | `${number}%` {
    const margin = getYogaNode(this).getMargin(Edge.Top) as unknown
    if (typeof margin === "number") return margin
    if (typeof margin === "object" && margin && "value" in margin && typeof margin.value === "number")
      return margin.value
    return 0
  }

  public set marginRight(margin: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(margin)) {
      getYogaNode(this).setMargin(Edge.Right, margin)
      this.requestRender()
    }
  }

  public set marginBottom(margin: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(margin)) {
      getYogaNode(this).setMargin(Edge.Bottom, margin)
      this.requestRender()
    }
  }

  public set marginLeft(margin: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(margin)) {
      getYogaNode(this).setMargin(Edge.Left, margin)
      this.requestRender()
    }
  }

  public set padding(padding: number | `${number}%` | null | undefined) {
    if (isPaddingType(padding)) {
      getYogaNode(this).setPadding(Edge.All, padding)
      this.requestRender()
    }
  }

  public set paddingX(paddingX: number | `${number}%` | null | undefined) {
    if (isPaddingType(paddingX)) {
      getYogaNode(this).setPadding(Edge.Horizontal, paddingX)
      this.requestRender()
    }
  }

  public set paddingY(paddingY: number | `${number}%` | null | undefined) {
    if (isPaddingType(paddingY)) {
      getYogaNode(this).setPadding(Edge.Vertical, paddingY)
      this.requestRender()
    }
  }

  public set paddingTop(padding: number | `${number}%` | null | undefined) {
    if (isPaddingType(padding)) {
      getYogaNode(this).setPadding(Edge.Top, padding)
      this.requestRender()
    }
  }

  public set paddingRight(padding: number | `${number}%` | null | undefined) {
    if (isPaddingType(padding)) {
      getYogaNode(this).setPadding(Edge.Right, padding)
      this.requestRender()
    }
  }

  public set paddingBottom(padding: number | `${number}%` | null | undefined) {
    if (isPaddingType(padding)) {
      getYogaNode(this).setPadding(Edge.Bottom, padding)
      this.requestRender()
    }
  }

  public set paddingLeft(padding: number | `${number}%` | null | undefined) {
    if (isPaddingType(padding)) {
      getYogaNode(this).setPadding(Edge.Left, padding)
      this.requestRender()
    }
  }

  public setMeasureProvider(provider: MeasureFunction | null): void {
    if (this._isDestroyed) throw new Error("Renderable is destroyed")
    const node = getYogaNode(this)
    node.runMutation(() => {
      if (provider === null && node.hasMeasureFunc()) node.markDirty()
      node.setMeasureFunc(provider)
      if (provider) node.markDirty()
      this.requestRender()
    })
  }

  public invalidateIntrinsicSize(): void {
    if (this._isDestroyed) throw new Error("Renderable is destroyed")
    const node = getYogaNode(this)
    node.assertMutable()
    if (node.hasMeasureFunc()) node.markDirty()
  }

  public getLayout(): Readonly<Layout> {
    if (this._isDestroyed) throw new Error("Renderable is destroyed")
    return getYogaNode(this).getComputedLayout()
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

    this.frameBuffer = OptimizedBuffer.create(w, h, this._ctx.widthMethod, {
      respectAlpha: true,
      id: `framebuffer-${this.id}`,
      owner: this._ctx.nativeScene,
    })
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

  private placeChild(child: Renderable, anchor?: Renderable): number {
    return getYogaNode(this).runMutation(() => {
      if (this._ctx.nativeScene !== child._ctx.nativeScene) {
        throw new Error("Cannot move renderables between native scenes")
      }
      if (!child.isDestroyed) this._ctx.nativeScene.refreshPendingHooks(child)
      let previous = child.parent
      if (previous && previous !== this && previous.remove !== Renderable.prototype.remove) {
        // Custom removal owns its policy and cleanup; placement cannot roll back those side effects.
        previous.remove(child)
        previous = child.parent
      }
      if (this._isDestroyed || child.isDestroyed || anchor?.isDestroyed) return -1
      const target: Renderable = this
      const childNode = getYogaNode(child)
      const previousIndex = previous?._childrenInLayoutOrder.indexOf(child) ?? -1
      const anchorIndex = anchor ? target._childrenInLayoutOrder.indexOf(anchor) : target._childrenInLayoutOrder.length
      if (anchorIndex === -1) return -1
      const index = anchorIndex - (previous === target && previousIndex !== -1 && previousIndex < anchorIndex ? 1 : 0)
      let counts: Map<Renderable, { before: number; after: number }> | undefined
      let lifecycle: Map<Set<Renderable>, boolean> | undefined
      let focus: Map<Renderable, boolean> | undefined
      let focusPaths: Renderable[][] | undefined
      if (previous !== target) {
        if (child._focused || child._hasFocusedDescendant) {
          focus = new Map()
          focusPaths = []
          for (const start of [previous, target]) {
            const path: Renderable[] = []
            for (let parent = start; parent; parent = parent.parent) {
              focus.set(parent, parent._hasFocusedDescendant)
              path.push(parent)
            }
            focusPaths.push(path)
          }
        }
        if (child._liveCount > 0) {
          counts = new Map()
          for (const [start, delta] of [
            [previous, -child._liveCount],
            [target, child._liveCount],
          ] as const) {
            for (let parent = start; parent; parent = parent.parent) {
              const count = counts.get(parent) ?? { before: parent._liveCount, after: parent._liveCount }
              count.after += delta
              counts.set(parent, count)
            }
          }
        }
        if (previous) {
          const passes = previous._ctx.getLifecyclePasses()
          lifecycle = new Map([[passes, false]])
        }
        if (typeof child.onLifecyclePass === "function") {
          const passes = target._ctx.getLifecyclePasses()
          lifecycle ??= new Map()
          lifecycle.set(passes, true)
        }
      }
      this._ctx.nativeScene.moveNode(childNode, getYogaNode(this), index)
      if (previous && previousIndex !== -1) previous._childrenInLayoutOrder.splice(previousIndex, 1)
      target._childrenInLayoutOrder.splice(index, 0, child)
      child.parent = target
      if (counts) for (const [parent, count] of counts) parent._liveCount = count.after
      if (focusPaths)
        for (const path of focusPaths) {
          for (const parent of path) {
            parent._hasFocusedDescendant = parent._childrenInLayoutOrder.some(
              (node) => node._focused || node._hasFocusedDescendant,
            )
          }
        }
      if (lifecycle)
        for (const [passes, active] of lifecycle) {
          if (active) passes.add(child)
          else passes.delete(child)
        }
      this.runCleanup((run) => {
        if (focus)
          for (const [parent, focused] of focus) {
            if (parent._hasFocusedDescendant !== focused) parent.markDirty()
          }
        if (counts) for (const [parent, count] of counts) run(() => parent.onLiveCountChanged(count.before))
        if (previous && previous !== target) run(() => child.onRemove())
        if (previous && previous !== target) run(() => previous.requestRender())
        run(() => target.requestRender())
      })
      return index
    })
  }

  public add(obj: Renderable | VNode<any, any[]> | unknown, index?: number): number {
    if (!obj) {
      return -1
    }
    if (isVNode(obj)) getYogaNode(this).assertMutable()

    const renderable = maybeMakeRenderable(this._ctx, obj)
    if (!renderable) {
      return -1
    }

    if (this._isDestroyed) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`Renderable with id ${this.id} was already destroyed, skipping add`)
      }
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

    return this.placeChild(renderable)
  }

  insertBefore(obj: Renderable | VNode<any, any[]> | unknown, anchor?: Renderable | unknown): number {
    if (!anchor) {
      return this.add(obj)
    }

    if (!obj) {
      return -1
    }
    if (isVNode(obj)) getYogaNode(this).assertMutable()

    const renderable = maybeMakeRenderable(this._ctx, obj)
    if (!renderable) {
      return -1
    }

    if (this._isDestroyed) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`Renderable with id ${this.id} was already destroyed, skipping insertBefore`)
      }
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

    if (this._childrenInLayoutOrder.indexOf(anchor) === -1) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`Anchor with id ${anchor.id} does not exist within the parent ${this.id}, skipping insertBefore`)
      }
      return -1
    }

    if (renderable === anchor) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`Anchor is the same as the node ${renderable.id} being inserted, skipping insertBefore`)
      }
      return -1
    }

    return this.placeChild(renderable, anchor)
  }

  // TODO: that naming is meh
  public getRenderable(id: string): Renderable | undefined {
    return this._childrenInLayoutOrder.find((child) => child.id === id)
  }

  public remove(child: BaseRenderable): void {
    if (!(child instanceof BaseRenderable)) {
      throw new Error("remove expects a renderable child object")
    }

    // Membership in _childrenInLayoutOrder proves child is a Renderable with a
    // layout node; anything else (text nodes, children of other parents,
    // already-detached renderables) is a caller bug worth surfacing in dev.
    const index = this._childrenInLayoutOrder.indexOf(child as Renderable)
    if (index === -1) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`Renderable with id ${child.id} is not a child of ${this.id}, skipping remove`)
      }
      return
    }

    const renderable = this._childrenInLayoutOrder[index]
    getYogaNode(this).runMutation(() => {
      this._ctx.nativeScene.moveNode(getYogaNode(renderable), null, 0)
      this._childrenInLayoutOrder.splice(index, 1)
      this.runCleanup((run) => {
        if (renderable._focused || renderable._hasFocusedDescendant) {
          run(() => renderable.propagateFocusChange(false))
        }
        if (renderable._liveCount > 0) run(() => this.propagateLiveCount(-renderable._liveCount))
        run(() => this.requestRender())
        run(() => renderable.onRemove())
        renderable.parent = null
        run(() => this._ctx.unregisterLifecyclePass(renderable))
      })
    })
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

  protected onUpdate(deltaTime: number): void {
    // Default implementation: do nothing
    // Override this method to provide custom rendering
  }

  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    // Default implementation: do nothing
    // Override this method to provide custom rendering
  }

  protected getNativeScenePaint(): NativeScenePaint {
    return {
      zIndex: this._zIndex,
      opacity: this._opacity,
      translateX: this._translateX,
      translateY: this._translateY,
      border: 0,
      shouldFill: false,
      backgroundColor: RGBA.fromValues(0, 0, 0, 0),
      borderColor: RGBA.fromValues(1, 1, 1, 1),
      focusable: this._focusable,
      focusedBorderColor: RGBA.fromValues(0, 170 / 255, 1, 1),
      borderStyle: "single",
    }
  }

  protected setNativeScenePaint(paint: Partial<NativeScenePaint> = {}): void {
    this._ctx.nativeScene.setPaint(this, { ...this.getNativeScenePaint(), ...paint })
  }

  // Share accessor functions across nodes; retain handler identity per node.
  private static nativeSceneMethods = nativeSceneMethodNames.map((name, index) => {
    const mask = 1 << index
    const normalize = (value: unknown) => {
      if (name === "selectable") return value
      if (name === "onLifecyclePass") value ??= null
      else if (name === "renderBefore" || name === "renderAfter") value ??= undefined
      else if (name === "onUpdate") value ??= Renderable.prototype.onUpdate
      if (
        typeof value !== "function" &&
        !((name === "renderBefore" || name === "renderAfter" || name === "onLifecyclePass") && value == null)
      )
        throw new TypeError(`Invalid ${name} hook`)
      return value
    }
    return {
      name,
      mask,
      normalize,
      descriptor: {
        configurable: true,
        get(this: Renderable) {
          return this._nativeSceneMethods[name]
        },
        set(this: Renderable, value: unknown) {
          // Unscanned constructor fields still behave like the original data properties.
          if ((this._nativeSceneInitialFields & mask) !== 0 && !this._isDestroyed) {
            this._nativeSceneMethods[name] = value
            return
          }
          if (name === "selectable") {
            getYogaNode(this).assertMutable()
            this._nativeSceneMethods[name] = value
            return
          }
          value = normalize(value)
          if (value === this._nativeSceneMethods[name]) return
          this.setNativeSceneHooks(this._nativeSceneHookFlags, { [name]: value })
          this._nativeSceneMethods[name] = value
          if (name === "onLifecyclePass") {
            if (!value) this._ctx.unregisterLifecyclePass(this)
            else if (this.parent) this._ctx.registerLifecyclePass(this)
            else this._ctx.nativeScene.lifecyclePasses.refresh(this)
          }
        },
      },
    }
  })

  /** Snapshot reflective hook replacements and restore normal callback assignment.
   * Call after defineProperty/delete, or to finalize fields after early constructor attachment.
   * Ordinary paint and style changes do not discover hooks. */
  public refreshHooks(): void {
    if (this._isDestroyed) return
    getYogaNode(this).assertMutable()
    try {
      this._scanNativeSceneHooks()
    } catch (error) {
      this._ctx.nativeScene.scheduleHookScan(this)
      throw error
    }
    this.requestRender()
  }

  /** @internal Snapshot hooks for construction, explicit refresh, or retry. */
  _scanNativeSceneHooks(): void {
    if (!this._isDestroyed) this.refreshNativeSceneMethods()
  }

  private refreshNativeSceneMethods(): void {
    this._ctx.nativeScene.refreshSurface(this)
    const methods = Renderable.nativeSceneMethods
    for (let index = 0; index < methods.length; index++) {
      const method = methods[index]
      const name = method.name
      const installed = name in this._nativeSceneMethods && lookupGetter.call(this, name) === method.descriptor.get
      if (installed && (this._nativeSceneInitialFields & method.mask) === 0) continue
      const handler = method.normalize(this[name])
      if (!installed) Object.defineProperty(this, name, method.descriptor)
      this._nativeSceneMethods[name] = handler
      this._nativeSceneInitialFields &= ~method.mask
      this._nativeSceneMethodsPending = true
    }
    if (this._nativeSceneMethodsPending) {
      this.setNativeSceneHooks(this._nativeSceneHookFlags, {
        onResize: this.onResize,
        onLayoutResize: this.onLayoutResize,
      })
      if (!this.onLifecyclePass) this._ctx.unregisterLifecyclePass(this)
      else if (this.parent) this._ctx.registerLifecyclePass(this)
      else this._ctx.nativeScene.lifecyclePasses.refresh(this)
      // A failed prerequisite flush must not make installed descriptors look fully published.
      this._nativeSceneMethodsPending = false
    }
  }

  protected refreshNativeSceneHooks(): void {
    this.setNativeSceneHooks(this._nativeSceneHookFlags)
  }

  private setNativeSceneHooks(
    flags: number,
    overrides: Partial<
      Record<
        "renderSelf" | "onResize" | "onLayoutResize" | "onUpdate" | "renderBefore" | "renderAfter" | "onLifecyclePass",
        unknown
      >
    > = {},
    lineInfo?: boolean,
  ): void {
    const scene = this._ctx.nativeScene
    const previousFlags = this._nativeSceneHookFlags
    const previousGeneration = this._nativeSceneHookGeneration
    const method = (name: keyof typeof overrides) => (name in overrides ? overrides[name] : this[name])
    const onUpdate = method("onUpdate")
    flags = (flags & ~57) | (method("renderBefore") ? 8 : 0) | (method("renderAfter") ? 16 : 0)
    const renderSelf = method("renderSelf")
    if (!scene.usesNativeDrawing(this, renderSelf)) flags |= 32
    // A caller getter can accept another hook mutation while these options are read.
    const overridden =
      ("onUpdate" in overrides ? 65 : 0) |
      ("onResize" in overrides || "onLayoutResize" in overrides ? 2 : 0) |
      ("renderBefore" in overrides ? 8 : 0) |
      ("renderAfter" in overrides ? 16 : 0) |
      ("renderSelf" in overrides ? 32 : 0)
    const changed = (previousFlags ^ this._nativeSceneHookFlags) & ~overridden
    flags = (flags & ~changed) | (this._nativeSceneHookFlags & changed)
    const resizeCallbacks = {
      onResize: "onResize" in overrides ? overrides.onResize : this._nativeSceneResizeCallbacks!.onResize,
      onLayoutResize:
        "onLayoutResize" in overrides ? overrides.onLayoutResize : this._nativeSceneResizeCallbacks!.onLayoutResize,
    }
    const resize =
      this.buffered ||
      resizeCallbacks.onLayoutResize !== Renderable.prototype.onLayoutResize ||
      (resizeCallbacks.onResize !== Renderable.prototype.onResize &&
        !scene.usesNativeResize(this, resizeCallbacks.onResize))
    if (this._nativeSceneResize !== resize)
      flags = (flags & ~2) | (this._sizeChangeListener || this.listenerCount("resize") ? 2 : 0)
    if (resize) flags |= 2
    lineInfo ??= scene.usesNativeLineInfoEvents(this) && this.listenerCount("line-info-change") > 0
    // Getters can change activity or accept a new implicit hook with the same flags.
    const update =
      "onUpdate" in overrides || previousGeneration === this._nativeSceneHookGeneration
        ? scene.hostUpdateFlags(this, onUpdate)
        : this._nativeSceneHookFlags & 65
    flags = (flags & ~65) | update
    const generation = this._nativeSceneHookGeneration + 1n
    if (flags !== 0 || lineInfo || this._nativeSceneHooksRegistered) {
      scene.setHooks(this, flags, generation, this._widthValue, this._heightValue, resize, renderSelf, lineInfo)
      this._nativeSceneHooksRegistered = true
    }
    this._nativeSceneResizeCallbacks = resizeCallbacks
    this._nativeSceneResize = resize
    this._nativeSceneHookFlags = flags
    this._nativeSceneHookGeneration = generation
  }

  /** @internal Refresh only requested host hooks, never walk wrappers to collect layout. */
  _runNativeSceneHook(request: NativeSceneFrameRequest, deltaTime: number, buffer: OptimizedBuffer): void {
    if (
      (this._isDestroyed && request.kind !== 5 && request.kind !== 7) ||
      request.hookGeneration !== this._nativeSceneHookGeneration
    )
      return
    const previousLayout = this._nativeSceneHookLayout
    const revision = this._ctx.nativeScene.currentGeometryRevision
    const currentGeometry = request.geometryRevision === revision
    this._nativeSceneHookLayout = { revision, layout: currentGeometry ? request.publicLayout : undefined }
    try {
      if (
        !this._isDestroyed &&
        (request.kind === 4 ||
          request.kind === 5 ||
          request.kind === 7 ||
          (request.kind === 2 && this._nativeSceneResize))
      ) {
        const layout =
          (currentGeometry && request.paintLayout) || this._ctx.nativeScene.getLayout(getYogaNode(this), "paint")
        this._x = layout.left
        this._y = layout.top
        this._screenX = layout.screenX
        this._screenY = layout.screenY
        this._widthValue = Math.max(1, layout.width)
        this._heightValue = Math.max(1, layout.height)
      }
      // Text/editor bodies draw into the supplied destination before native composition.
      let renderBuffer =
        !this._ctx.nativeScene.skipsPaintHooks(this) && this.buffered && this.frameBuffer ? this.frameBuffer : buffer
      if (request.kind === 4 || request.kind === 5 || request.kind === 7) {
        if (this._nativeScenePaintBuffer?.frameId !== request.frameId) {
          this._nativeScenePaintBuffer = { frameId: request.frameId, buffer: renderBuffer }
        }
        renderBuffer = this._nativeScenePaintBuffer.buffer
        try {
          return renderBuffer._withNativePaint(() => this.runNativeSceneHook(request, deltaTime, buffer, renderBuffer))
        } catch (error) {
          this._nativeScenePaintBuffer = undefined
          throw error
        } finally {
          if (request.kind === 5) this._nativeScenePaintBuffer = undefined
        }
      }
      this.runNativeSceneHook(request, deltaTime, buffer, renderBuffer)
    } finally {
      this._nativeSceneHookLayout = previousLayout
    }
  }

  private runNativeSceneHook(
    request: NativeSceneFrameRequest,
    deltaTime: number,
    buffer: OptimizedBuffer,
    renderBuffer: OptimizedBuffer,
  ): void {
    switch (request.kind) {
      case 1:
        this.onUpdate(deltaTime)
        break
      case 2:
        if (this._nativeSceneResize) this.onLayoutResize(request.width, request.height)
        else {
          if (!this._ctx.nativeScene.skipsPaintHooks(this)) {
            this.onSizeChange?.call(this)
            if (!this._isDestroyed) this.emit("resize")
          }
          if (!this._isDestroyed && this._ctx.nativeScene.usesNativeLineInfoEvents(this)) this.emit("line-info-change")
        }
        break
      case 3:
        this.emit(LayoutEvents.LAYOUT_CHANGED)
        break
      case 4:
        this.renderBefore?.call(this, renderBuffer, deltaTime)
        break
      case 5:
        if (!this._ctx.nativeScene.skipsPaintHooks(this)) {
          this.renderAfter?.call(this, renderBuffer, deltaTime)
          this.markClean()
        }
        if (!this._ctx.nativeScene.composesBuffer(this) && this.buffered && this.frameBuffer)
          buffer.drawFrameBuffer(Math.trunc(this._screenX), Math.trunc(this._screenY), this.frameBuffer)
        break
      case 7:
        if (this._ctx.nativeScene.skipsPaintHooks(this)) this.markClean()
        this._invokeNativePaint(renderBuffer, deltaTime)
        break
    }
  }

  protected _invokeNativePaint(buffer: OptimizedBuffer, deltaTime: number): void {
    this.renderSelf(buffer, deltaTime)
  }

  public get isDestroyed(): boolean {
    return this._isDestroyed
  }

  public destroy(): void {
    if (this._isDestroyed || this._cleanupInProgress || this._childCleanupInProgress) {
      return
    }

    getYogaNode(this).assertMutable()
    this._ctx.nativeScene.driver.renderLib.getYogaHost().throwCallbackError()
    this.destroyLayoutBacking((run) => {
      run(() => this.destroyOwnedResources())
      this._isDestroyed = true
      run(() => this.emit(RenderableEvents.DESTROYED))

      if (this._focused || this._hasFocusedDescendant) {
        run(() => {
          // Listeners can move focus, or clear it before throwing during blur.
          const current = this._ctx.currentFocusedRenderable
          let focused = current
          while (focused && focused !== this) focused = focused.parent
          if (!current || focused === this) this.propagateFocusChange(false)
        })
      }
      if (this.parent) {
        const parent = this.parent
        run(() => parent.remove(this))
        if (this.parent === parent) {
          run(() => this.detachFromParent())
        }
      }

      if (this.frameBuffer) {
        const frameBuffer = this.frameBuffer
        this.frameBuffer = null
        run(() => frameBuffer.destroy())
      }

      for (const child of [...this._childrenInLayoutOrder]) {
        run(() => this.remove(child))
      }

      this._childrenInLayoutOrder = []
      Renderable.renderablesByNumber.delete(this.num)

      run(() => this.blur())
      run(() => this.removeAllListeners())
      run(() => this.destroySelf())
    })
  }

  public destroyRecursively(): void {
    if (this._isDestroyed || this._cleanupInProgress || this._childCleanupInProgress) return
    getYogaNode(this).assertMutable()
    // Destroy children first to ensure removal as destroy clears child array
    // Make a copy of the children array to avoid iteration issues when children are destroyed
    const children = [...this._childrenInLayoutOrder]
    let index = 0
    this._childCleanupInProgress = true
    const cleanupOwners = ((this._ctx as CleanupContext).__otuiActiveCleanupOwners ??= new Set<Renderable>())
    const ownsCompletion = !cleanupOwners.has(this)
    cleanupOwners.add(this)
    const resume = () =>
      this.runCleanup((run) => {
        while (index < children.length) {
          const child = children[index++]
          run(() => child.destroyRecursively())
          if (child._cleanupInProgress || child._childCleanupInProgress) {
            // Resume this snapshot after the active child's native release.
            ;(child._deferredCleanup ??= []).push(resume)
            return
          }
        }
        this._childCleanupInProgress = false
        // Keep the walk's completion ownership through subclass work after super.destroy().
        run(() => this.destroy())
        if (ownsCompletion) this.completeCleanup(run)
      })
    resume()
  }

  /** @internal Defer renderer finalization until active cleanup in its context completes. */
  _deferUntilCleanupComplete(resume: () => void): boolean {
    const pending: Renderable[] = [this]
    while (pending.length > 0) {
      const node = pending.pop()!
      if (node._cleanupInProgress || node._childCleanupInProgress) {
        ;(node._deferredCleanup ??= []).push(resume)
        return true
      }
      for (const child of node._childrenInLayoutOrder) pending.push(child)
    }
    // Cleanup can continue after its owner leaves the layout tree.
    for (const node of (this._ctx as CleanupContext).__otuiActiveCleanupOwners ?? []) {
      ;(node._deferredCleanup ??= []).push(resume)
      return true
    }
    return false
  }

  protected destroyOwnedResources(): void {}

  protected destroySelf(): void {
    // Default implementation: do nothing else
    // Override this method to provide custom cleanup
  }

  private destroyLayoutBacking(
    cleanup?: (run: (step: () => void) => void) => void,
    yogaNode: YogaNode | null = getYogaNode(this),
  ): void {
    const scene = this._ctx.nativeScene
    this._cleanupInProgress = true
    const cleanupOwners = ((this._ctx as CleanupContext).__otuiActiveCleanupOwners ??= new Set<Renderable>())
    const ownsCompletion = !cleanupOwners.has(this)
    cleanupOwners.add(this)
    this.runCleanup((run) => {
      // Constructor rollback must release ownership even when a previous callback failed.
      run(() => scene.driver.renderLib.getYogaHost().throwCallbackError())
      if (yogaNode) {
        run(() => {
          // Selection anchors retain local coordinates after detachment and release.
          const layout = scene.getLayout(yogaNode)
          this._x = layout.left
          this._y = layout.top
        })
      }
      if (cleanup) run(() => cleanup(run))
      this._isDestroyed = true
      if (yogaNode) run(() => scene.destroyNode(this, yogaNode))
      this._cleanupInProgress = false
      if (ownsCompletion) this.completeCleanup(run)
    })
  }

  private completeCleanup(run: (step: () => void) => void): void {
    ;(this._ctx as CleanupContext).__otuiActiveCleanupOwners!.delete(this)
    const deferred = this._deferredCleanup
    this._deferredCleanup = undefined
    if (deferred) for (const resume of deferred) run(resume)
  }

  private detachFromParent(): void {
    const parent = this.parent
    if (!parent) return

    const layoutIndex = parent._childrenInLayoutOrder.indexOf(this)
    if (layoutIndex !== -1) {
      this._ctx.nativeScene.moveNode(getYogaNode(this), null, 0)
      parent._childrenInLayoutOrder.splice(layoutIndex, 1)
      if (this._liveCount > 0) {
        parent.propagateLiveCount(-this._liveCount)
      }
    }

    parent._ctx.unregisterLifecyclePass(this)
    this.parent = null
  }

  public processMouseEvent(event: MouseEvent): void {
    ;(event as { currentTarget: Renderable | null }).currentTarget = this
    this._mouseListener?.call(this, event)
    if (this._isDestroyed) return
    this._mouseListeners[event.type]?.call(this, event)
    if (this._isDestroyed) return
    this.onMouseEvent(event)

    if (this.parent && !event.propagationStopped) {
      this.parent.processMouseEvent(event)
    }
  }

  private assertSupportedEvent(event: string | symbol): void {
    if (
      (event === LayoutEvents.RESIZED || event === LayoutEvents.LAYOUT_CHANGED) &&
      !(this instanceof RootRenderable)
    ) {
      throw new Error(`Native scene does not support ${event} hooks`)
    }
  }

  public on(event: string | symbol, listener: (...args: any[]) => void): this {
    return this.changeSceneListeners("add", event, listener)
  }

  public addListener(event: string | symbol, listener: (...args: any[]) => void): this {
    return this.changeSceneListeners("add", event, listener)
  }

  public prependListener(event: string | symbol, listener: (...args: any[]) => void): this {
    return this.changeSceneListeners("prepend", event, listener)
  }

  public off(event: string | symbol, listener: (...args: any[]) => void): this {
    return this.changeSceneListeners("remove", event, listener)
  }

  public removeListener(event: string | symbol, listener: (...args: any[]) => void): this {
    return this.changeSceneListeners("remove", event, listener)
  }

  public removeAllListeners(event?: string | symbol): this {
    if (arguments.length > 0 && event === undefined) return super.removeAllListeners(event)
    return this.changeSceneListeners("clear", event)
  }

  private changeSceneListeners(
    operation: "add" | "prepend" | "remove" | "clear",
    event?: string | symbol,
    listener?: (...args: any[]) => void,
  ): this {
    if (operation === "add" || operation === "prepend") this.assertSupportedEvent(event!)
    const change = () => {
      switch (operation) {
        case "add":
          return super.addListener(event!, listener!)
        case "prepend":
          return super.prependListener(event!, listener!)
        case "remove":
          return super.removeListener(event!, listener!)
        case "clear":
          return event === undefined ? super.removeAllListeners() : super.removeAllListeners(event)
      }
    }
    if (
      this._isDestroyed ||
      (event === "line-info-change" && !this._ctx.nativeScene.usesNativeLineInfoEvents(this)) ||
      ((operation !== "clear" || event !== undefined) &&
        event !== "resize" &&
        event !== "line-info-change" &&
        event !== LayoutEvents.LAYOUT_CHANGED) ||
      (operation !== "clear" && typeof listener !== "function")
    ) {
      return change()
    }
    let resize = this.listenerCount("resize")
    const initialLineInfo = this._ctx.nativeScene.usesNativeLineInfoEvents(this)
      ? this.listenerCount("line-info-change")
      : 0
    let lineInfo = initialLineInfo
    let layout = this.listenerCount(LayoutEvents.LAYOUT_CHANGED)
    if (operation === "clear") {
      if (event === undefined || event === "resize") resize = 0
      if (event === undefined || event === "line-info-change") lineInfo = 0
      if (event === undefined || event === LayoutEvents.LAYOUT_CHANGED) layout = 0
      const changed =
        resize !== this.listenerCount("resize") ||
        lineInfo !== initialLineInfo ||
        layout !== this.listenerCount(LayoutEvents.LAYOUT_CHANGED)
      if (!changed) return change()
    } else {
      if (
        operation === "remove" &&
        !this.rawListeners(event!).some(
          (entry) => entry === listener || (entry as { listener?: typeof listener }).listener === listener,
        )
      ) {
        return change()
      }
      const delta = operation === "remove" ? -1 : 1
      if (event === "resize") resize += delta
      else if (event === "line-info-change") lineInfo += delta
      else layout += delta
    }
    this.setNativeSceneHooks(
      (this._nativeSceneHookFlags & ~6) | (resize > 0 || this._sizeChangeListener ? 2 : 0) | (layout > 0 ? 4 : 0),
      {},
      lineInfo > 0,
    )
    this.runCleanup((run) => {
      run(change)
      // Meta-listeners can mutate subscriptions or throw. Keep their accepted changes rather than rolling them back.
      run(() => {
        if (!this._isDestroyed) {
          const flags =
            (this._nativeSceneHookFlags & ~6) |
            (this.listenerCount("resize") > 0 || this._sizeChangeListener ? 2 : 0) |
            (this.listenerCount(LayoutEvents.LAYOUT_CHANGED) > 0 ? 4 : 0)
          this.setNativeSceneHooks(flags)
        }
      })
    })
    return this
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
    if (handler !== this._sizeChangeListener) {
      if (handler != null && typeof handler !== "function") throw new TypeError("Invalid size change hook")
      const flags = this._nativeSceneHookFlags & ~2
      this.setNativeSceneHooks(flags | (handler || this.listenerCount("resize") > 0 ? 2 : 0))
    }
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

export class RootRenderable extends Renderable {
  private _currentRenderable: Renderable | undefined

  constructor(ctx: RenderContext) {
    super(ctx, {
      id: "__root__",
      zIndex: 0,
      visible: true,
      width: ctx.width,
      height: ctx.height,
      enableLayout: true,
    })

    try {
      getYogaNode(this).setFlexDirection(FlexDirection.Column)
      this.setNativeScenePaint()
    } catch (error) {
      this.abortConstruction(error)
    }
  }

  public get currentRenderable(): Renderable | undefined {
    return this._currentRenderable
  }

  /** @internal Clear after successful dispatch; error handling consumes the failing node. */
  _setCurrentRenderable(renderable: Renderable | undefined): void {
    this._currentRenderable = renderable
  }

  public takeCurrentRenderable(): Renderable | undefined {
    const renderable = this._currentRenderable
    this._currentRenderable = undefined
    return renderable
  }

  protected propagateLiveCount(delta: number): void {
    const oldCount = this._liveCount
    this._liveCount += delta
    this.onLiveCountChanged(oldCount)
  }

  protected onLiveCountChanged(previous: number): void {
    if (previous === 0 && this._liveCount > 0) {
      this._ctx.requestLive()
    } else if (previous > 0 && this._liveCount === 0) {
      this._ctx.dropLive()
    }
  }

  public resize(width: number, height: number): void {
    this.width = width
    this.height = height

    // Accepted-size notification is synchronous, separate from completed Yoga layout.
    this.emit(LayoutEvents.RESIZED, { width, height })
  }
}
