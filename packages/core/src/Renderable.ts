import { EventEmitter } from "events"
import {
  Dimension,
  Display,
  Edge,
  FlexDirection,
  Gutter,
  PositionType,
  Unit,
  YogaEnumKind,
  YogaFloatKind,
  YogaValueKind,
  parseYogaValue,
  sceneGetEnum,
  sceneGetFloat,
  sceneGetValue,
  sceneSetDimension,
  sceneSetEnum,
  sceneSetFloat,
  sceneSetValue,
  type Layout,
  type MeasureFunction,
  type Value,
} from "./yoga.js"
import type { NativeScene } from "./NativeScene.js"
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
import { nativeConstants } from "./native-abi.generated.js"
import {
  isNativeScenePaintFrame,
  NATIVE_EDGE_NONE,
  NativeBorder,
  NativeSceneFrame,
  NativeSceneHook,
  type NativeSceneFrameRequest,
  type NativeSceneLayout,
  type NativeScenePaint,
  type SceneNodeHandle,
} from "./zig.js"
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
const nativeSceneMethodDefaults: Partial<Record<(typeof nativeSceneMethodNames)[number], unknown>> = {
  selectable: false,
  onLifecyclePass: null,
  renderBefore: undefined,
  renderAfter: undefined,
}
const nativeSceneHookUpdates = nativeConstants.OT_SCENE_HOOK_UPDATE | nativeConstants.OT_SCENE_HOOK_IDLE_UPDATE
const nativeSceneHookListeners = nativeConstants.OT_SCENE_HOOK_RESIZE | nativeConstants.OT_SCENE_HOOK_LAYOUT_CHANGED
const nativeSceneHookBeforeAfter =
  nativeConstants.OT_SCENE_HOOK_RENDER_BEFORE | nativeConstants.OT_SCENE_HOOK_RENDER_AFTER
const nativeSceneHookHostMethods =
  nativeConstants.OT_SCENE_HOOK_UPDATE | nativeSceneHookBeforeAfter | nativeConstants.OT_SCENE_HOOK_RENDER_SELF

function isRowFlexDirection(direction: FlexDirection): boolean {
  return direction === FlexDirection.Row || direction === FlexDirection.RowReverse
}

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

/** Class-owned native integration, declared with defineNativeIntegration(). Method identities
 * identify work performed by native; overrides use the ordinary host hook dispatcher. */
export interface NativeRenderableIntegration {
  readonly kind: Parameters<NativeScene["driver"]["renderLib"]["sceneCreateNode"]>[2]
  readonly body:
    | "host"
    | { readonly native: (buffer: OptimizedBuffer, deltaTime: number) => void; readonly buffered?: boolean }
    | { readonly textController: (buffer: OptimizedBuffer, deltaTime: number) => void }
  readonly lifecycle?: {
    readonly resize?: "host" | { readonly native: (width: number, height: number) => void }
    readonly update?:
      | "host"
      | {
          readonly idle: (deltaTime: number) => void
          readonly active: (renderable: Renderable) => boolean
        }
  }
  readonly beforeAfter?: boolean
  readonly paintBuffer?: "destination"
  readonly bufferComposition?: "native"
  readonly lineInfo?: boolean
  readonly measure?: (this: Renderable, ...constraints: Parameters<MeasureFunction>) => ReturnType<MeasureFunction>
  /** Only an own description can promise that construction adds no hook class fields. */
  readonly construction?: "prototype" | "fields"
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
  static readonly nativeIntegration: NativeRenderableIntegration = {
    kind: "custom",
    body: { native: this.prototype.renderSelf },
  }

  /** @internal Stable class description shared by creation, hook registration, and dispatch. */
  readonly nativeIntegration: NativeRenderableIntegration

  protected _isDestroyed: boolean = false
  private _cleanupInProgress: boolean = false
  private _childCleanupInProgress: boolean = false
  private _deferredCleanup?: (() => void)[]
  protected _ctx: RenderContext
  /** @internal Scene-backed Yoga handle stored on the wrapper; there is no JS Yoga Node. */
  _sceneHandle?: SceneNodeHandle
  private _yogaFreed = false
  protected _translateX: number = 0
  protected _translateY: number = 0
  protected _width: number | "auto" | `${number}%`
  protected _height: number | "auto" | `${number}%`
  private _destroyedLayout?: {
    x: number
    y: number
    screenX: number
    screenY: number
    width: number
    height: number
  }
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
  private _nativeSceneHookLayout?: {
    revision: number
    layout?: NativeSceneLayout
    paintRevision?: number
    paintLayout?: NativeSceneLayout
  }
  private _nativeSceneMethods?: Partial<Record<(typeof nativeSceneMethodNames)[number], unknown>>
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
    this.nativeIntegration = (new.target as typeof Renderable).nativeIntegration
    Renderable.renderablesByNumber.set(this.num, this)

