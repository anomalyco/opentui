import { type KeyEvent } from "../lib/index.js"
import { LinearScrollAccel, type ScrollAcceleration } from "../lib/scroll-acceleration.js"
import { scrollOnce, wheelDirection } from "../lib/scroll-chain.js"
import type { NativeRenderableIntegration } from "../Renderable.js"
import type { MouseEvent } from "../renderer.js"
import type { RenderContext, Timeout } from "../types.js"
import type { NativeScene } from "../NativeScene.js"
import type { NativeSceneRect, NativeSceneScrollState } from "../zig.js"
import { BoxRenderable, type BoxOptions } from "./Box.js"
import type { ScrollBarOptions, ScrollUnit } from "./ScrollBar.js"
import {
  ScrollBoxBar,
  ScrollBoxContent,
  ScrollBoxViewport,
  ScrollBoxWrapper,
  type ScrollBoxHost,
  type SceneStyleNode,
} from "./ScrollBoxParts.js"

export { ScrollBoxBar, ScrollBoxContent, ScrollBoxViewport, ScrollBoxWrapper } from "./ScrollBoxParts.js"

export interface ScrollBoxOptions extends BoxOptions<ScrollBoxRenderable> {
  rootOptions?: BoxOptions
  wrapperOptions?: BoxOptions
  viewportOptions?: BoxOptions
  contentOptions?: BoxOptions
  scrollbarOptions?: Omit<ScrollBarOptions, "orientation">
  verticalScrollbarOptions?: Omit<ScrollBarOptions, "orientation">
  horizontalScrollbarOptions?: Omit<ScrollBarOptions, "orientation">
  stickyScroll?: boolean
  stickyStart?: "bottom" | "top" | "left" | "right"
  scrollX?: boolean
  scrollY?: boolean
  scrollAcceleration?: ScrollAcceleration
  viewportCulling?: boolean
}

const SCROLLBOX_PADDING_KEYS = [
  "padding",
  "paddingX",
  "paddingY",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
] as const

type ScrollBoxPaddingKey = (typeof SCROLLBOX_PADDING_KEYS)[number]
type ScrollBoxPaddingOptions = Pick<ScrollBoxOptions, ScrollBoxPaddingKey>

function pickScrollBoxPadding(options: Partial<ScrollBoxOptions> | undefined): Partial<ScrollBoxPaddingOptions> {
  if (!options) return {}

  const picked: Partial<ScrollBoxPaddingOptions> = {}
  for (const key of SCROLLBOX_PADDING_KEYS) {
    const value = options[key]
    if (value !== undefined) {
      picked[key] = value
    }
  }

  return picked
}

function stripScrollBoxPadding<T extends object>(options: T): Omit<T, ScrollBoxPaddingKey> {
  const sanitized = { ...options }
  for (const key of SCROLLBOX_PADDING_KEYS) {
    delete (sanitized as Partial<Record<ScrollBoxPaddingKey, unknown>>)[key]
  }
  return sanitized as Omit<T, ScrollBoxPaddingKey>
}

const emptyRect: NativeSceneRect = { x: 0, y: 0, width: 0, height: 0 }
const emptyBar = {
  visible: false,
  track: emptyRect,
  startArrow: emptyRect,
  endArrow: emptyRect,
  thumbStart: 0,
  thumbSize: 0,
}
const emptyState: NativeSceneScrollState = {
  stuck: false,
  generation: 0n,
  offset: [0, 0],
  max: [0, 0],
  content: emptyRect,
  viewport: emptyRect,
  bars: [emptyBar, emptyBar],
}

type BarPress = { axis: number; offset: number } | { axis: number; arrow: -1 | 1; timer: Timeout }

/** A box whose scroll offset, range, sticky edge and scrollbars are native state of its scene node. The
 * `wrapper`, `viewport`, `content` and scrollbar fields are facades over that state, not renderables; the
 * box's children are the scrolled content. */
