import { EventEmitter } from "events"
import {
  Align,
  Dimension,
  Display,
  Edge,
  FlexDirection,
  Gutter,
  Justify,
  PositionType,
  Wrap,
  type Layout,
  type MeasureFunction,
  type Value,
} from "./yoga.js"
import {
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
  UNDEFINED_VALUE,
} from "./yoga.internal.js"
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
  NATIVE_EDGE_NONE,
  NativeBorder,
  NativeSceneFrame,
  NativeSceneHook,
  NativeScenePaintPhase,
  type NativePaintRecorder,
  type NativeSceneFrameRequest,
  type NativeSceneLayout,
  type NativeScenePaint,
  type NativeScenePaintSlot,
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
const hookNames = [
  "renderSelf",
  "onResize",
  "onLayoutResize",
  "onUpdate",
  "renderBefore",
  "renderAfter",
  "onLifecyclePass",
] as const
type PaintHook = (this: Renderable, buffer: OptimizedBuffer, deltaTime: number) => void
/** A node's hooks: its class's methods at construction, public assignments, and the last refreshHooks(). */
type Hooks = Record<(typeof hookNames)[number], any>
const nativeSceneHookBeforeAfter =
  nativeConstants.OT_SCENE_HOOK_RENDER_BEFORE | nativeConstants.OT_SCENE_HOOK_RENDER_AFTER

function isRowFlexDirection(direction: FlexDirection): boolean {
  return direction === FlexDirection.Row || direction === FlexDirection.RowReverse
}

