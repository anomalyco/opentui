import { EventEmitter } from "events"
import type { KeyEvent } from "../lib/KeyHandler.js"
import { parseColor, RGBA, type ColorInput } from "../lib/RGBA.js"
import {
  parseAlign,
  parseAlignItems,
  parseFlexDirection,
  parseJustify,
  parseWrap,
  type FlexDirectionString,
} from "../lib/yoga.options.js"
import type { BaseRenderable, Renderable } from "../Renderable.js"
import { Edge, FlexDirection, Gutter } from "../yoga.js"
import {
  sceneSetEnum,
  sceneSetFloat,
  sceneSetValue,
  YogaEnumKind,
  YogaFloatKind,
  YogaValueKind,
} from "../yoga.internal.js"
import type { NativeScene } from "../NativeScene.js"
import {
  NATIVE_EDGE_NONE,
  NativeStyleFlags,
  type NativeSceneRect,
  type NativeSceneScrollBarOptions,
  type SceneNodeHandle,
} from "../zig.js"
import type { BoxOptions } from "./Box.js"
import type { VNode } from "./composition/vnode.js"
import { ScrollBarRenderable, scrollUnitSize, type ArrowOptions, type ScrollUnit } from "./ScrollBar.js"
import type { ScrollBoxRenderable } from "./ScrollBox.js"

export type SceneStyleNode = { _getSceneHandle(owner: NativeScene): SceneNodeHandle }

/** A ScrollBox part: plain geometry and events over the box's native scroll state, not a renderable. */
abstract class ScrollBoxPart extends EventEmitter {
  /** `event` is the notification this part emits, if any. */
  constructor(
    protected readonly box: ScrollBoxRenderable,
    event?: string,
  ) {
    super()
    // Listeners of the part's event decide whether the box asks native for SCROLL requests. A new listener is not
    // counted yet.
    this.on("newListener", (name) => name === event && box._refreshScrollHook(true))
    this.on("removeListener", (name) => name === event && box._refreshScrollHook())
  }

  protected abstract rect(): NativeSceneRect

  /** A part lives as long as its box. */
  get isDestroyed(): boolean {
    return this.box.isDestroyed
  }

  get x(): number {
    return this.rect().x
  }

  get y(): number {
    return this.rect().y
  }

  get screenX(): number {
    return this.rect().x
  }

  get screenY(): number {
    return this.rect().y
  }

  get width(): number {
    return this.rect().width
  }

  get height(): number {
    return this.rect().height
  }

  /** @internal Whether a listener needs the box's SCROLL request. */
  abstract _listening(): boolean

  // Keep the two listeners above, which a removal of every listener would drop.
  override removeAllListeners(event?: string | symbol): this {
    for (const name of event === undefined ? this.eventNames() : [event]) {
      if (name !== "newListener" && name !== "removeListener") super.removeAllListeners(name)
    }
    return this
  }

  /** @internal Apply the option keys a part keeps, in order; the others are ignored. */
  _assign(options: object | undefined, keys: readonly string[]): void {
    if (options == null) return
    for (const key of Reflect.ownKeys(options)) {
      if (typeof key !== "string" || !keys.includes(key)) continue
      if (!Object.getOwnPropertyDescriptor(options, key)?.enumerable) continue
      ;(this as unknown as Record<string, unknown>)[key] = Reflect.get(options, key)
      if (this.box.isDestroyed) return
    }
  }
}

/** A fill color, as `backgroundColor` on today's part boxes; transparent paints nothing. */
abstract class ScrollBoxFilledPart extends ScrollBoxPart {
  private _backgroundColor?: RGBA

  get backgroundColor(): RGBA {
    return RGBA.clone(this._backgroundColor ?? RGBA.fromValues(0, 0, 0, 0))
  }

  set backgroundColor(value: ColorInput | null | undefined) {
    this._backgroundColor = value == null ? undefined : RGBA.clone(parseColor(value))
    this.box._applyScrollOptions()
  }

  /** @internal */
  _fill(): RGBA | undefined {
    return this._backgroundColor
  }
}