export class ScrollBoxRenderable extends BoxRenderable implements ScrollBoxHost {
  static override readonly nativeIntegration: NativeRenderableIntegration = {
    ...BoxRenderable.nativeIntegration,
    lifecycle: {
      update: {
        idle: this.prototype.onUpdate,
        active: (renderable) => (renderable as ScrollBoxRenderable)["isAutoScrolling"],
      },
      scroll: {
        active: (renderable) => (renderable as ScrollBoxRenderable).scrollHook,
        notify: (renderable) => (renderable as ScrollBoxRenderable).notifyScroll(),
      },
    },
  }
  public readonly wrapper: ScrollBoxWrapper
  public readonly viewport: ScrollBoxViewport
  public readonly content: ScrollBoxContent
  public readonly horizontalScrollBar: ScrollBoxBar
  public readonly verticalScrollBar: ScrollBoxBar

  protected static override readonly defaultFocusable = true
  private selectionListener?: () => void

  private autoScrollMouseX: number = 0
  private autoScrollMouseY: number = 0
  private readonly autoScrollThresholdVertical = 3
  private readonly autoScrollThresholdHorizontal = 3
  private readonly autoScrollSpeedSlow = 6
  private readonly autoScrollSpeedMedium = 36
  private readonly autoScrollSpeedFast = 72
  private isAutoScrolling: boolean = false
  private cachedAutoScrollSpeed: number = 3
  private autoScrollAccumulatorX: number = 0
  private autoScrollAccumulatorY: number = 0

  private scrollAccumulatorX: number = 0
  private scrollAccumulatorY: number = 0

  private _stickyScroll: boolean
  private _stickyStart?: "bottom" | "top" | "left" | "right"
  private scrollAccel: ScrollAcceleration
  private readonly axes: { x: boolean; y: boolean }
  private _viewportCulling: boolean
  // The state native last reported and its layout revision; reads in one revision share one FFI call.
  private state: NativeSceneScrollState = emptyState
  private stateRevision?: number
  // What listeners last heard: offsets, then content size, then viewport size.
  private notified = [0, 0, 0, 0, 0, 0]
  private scrollHook = false
  private configured = false
  private barPress?: BarPress

  get stickyScroll(): boolean {
    return this._stickyScroll
  }

  set stickyScroll(value: boolean) {
    this._stickyScroll = value
    this._applyScrollOptions()
  }

  get stickyStart(): "bottom" | "top" | "left" | "right" | undefined {
    return this._stickyStart
  }

  set stickyStart(value: "bottom" | "top" | "left" | "right" | undefined) {
    this._stickyStart = value
    this._applyScrollOptions()
  }

  /** Whether the box scrolls sideways; on an axis that does not scroll, the content is at most as wide as the viewport. */
  get scrollX(): boolean {
    return this.axes.x
  }

  set scrollX(value: boolean) {
    this.axes.x = value ?? false
    this._applyScrollOptions()
  }

  get scrollY(): boolean {
    return this.axes.y
  }

  set scrollY(value: boolean) {
    this.axes.y = value ?? true
    this._applyScrollOptions()
  }

  get scrollTop(): number {
    return this._scrollState().offset[1]
  }

  set scrollTop(value: number) {
    this._scrollAxis(1, value, false)
  }

  get scrollLeft(): number {
    return this._scrollState().offset[0]
  }

  set scrollLeft(value: number) {
    this._scrollAxis(0, value, false)
  }

  get scrollWidth(): number {
    return this._scrollState().content.width
  }

  get scrollHeight(): number {
    return this._scrollState().content.height
  }