    try {
      validateOptions(this.id, options)

      this._width = options.width ?? "auto"
      this._height = options.height ?? "auto"

      this._zIndex = options.zIndex ?? 0
      this._visible = options.visible !== false
      this.buffered = options.buffered ?? false
      this._live = options.live ?? false
      this._liveCount = this._live && this._visible ? 1 : 0
      this._opacity = options.opacity !== undefined ? Math.max(0, Math.min(1, options.opacity)) : 1.0

      ctx.nativeScene.createNode(this, options)
      if (options.renderBefore !== undefined) this.renderBefore = options.renderBefore
      if (options.renderAfter !== undefined) this.renderAfter = options.renderAfter
      if (this.nativeSceneNeedsHookPublish()) this.setNativeSceneHooks(this._nativeSceneHookFlags)
      this.setDisplay(this._visible ? Display.Flex : Display.None)
      this.setupYogaProperties(options)
      if (this.nativeIntegration.measure) this.setMeasureFunc(this.nativeIntegration.measure.bind(this))
      // Native create already has default z-index, opacity, and translations.
      // Subclasses publish their real paint; keep this write for non-default values.
      if (this._zIndex !== 0 || this._opacity !== 1 || this._focusable) {
        ctx.nativeScene.setPaint(this, Renderable.prototype.getNativeScenePaint.call(this))
      }

      this.applyEventOptions(options)

      if (this.buffered) {
        this.createFrameBuffer()
      }
      // Derived class fields run after super(); leaf classes cannot grow hooks that way.
      if (!Object.hasOwn(new.target, "nativeIntegration") || this.nativeIntegration.construction !== "prototype") {
        ctx.nativeScene.scheduleHookScan(this)
      }
    } catch (error) {
      try {
        this.destroyLayoutBacking()
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
    this.assertMutable()
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
    if (value === undefined) throw new TypeError("Scene focusable must be a boolean")
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
    return isRowFlexDirection(this.getFlexDirection()) ? "row" : "column"
  }

  public set visible(value: boolean) {
    if (this._visible === value) return

    this.runMutation(() => {
      const wasVisible = this._visible
      this.setDisplay(value ? Display.Flex : Display.None)
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
    if (value === undefined) throw new RangeError("Scene translations must be finite numbers")
    if (this._translateX === value) return
    this.setNativeScenePaint({ translateX: value })
    this._translateX = value
    this.requestRender()
  }

  public get translateY(): number {
    return this._translateY
  }

  public set translateY(value: number) {
    if (value === undefined) throw new RangeError("Scene translations must be finite numbers")
    if (this._translateY === value) return
    this.setNativeScenePaint({ translateY: value })
    this._translateY = value
    this.requestRender()
  }

  public get screenX(): number {
    return this._isDestroyed ? (this._destroyedLayout?.screenX ?? 0) : this.getNativeSceneLayout().screenX
  }

  public get screenY(): number {
    return this._isDestroyed ? (this._destroyedLayout?.screenY ?? 0) : this.getNativeSceneLayout().screenY
  }

  // Host paint uses the prepared snapshot even after same-frame reparenting.
  protected get _screenX(): number {
    return this.getNativeScenePaintLayout()?.screenX ?? this.screenX
  }

  protected get _screenY(): number {
    return this.getNativeScenePaintLayout()?.screenY ?? this.screenY
  }

  private getNativeScenePaintLayout(): NativeSceneLayout | undefined {
    const cached = this._nativeSceneHookLayout
    if (!cached) return undefined
    const scene = this._ctx.nativeScene
    const revision = scene.currentGeometryRevision
    if (!this._isDestroyed && cached.paintRevision !== revision) {
      // Native preserves prepared membership while accepting explicit translations.
      cached.paintLayout = scene.getLayout(this, "paint")
      cached.paintRevision = revision
    }
    return cached.paintLayout
  }

  public get x(): number {
    if (!this._isDestroyed) return this.getNativeSceneLayout().screenX
    const left = this._destroyedLayout?.x ?? 0
    if (this.parent) {
      return this.parent.x + left + this._translateX
    }
    return left + this._translateX
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
    const top = this._destroyedLayout?.y ?? 0
    if (this.parent) {
      return this.parent.y + top + this._translateY
    }
    return top + this._translateY
  }

  public set y(value: number) {
    this.top = value
  }

  public get width(): number {
    if (!this._isDestroyed) {
      const layout = this.getNativeSceneLayout()
      // Native snapshots use zero before layout; completed dimensions are at least one cell.
      return layout.width === 0 ? this.styledDimension("width") : layout.width
    }
    return this._destroyedLayout?.width ?? this.styledDimension("width")
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
      return layout.height === 0 ? this.styledDimension("height") : layout.height
    }
    return this._destroyedLayout?.height ?? this.styledDimension("height")
  }

  private styledDimension(kind: "width" | "height"): number {
    const value = kind === "width" ? this._width : this._height
    return typeof value === "number" ? value : 0
  }

  private getNativeSceneLayout(): NativeSceneLayout {
    const scene = this._ctx.nativeScene
    const cached = this._nativeSceneHookLayout
    const revision = scene.currentGeometryRevision
    if (cached?.layout && cached.revision === revision) return cached.layout
    const layout = scene.getLayout(this)
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
    this.runMutation(() => {
      const key = dimension === Dimension.Width ? "_width" : "_height"
      const disableShrink = typeof value === "number" && this._flexShrink === 1
      this.yogaSetDimension(dimension, value, disableShrink)
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
    const axis = isRowFlexDirection(this.getFlexDirection()) ? "screenX" : "screenY"
    if (this._childrenInLayoutOrder.length < 2) return [...this._childrenInLayoutOrder]
    // Selection traverses children in screen order, including ancestor translations.
    const children = this._childrenInLayoutOrder.map((child) => ({ child, coordinate: child[axis] }))
    children.sort((a, b) => a.coordinate - b.coordinate)
    return children.map(({ child }) => child)
  }

  /** @internal Bind the native scene handle. Scene-backed layout has no JS Yoga Node. */
  _bindSceneHandle(handle: SceneNodeHandle): void {
    this._sceneHandle = handle
    this._yogaFreed = false
  }

  /** @internal Only the matching scene can use this node's handle. */
  _getSceneHandle(owner: NativeScene): SceneNodeHandle {
    if (this._ctx.nativeScene !== owner) throw new Error("Yoga node belongs to a different native scene")
    owner.assertAlive()
    if (this._yogaFreed || !this._sceneHandle) throw new Error("Native scene Yoga node is freed")
    return this._sceneHandle
  }

  /** @internal Invalidate the handle after native release. */
  _releaseSceneHandle(): void {
    this._yogaFreed = true
    this._sceneHandle = undefined
  }

  isFreed(): boolean {
    return this._yogaFreed || !this._sceneHandle
  }

  assertMutable(): void {
    this._ctx.nativeScene.driver.renderLib.getYogaHost().assertMutable()
    this._getSceneHandle(this._ctx.nativeScene)
  }

  runMutation<T>(operation: () => T): T {
    this.assertMutable()
    return this._ctx.nativeScene.driver.renderLib.getYogaHost().runMutation(operation)
  }

  private yogaSetEnum(kind: (typeof YogaEnumKind)[keyof typeof YogaEnumKind], value: number): void {
    sceneSetEnum(this._ctx.nativeScene, this, kind, value)
  }

  private yogaGetEnum(kind: (typeof YogaEnumKind)[keyof typeof YogaEnumKind], fallback: number): number {
    return sceneGetEnum(this._ctx.nativeScene, this, kind, fallback)
  }

  private yogaSetFloat(kind: (typeof YogaFloatKind)[keyof typeof YogaFloatKind], value: number | undefined): void {
    sceneSetFloat(this._ctx.nativeScene, this, kind, value)
  }

  private yogaGetFloat(kind: (typeof YogaFloatKind)[keyof typeof YogaFloatKind]): number {
    return sceneGetFloat(this._ctx.nativeScene, this, kind)
  }

  private yogaSetValue(
    kind: (typeof YogaValueKind)[keyof typeof YogaValueKind],
    edge: number,
    valueInput: number | "auto" | `${number}%` | Value | undefined,
  ): void {
    sceneSetValue(this._ctx.nativeScene, this, kind, edge, valueInput)
  }

  private yogaGetValue(kind: (typeof YogaValueKind)[keyof typeof YogaValueKind], edge: number): Value {
    return sceneGetValue(this._ctx.nativeScene, this, kind, edge)
  }

  setDisplay(display: Display): void {
    this.yogaSetEnum(YogaEnumKind.Display, display)
  }

  getFlexDirection(): FlexDirection {
    return this.yogaGetEnum(YogaEnumKind.FlexDirection, FlexDirection.Column) as FlexDirection
  }

  setFlexDirection(flexDirection: FlexDirection): void {
    this.yogaSetEnum(YogaEnumKind.FlexDirection, flexDirection)
  }

  setFlexWrap(flexWrap: number): void {
    this.yogaSetEnum(YogaEnumKind.FlexWrap, flexWrap)
  }

  setAlignItems(alignItems: number): void {
    this.yogaSetEnum(YogaEnumKind.AlignItems, alignItems)
  }

  setJustifyContent(justifyContent: number): void {
    this.yogaSetEnum(YogaEnumKind.JustifyContent, justifyContent)
  }

  setAlignSelf(alignSelf: number): void {
    this.yogaSetEnum(YogaEnumKind.AlignSelf, alignSelf)
  }

  setPositionType(positionType: number): void {
    this.yogaSetEnum(YogaEnumKind.PositionType, positionType)
  }

  setOverflow(overflow: number): void {
    this.yogaSetEnum(YogaEnumKind.Overflow, overflow)
  }

  setFlexGrow(flexGrow: number | undefined): void {
    this.yogaSetFloat(YogaFloatKind.FlexGrow, flexGrow)
  }

  getFlexGrow(): number {
    return this.yogaGetFloat(YogaFloatKind.FlexGrow)
  }

  setFlexShrink(flexShrink: number | undefined): void {
    this.yogaSetFloat(YogaFloatKind.FlexShrink, flexShrink)
  }

  getFlexShrink(): number {
    return this.yogaGetFloat(YogaFloatKind.FlexShrink)
  }

  getPositionType(): PositionType {
    return this.yogaGetEnum(YogaEnumKind.PositionType, PositionType.Relative) as PositionType
  }

  setFlexBasis(flexBasis: number | "auto" | `${number}%` | undefined): void {
    this.yogaSetValue(YogaValueKind.FlexBasis, NATIVE_EDGE_NONE, flexBasis)
  }

  setWidth(width: number | "auto" | `${number}%`): void {
    this.yogaSetValue(YogaValueKind.Width, NATIVE_EDGE_NONE, width)
  }

  setHeight(height: number | "auto" | `${number}%`): void {
    this.yogaSetValue(YogaValueKind.Height, NATIVE_EDGE_NONE, height)
  }

  setMinWidth(minWidth: number | `${number}%` | undefined): void {
    this.yogaSetValue(YogaValueKind.MinWidth, NATIVE_EDGE_NONE, minWidth)
  }

  getMinWidth(): Value {
    return this.yogaGetValue(YogaValueKind.MinWidth, NATIVE_EDGE_NONE)
  }

  setMaxWidth(maxWidth: number | `${number}%` | undefined): void {
    this.yogaSetValue(YogaValueKind.MaxWidth, NATIVE_EDGE_NONE, maxWidth)
  }

  setMinHeight(minHeight: number | `${number}%` | undefined): void {
    this.yogaSetValue(YogaValueKind.MinHeight, NATIVE_EDGE_NONE, minHeight)
  }

  setMaxHeight(maxHeight: number | `${number}%` | undefined): void {
    this.yogaSetValue(YogaValueKind.MaxHeight, NATIVE_EDGE_NONE, maxHeight)
  }

  setMargin(edge: Edge, margin: number | "auto" | `${number}%` | undefined): void {
    this.yogaSetValue(YogaValueKind.Margin, edge, margin)
  }

  getMargin(edge: Edge): Value {
    return this.yogaGetValue(YogaValueKind.Margin, edge)
  }

  getPosition(edge: Edge): Value {
    return this.yogaGetValue(YogaValueKind.Position, edge)
  }

  setPadding(edge: Edge, padding: number | `${number}%` | undefined): void {
    this.yogaSetValue(YogaValueKind.Padding, edge, padding)
  }

  setGap(gutter: Gutter, gap: number | `${number}%` | undefined): void {
    this.yogaSetValue(YogaValueKind.Gap, gutter, gap)
  }

  getWidth(): Value {
    return this.yogaGetValue(YogaValueKind.Width, NATIVE_EDGE_NONE)
  }

  getHeight(): Value {
    return this.yogaGetValue(YogaValueKind.Height, NATIVE_EDGE_NONE)
  }

  yogaSetDimension(
    dimension: Dimension,
    input: number | "auto" | `${number}%`,
    disableFlexShrink: boolean = false,
  ): void {
    sceneSetDimension(this._ctx.nativeScene, this, dimension, input, disableFlexShrink)
  }

  setPositions(positions: readonly [unknown, unknown, unknown, unknown]): void {
    this.assertMutable()
    const units = new Uint32Array(Edge.Bottom + 1)
    const values = new Float32Array(Edge.Bottom + 1)
    let mask = 0
    for (let edge = 0; edge <= Edge.Bottom; edge++) {
      if (positions[edge] === undefined) continue
      const value = parseYogaValue(positions[edge] as number | "auto" | `${number}%` | Value | undefined)
      if (!Number.isInteger(value.unit) || value.unit < Unit.Undefined || value.unit > Unit.Auto) {
        throw new RangeError("Invalid Yoga position unit")
      }
      mask |= 1 << edge
      units[edge] = value.unit
      values[edge] = value.value
    }
    this._ctx.nativeScene.setPositions(this, mask, units, values)
  }

  getComputedLayout(): Layout {
    const { left, top, right, bottom, width, height } = this._ctx.nativeScene.getLayout(this, true)
    return { left, top, right, bottom, width, height }
  }

  getComputedTop(): number {
    return this.getComputedLayout().top
  }

  getComputedWidth(): number {
    return this.getComputedLayout().width
  }

  getComputedHeight(): number {
    return this.getComputedLayout().height
  }

  setMeasureFunc(measure: MeasureFunction | null): void {
    this.assertMutable()
    this._ctx.nativeScene.setMeasureFunc(this, measure)
  }

  hasMeasureFunc(): boolean {
    return this._ctx.nativeScene.hasMeasureFunc(this)
  }

  private setupYogaProperties(options: RenderableOptions<Renderable>): void {
    const node = this

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
    const node = this

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

    this.runMutation(() => {
      this.setPositionType(parsePositionType(positionType))
      this._positionType = positionType
      this.requestRender()
    })
  }

  get overflow(): OverflowString {
    return this._overflow
  }

  set overflow(overflow: OverflowString | null | undefined) {
    if (!isOverflowType(overflow) || this._overflow === overflow) return

    this.runMutation(() => {
      this.setOverflow(parseOverflow(overflow))
      this._overflow = overflow
      this.requestRender()
    })
  }

  public setPosition(position: Position): void {
    this.runMutation(() => {
      this.updateYogaPosition(position)
      this._position = { ...this._position, ...position }
      this.requestRender()
    })
  }

  private updateYogaPosition(position: Position): void {
    const { top, right, bottom, left } = position
    this.setPositions([
      isPositionType(left) ? left : undefined,
      isPositionType(top) ? top : undefined,
      isPositionType(right) ? right : undefined,
      isPositionType(bottom) ? bottom : undefined,
    ])
  }

  public set flexGrow(grow: number | null | undefined) {
    if (grow == null) {
      this.setFlexGrow(0)
    } else {
      this.setFlexGrow(grow)
    }
    this.requestRender()
  }

  public set flexShrink(shrink: number | null | undefined) {
    const value = shrink == null ? 1 : shrink
    this.runMutation(() => {
      this.setFlexShrink(value)
      this._flexShrink = value
      this.requestRender()
    })
  }

  public set flexDirection(direction: FlexDirectionString | null | undefined) {
    this.setFlexDirection(parseFlexDirection(direction))
    this.requestRender()
  }

  public set flexWrap(wrap: WrapString | null | undefined) {
    this.setFlexWrap(parseWrap(wrap))
    this.requestRender()
  }

  public set alignItems(alignItems: AlignString | null | undefined) {
    this.setAlignItems(parseAlignItems(alignItems))
    this.requestRender()
  }

  public set justifyContent(justifyContent: JustifyString | null | undefined) {
    this.setJustifyContent(parseJustify(justifyContent))
    this.requestRender()
  }

  public set alignSelf(alignSelf: AlignString | null | undefined) {
    this.setAlignSelf(parseAlign(alignSelf))
    this.requestRender()
  }

  public set flexBasis(basis: number | "auto" | null | undefined) {
    if (isFlexBasisType(basis)) {
      this.setFlexBasis(basis)
      this.requestRender()
    }
  }

  public set minWidth(minWidth: number | `${number}%` | null | undefined) {
    if (isSizeType(minWidth)) {
      this.setMinWidth(minWidth)
      this.requestRender()
    }
  }

  public set maxWidth(maxWidth: number | `${number}%` | null | undefined) {
    if (isSizeType(maxWidth)) {
      this.setMaxWidth(maxWidth)
      this.requestRender()
    }
  }

  public set minHeight(minHeight: number | `${number}%` | null | undefined) {
    if (isSizeType(minHeight)) {
      this.setMinHeight(minHeight)
      this.requestRender()
    }
  }

  public set maxHeight(maxHeight: number | `${number}%` | null | undefined) {
    if (isSizeType(maxHeight)) {
      this.setMaxHeight(maxHeight)
      this.requestRender()
    }
  }

  public set margin(margin: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(margin)) {
      this.setMargin(Edge.All, margin)
      this.requestRender()
    }
  }

  public set marginX(marginX: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(marginX)) {
      this.setMargin(Edge.Horizontal, marginX)
      this.requestRender()
    }
  }

  public set marginY(marginY: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(marginY)) {
      this.setMargin(Edge.Vertical, marginY)
      this.requestRender()
    }
  }

  public set marginTop(margin: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(margin)) {
      this.setMargin(Edge.Top, margin)
      this.requestRender()
    }
  }