/** A part whose size changes reach `"resize"` listeners and `onSizeChange`. */
abstract class ScrollBoxSizedPart extends ScrollBoxFilledPart {
  private _onSizeChange?: () => void

  constructor(box: ScrollBoxRenderable) {
    super(box, "resize")
  }

  get onSizeChange(): (() => void) | undefined {
    return this._onSizeChange
  }

  set onSizeChange(handler: (() => void) | null | undefined) {
    this._onSizeChange = handler ?? undefined
    this.box._refreshScrollHook()
  }

  _listening(): boolean {
    return this._onSizeChange !== undefined || this.listenerCount("resize") > 0
  }

  /** @internal */
  _emitResize(): void {
    this._onSizeChange?.()
    if (!this.box.isDestroyed) this.emit("resize")
  }
}

/** The box's inner rect minus the vertical bar's gutter. */
export class ScrollBoxWrapper extends ScrollBoxFilledPart {
  static readonly keys = ["backgroundColor"] as const

  _listening(): boolean {
    return false
  }

  protected rect(): NativeSceneRect {
    return this.box._wrapperRect()
  }
}

const paddingKeys = ["padding", "paddingX", "paddingY", "paddingLeft", "paddingTop", "paddingRight", "paddingBottom"]

/** The hidden viewport node: the culling window and the children's clip, with the viewport padding in cells. */
export class ScrollBoxViewport extends ScrollBoxSizedPart {
  static readonly keys = ["backgroundColor", "onSizeChange", ...paddingKeys]
  private readonly paddings: Partial<Record<string, number>> = {}

  constructor(box: ScrollBoxRenderable) {
    super(box)
    // Each edge reads back resolved; the shorthands are write-only.
    paddingKeys.forEach((key, index) =>
      Object.defineProperty(this, key, {
        configurable: true,
        get: index < 3 ? undefined : () => this._edges()[index - 3],
        set: (value: number | null | undefined) => this.setPadding(key, value),
      }),
    )
  }

  protected rect(): NativeSceneRect {
    return this.box._scrollState().viewport
  }

  private setPadding(key: string, value: number | null | undefined): void {
    if (value != null && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff)) {
      throw new RangeError("ScrollBox viewport padding must be a whole number of cells")
    }
    if (value == null) delete this.paddings[key]
    else this.paddings[key] = value
    this.box._applyScrollOptions()
  }

  /** @internal Left, top, right, bottom, resolved like Yoga edges: an edge, then its axis, then all. */
  _edges(): number[] {
    const p = this.paddings
    const all = p.padding ?? 0
    const x = p.paddingX ?? all
    const y = p.paddingY ?? all
    return [p.paddingLeft ?? x, p.paddingTop ?? y, p.paddingRight ?? x, p.paddingBottom ?? y]
  }
}

// Padding accessors come from the constructor.
export interface ScrollBoxViewport {
  padding: number | null | undefined
  paddingX: number | null | undefined
  paddingY: number | null | undefined
  get paddingLeft(): number
  set paddingLeft(value: number | null | undefined)
  get paddingTop(): number
  set paddingTop(value: number | null | undefined)
  get paddingRight(): number
  set paddingRight(value: number | null | undefined)
  get paddingBottom(): number
  set paddingBottom(value: number | null | undefined)
}

type StyleWrite = (scene: NativeScene, node: SceneStyleNode, value: any) => void
const content = NativeStyleFlags.Content