  constructor(ctx: RenderContext, options: ScrollBoxOptions) {
    const {
      wrapperOptions,
      viewportOptions,
      contentOptions,
      rootOptions,
      scrollbarOptions,
      verticalScrollbarOptions,
      horizontalScrollbarOptions,
      stickyScroll = false,
      stickyStart,
      scrollX = false,
      scrollY = true,
      scrollAcceleration,
      viewportCulling = true,
      ...rootBoxOptions
    } = options

    const forwardedContentPadding = {
      ...pickScrollBoxPadding(rootBoxOptions),
      ...pickScrollBoxPadding(rootOptions),
    }

    const sanitizedRootBoxOptions = stripScrollBoxPadding(rootBoxOptions)
    const sanitizedRootOptions = rootOptions ? stripScrollBoxPadding(rootOptions) : undefined

    super(ctx, {
      flexDirection: "row",
      alignItems: "stretch",
      ...(sanitizedRootBoxOptions as BoxOptions),
      ...(sanitizedRootOptions as BoxOptions),
      overflow: "hidden",
    })

    try {
      this._stickyScroll = stickyScroll
      this._stickyStart = stickyStart
      this.scrollAccel = scrollAcceleration ?? new LinearScrollAccel()
      this.axes = { x: scrollX, y: scrollY }
      this._viewportCulling = viewportCulling
      this.wrapper = new ScrollBoxWrapper(this)
      this.viewport = new ScrollBoxViewport(this)
      this.content = new ScrollBoxContent(this, this)
      this.verticalScrollBar = new ScrollBoxBar(this, "vertical")
      this.horizontalScrollBar = new ScrollBoxBar(this, "horizontal")
      this.wrapper._assign(wrapperOptions, ScrollBoxWrapper.keys)
      this.viewport._assign(viewportOptions, ScrollBoxViewport.keys)
      for (const [bar, own] of [
        [this.verticalScrollBar, verticalScrollbarOptions],
        [this.horizontalScrollBar, horizontalScrollbarOptions],
      ] as const) {
        bar._assign(
          { ...scrollbarOptions, ...own, arrowOptions: { ...scrollbarOptions?.arrowOptions, ...own?.arrowOptions } },
          ScrollBoxBar.keys,
        )
      }
      // Native accepts scroll options only before the box has children.
      this.configured = true
      this._applyScrollOptions()
      this._applyScrollArrows(0)
      this._applyScrollArrows(1)
      this.content._assign({ ...forwardedContentPadding, ...contentOptions }, ScrollBoxContent.keys)
      this._refreshScrollHook()

      this.selectionListener = () => {
        if (this.isDestroyed) return
        const selection = this._ctx.getSelection()
        if (!selection || !selection.isDragging) {
          this.stopAutoScroll()
        }
      }
      this._ctx.on("selection", this.selectionListener)
      this.setNativeScenePaint()
    } catch (error) {
      this.abortConstruction(error, (run) => run(() => this.destroySelf()))
    }
  }

  /** @internal */
  _applyScrollOptions(): void {
    if (!this.configured || this.isFreed()) return
    const sticky = this._stickyScroll && this._stickyStart
    this._ctx.nativeScene.setScroll(this, {
      scrollX: this.axes.x,
      scrollY: this.axes.y,
      follow: sticky ? this._stickyStart! : "none",
      culling: this._viewportCulling,
      padding: this.viewport._edges(),
      fills: [this.wrapper._fill(), this.viewport._fill(), this.content._fill()],
      bars: [this.horizontalScrollBar._native(), this.verticalScrollBar._native()],
    })
    this.requestRender()
  }

  /** @internal */
  _applyScrollArrows(axis: number): void {
    if (!this.configured || this.isFreed()) return
    const bar = axis === 1 ? this.verticalScrollBar : this.horizontalScrollBar
    bar._arrows().forEach((arrow, end) => this._ctx.nativeScene.setScrollArrow(this, axis, end, arrow))
    this.requestRender()
  }

  /** @internal Writes a style of the hidden content node. */
  _setContentStyle(apply: (scene: NativeScene, node: SceneStyleNode) => void): void {
    if (this.isFreed()) return
    apply(this._ctx.nativeScene, this)
    this.requestRender()
  }