  public get marginTop(): number | "auto" | `${number}%` {
    const margin = this.getMargin(Edge.Top) as unknown
    if (typeof margin === "number") return margin
    if (typeof margin === "object" && margin && "value" in margin && typeof margin.value === "number")
      return margin.value
    return 0
  }

  public set marginRight(margin: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(margin)) {
      this.setMargin(Edge.Right, margin)
      this.requestRender()
    }
  }

  public set marginBottom(margin: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(margin)) {
      this.setMargin(Edge.Bottom, margin)
      this.requestRender()
    }
  }

  public set marginLeft(margin: number | "auto" | `${number}%` | null | undefined) {
    if (isMarginType(margin)) {
      this.setMargin(Edge.Left, margin)
      this.requestRender()
    }
  }

  public set padding(padding: number | `${number}%` | null | undefined) {
    if (isPaddingType(padding)) {
      this.setPadding(Edge.All, padding)
      this.requestRender()
    }
  }

  public set paddingX(paddingX: number | `${number}%` | null | undefined) {
    if (isPaddingType(paddingX)) {
      this.setPadding(Edge.Horizontal, paddingX)
      this.requestRender()
    }
  }

  public set paddingY(paddingY: number | `${number}%` | null | undefined) {
    if (isPaddingType(paddingY)) {
      this.setPadding(Edge.Vertical, paddingY)
      this.requestRender()
    }
  }

  public set paddingTop(padding: number | `${number}%` | null | undefined) {
    if (isPaddingType(padding)) {
      this.setPadding(Edge.Top, padding)
      this.requestRender()
    }
  }

  public set paddingRight(padding: number | `${number}%` | null | undefined) {
    if (isPaddingType(padding)) {
      this.setPadding(Edge.Right, padding)
      this.requestRender()
    }
  }

  public set paddingBottom(padding: number | `${number}%` | null | undefined) {
    if (isPaddingType(padding)) {
      this.setPadding(Edge.Bottom, padding)
      this.requestRender()
    }
  }

  public set paddingLeft(padding: number | `${number}%` | null | undefined) {
    if (isPaddingType(padding)) {
      this.setPadding(Edge.Left, padding)
      this.requestRender()
    }
  }

  public setMeasureProvider(provider: MeasureFunction | null): void {
    if (this._isDestroyed) throw new Error("Renderable is destroyed")
    const node = this
    node.runMutation(() => {
      if (provider === null && node.hasMeasureFunc()) this._ctx.nativeScene.markDirty(this)
      node.setMeasureFunc(provider)
      if (provider) this._ctx.nativeScene.markDirty(this)
      this.requestRender()
    })
  }

  public invalidateIntrinsicSize(): void {
    if (this._isDestroyed) throw new Error("Renderable is destroyed")
    const node = this
    node.assertMutable()
    if (node.hasMeasureFunc()) this._ctx.nativeScene.markDirty(this)
  }

  public getLayout(): Readonly<Layout> {
    if (this._isDestroyed) throw new Error("Renderable is destroyed")
    return this.getComputedLayout()
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
    return this.runMutation(() => {
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
      const childNode = child
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
      this._ctx.nativeScene.moveNode(childNode, this, index)
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
    if (isVNode(obj)) this.assertMutable()

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
    if (isVNode(obj)) this.assertMutable()

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
    this.runMutation(() => {
      this._ctx.nativeScene.moveNode(renderable, null, 0)
      this.removeLayoutChildAt(index)
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
      border: NativeBorder.None,
      shouldFill: false,
      backgroundColor: RGBA.fromValues(0, 0, 0, 0),
      borderColor: RGBA.fromValues(1, 1, 1, 1),
      focusable: this._focusable,
      focusedBorderColor: RGBA.fromValues(0, 170 / 255, 1, 1),
      borderStyle: "single",
    }
  }

  protected setNativeScenePaint(paint: Partial<NativeScenePaint> = this.getNativeScenePaint()): void {
    this._ctx.nativeScene.setPaint(this, paint)
  }

  // Share accessor functions across nodes; retain handler identity per node.
  private static nativeSceneMethods = nativeSceneMethodNames.map((name) => {
    const normalize = (value: unknown) => {
      if (name === "selectable") return value
      if (name === "onLifecyclePass") value ??= null
      else if (name === "renderBefore" || name === "renderAfter") value ??= undefined
      else if (name === "onUpdate") value ??= nativeSceneMethodDefaults.onUpdate
      if (
        typeof value !== "function" &&
        !((name === "renderBefore" || name === "renderAfter" || name === "onLifecyclePass") && value == null)
      )
        throw new TypeError(`Invalid ${name} hook`)
      return value
    }
    return {
      name,
      normalize,
      descriptor: {
        configurable: true,
        get(this: Renderable) {
          const methods = this._nativeSceneMethods
          if (methods && name in methods) return methods[name]
          return nativeSceneMethodDefaults[name]
        },
        set(this: Renderable, value: unknown) {
          if (name === "selectable") {
            this.assertMutable()
            this.ensureNativeSceneMethods()[name] = value
            return
          }
          value = normalize(value)
          if (value === this[name]) return
          this.setNativeSceneHooks(this._nativeSceneHookFlags, { [name]: value })
          this.ensureNativeSceneMethods()[name] = value
          if (name === "onLifecyclePass") {
            if (!value) this._ctx.unregisterLifecyclePass(this)
            else if (this.parent) this._ctx.registerLifecyclePass(this)
            else this._ctx.nativeScene.lifecyclePasses.refresh(this)
          }
        },
      },
    }
  })

  static {
    const prototype = this.prototype as Renderable
    nativeSceneMethodDefaults.renderSelf = prototype.renderSelf
    nativeSceneMethodDefaults.onResize = prototype.onResize
    nativeSceneMethodDefaults.onLayoutResize = prototype.onLayoutResize
    nativeSceneMethodDefaults.onUpdate = prototype.onUpdate
    for (const method of this.nativeSceneMethods) {
      if (
        method.name === "renderSelf" ||
        method.name === "onResize" ||
        method.name === "onLayoutResize" ||
        method.name === "onUpdate"
      ) {
        this.installNativeSceneMethod(prototype, method, nativeSceneMethodDefaults[method.name])
      } else {
        Object.defineProperty(prototype, method.name, method.descriptor)
      }
    }
  }

  /** Declare integration once per class, before instances exist. Prototype methods retain
   * super calls, while assignment publishes through the same accessors as discovered fields. */
  protected static defineNativeIntegration(integration: NativeRenderableIntegration): NativeRenderableIntegration {
    for (const method of Renderable.nativeSceneMethods) {
      let prototype: object | null = this.prototype
      while (prototype) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, method.name)
        if (descriptor) {
          if ("value" in descriptor) this.installNativeSceneMethod(this.prototype, method, descriptor.value)
          break
        }
        prototype = Object.getPrototypeOf(prototype)
      }
    }
    return integration
  }

  private static installNativeSceneMethod(
    prototype: Renderable,
    method: (typeof Renderable.nativeSceneMethods)[number],
    handler: unknown,
  ): void {
    const instance = {
      ...method.descriptor,
      get(this: Renderable) {
        const methods = this._nativeSceneMethods
        return methods && method.name in methods ? methods[method.name] : handler
      },
    }
    Object.defineProperty(prototype, method.name, {
      configurable: true,
      get() {
        // A super lookup must return this class's implementation, not the live instance override.
        return handler
      },
      set(this: Renderable, value: unknown) {
        Object.defineProperty(this, method.name, instance)
        method.descriptor.set.call(this, value)
      },
    })
  }

  /** Snapshot reflective hook replacements and restore normal callback assignment.
   * Call after defineProperty/delete, or to finalize fields after early constructor attachment.
   * Ordinary paint and style changes do not discover hooks. */
  public refreshHooks(): void {
    if (this._isDestroyed) return
    this.assertMutable()
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

  private ensureNativeSceneMethods(): NonNullable<Renderable["_nativeSceneMethods"]> {
    return (this._nativeSceneMethods ??= {})
  }

  private nativeSceneNeedsHookPublish(): boolean {
    if (this.buffered) return true
    if (this._sizeChangeListener) return true
    if (!this.usesNativeDrawing(this.renderSelf)) return true
    if (this.hostUpdateFlags(this.onUpdate) !== 0) return true
    const onResize = this.onResize
    const onLayoutResize = this.onLayoutResize
    if (onLayoutResize !== nativeSceneMethodDefaults.onLayoutResize) return true
    if (
      !this._nativeSceneHooksRegistered &&
      this.nativeIntegration.beforeAfter !== false &&
      (this.renderBefore || this.renderAfter)
    )
      return true
    return this.needsHostResize(onResize)
  }

  private usesNativeDrawing(renderSelf: unknown): boolean {
    const body = this.nativeIntegration.body
    return (
      typeof body === "object" &&
      "native" in body &&
      (!this.buffered || body.buffered === true) &&
      renderSelf === body.native
    )
  }

  /** @internal Code's entered controller decision also selects this request's native text paint. */
  _usesNativeTextController(renderSelf: unknown): boolean {
    const body = this.nativeIntegration.body
    return !this.buffered && typeof body === "object" && "textController" in body && renderSelf === body.textController
  }

  private needsHostResize(onResize: unknown): boolean {
    const resize = this.nativeIntegration.lifecycle?.resize
    if (resize === "host") return true
    return onResize !== nativeSceneMethodDefaults.onResize && onResize !== resize?.native
  }

  private hostUpdateFlags(onUpdate: unknown): number {
    const update = this.nativeIntegration.lifecycle?.update
    if (update === "host") return NativeSceneHook.Update
    if (update && onUpdate === update.idle) {
      return update.active(this) ? NativeSceneHook.Update : NativeSceneHook.IdleUpdate
    }
    return onUpdate === nativeSceneMethodDefaults.onUpdate ? 0 : NativeSceneHook.Update
  }

  private refreshNativeSceneMethods(): void {
    this._refreshNativeSceneSurface()
    const methods = Renderable.nativeSceneMethods
    for (let index = 0; index < methods.length; index++) {
      const method = methods[index]
      const name = method.name
      const own = Object.getOwnPropertyDescriptor(this, name)
      if (own?.set === method.descriptor.set) continue
      const handler = method.normalize(this[name as keyof this])
      if (!own && handler === nativeSceneMethodDefaults[name]) continue
      this.ensureNativeSceneMethods()[name] = handler
      Object.defineProperty(this, name, method.descriptor)
      // Prototype hooks were published by super(); capture their later assignments without another admission.
      if (own) this._nativeSceneMethodsPending = true
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

  /** @internal Retained surfaces restore their binding accessor during the same construction refresh. */
  _refreshNativeSceneSurface(): void {}

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
    flags =
      (flags & ~nativeSceneHookHostMethods) |
      (method("renderBefore") ? NativeSceneHook.RenderBefore : 0) |
      (method("renderAfter") ? NativeSceneHook.RenderAfter : 0)
    const renderSelf = method("renderSelf")
    if (!this.usesNativeDrawing(renderSelf)) flags |= NativeSceneHook.RenderSelf
    // A caller getter can accept another hook mutation while these options are read.
    const overridden =
      ("onUpdate" in overrides ? nativeSceneHookUpdates : 0) |
      ("onResize" in overrides || "onLayoutResize" in overrides ? NativeSceneHook.Resize : 0) |
      ("renderBefore" in overrides ? NativeSceneHook.RenderBefore : 0) |
      ("renderAfter" in overrides ? NativeSceneHook.RenderAfter : 0) |
      ("renderSelf" in overrides ? NativeSceneHook.RenderSelf : 0)
    const changed = (previousFlags ^ this._nativeSceneHookFlags) & ~overridden
    flags = (flags & ~changed) | (this._nativeSceneHookFlags & changed)
    const resizeCallbacks = {
      onResize:
        "onResize" in overrides ? overrides.onResize : (this._nativeSceneResizeCallbacks?.onResize ?? this.onResize),
      onLayoutResize:
        "onLayoutResize" in overrides
          ? overrides.onLayoutResize
          : (this._nativeSceneResizeCallbacks?.onLayoutResize ?? this.onLayoutResize),
    }
    const resize =
      this.buffered ||
      resizeCallbacks.onLayoutResize !== Renderable.prototype.onLayoutResize ||
      this.needsHostResize(resizeCallbacks.onResize)
    if (this._nativeSceneResize !== resize)
      flags =
        (flags & ~NativeSceneHook.Resize) |
        (this._sizeChangeListener || this.listenerCount("resize") ? NativeSceneHook.Resize : 0)
    if (resize) flags |= NativeSceneHook.Resize
    lineInfo ??= !!this.nativeIntegration.lineInfo && this.listenerCount("line-info-change") > 0
    // Getters can change activity or accept a new implicit hook with the same flags.
    const update =
      "onUpdate" in overrides || previousGeneration === this._nativeSceneHookGeneration
        ? this.hostUpdateFlags(onUpdate)
        : this._nativeSceneHookFlags & nativeSceneHookUpdates
    flags = (flags & ~nativeSceneHookUpdates) | update
    const generation = this._nativeSceneHookGeneration + 1n
    if (flags !== 0 || lineInfo || this._nativeSceneHooksRegistered) {
      let nativeFlags = flags
      if (this.nativeIntegration.beforeAfter === false) {
        nativeFlags &= ~nativeSceneHookBeforeAfter
      }
      const nativeResize = this.nativeIntegration.lifecycle?.resize
      if (!resize && nativeResize && nativeResize !== "host") {
        nativeFlags =
          (nativeFlags & ~NativeSceneHook.Resize) |
          (lineInfo && this.nativeIntegration.lineInfo ? NativeSceneHook.Resize : 0)
      }
      if (this._usesNativeTextController(renderSelf)) nativeFlags |= NativeSceneHook.ResumeNativeText
      if (nativeFlags & NativeSceneHook.RenderSelf) nativeFlags |= NativeSceneHook.RenderAfter
      scene.setHooks(this, nativeFlags, generation, this.styledDimension("width"), this.styledDimension("height"))
      this._nativeSceneHooksRegistered = true
    }
    this._nativeSceneResizeCallbacks = resize ? resizeCallbacks : undefined
    this._nativeSceneResize = resize
    this._nativeSceneHookFlags = flags
    this._nativeSceneHookGeneration = generation
  }

  /** @internal Refresh only requested host hooks, never walk wrappers to collect layout. */
  _runNativeSceneHook(request: NativeSceneFrameRequest, deltaTime: number, buffer: OptimizedBuffer): void {
    if (
      (this._isDestroyed &&
        request.kind !== NativeSceneFrame.RenderAfter &&
        request.kind !== NativeSceneFrame.RenderSelf) ||
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
        (isNativeScenePaintFrame(request.kind) || (request.kind === NativeSceneFrame.Resize && this._nativeSceneResize))
      ) {
        this._nativeSceneHookLayout.paintLayout =
          (currentGeometry && request.paintLayout) || this._ctx.nativeScene.getLayout(this, "paint")
        this._nativeSceneHookLayout.paintRevision = revision
      }
      // Text/editor bodies draw into the supplied destination before native composition.
      let renderBuffer =
        this.nativeIntegration.paintBuffer !== "destination" && this.buffered && this.frameBuffer
          ? this.frameBuffer
          : buffer
      if (isNativeScenePaintFrame(request.kind)) {
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
          if (request.kind === NativeSceneFrame.RenderAfter) this._nativeScenePaintBuffer = undefined
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
      case NativeSceneFrame.Update:
        this.onUpdate(deltaTime)
        break
      case NativeSceneFrame.Resize:
        if (this._nativeSceneResize) this.onLayoutResize(request.width, request.height)
        else {
          const resize = this.nativeIntegration.lifecycle?.resize
          if (!resize || resize === "host") {
            this.onSizeChange?.call(this)
            if (!this._isDestroyed) this.emit("resize")
          }
          if (!this._isDestroyed && this.nativeIntegration.lineInfo) this.emit("line-info-change")
        }
        break
      case NativeSceneFrame.LayoutChanged:
        this.emit(LayoutEvents.LAYOUT_CHANGED)
        break
      case NativeSceneFrame.RenderBefore:
        this.renderBefore?.call(this, renderBuffer, deltaTime)
        break
      case NativeSceneFrame.RenderAfter:
        if (this.nativeIntegration.beforeAfter !== false) {
          this.renderAfter?.call(this, renderBuffer, deltaTime)
          this.markClean()
        }
        if (this.nativeIntegration.bufferComposition !== "native" && this.buffered && this.frameBuffer)
          buffer.drawFrameBuffer(Math.trunc(this._screenX), Math.trunc(this._screenY), this.frameBuffer)
        break
      case NativeSceneFrame.RenderSelf:
        if (this.nativeIntegration.beforeAfter === false) this.markClean()
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

    this.assertMutable()
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
    this.assertMutable()
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

  private destroyLayoutBacking(cleanup?: (run: (step: () => void) => void) => void): void {
    const scene = this._ctx.nativeScene
    const hasHandle = !!this._sceneHandle && !this._yogaFreed
    this._cleanupInProgress = true
    const cleanupOwners = ((this._ctx as CleanupContext).__otuiActiveCleanupOwners ??= new Set<Renderable>())
    const ownsCompletion = !cleanupOwners.has(this)
    cleanupOwners.add(this)
    this.runCleanup((run) => {
      // Constructor rollback must release ownership even when a previous callback failed.
      run(() => scene.driver.renderLib.getYogaHost().throwCallbackError())
      if (hasHandle && this.selectable) {
        run(() => {
          // Selection anchors retain local coordinates after detachment and release.
          const layout = scene.getLayout(this)
          this._destroyedLayout = {
            x: layout.left,
            y: layout.top,
            screenX: layout.screenX,
            screenY: layout.screenY,
            width: layout.width === 0 ? this.styledDimension("width") : layout.width,
            height: layout.height === 0 ? this.styledDimension("height") : layout.height,
          }
        })
      }
      if (cleanup) run(() => cleanup(run))
      this._isDestroyed = true
      if (hasHandle) run(() => scene.destroyNode(this))
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

  private removeLayoutChildAt(index: number): void {
    const children = this._childrenInLayoutOrder
    if (index === children.length - 1) children.pop()
    else children.splice(index, 1)
  }

  private detachFromParent(): void {
    const parent = this.parent
    if (!parent) return

    const layoutIndex = parent._childrenInLayoutOrder.indexOf(this)
    if (layoutIndex !== -1) {
      this._ctx.nativeScene.moveNode(this, null, 0)
      parent.removeLayoutChildAt(layoutIndex)
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
      (event === "line-info-change" && !this.nativeIntegration.lineInfo) ||
      ((operation !== "clear" || event !== undefined) &&
        event !== "resize" &&
        event !== "line-info-change" &&
        event !== LayoutEvents.LAYOUT_CHANGED) ||
      (operation !== "clear" && typeof listener !== "function")
    ) {
      return change()
    }
    let resize = this.listenerCount("resize")
    const initialLineInfo = this.nativeIntegration.lineInfo ? this.listenerCount("line-info-change") : 0
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
      (this._nativeSceneHookFlags & ~nativeSceneHookListeners) |
        (resize > 0 || this._sizeChangeListener ? NativeSceneHook.Resize : 0) |
        (layout > 0 ? NativeSceneHook.LayoutChanged : 0),
      {},
      lineInfo > 0,
    )
    this.runCleanup((run) => {
      run(change)
      // Meta-listeners can mutate subscriptions or throw. Keep their accepted changes rather than rolling them back.
      run(() => {
        if (!this._isDestroyed) {
          const flags =
            (this._nativeSceneHookFlags & ~nativeSceneHookListeners) |
            (this.listenerCount("resize") > 0 || this._sizeChangeListener ? NativeSceneHook.Resize : 0) |
            (this.listenerCount(LayoutEvents.LAYOUT_CHANGED) > 0 ? NativeSceneHook.LayoutChanged : 0)
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
      const flags = this._nativeSceneHookFlags & ~NativeSceneHook.Resize
      this.setNativeSceneHooks(flags | (handler || this.listenerCount("resize") > 0 ? NativeSceneHook.Resize : 0))
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
  static override readonly nativeIntegration = this.defineNativeIntegration({
    ...Renderable.nativeIntegration,
    kind: "root",
    construction: "prototype",
  })
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
      this.setFlexDirection(FlexDirection.Column)
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