/** Layout keys of the content node, written with the content target. */
const contentStyles: Record<string, StyleWrite> = {}
{
  const value =
    (kind: (typeof YogaValueKind)[keyof typeof YogaValueKind], edge: number = NATIVE_EDGE_NONE): StyleWrite =>
    (scene, node, input) =>
      sceneSetValue(scene, node, kind, edge, input ?? undefined, content)
  const enums: [string, (typeof YogaEnumKind)[keyof typeof YogaEnumKind], (value: any) => number][] = [
    ["flexDirection", YogaEnumKind.FlexDirection, parseFlexDirection],
    ["flexWrap", YogaEnumKind.FlexWrap, parseWrap],
    ["alignItems", YogaEnumKind.AlignItems, parseAlignItems],
    ["justifyContent", YogaEnumKind.JustifyContent, parseJustify],
    ["alignSelf", YogaEnumKind.AlignSelf, parseAlign],
  ]
  for (const [key, kind, parse] of enums) {
    contentStyles[key] = (scene, node, input) => sceneSetEnum(scene, node, kind, parse(input ?? undefined), content)
  }
  contentStyles.flexGrow = (scene, node, input) =>
    sceneSetFloat(scene, node, YogaFloatKind.FlexGrow, input ?? 0, content)
  contentStyles.flexShrink = (scene, node, input) =>
    sceneSetFloat(scene, node, YogaFloatKind.FlexShrink, input ?? 0, content)
  for (const [key, kind] of [
    ["width", YogaValueKind.Width],
    ["height", YogaValueKind.Height],
    ["flexBasis", YogaValueKind.FlexBasis],
    ["minWidth", YogaValueKind.MinWidth],
    ["minHeight", YogaValueKind.MinHeight],
    ["maxWidth", YogaValueKind.MaxWidth],
    ["maxHeight", YogaValueKind.MaxHeight],
  ] as const) {
    contentStyles[key] = value(kind)
  }
  for (const [suffix, edge] of [
    ["", Edge.All],
    ["X", Edge.Horizontal],
    ["Y", Edge.Vertical],
    ["Top", Edge.Top],
    ["Right", Edge.Right],
    ["Bottom", Edge.Bottom],
    ["Left", Edge.Left],
  ] as const) {
    contentStyles[`padding${suffix}`] = value(YogaValueKind.Padding, edge)
    contentStyles[`margin${suffix}`] = value(YogaValueKind.Margin, edge)
  }
  contentStyles.gap = value(YogaValueKind.Gap, Gutter.All)
  contentStyles.rowGap = value(YogaValueKind.Gap, Gutter.Row)
  contentStyles.columnGap = value(YogaValueKind.Gap, Gutter.Column)
}

/** The hidden content node: the box's children lay out in it, and it moves with the offset. */
export class ScrollBoxContent extends ScrollBoxSizedPart {
  static readonly keys = ["backgroundColor", "onSizeChange", "viewportCulling", ...Object.keys(contentStyles)]
  private readonly styles = new Map<string, unknown>()

  constructor(box: ScrollBoxRenderable) {
    super(box)
    for (const key of Object.keys(contentStyles)) {
      // Reads of width and height stay the content's size; writes set its style.
      const size = key === "width" || key === "height"
      Object.defineProperty(this, key, {
        configurable: true,
        enumerable: false,
        get: () => (size ? this.rect()[key] : this.styles.get(key)),
        set: (input: unknown) => this.setStyle(key, input),
      })
    }
  }

  protected rect(): NativeSceneRect {
    const { content, offset } = this.box._scrollState()
    return {
      x: this.box.screenX + content.x - offset[0],
      y: this.box.screenY + content.y - offset[1],
      width: content.width,
      height: content.height,
    }
  }

  // The value is kept only once its write was accepted.
  private setStyle(key: string, input: unknown): void {
    this.box._setContentStyle((scene, node) => contentStyles[key](scene, node, input))
    if (input == null) this.styles.delete(key)
    else this.styles.set(key, input)
  }

  /** @internal Whether children lay out in a row, by the direction native was given. */
  get _row(): boolean {
    const direction = parseFlexDirection(this.styles.get("flexDirection") as FlexDirectionString | undefined)
    return direction === FlexDirection.Row || direction === FlexDirection.RowReverse
  }

  get viewportCulling(): boolean {
    return this.box.viewportCulling
  }

  set viewportCulling(value: boolean) {
    this.box.viewportCulling = value
  }

  add(obj: Renderable | VNode<any, any[]>, index?: number): number {
    return this.box.add(obj, index)
  }

  insertBefore(obj: Renderable | VNode<any, any[]> | unknown, anchor?: Renderable | unknown): number {
    return this.box.insertBefore(obj, anchor)
  }