  /** @internal The scroll state of the last prepared frame or explicit scroll. */
  _scrollState(): NativeSceneScrollState {
    if (this.isFreed()) return this.state
    const revision = this._ctx.nativeScene.observedLayoutRevision
    if (revision !== undefined && revision === this.stateRevision) return this.state
    this.state = this._ctx.nativeScene.getScroll(this)
    this.stateRevision = revision
    return this.state
  }

  /** @internal The box's inner rect without the vertical bar's gutter, as today's wrapper box. */
  _wrapperRect(): NativeSceneRect {
    const { viewport, bars } = this._scrollState()
    const horizontal = bars[0]
    const gutter = horizontal.visible ? horizontal.track.y + horizontal.track.height - viewport.y - viewport.height : 0
    return { ...viewport, height: viewport.height + Math.max(0, gutter) }
  }

  /** @internal An explicit scroll on one axis; `"change"` reaches listeners at once. */
  _scrollAxis(axis: number, value: number, relative: boolean): void {
    if (this.isFreed()) return
    this.assertMutable()
    value ??= 0
    if (Number.isNaN(value)) throw new RangeError("Scene scroll positions must be finite numbers")
    const x = axis === 0 ? value : 0
    const y = axis === 1 ? value : 0
    const before = this._scrollState().offset
    const state = this._ctx.nativeScene.scrollTo(this, x, y, axis !== 0 || relative, axis !== 1 || relative)
    this.state = state
    this.stateRevision = this._ctx.nativeScene.observedLayoutRevision
    if (state.offset[0] !== before[0] || state.offset[1] !== before[1]) this.requestRender()
    this.notifyOffsets(state)
  }

  private notifyOffsets(state: NativeSceneScrollState): void {
    for (const axis of [1, 0]) {
      const position = state.offset[axis]
      if (this.notified[axis] === position) continue
      this.notified[axis] = position
      ;(axis === 1 ? this.verticalScrollBar : this.horizontalScrollBar)._emitChange(position)
      if (this.isDestroyed) return
    }
  }

  private listening(): boolean {
    return (
      this.verticalScrollBar?._listening() ||
      this.horizontalScrollBar?._listening() ||
      this.content?._listening() ||
      this.viewport?._listening() ||
      false
    )
  }

  /** @internal Ask for SCROLL requests only while a part has a listener; `adding` counts one about to be added. */
  _refreshScrollHook(adding = false): void {
    if (!this.configured || this.isFreed()) return
    const listening = adding || this.listening()
    if (listening === this.scrollHook) return
    this.scrollHook = listening
    // Listeners hear changes from now on, not the ones nobody heard.
    const { offset, content, viewport } = this._scrollState()
    this.notified = [offset[0], offset[1], content.width, content.height, viewport.width, viewport.height]
    this.refreshNativeSceneHooks()
  }

  /** A SCROLL request: offsets first, as a sticky follow inside a resize hook did, then sizes. */
  private notifyScroll(): void {
    const state = this._scrollState()
    this.notifyOffsets(state)
    if (this.isDestroyed) return
    const sizes = [state.content.width, state.content.height, state.viewport.width, state.viewport.height]
    const viewportChanged = sizes[2] !== this.notified[4] || sizes[3] !== this.notified[5]
    const contentChanged = sizes[0] !== this.notified[2] || sizes[1] !== this.notified[3]
    this.notified.splice(2, 4, ...sizes)
    if (viewportChanged) this.viewport._emitResize()
    if (contentChanged && !this.isDestroyed) this.content._emitResize()
  }

  public override get primaryAxis(): "row" | "column" {
    return this.content._row ? "row" : "column"
  }

  protected onUpdate(deltaTime: number): void {
    this.handleAutoScroll(deltaTime)
  }

  public scrollBy(delta: number | { x: number; y: number }, unit: ScrollUnit = "absolute"): void {
    if (typeof delta === "number") {
      this.verticalScrollBar.scrollBy(delta, unit)
    } else {
      this.verticalScrollBar.scrollBy(delta.y, unit)
      if (this.isDestroyed) return
      this.horizontalScrollBar.scrollBy(delta.x, unit)
    }
  }