// `undefined` restores the default; `null` clamps to 0, as on `main`.
function clampOpacity(value: number | undefined): number {
  return value === undefined ? 1 : Math.max(0, Math.min(1, value))
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

// Indexed by Yoga edge: Edge.Left is 0 and Edge.Bottom is 3.
const positionKeys = ["left", "top", "right", "bottom"] as const

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
  /** Ticks `onAnimationTick` at this rate on the renderer's shared animation clock while the node is visible. */
  animationFps?: number
  opacity?: number

  // Draw-only hooks for custom decorations. They run after layout and viewport
  // culling and record drawing that native code paints later in the frame, so they
  // cannot read the frame. Layout changes made here wait for the next frame.
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

/** Class-owned native integration, declared as the class's static `nativeIntegration`. Method
 * identities identify work performed by native; overrides use the ordinary host hook dispatcher. */
export interface NativeRenderableIntegration {
  readonly kind: Parameters<NativeScene["driver"]["renderLib"]["sceneCreateNode"]>[2]
  readonly body:
    | "host"
    | { readonly native: (buffer: OptimizedBuffer, deltaTime: number) => void; readonly buffered?: boolean }
  readonly lifecycle?: {
    readonly resize?: { readonly native: (width: number, height: number) => void }
    readonly update?: {
      readonly idle: (deltaTime: number) => void
      readonly active: (renderable: Renderable) => boolean
    }
    /** A scroll node's SCROLL request, asked for only while `active` holds. */
    readonly scroll?: {
      readonly active: (renderable: Renderable) => boolean
      readonly notify: (renderable: Renderable) => void
    }
  }
  readonly beforeAfter?: boolean
  readonly paintBuffer?: "destination"
  readonly bufferComposition?: "native"
  readonly lineInfo?: boolean
  readonly measure?: (this: Renderable, ...constraints: Parameters<MeasureFunction>) => ReturnType<MeasureFunction>
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

export abstract class Renderable extends BaseRenderable {
  /** Focusable state of new nodes; a nullish `focusable` write restores it. */
  protected static readonly defaultFocusable: boolean = false
  static renderablesByNumber: Map<number, Renderable> = new Map()
  static readonly nativeIntegration: NativeRenderableIntegration = {
    kind: "custom",
    body: { native: this.prototype.renderSelf },
  }

  private static readonly baseHooks: Hooks = {
    renderSelf: this.prototype.renderSelf,
    onResize: this.prototype.onResize,
    onLayoutResize: this.prototype.onLayoutResize,
    onUpdate: this.prototype.onUpdate,
    renderBefore: undefined,
    renderAfter: undefined,
    onLifecyclePass: null,
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

  protected _focusable: boolean = (this.constructor as typeof Renderable).defaultFocusable
  protected _focused: boolean = false
  protected keypressHandler: ((key: KeyEvent) => void) | null = null
  protected pasteHandler: ((event: PasteEvent) => void) | null = null

  private _live: boolean = false
  private _animationFps: number | undefined
  private stopAnimationTick: (() => void) | undefined
  private animationDrawnFrame = -1
  protected _liveCount: number = 0

  private _sizeChangeListener: (() => void) | undefined = undefined
  private _hooks: Hooks = Renderable.baseHooks
  protected _nativeSceneHookGeneration = 0n
  private _nativeSceneHooksRegistered = false
  private _nativeSceneResize = false
  // The prepared paint geometry while one of this node's hooks runs.
  private _paintLayout?: NativeSceneLayout
  // Layout reads between native layout passes and host writes return the same values.
  private _observedLayout?: NativeSceneLayout
  private _observedLayoutRevision = -1
  private _selectable = false
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

  // Accessors, so a class field that overrides one is a type error (TS2610) instead of a silent shadow.
  public get onLifecyclePass(): (() => void) | null {
    return this._hooks.onLifecyclePass
  }
  public set onLifecyclePass(value: (() => void) | null | undefined) {
    this.setHook("onLifecyclePass", value)
  }
  public get renderBefore(): PaintHook | undefined {
    return this._hooks.renderBefore
  }
  public set renderBefore(value: PaintHook | null | undefined) {
    this.setHook("renderBefore", value)
  }
  public get renderAfter(): PaintHook | undefined {
    return this._hooks.renderAfter
  }
  public set renderAfter(value: PaintHook | null | undefined) {
    this.setHook("renderAfter", value)
  }

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
      this._opacity = clampOpacity(options.opacity)

      ctx.nativeScene.createNode(this, options)
      const hooks = {} as Hooks
      for (const name of hookNames) hooks[name] = this[name]
      for (const name of ["renderBefore", "renderAfter"] as const) {
        if (options[name] !== undefined) hooks[name] = Renderable.normalizeHook(name, options[name])
      }
      this.publishHooks(hooks)
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
      this.animationFps = options.animationFps
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
        this.updateAnimationTick()
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

  /** Completed base layers need full cleanup even before a subclass destroy override can run. */
  protected rollbackConstruction(error: unknown): never {
    try {
      Renderable.prototype.destroy.call(this)
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
      if (!Object.getOwnPropertyDescriptor(options, key)?.enumerable) continue
      const value = Reflect.get(options, key)
      if (this._isDestroyed || target._isDestroyed) return
      ;(target as unknown as Record<PropertyKey, unknown>)[key] = value
    }
  }

  public get focusable(): boolean {
    return this._focusable
  }

  public set focusable(value: boolean) {
    value ??= (this.constructor as typeof Renderable).defaultFocusable
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
    value ??= true
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
      this.updateAnimationTick()

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
    const clamped = clampOpacity(value)
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

  /** Ancestors can paint focus within, so a focus change marks them dirty. */
  protected propagateFocusChange(_hasFocus: boolean): void {
    for (let parent = this.parent; parent; parent = parent.parent) parent.markDirty()
    this.requestRender()
  }

  public blur(): void {
    if (!this._focused) return

    // Release JS focus state before native: destroy must not leave focus on a node whose native blur failed.
    this._focused = false
    const keypress = this.keypressHandler
    const paste = this.pasteHandler
    this.keypressHandler = null
    this.pasteHandler = null
    this.runCleanup((run) => {
      run(() => this._ctx.nativeScene.setFocus(this, false))
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
    const focused = this._ctx.currentFocusedRenderable
    if (!focused?._focused || focused._isDestroyed) return false
    for (let parent = focused.parent; parent; parent = parent.parent) if (parent === this) return true
    return false
  }

  public get live(): boolean {
    return this._live
  }

  public get liveCount(): number {
    return this._liveCount
  }

  public set live(value: boolean) {
    value ??= false
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

  public get animationFps(): number | undefined {
    return this._animationFps
  }

  public set animationFps(value: number | undefined) {
    value ??= undefined // Frameworks clear a prop with null.
    if (value !== undefined && !(value > 0 && value < Infinity)) {
      throw new RangeError(`animationFps must be positive and finite, got ${value}`)
    }
    if (this._animationFps === value) return
    const toggled = (this._animationFps === undefined) !== (value === undefined)
    this._animationFps = value
    // The update hook marks the frames that draw the node.
    if (toggled) this.refreshNativeSceneHooks()
    this.updateAnimationTick()
  }

  // Ticks only while the node is drawn. A hidden, culled or removed node gets no update, so the first tick after a
  // frame without one stops the clock, and the node's next update starts it again.
  private updateAnimationTick(): void {
    this.stopAnimationTick?.()
    this.stopAnimationTick = undefined
    if (this._animationFps === undefined || !this._visible || this._isDestroyed) return
    this.stopAnimationTick = this._ctx.onAnimationTick(this._animationFps, (deltaTime, ticks, time) => {
      if (this.animationDrawnFrame < this._ctx.frameId - 1) {
        this.stopAnimationTick?.()
        this.stopAnimationTick = undefined
        return
      }
      this.onAnimationTick(deltaTime, ticks, time)
    })
  }

  protected onAnimationTick(deltaTime: number, ticks: number, time: number): void {}

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

  // A translation in a paint hook moves the node's buffered composition from the next frame on.
  public set translateX(value: number) {
    value ??= 0
    if (this._translateX === value) return
    this.setNativeScenePaint({ translateX: value })
    this._translateX = value
    this.requestRender()
  }

  public get translateY(): number {
    return this._translateY
  }

  public set translateY(value: number) {
    value ??= 0
    if (this._translateY === value) return
    this.setNativeScenePaint({ translateY: value })
    this._translateY = value
    this.requestRender()
  }

  public get screenX(): number {
    return this.isFreed() ? (this._destroyedLayout?.screenX ?? 0) : this.getNativeSceneLayout().screenX
  }

  public get screenY(): number {
    return this.isFreed() ? (this._destroyedLayout?.screenY ?? 0) : this.getNativeSceneLayout().screenY
  }

  // Host paint uses the prepared snapshot even after same-frame reparenting.
  protected get _screenX(): number {
    return this._paintLayout?.screenX ?? this.screenX
  }

  protected get _screenY(): number {
    return this._paintLayout?.screenY ?? this.screenY
  }

  /** @internal Where the body paints: the buffer's origin when the node paints its own buffer. */
  protected _paintOrigin(buffer: OptimizedBuffer): [number, number] {
    return buffer === this.frameBuffer ? [0, 0] : [Math.trunc(this._screenX), Math.trunc(this._screenY)]
  }

  /** @internal Record or draw the native body at its paint origin. */
  protected _drawNativeBody(buffer: OptimizedBuffer): void {
    this._ctx.nativeScene.drawBody(this, buffer, ...this._paintOrigin(buffer))
  }

  // Paint geometry is clamped to the cell range that drawing accepts; public sizes are Yoga's.
  protected get _paintWidth(): number {
    return this._paintLayout?.width ?? this.width
  }

  protected get _paintHeight(): number {
    return this._paintLayout?.height ?? this.height
  }

  public get x(): number {
    if (!this.isFreed()) return this.getNativeSceneLayout().screenX
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

  public set top(value: number | "auto" | `${number}%` | null | undefined) {
    if (isPositionType(value) || value == null) {
      this.setPosition({ top: value ?? undefined })
    }
  }

  public get right(): number | "auto" | `${number}%` | undefined {
    return this._position.right
  }

  public set right(value: number | "auto" | `${number}%` | null | undefined) {
    if (isPositionType(value) || value == null) {
      this.setPosition({ right: value ?? undefined })
    }
  }

  public get bottom(): number | "auto" | `${number}%` | undefined {
    return this._position.bottom
  }

  public set bottom(value: number | "auto" | `${number}%` | null | undefined) {
    if (isPositionType(value) || value == null) {
      this.setPosition({ bottom: value ?? undefined })
    }
  }

  public get left(): number | "auto" | `${number}%` | undefined {
    return this._position.left
  }

  public set left(value: number | "auto" | `${number}%` | null | undefined) {
    if (isPositionType(value) || value == null) {
      this.setPosition({ left: value ?? undefined })
    }
  }

  public get y(): number {
    if (!this.isFreed()) return this.getNativeSceneLayout().screenY
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
    if (!this.isFreed()) {
      const layout = this.getNativeSceneLayout()
      // Native snapshots use zero before layout; completed dimensions are at least one cell.
      return layout.width === 0 ? this.styledDimension("width") : layout.width
    }
    return this._destroyedLayout?.width ?? this.styledDimension("width")
  }

  public set width(value: number | "auto" | `${number}%` | null | undefined) {
    this.setDimension("width", value)
  }

  public get height(): number {
    if (!this.isFreed()) {
      const layout = this.getNativeSceneLayout()
      return layout.height === 0 ? this.styledDimension("height") : layout.height
    }
    return this._destroyedLayout?.height ?? this.styledDimension("height")
  }

  /** The `width` or `height` that a nullish write restores. A class that sizes itself overrides it. */
  protected defaultDimension(_kind: "width" | "height"): number | "auto" | `${number}%` {
    return "auto"
  }

  private styledDimension(kind: "width" | "height"): number {
    const value = kind === "width" ? this._width : this._height
    return typeof value === "number" ? value : 0
  }

  private getNativeSceneLayout(): NativeSceneLayout {
    const revision = this._ctx.nativeScene.observedLayoutRevision
    if (revision !== undefined && this._observedLayoutRevision === revision) return this._observedLayout!
    return this.observeLayout(this._ctx.nativeScene.getLayout(this))
  }

  /** Caches a layout that native returned since the last frame, move, destroy, or translation. */
  private observeLayout(layout: NativeSceneLayout | undefined): NativeSceneLayout {
    const revision = this._ctx.nativeScene.observedLayoutRevision
    if (layout && revision !== undefined) {
      this._observedLayout = layout
      this._observedLayoutRevision = revision
    }
    return layout!
  }

  public set height(value: number | "auto" | `${number}%` | null | undefined) {
    this.setDimension("height", value)
  }

  private setDimension(kind: "width" | "height", input: number | "auto" | `${number}%` | null | undefined): void {
    // A destroyed node ignores writes; a defaultDimension override may need its native context.
    if (this.isFreed()) return
    const value = input ?? this.defaultDimension(kind)
    const key = kind === "width" ? "_width" : "_height"
    if (!isDimensionType(value) || this[key] === value) return
    this.runMutation(() => {
      const disableShrink = typeof value === "number" && this._flexShrink === 1
      const dimension = kind === "width" ? Dimension.Width : Dimension.Height
      sceneSetDimension(this._ctx.nativeScene, this, dimension, value, disableShrink)
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
    const axis = this.primaryAxis === "row" ? "screenX" : "screenY"
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

  /** A destroyed renderable skips the operation: writes to it are no-ops, as on `main`. */
  runMutation<T>(operation: () => T): T {
    if (this.isFreed()) return undefined as T
    this.assertMutable()
    return this._ctx.nativeScene.driver.renderLib.getYogaHost().runMutation(operation)
  }

  private yogaSetEnum(kind: (typeof YogaEnumKind)[keyof typeof YogaEnumKind], value: number): void {
    if (this.isFreed()) return
    sceneSetEnum(this._ctx.nativeScene, this, kind, value)
  }

  private yogaGetEnum(kind: (typeof YogaEnumKind)[keyof typeof YogaEnumKind], fallback: number): number {
    return this.isFreed() ? fallback : sceneGetEnum(this._ctx.nativeScene, this, kind)
  }

  private yogaGetFloat(kind: (typeof YogaFloatKind)[keyof typeof YogaFloatKind]): number {
    return this.isFreed() ? NaN : sceneGetFloat(this._ctx.nativeScene, this, kind)
  }

  private yogaSetFloat(kind: (typeof YogaFloatKind)[keyof typeof YogaFloatKind], value: number | undefined): void {
    if (this.isFreed()) return
    sceneSetFloat(this._ctx.nativeScene, this, kind, value)
  }

  private yogaSetValue(
    kind: (typeof YogaValueKind)[keyof typeof YogaValueKind],
    edge: number,
    valueInput: number | "auto" | `${number}%` | Value | undefined,
  ): void {
    if (this.isFreed()) return
    sceneSetValue(this._ctx.nativeScene, this, kind, edge, valueInput)
  }

  private yogaGetValue(kind: (typeof YogaValueKind)[keyof typeof YogaValueKind], edge: number): Value {
    return this.isFreed() ? UNDEFINED_VALUE : sceneGetValue(this._ctx.nativeScene, this, kind, edge)
  }

  private setDisplay(display: Display): void {
    this.yogaSetEnum(YogaEnumKind.Display, display)
  }

  getFlexDirection(): FlexDirection {
    return this.yogaGetEnum(YogaEnumKind.FlexDirection, FlexDirection.Column) as FlexDirection
  }

  private setFlexDirection(flexDirection: FlexDirection): void {
    this.yogaSetEnum(YogaEnumKind.FlexDirection, flexDirection)
  }

  private setFlexWrap(flexWrap: number): void {
    this.yogaSetEnum(YogaEnumKind.FlexWrap, flexWrap)
  }

  private setAlignItems(alignItems: number): void {
    this.yogaSetEnum(YogaEnumKind.AlignItems, alignItems)
  }

  private setJustifyContent(justifyContent: number): void {
    this.yogaSetEnum(YogaEnumKind.JustifyContent, justifyContent)
  }

  private setAlignSelf(alignSelf: number): void {
    this.yogaSetEnum(YogaEnumKind.AlignSelf, alignSelf)
  }

  private setPositionType(positionType: number): void {
    this.yogaSetEnum(YogaEnumKind.PositionType, positionType)
  }

  private setOverflow(overflow: number): void {
    this.yogaSetEnum(YogaEnumKind.Overflow, overflow)
  }

  private setFlexGrow(flexGrow: number | undefined): void {
    this.yogaSetFloat(YogaFloatKind.FlexGrow, flexGrow)
  }

  private setFlexShrink(flexShrink: number | undefined): void {
    this.yogaSetFloat(YogaFloatKind.FlexShrink, flexShrink)
  }

  private setFlexBasis(flexBasis: number | "auto" | `${number}%` | undefined): void {
    this.yogaSetValue(YogaValueKind.FlexBasis, NATIVE_EDGE_NONE, flexBasis)
  }

  private setWidth(width: number | "auto" | `${number}%`): void {
    this.yogaSetValue(YogaValueKind.Width, NATIVE_EDGE_NONE, width)
  }

  private setHeight(height: number | "auto" | `${number}%`): void {
    this.yogaSetValue(YogaValueKind.Height, NATIVE_EDGE_NONE, height)
  }

  private setMinWidth(minWidth: number | `${number}%` | undefined): void {
    this.yogaSetValue(YogaValueKind.MinWidth, NATIVE_EDGE_NONE, minWidth)
  }

  private setMaxWidth(maxWidth: number | `${number}%` | undefined): void {
    this.yogaSetValue(YogaValueKind.MaxWidth, NATIVE_EDGE_NONE, maxWidth)
  }

  private setMinHeight(minHeight: number | `${number}%` | undefined): void {
    this.yogaSetValue(YogaValueKind.MinHeight, NATIVE_EDGE_NONE, minHeight)
  }

  private setMaxHeight(maxHeight: number | `${number}%` | undefined): void {
    this.yogaSetValue(YogaValueKind.MaxHeight, NATIVE_EDGE_NONE, maxHeight)
  }

  private setMargin(edge: Edge, margin: number | "auto" | `${number}%` | undefined): void {
    this.yogaSetValue(YogaValueKind.Margin, edge, margin)
  }

  getMargin(edge: Edge): Value {
    return this.yogaGetValue(YogaValueKind.Margin, edge)
  }

  private setPadding(edge: Edge, padding: number | `${number}%` | undefined): void {
    this.yogaSetValue(YogaValueKind.Padding, edge, padding)
  }

  protected setGap(gutter: Gutter, gap: number | `${number}%` | undefined): void {
    this.yogaSetValue(YogaValueKind.Gap, gutter, gap)
  }

  getWidth(): Value {
    return this.yogaGetValue(YogaValueKind.Width, NATIVE_EDGE_NONE)
  }

  // Declared style, with the types of the matching standalone Yoga Node getters. Pending writes are visible.
  getFlexWrap(): Wrap {
    return this.yogaGetEnum(YogaEnumKind.FlexWrap, Wrap.NoWrap) as Wrap
  }

  getAlignItems(): Align {
    return this.yogaGetEnum(YogaEnumKind.AlignItems, Align.Stretch) as Align
  }

  getJustifyContent(): Justify {
    return this.yogaGetEnum(YogaEnumKind.JustifyContent, Justify.FlexStart) as Justify
  }

  getAlignSelf(): Align {
    return this.yogaGetEnum(YogaEnumKind.AlignSelf, Align.Auto) as Align
  }

  getPositionType(): PositionType {
    return this.yogaGetEnum(YogaEnumKind.PositionType, PositionType.Relative) as PositionType
  }

  getFlexGrow(): number {
    return this.yogaGetFloat(YogaFloatKind.FlexGrow)
  }

  getFlexShrink(): number {
    return this.yogaGetFloat(YogaFloatKind.FlexShrink)
  }

  getFlexBasis(): Value {
    return this.yogaGetValue(YogaValueKind.FlexBasis, NATIVE_EDGE_NONE)
  }

  getHeight(): Value {
    return this.yogaGetValue(YogaValueKind.Height, NATIVE_EDGE_NONE)
  }

  getMinWidth(): Value {
    return this.yogaGetValue(YogaValueKind.MinWidth, NATIVE_EDGE_NONE)
  }

  getMinHeight(): Value {
    return this.yogaGetValue(YogaValueKind.MinHeight, NATIVE_EDGE_NONE)
  }

  getMaxWidth(): Value {
    return this.yogaGetValue(YogaValueKind.MaxWidth, NATIVE_EDGE_NONE)
  }

  getMaxHeight(): Value {
    return this.yogaGetValue(YogaValueKind.MaxHeight, NATIVE_EDGE_NONE)
  }

  getPadding(edge: Edge): Value {
    return this.yogaGetValue(YogaValueKind.Padding, edge)
  }

  getGap(gutter: Gutter): Value {
    return this.yogaGetValue(YogaValueKind.Gap, gutter)
  }

  getComputedLayout(): Layout {
    const { left, top, right, bottom, width, height } = this._ctx.nativeScene.getLayout(this, true)
    return { left, top, right, bottom, width, height }
  }

  private setMeasureFunc(measure: MeasureFunction | null): void {
    this.assertMutable()
    this._ctx.nativeScene.setMeasureFunc(this, measure)
  }

  private hasMeasureFunc(): boolean {
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
    positionType ??= "relative"
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
    overflow ??= "visible"
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

  // A present nullish key unsets its edge, as when the option is omitted. An absent or invalid key keeps it.
  private updateYogaPosition(position: Position): void {
    const units = new Uint32Array(positionKeys.length)
    const values = new Float32Array(positionKeys.length)
    let mask = 0
    for (let edge = 0; edge < positionKeys.length; edge++) {
      const key = positionKeys[edge]
      const input = position[key] ?? undefined
      if (!(key in position) || (input !== undefined && !isPositionType(input))) continue
      const value = parseYogaValue(input)
      mask |= 1 << edge
      units[edge] = value.unit
      values[edge] = value.value
    }
    this._ctx.nativeScene.setPositions(this, mask, units, values)
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
    this.setStyleValue(YogaValueKind.FlexBasis, NATIVE_EDGE_NONE, basis, isFlexBasisType)
  }

  public set minWidth(minWidth: number | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.MinWidth, NATIVE_EDGE_NONE, minWidth, isSizeType)
  }

  public set maxWidth(maxWidth: number | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.MaxWidth, NATIVE_EDGE_NONE, maxWidth, isSizeType)
  }

  public set minHeight(minHeight: number | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.MinHeight, NATIVE_EDGE_NONE, minHeight, isSizeType)
  }

  public set maxHeight(maxHeight: number | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.MaxHeight, NATIVE_EDGE_NONE, maxHeight, isSizeType)
  }

  public set margin(margin: number | "auto" | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.Margin, Edge.All, margin, isMarginType)
  }

  public set marginX(marginX: number | "auto" | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.Margin, Edge.Horizontal, marginX, isMarginType)
  }

  public set marginY(marginY: number | "auto" | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.Margin, Edge.Vertical, marginY, isMarginType)
  }

  public set marginTop(margin: number | "auto" | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.Margin, Edge.Top, margin, isMarginType)
  }

  public get marginTop(): number | "auto" | `${number}%` {
    return this.getMargin(Edge.Top).value
  }

  public set marginRight(margin: number | "auto" | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.Margin, Edge.Right, margin, isMarginType)
  }

  public set marginBottom(margin: number | "auto" | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.Margin, Edge.Bottom, margin, isMarginType)
  }

  public set marginLeft(margin: number | "auto" | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.Margin, Edge.Left, margin, isMarginType)
  }

  public set padding(padding: number | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.Padding, Edge.All, padding, isPaddingType)
  }

  public set paddingX(paddingX: number | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.Padding, Edge.Horizontal, paddingX, isPaddingType)
  }

  public set paddingY(paddingY: number | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.Padding, Edge.Vertical, paddingY, isPaddingType)
  }

  public set paddingTop(padding: number | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.Padding, Edge.Top, padding, isPaddingType)
  }

  public set paddingRight(padding: number | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.Padding, Edge.Right, padding, isPaddingType)
  }

  public set paddingBottom(padding: number | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.Padding, Edge.Bottom, padding, isPaddingType)
  }

  public set paddingLeft(padding: number | `${number}%` | null | undefined) {
    this.setStyleValue(YogaValueKind.Padding, Edge.Left, padding, isPaddingType)
  }

  // A nullish value unsets the style, as when the option is omitted, so an edge falls back to its shorthand again.
  private setStyleValue(
    kind: (typeof YogaValueKind)[keyof typeof YogaValueKind],
    edge: number,
    value: number | "auto" | `${number}%` | null | undefined,
    isValid: (value: unknown) => boolean,
  ): void {
    if (value != null && !isValid(value)) return
    this.yogaSetValue(kind, edge, value ?? undefined)
    this.requestRender()
  }

  public setMeasureProvider(provider: MeasureFunction | null): void {
    if (this.isFreed()) return
    const node = this
    node.runMutation(() => {
      node.setMeasureFunc(provider)
      this.requestRender()
    })
  }

  public invalidateIntrinsicSize(): void {
    if (this.isFreed()) return
    const node = this
    node.assertMutable()
    if (node.hasMeasureFunc()) this._ctx.nativeScene.markDirty(this)
  }

  public getLayout(): Readonly<Layout> {
    if (this.isFreed()) throw new Error("Renderable is destroyed")
    return this.getComputedLayout()
  }

  protected onLayoutResize(width: number, height: number): void {
    if (this._visible) {
      // TODO: Should probably .markDirty()
      this.handleFrameBufferResize(width, height)
      this._hooks.onResize.call(this, width, height)
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
      if (previous !== target) {
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
      if (lifecycle)
        for (const [passes, active] of lifecycle) {
          if (active) passes.add(child)
          else passes.delete(child)
        }
      this.runCleanup((run) => {
        if (previous !== target && (child._focused || child.hasFocusedDescendant))
          for (const start of [previous, target])
            for (let parent = start; parent; parent = parent.parent) parent.markDirty()
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
        if (renderable._focused || renderable.hasFocusedDescendant) {
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
    if (this.isFreed()) return
    this._ctx.nativeScene.setPaint(this, paint)
  }

  static {
    Object.defineProperty(this.prototype, "selectable", {
      configurable: true,
      get(this: Renderable) {
        return this._selectable
      },
      set(this: Renderable, value: boolean) {
        if (this.isFreed()) return
        this.assertMutable()
        this._selectable = value
      },
    })
  }

  private static normalizeHook(name: (typeof hookNames)[number], value: unknown): unknown {
    if (value == null && name !== "renderSelf" && name !== "onResize" && name !== "onLayoutResize") {
      return name === "onUpdate" ? Renderable.baseHooks.onUpdate : name === "onLifecyclePass" ? null : undefined
    }
    if (typeof value !== "function") throw new TypeError(`Invalid ${name} hook`)
    return value
  }

  private setHook(name: "renderBefore" | "renderAfter" | "onLifecyclePass", value: unknown): void {
    value = Renderable.normalizeHook(name, value)
    if (value === this._hooks[name]) return
    const hooks = { ...this._hooks, [name]: value }
    if (name !== "onLifecyclePass") return this.publishHooks(hooks)
    // A lifecycle pass sets no native hook bit; only its registration changes.
    this._hooks = hooks
    this.syncLifecyclePass()
  }

  private syncLifecyclePass(): void {
    if (!this.onLifecyclePass) this._ctx.unregisterLifecyclePass(this)
    else if (this.parent) this._ctx.registerLifecyclePass(this)
    else this._ctx.nativeScene.lifecyclePasses.refresh(this)
  }

  /** Adopt hooks that an instance class field, `Object.defineProperty`, or an instance assignment of a
   * protected hook method supplied. Until this call, the node runs the hooks of its class. */
  public refreshHooks(): void {
    if (this._isDestroyed) return
    this.assertMutable()
    const hooks = {} as Hooks
    for (const name of hookNames) hooks[name] = Renderable.normalizeHook(name, this[name])
    this.publishHooks(hooks)
    // Later assignments of the public hooks go through their setters again.
    for (const name of ["renderBefore", "renderAfter", "onLifecyclePass"] as const) {
      if (!Object.hasOwn(this, name)) continue
      delete this[name]
      // A prototype data property shadows the setter; keep the adopted value on the instance.
      if (this[name] !== hooks[name]) Reflect.set(this, name, hooks[name])
    }
    this.syncLifecyclePass()
    this._refreshNativeSceneSurface()
    this.requestRender()
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

  private needsHostResize(onResize: unknown): boolean {
    const resize = this.nativeIntegration.lifecycle?.resize
    return onResize !== Renderable.baseHooks.onResize && onResize !== resize?.native
  }

  private hostUpdateFlags(onUpdate: unknown): number {
    if (this._animationFps !== undefined) return NativeSceneHook.Update
    const update = this.nativeIntegration.lifecycle?.update
    if (update && onUpdate === update.idle) {
      return update.active(this) ? NativeSceneHook.Update : NativeSceneHook.IdleUpdate
    }
    return onUpdate === Renderable.baseHooks.onUpdate ? 0 : NativeSceneHook.Update
  }

  protected refreshNativeSceneHooks(): void {
    this.publishHooks(this._hooks)
  }

  /** @internal Retained surfaces restore their binding accessor when hooks are refreshed. */
  _refreshNativeSceneSurface(): void {}

  /** Publish the flags for `hooks`, then adopt them. `pending` carries listener changes that are about to apply. */
  private publishHooks(
    hooks: Hooks,
    pending: { resize?: number; layout?: number; lineInfo?: boolean; sizeChange?: unknown } = {},
  ): void {
    if (!this.isFreed()) {
      const integration = this.nativeIntegration
      const resize =
        this.buffered ||
        hooks.onLayoutResize !== Renderable.baseHooks.onLayoutResize ||
        this.needsHostResize(hooks.onResize)
      const sizeChange = "sizeChange" in pending ? pending.sizeChange : this._sizeChangeListener
      const lineInfo = pending.lineInfo ?? (!!integration.lineInfo && this.listenerCount("line-info-change") > 0)
      const flags =
        (hooks.renderBefore ? NativeSceneHook.RenderBefore : 0) |
        (hooks.renderAfter ? NativeSceneHook.RenderAfter : 0) |
        (this.usesNativeDrawing(hooks.renderSelf) ? 0 : NativeSceneHook.RenderSelf) |
        this.hostUpdateFlags(hooks.onUpdate) |
        (integration.lifecycle?.scroll?.active(this) ? NativeSceneHook.Scroll : 0) |
        (resize || sizeChange || (pending.resize ?? this.listenerCount("resize")) > 0 ? NativeSceneHook.Resize : 0) |
        ((pending.layout ?? this.listenerCount(LayoutEvents.LAYOUT_CHANGED)) > 0 ? NativeSceneHook.LayoutChanged : 0)
      const generation = this._nativeSceneHookGeneration + 1n
      if (flags !== 0 || lineInfo || this._nativeSceneHooksRegistered) {
        let nativeFlags = flags
        if (integration.beforeAfter === false) nativeFlags &= ~nativeSceneHookBeforeAfter
        if (!resize && integration.lifecycle?.resize) {
          nativeFlags =
            (nativeFlags & ~NativeSceneHook.Resize) | (lineInfo && integration.lineInfo ? NativeSceneHook.Resize : 0)
        }
        if (nativeFlags & NativeSceneHook.RenderSelf) nativeFlags |= NativeSceneHook.RenderAfter
        const scene = this._ctx.nativeScene
        scene.setHooks(this, nativeFlags, generation, this.styledDimension("width"), this.styledDimension("height"))
        this._nativeSceneHooksRegistered = true
      }
      this._nativeSceneResize = resize
      this._nativeSceneHookGeneration = generation
    }
    this._hooks = hooks
  }

  /** @internal Refresh only requested host hooks, never walk wrappers to collect layout. */
  _runNativeSceneHook(request: NativeSceneFrameRequest, deltaTime: number): void {
    if (this._isDestroyed || request.hookGeneration !== this._nativeSceneHookGeneration) return
    this.observeLayout(request.publicLayout)
    this._paintLayout = request.paintLayout
    try {
      switch (request.kind) {
        case NativeSceneFrame.Update:
          if (this._animationFps !== undefined) {
            this.animationDrawnFrame = this._ctx.frameId
            if (!this.stopAnimationTick) this.updateAnimationTick()
          }
          this._hooks.onUpdate.call(this, deltaTime)
          break
        case NativeSceneFrame.Resize:
          if (this._nativeSceneResize) {
            this._hooks.onLayoutResize.call(this, request.width, request.height)
          } else {
            const resize = this.nativeIntegration.lifecycle?.resize
            if (!resize) {
              this.onSizeChange?.call(this)
              if (!this._isDestroyed) this.emit("resize")
            }
            if (!this._isDestroyed && this.nativeIntegration.lineInfo) this.emit("line-info-change")
          }
          break
        case NativeSceneFrame.LayoutChanged:
          this.emit(LayoutEvents.LAYOUT_CHANGED)
          break
        case NativeSceneFrame.Scroll:
          this.nativeIntegration.lifecycle?.scroll?.notify(this)
          break
      }
    } finally {
      this._paintLayout = undefined
    }
  }

  /** @internal Record this node's paint hooks for one slot. Native code paints the
   * recording at the slot's prepared position after every slot has recorded. */
  _recordNativeScenePaint(
    slot: NativeScenePaintSlot,
    index: number,
    deltaTime: number,
    frame: OptimizedBuffer,
    recorder: NativePaintRecorder,
    publicLayout: NativeSceneLayout | undefined,
  ): void {
    // Native code paints the phases the slot requested even if an earlier hook changed this
    // node's hooks, so record them with the current methods instead of skipping the slot.
    if (this._isDestroyed) return
    this.observeLayout(publicLayout)
    this._paintLayout = slot.paintLayout
    // Buffered bodies draw into their own buffer. When native code composes that buffer, it
    // plays the recording into it after clearing it, so those hooks record like the rest.
    const buffer =
      this.nativeIntegration.paintBuffer !== "destination" &&
      this.nativeIntegration.bufferComposition !== "native" &&
      this.buffered &&
      this.frameBuffer
        ? this.frameBuffer
        : frame
    try {
      if (slot.hooks & NativeSceneHook.RenderBefore) {
        recorder.slot(index, NativeScenePaintPhase.Before, slot.opacity)
        this._hooks.renderBefore?.call(this, buffer, deltaTime)
        // Native code drops a node destroyed by its own hook, with its recording.
        if (this._isDestroyed) return
      }
      if (slot.hooks & NativeSceneHook.RenderSelf) {
        recorder.slot(index, NativeScenePaintPhase.Self, slot.opacity)
        if (this.nativeIntegration.beforeAfter === false) this.markClean()
        this._invokeNativePaint(buffer, deltaTime)
        if (this._isDestroyed) return
      }
      if (slot.hooks & NativeSceneHook.RenderAfter) {
        recorder.slot(index, NativeScenePaintPhase.After, slot.opacity)
        if (this.nativeIntegration.beforeAfter !== false) {
          this._hooks.renderAfter?.call(this, buffer, deltaTime)
          this.markClean()
        }
        if (
          !this._isDestroyed &&
          this.nativeIntegration.bufferComposition !== "native" &&
          this.buffered &&
          this.frameBuffer
        )
          frame.drawFrameBuffer(Math.trunc(this._screenX), Math.trunc(this._screenY), this.frameBuffer)
      }
    } finally {
      this._paintLayout = undefined
    }
  }

  protected _invokeNativePaint(buffer: OptimizedBuffer, deltaTime: number): void {
    this._hooks.renderSelf.call(this, buffer, deltaTime)
  }

  public get isDestroyed(): boolean {
    return this._isDestroyed
  }

  public destroy(): void {
    if (this._isDestroyed || this._cleanupInProgress || this._childCleanupInProgress) {
      return
    }

    this.assertMutable()
    this.destroyLayoutBacking((run) => {
      run(() => this.destroyOwnedResources())
      // Read before listeners run: one may move or clear the focus.
      const heldFocus = this._focused || this.hasFocusedDescendant
      this._isDestroyed = true
      this.updateAnimationTick()
      run(() => this.emit(RenderableEvents.DESTROYED))

      if (heldFocus) run(() => this.propagateFocusChange(false))
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
    const cleanupOwners = this._ctx.nativeScene.cleanupOwners
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
    for (const node of this._ctx.nativeScene.cleanupOwners) {
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
    const cleanupOwners = scene.cleanupOwners
    const ownsCompletion = !cleanupOwners.has(this)
    cleanupOwners.add(this)
    this.runCleanup((run) => {
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
    this._ctx.nativeScene.cleanupOwners.delete(this)
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
    this.publishHooks(this._hooks, { resize, layout, lineInfo: lineInfo > 0 })
    this.runCleanup((run) => {
      run(change)
      // Meta-listeners can mutate subscriptions or throw. Keep their accepted changes rather than rolling them back.
      run(() => {
        if (!this._isDestroyed) this.publishHooks(this._hooks)
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
      this.publishHooks(this._hooks, { sizeChange: handler })
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
  static override readonly nativeIntegration: NativeRenderableIntegration = {
    ...Renderable.nativeIntegration,
    kind: "root",
  }
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