  remove(child: BaseRenderable): void {
    this.box.remove(child)
  }

  getChildren(): Renderable[] {
    return this.box.getChildren()
  }

  getChildrenCount(): number {
    return this.box.getChildrenCount()
  }

  getRenderable(id: string): Renderable | undefined {
    return this.box.getRenderable(id)
  }

  findDescendantById(id: string): Renderable | undefined {
    return this.box.findDescendantById(id)
  }
}

const defaultTrack = RGBA.fromHex("#252527")
const defaultThumb = RGBA.fromHex("#9a9ea3")
const defaultArrowForeground = RGBA.fromValues(1, 1, 1, 1)
const defaultArrowBackground = RGBA.fromValues(0, 0, 0, 0)

/** A scrollbar: its track, thumb and arrows paint natively from the box's scroll state. */
export class ScrollBoxBar extends ScrollBoxPart {
  static readonly keys = [
    "visible",
    "showArrows",
    "arrowOptions",
    "trackOptions",
    "onChange",
    "width",
    "height",
    "paddingLeft",
    "paddingTop",
    "position",
    "scrollStep",
  ] as const
  readonly orientation: "vertical" | "horizontal"
  scrollStep: number | undefined | null = null
  private readonly axis: number
  private policy: NativeSceneScrollBarOptions["policy"] = "auto"
  private _showArrows = false
  private _arrowOptions: Omit<ArrowOptions, "direction"> = {}
  private trackForeground = defaultThumb
  private trackBackground = defaultTrack
  private thickness = 1
  private gap = 0
  private overlay = false
  private _onChange?: (position: number) => void

  constructor(box: ScrollBoxRenderable, orientation: "vertical" | "horizontal") {
    super(box, "change")
    this.orientation = orientation
    this.axis = orientation === "vertical" ? 1 : 0
  }

  protected rect(): NativeSceneRect {
    const bar = this.box._scrollState().bars[this.axis]
    const arrows = this._showArrows ? 1 : 0
    return this.axis === 1
      ? {
          x: bar.track.x - this.gap,
          y: bar.track.y - arrows,
          width: bar.track.width + this.gap,
          height: bar.track.height + 2 * arrows,
        }
      : {
          x: bar.track.x - arrows,
          y: bar.track.y - this.gap,
          width: bar.track.width + 2 * arrows,
          height: bar.track.height + this.gap,
        }
  }

  _listening(): boolean {
    return this._onChange !== undefined || this.listenerCount("change") > 0
  }

  /** @internal */
  _native(): NativeSceneScrollBarOptions {
    return {
      policy: this.policy,
      overlay: this.overlay,
      thickness: this.thickness,
      gap: this.gap,
      arrows: this._showArrows,
      foregroundColor: this.trackForeground,
      backgroundColor: this.trackBackground,
    }
  }

  /** @internal The start and end arrows as native arrow options. */
  _arrows(): { attributes: number; foregroundColor: RGBA; backgroundColor: RGBA; text?: string }[] {
    const options = this._arrowOptions
    // As ScrollBarRenderable: given arrow options without a foreground color use the background color.
    const background = options.backgroundColor ?? undefined
    const foreground = options.foregroundColor ?? background
    const chars = options.arrowChars ?? {}
    return (this.axis === 1 ? (["up", "down"] as const) : (["left", "right"] as const)).map((direction) => ({
      attributes: options.attributes ?? 0,
      foregroundColor: RGBA.clone(parseColor(foreground || defaultArrowForeground)),
      backgroundColor: RGBA.clone(parseColor(background || defaultArrowBackground)),
      text: chars[direction],
    }))
  }

  /** @internal */
  _emitChange(position: number): void {
    this._onChange?.(position)
    if (!this.box.isDestroyed) this.emit("change", { position })
  }

  get visible(): boolean {
    return this.box._scrollState().bars[this.axis].visible
  }

  /** True and false hold the bar shown or hidden; a nullish write lets it follow the range again. */
  set visible(value: boolean | null | undefined) {
    this.setOption(() => (this.policy = value == null ? "auto" : value ? "always" : "never"))
  }