  public scrollChildIntoView(childId: string): void {
    const child = this.findDescendantById(childId)
    if (!child) return

    const getNearestDelta = (
      elementStart: number,
      elementEnd: number,
      viewportStart: number,
      viewportEnd: number,
    ): number => {
      const elementSize = elementEnd - elementStart
      const viewportSize = viewportEnd - viewportStart
      const elementStartOutside = elementStart < viewportStart
      const elementEndOutside = elementEnd > viewportEnd

      if (elementStartOutside && elementEndOutside) {
        return 0
      }

      if ((elementStartOutside && elementSize < viewportSize) || (elementEndOutside && elementSize > viewportSize)) {
        return elementStart - viewportStart
      }

      if ((elementStartOutside && elementSize > viewportSize) || (elementEndOutside && elementSize < viewportSize)) {
        return elementEnd - viewportEnd
      }

      return 0
    }

    const childTop = child.y
    const childBottom = child.y + child.height
    const viewportTop = this.viewport.y
    const viewportBottom = this.viewport.y + this.viewport.height

    const dy = getNearestDelta(childTop, childBottom, viewportTop, viewportBottom)

    const childLeft = child.x
    const childRight = child.x + child.width
    const viewportLeft = this.viewport.x
    const viewportRight = this.viewport.x + this.viewport.width

    const dx = getNearestDelta(childLeft, childRight, viewportLeft, viewportRight)

    if (dx !== 0 || dy !== 0) {
      this.scrollBy({ x: dx, y: dy })
    }
  }

  public scrollTo(position: number | { x: number; y: number }): void {
    if (typeof position === "number") {
      this.scrollTop = position
    } else {
      this.scrollTop = position.y
      if (this.isDestroyed) return
      this.scrollLeft = position.x
    }
  }

  /** Takes a wheel step when the box can still move that way. Acceleration and the fractional remainder belong to the
   * box that takes the step; a reversal or an edge clamp drops the remainder. */
  private scrollByWheel(event: MouseEvent): boolean {
    const dir = wheelDirection(event)
    const vertical = dir === "up" || dir === "down"
    if (!vertical && dir !== "left" && dir !== "right") return false
    const axis = vertical ? 1 : 0
    const sign = dir === "up" || dir === "left" ? -1 : 1
    const { offset, max } = this._scrollState()
    const position = offset[axis]
    if (sign < 0 ? position <= 0 : position >= max[axis]) return false

    let remainder = vertical ? this.scrollAccumulatorY : this.scrollAccumulatorX
    if (remainder * sign < 0) remainder = 0
    remainder += sign * (event.scroll?.delta ?? 0) * this.scrollAccel.tick(Date.now())
    const step = Math.trunc(remainder)
    if (step !== 0) this._scrollAxis(axis, position + step, false)
    // An edge clamp keeps no remainder toward the edge it hit.
    remainder = this._scrollState().offset[axis] - position === step ? remainder - step : 0
    if (vertical) this.scrollAccumulatorY = remainder
    else this.scrollAccumulatorX = remainder
    return true
  }

  protected onMouseEvent(event: MouseEvent): void {
    if (event.type === "scroll") scrollOnce(event, this, () => this.scrollByWheel(event))

    if (this.handleBarMouse(event)) return
    if (event.type === "drag" && event.isDragging) {
      this.updateAutoScroll(event.x, event.y)
    } else if (event.type === "up") {
      this.stopAutoScroll()
    }
  }

  /** Bar cells hit the box: a press on an arrow scrolls and repeats, one on the track jumps there, and a drag that
   * started on the track or thumb moves the thumb with the pointer. */
  private handleBarMouse(event: MouseEvent): boolean {
    const press = this.barPress
    if (press && (event.type === "drag" || event.type === "up" || event.type === "drag-end")) {
      if ("offset" in press && event.type !== "drag-end") this.dragThumb(press, event)
      if (event.type === "up") this.endBarPress()
      event.stopPropagation()
      return true
    }
    // Button 0 is the left button.
    if (event.type !== "down" || event.button !== 0 || event.target !== this) return false
    const { bars } = this._scrollState()
    for (const axis of [1, 0]) {
      const bar = bars[axis]
      if (!bar.visible) continue
      const part = axis === 1 ? this.verticalScrollBar : this.horizontalScrollBar
      const inside = (rect: NativeSceneRect) =>
        event.x >= rect.x && event.x < rect.x + rect.width && event.y >= rect.y && event.y < rect.y + rect.height
      const arrow = part.showArrows ? (inside(bar.startArrow) ? -1 : inside(bar.endArrow) ? 1 : 0) : 0
      if (arrow === 0 && !inside(bar.track)) continue
      event.stopPropagation()
      event.preventDefault()
      this.endBarPress()
      if (arrow !== 0) this.pressArrow(axis, arrow, part)
      else this.pressTrack(axis, event)
      return true
    }
    return false
  }

  private pressArrow(axis: number, arrow: -1 | 1, part: ScrollBoxBar): void {
    const press = { axis, arrow, timer: undefined as Timeout }
    this.barPress = press
    part.scrollBy(arrow * 0.5, "viewport")
    if (this.barPress !== press || this.isDestroyed) return
    press.timer = setTimeout(() => {
      if (this.barPress !== press || this.isDestroyed) return
      part.scrollBy(arrow * 0.5, "viewport")
      if (this.barPress !== press || this.isDestroyed) return
      press.timer = setInterval(() => {
        if (this.barPress !== press || this.isDestroyed) return this.endBarPress()
        part.scrollBy(arrow * 0.2, "viewport")
      }, 200)
    }, 500)
  }

  /** Thumb geometry is in half cells along the track, as the native slider's. */
  private thumbPointer(axis: number, event: MouseEvent): { at: number; length: number; start: number; size: number } {
    const bar = this._scrollState().bars[axis]
    const along = axis === 1 ? event.y - bar.track.y : event.x - bar.track.x
    const length = axis === 1 ? bar.track.height : bar.track.width
    return {
      at: Math.max(0, Math.min(length, along)) * 2,
      length: length * 2,
      start: bar.thumbStart,
      size: bar.thumbSize,
    }
  }

  private pressTrack(axis: number, event: MouseEvent): void {
    let thumb = this.thumbPointer(axis, event)
    const inThumb =
      thumb.at >= Math.floor(thumb.start / 2) * 2 && thumb.at < Math.ceil((thumb.start + thumb.size) / 2) * 2
    if (!inThumb) {
      const max = this._scrollState().max[axis]
      this._scrollAxis(axis, thumb.length === 0 ? 0 : (thumb.at / thumb.length) * max, false)
      if (this.isDestroyed) return
      thumb = this.thumbPointer(axis, event)
    }
    this.barPress = { axis, offset: Math.max(0, Math.min(thumb.size, thumb.at - thumb.start)) }
  }

  private dragThumb(press: { axis: number; offset: number }, event: MouseEvent): void {
    const thumb = this.thumbPointer(press.axis, event)
    const span = Math.max(0, thumb.length - thumb.size)
    const start = Math.max(0, Math.min(span, thumb.at - press.offset))
    this._scrollAxis(press.axis, span === 0 ? 0 : (start / span) * this._scrollState().max[press.axis], false)
  }

  private endBarPress(): void {
    const press = this.barPress
    this.barPress = undefined
    if (press && "timer" in press) clearTimeout(press.timer)
  }

  public handleKeyPress(key: KeyEvent): boolean {
    if (this.verticalScrollBar.handleKeyPress(key) || this.horizontalScrollBar.handleKeyPress(key)) {
      this.scrollAccel.reset()
      this.resetScrollAccumulators()
      return true
    }
    return false
  }