  resetVisibilityControl(): void {
    this.visible = null
  }

  get onChange(): ((position: number) => void) | undefined {
    return this._onChange
  }

  set onChange(handler: ((position: number) => void) | null | undefined) {
    this._onChange = handler ?? undefined
    this.box._refreshScrollHook()
  }

  get showArrows(): boolean {
    return this._showArrows
  }

  set showArrows(value: boolean | null | undefined) {
    this.setOption(() => (this._showArrows = value ?? false))
  }

  set arrowOptions(options: Omit<ArrowOptions, "direction"> | null | undefined) {
    this._arrowOptions = { ...this._arrowOptions, ...options }
    if (!this.box.isDestroyed) this.box._applyScrollArrows(this.axis)
  }

  set trackOptions(options: { foregroundColor?: ColorInput; backgroundColor?: ColorInput } | null | undefined) {
    this.setOption(() => {
      if (options && "foregroundColor" in options) {
        this.trackForeground = RGBA.clone(parseColor(options.foregroundColor ?? defaultThumb))
      }
      if (options && "backgroundColor" in options) {
        this.trackBackground = RGBA.clone(parseColor(options.backgroundColor ?? defaultTrack))
      }
    })
  }

  override get width(): number {
    return super.width
  }

  override set width(value: number | string | null | undefined) {
    if (this.axis === 1) this.setOption(() => (this.thickness = Math.max(1, cells(value, 1))))
  }

  override get height(): number {
    return super.height
  }

  override set height(value: number | string | null | undefined) {
    if (this.axis === 0) this.setOption(() => (this.thickness = Math.max(1, cells(value, 1))))
  }

  set paddingLeft(value: number | null | undefined) {
    if (this.axis === 1) this.setOption(() => (this.gap = cells(value, 0)))
  }

  set paddingTop(value: number | null | undefined) {
    if (this.axis === 0) this.setOption(() => (this.gap = cells(value, 0)))
  }

  /** An absolute bar overlays the content's edge instead of taking a gutter. */
  set position(value: "absolute" | "relative" | null | undefined) {
    this.setOption(() => (this.overlay = value === "absolute"))
  }

  private setOption(change: () => void): void {
    if (this.box.isDestroyed) return
    change()
    this.box._applyScrollOptions()
  }

  get scrollSize(): number {
    const { content } = this.box._scrollState()
    return this.axis === 1 ? content.height : content.width
  }

  get viewportSize(): number {
    const { viewport } = this.box._scrollState()
    return this.axis === 1 ? viewport.height : viewport.width
  }

  get scrollPosition(): number {
    return this.box._scrollState().offset[this.axis]
  }

  set scrollPosition(value: number) {
    this.box._scrollAxis(this.axis, value, false)
  }

  // Units and keys are the standalone scrollbar's. A delta adds to a pending target and applies again after layout.
  scrollBy(delta: number, unit: ScrollUnit = "absolute"): void {
    this.box._scrollAxis(this.axis, scrollUnitSize(this, unit) * delta, true, true)
  }

  handleKeyPress(key: KeyEvent): boolean {
    return ScrollBarRenderable.prototype.handleKeyPress.call(this as unknown as ScrollBarRenderable, key)
  }
}

function cells(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(255, Math.trunc(value))) : fallback
}

type Edges = "" | "X" | "Y" | "Top" | "Right" | "Bottom" | "Left"
type ContentLayoutKey =
  | "flexDirection"
  | "flexWrap"
  | "alignItems"
  | "justifyContent"
  | "alignSelf"
  | "flexGrow"
  | "flexShrink"
  | "flexBasis"
  | `${"min" | "max"}${"Width" | "Height"}`
  | `${"padding" | "margin"}${Edges}`
  | "gap"
  | "rowGap"
  | "columnGap"

// The layout keys are accessors that the constructor defines from the style table.
export interface ScrollBoxContent extends ContentLayout {}
type ContentLayout = { [K in ContentLayoutKey]?: BoxOptions[K] | null }