  private resetScrollAccumulators(): void {
    this.scrollAccumulatorX = 0
    this.scrollAccumulatorY = 0
  }

  public startAutoScroll(mouseX: number, mouseY: number): void {
    this.stopAutoScroll()
    this.autoScrollMouseX = mouseX
    this.autoScrollMouseY = mouseY
    this.cachedAutoScrollSpeed = this.getAutoScrollSpeed(mouseX, mouseY)
    this.isAutoScrolling = true
    this.live = true
    this.refreshNativeSceneHooks()
  }

  public updateAutoScroll(mouseX: number, mouseY: number): void {
    this.autoScrollMouseX = mouseX
    this.autoScrollMouseY = mouseY

    // Cache the speed based on current mouse position
    this.cachedAutoScrollSpeed = this.getAutoScrollSpeed(mouseX, mouseY)

    const scrollX = this.getAutoScrollDirectionX(mouseX)
    const scrollY = this.getAutoScrollDirectionY(mouseY)

    if (scrollX === 0 && scrollY === 0) {
      this.stopAutoScroll()
    } else if (!this.isAutoScrolling) {
      this.startAutoScroll(mouseX, mouseY)
    }
  }

  public stopAutoScroll(): void {
    const wasAutoScrolling = this.isAutoScrolling
    this.isAutoScrolling = false
    this.autoScrollAccumulatorX = 0
    this.autoScrollAccumulatorY = 0
    // Auto-scroll is the only reason a ScrollBox goes live or asks for updates.
    if (wasAutoScrolling) {
      this.live = false
      this.refreshNativeSceneHooks()
    }
  }

  private handleAutoScroll(deltaTime: number): void {
    if (!this.isAutoScrolling) return

    const scrollX = this.getAutoScrollDirectionX(this.autoScrollMouseX)
    const scrollY = this.getAutoScrollDirectionY(this.autoScrollMouseY)
    const scrollAmount = this.cachedAutoScrollSpeed * (deltaTime / 1000)

    let scrolled = false

    if (scrollX !== 0) {
      this.autoScrollAccumulatorX += scrollX * scrollAmount
      const integerScrollX = Math.trunc(this.autoScrollAccumulatorX)
      if (integerScrollX !== 0) {
        this.scrollLeft += integerScrollX
        if (this.isDestroyed) return
        this.autoScrollAccumulatorX -= integerScrollX
        scrolled = true
      }
    }

    if (scrollY !== 0) {
      this.autoScrollAccumulatorY += scrollY * scrollAmount
      const integerScrollY = Math.trunc(this.autoScrollAccumulatorY)
      if (integerScrollY !== 0) {
        this.scrollTop += integerScrollY
        if (this.isDestroyed) return
        this.autoScrollAccumulatorY -= integerScrollY
        scrolled = true
      }
    }

    if (scrolled) {
      this._ctx.requestSelectionUpdate()
    }

    if (scrollX === 0 && scrollY === 0) {
      this.stopAutoScroll()
    }
  }

  private getAutoScrollDirectionX(mouseX: number): number {
    const relativeX = mouseX - this.x
    const distToLeft = relativeX
    const distToRight = this.width - relativeX

    if (distToLeft <= this.autoScrollThresholdHorizontal) {
      return this.scrollLeft > 0 ? -1 : 0
    } else if (distToRight <= this.autoScrollThresholdHorizontal) {
      return this.scrollLeft < this._scrollState().max[0] ? 1 : 0
    }
    return 0
  }

  private getAutoScrollDirectionY(mouseY: number): number {
    const relativeY = mouseY - this.y
    const distToTop = relativeY
    const distToBottom = this.height - relativeY

    if (distToTop <= this.autoScrollThresholdVertical) {
      return this.scrollTop > 0 ? -1 : 0
    } else if (distToBottom <= this.autoScrollThresholdVertical) {
      return this.scrollTop < this._scrollState().max[1] ? 1 : 0
    }
    return 0
  }

  private getAutoScrollSpeed(mouseX: number, mouseY: number): number {
    const relativeX = mouseX - this.x
    const relativeY = mouseY - this.y

    const distToLeft = relativeX
    const distToRight = this.width - relativeX
    const distToTop = relativeY
    const distToBottom = this.height - relativeY

    const minDistance = Math.min(distToLeft, distToRight, distToTop, distToBottom)

    if (minDistance <= 1) {
      return this.autoScrollSpeedFast
    } else if (minDistance <= 2) {
      return this.autoScrollSpeedMedium
    } else {
      return this.autoScrollSpeedSlow
    }
  }

  // Setters for reactive properties
  public set padding(value: number | `${number}%` | null | undefined) {
    this.content.padding = value
  }

  public set paddingX(value: number | `${number}%` | null | undefined) {
    this.content.paddingX = value
  }

  public set paddingY(value: number | `${number}%` | null | undefined) {
    this.content.paddingY = value
  }

  public set paddingTop(value: number | `${number}%` | null | undefined) {
    this.content.paddingTop = value
  }

  public set paddingRight(value: number | `${number}%` | null | undefined) {
    this.content.paddingRight = value
  }

  public set paddingBottom(value: number | `${number}%` | null | undefined) {
    this.content.paddingBottom = value
  }

  public set paddingLeft(value: number | `${number}%` | null | undefined) {
    this.content.paddingLeft = value
  }

  public set rootOptions(options: ScrollBoxOptions["rootOptions"]) {
    this.assignOptions(this, options && stripScrollBoxPadding(options))
    if (options) this.content._assign(pickScrollBoxPadding(options), ScrollBoxContent.keys)
    if (!this.isDestroyed) this.requestRender()
  }

  public set wrapperOptions(options: ScrollBoxOptions["wrapperOptions"]) {
    this.wrapper._assign(options, ScrollBoxWrapper.keys)
  }

  public set viewportOptions(options: ScrollBoxOptions["viewportOptions"]) {
    this.viewport._assign(options, ScrollBoxViewport.keys)
  }

  public set contentOptions(options: ScrollBoxOptions["contentOptions"]) {
    this.content._assign(options, ScrollBoxContent.keys)
  }

  // Nullish options remove the callbacks that options set.
  public set scrollbarOptions(options: ScrollBoxOptions["scrollbarOptions"]) {
    this.verticalScrollBar._assign(options ?? { onChange: undefined }, ScrollBoxBar.keys)
    this.horizontalScrollBar._assign(options ?? { onChange: undefined }, ScrollBoxBar.keys)
  }

  public set verticalScrollbarOptions(options: ScrollBoxOptions["verticalScrollbarOptions"]) {
    this.verticalScrollBar._assign(options ?? { onChange: undefined }, ScrollBoxBar.keys)
  }

  public set horizontalScrollbarOptions(options: ScrollBoxOptions["horizontalScrollbarOptions"]) {
    this.horizontalScrollBar._assign(options ?? { onChange: undefined }, ScrollBoxBar.keys)
  }

  public get scrollAcceleration(): ScrollAcceleration {
    return this.scrollAccel
  }

  public set scrollAcceleration(value: ScrollAcceleration) {
    this.scrollAccel = value
  }

  get viewportCulling(): boolean {
    return this._viewportCulling
  }

  set viewportCulling(value: boolean) {
    this._viewportCulling = value ?? true
    this._applyScrollOptions()
  }

  public override get overflow(): "hidden" {
    return "hidden"
  }

  /** The box clips like its viewport; other values are ignored. */
  public override set overflow(_value: unknown) {}

  protected destroySelf(): void {
    const selectionListener = this.selectionListener
    this.selectionListener = undefined
    this.endBarPress()
    this.runCleanup((run) => {
      if (selectionListener) run(() => this._ctx.off("selection", selectionListener))
      run(() => super.destroySelf())
    })
  }
}
