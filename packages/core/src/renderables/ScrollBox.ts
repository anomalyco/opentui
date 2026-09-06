import { assertRenderableMutable } from "../lib/renderable-layout.js"
import { type KeyEvent } from "../lib/index.js"
import { LinearScrollAccel, MacOSScrollAccel, type ScrollAcceleration } from "../lib/scroll-acceleration.js"
import type { BaseRenderable, Renderable, RenderableOptions } from "../Renderable.js"
import type { MouseEvent } from "../renderer.js"
import type { RenderContext } from "../types.js"
import { BoxRenderable, type BoxOptions } from "./Box.js"
import type { VNode } from "./composition/vnode.js"
import { ScrollBarRenderable, type ScrollBarOptions, type ScrollUnit } from "./ScrollBar.js"

export class ContentRenderable extends BoxRenderable {
  private viewport: BoxRenderable
  private _viewportCulling: boolean

  constructor(
    ctx: RenderContext,
    viewport: BoxRenderable,
    viewportCulling: boolean,
    options: RenderableOptions<BoxRenderable>,
  ) {
    super(ctx, options)
    try {
      this.viewport = viewport
      ctx.nativeScene.setViewport(this, viewportCulling ? viewport : null)
      this._viewportCulling = viewportCulling
    } catch (error) {
      this.abortConstruction(error)
    }
  }

  get viewportCulling(): boolean {
    return this._viewportCulling
  }

  set viewportCulling(value: boolean) {
    this._ctx.nativeScene.setViewport(this, value ? this.viewport : null)
    this._viewportCulling = value
  }
}

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

export class ScrollBoxRenderable extends BoxRenderable {
  static idCounter = 0
  private internalId = 0
  public readonly wrapper: BoxRenderable
  public readonly viewport: BoxRenderable
  public readonly content: ContentRenderable
  public readonly horizontalScrollBar: ScrollBarRenderable
  public readonly verticalScrollBar: ScrollBarRenderable

  protected _focusable: boolean = true
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
  private _stickyScrollTop: boolean = false
  private _stickyScrollBottom: boolean = false
  private _stickyScrollLeft: boolean = false
  private _stickyScrollRight: boolean = false
  private _stickyStart?: "bottom" | "top" | "left" | "right"
  private _hasManualScroll: boolean = false
  private _isApplyingStickyScroll: boolean = false
  private scrollAccel: ScrollAcceleration

  get stickyScroll(): boolean {
    return this._stickyScroll
  }

  set stickyScroll(value: boolean) {
    assertRenderableMutable(this)
    this._stickyScroll = value
    this.updateStickyState()
  }

  get stickyStart(): "bottom" | "top" | "left" | "right" | undefined {
    return this._stickyStart
  }

  set stickyStart(value: "bottom" | "top" | "left" | "right" | undefined) {
    assertRenderableMutable(this)
    this._stickyStart = value
    this.updateStickyState()
  }

  get scrollTop(): number {
    return this.verticalScrollBar.scrollPosition
  }

  set scrollTop(value: number) {
    this.verticalScrollBar.scrollPosition = value
    this.updateStickyState()
  }

  get scrollLeft(): number {
    return this.horizontalScrollBar.scrollPosition
  }

  set scrollLeft(value: number) {
    this.horizontalScrollBar.scrollPosition = value
    this.updateStickyState()
  }

  get scrollWidth(): number {
    return this.horizontalScrollBar.scrollSize
  }

  get scrollHeight(): number {
    return this.verticalScrollBar.scrollSize
  }

  private updateStickyState(): void {
    if (this.isDestroyed) return
    if (!this._stickyScroll) {
      this.syncManualScrollState()
      return
    }

    const maxScrollTop = Math.max(0, this.scrollHeight - this.viewport.height)
    const maxScrollLeft = Math.max(0, this.scrollWidth - this.viewport.width)

    if (this.scrollTop <= 0) {
      this._stickyScrollTop = true
      this._stickyScrollBottom = false
    } else if (this.scrollTop >= maxScrollTop) {
      this._stickyScrollTop = false
      this._stickyScrollBottom = true
    } else {
      this._stickyScrollTop = false
      this._stickyScrollBottom = false
    }

    if (this.scrollLeft <= 0) {
      this._stickyScrollLeft = true
      this._stickyScrollRight = false
    } else if (this.scrollLeft >= maxScrollLeft) {
      this._stickyScrollLeft = false
      this._stickyScrollRight = true
    } else {
      this._stickyScrollLeft = false
      this._stickyScrollRight = false
    }

    this.syncManualScrollState()
  }

  private syncManualScrollState(): void {
    if (this.isDestroyed) return
    if (!this._stickyScroll) {
      this._hasManualScroll = false
      return
    }

    const maxScrollTop = Math.max(0, this.scrollHeight - this.viewport.height)
    const maxScrollLeft = Math.max(0, this.scrollWidth - this.viewport.width)
    const hasScrollableContent = maxScrollTop > 1 || maxScrollLeft > 1

    if (this._isApplyingStickyScroll) {
      if (this._hasManualScroll && hasScrollableContent && this.isAtStickyPosition()) {
        this._hasManualScroll = false
      }
      return
    }

    this._hasManualScroll = hasScrollableContent && !this.isAtStickyPosition()
  }

  private applyStickyStart(stickyStart: "bottom" | "top" | "left" | "right"): void {
    const wasApplyingStickyScroll = this._isApplyingStickyScroll
    this._isApplyingStickyScroll = true
    try {
      switch (stickyStart) {
        case "top":
          this._stickyScrollTop = true
          this._stickyScrollBottom = false
          this.verticalScrollBar.scrollPosition = 0
          break
        case "bottom":
          this._stickyScrollTop = false
          this._stickyScrollBottom = true
          this.verticalScrollBar.scrollPosition = Math.max(0, this.scrollHeight - this.viewport.height)
          break
        case "left":
          this._stickyScrollLeft = true
          this._stickyScrollRight = false
          this.horizontalScrollBar.scrollPosition = 0
          break
        case "right":
          this._stickyScrollLeft = false
          this._stickyScrollRight = true
          this.horizontalScrollBar.scrollPosition = Math.max(0, this.scrollWidth - this.viewport.width)
          break
      }
    } finally {
      this._isApplyingStickyScroll = wasApplyingStickyScroll
    }
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
    const mergedContentOptions = {
      ...forwardedContentPadding,
      ...contentOptions,
    }

    // Root
    super(ctx, {
      flexDirection: "row",
      alignItems: "stretch",
      ...(sanitizedRootBoxOptions as BoxOptions),
      ...(sanitizedRootOptions as BoxOptions),
    })

    const children: Renderable[] = []
    try {
      this.internalId = ScrollBoxRenderable.idCounter++
      this._stickyScroll = stickyScroll
      this._stickyStart = stickyStart
      this.scrollAccel = scrollAcceleration ?? new LinearScrollAccel()

      this.wrapper = new BoxRenderable(ctx, {
        flexDirection: "column",
        flexGrow: 1,
        ...wrapperOptions,
        id: `scroll-box-wrapper-${this.internalId}`,
      })
      children.push(this.wrapper)
      super.add(this.wrapper)

      this.viewport = new BoxRenderable(ctx, {
        flexDirection: "column",
        flexGrow: 1,
        // NOTE: Overflow scroll makes the content size behave weird
        // when the scrollbox is in a container with max-width/height
        overflow: "hidden",
        onSizeChange: () => {
          this.recalculateBarProps()
        },
        ...viewportOptions,
        id: `scroll-box-viewport-${this.internalId}`,
      })
      children.push(this.viewport)
      this.wrapper.add(this.viewport)

      this.content = new ContentRenderable(ctx, this.viewport, viewportCulling, {
        alignSelf: "flex-start",
        flexShrink: 0,
        ...(scrollX ? { minWidth: "100%" } : { minWidth: "100%", maxWidth: "100%" }),
        ...(scrollY ? { minHeight: "100%" } : { minHeight: "100%", maxHeight: "100%" }),
        onSizeChange: () => {
          this.recalculateBarProps()
        },
        ...mergedContentOptions,
        id: `scroll-box-content-${this.internalId}`,
      })
      children.push(this.content)
      this.viewport.add(this.content)

      this.verticalScrollBar = new ScrollBarRenderable(ctx, {
        ...scrollbarOptions,
        ...verticalScrollbarOptions,
        arrowOptions: {
          ...scrollbarOptions?.arrowOptions,
          ...verticalScrollbarOptions?.arrowOptions,
        },
        id: `scroll-box-vertical-scrollbar-${this.internalId}`,
        orientation: "vertical",
        onChange: (position) => {
          if (this.isDestroyed) return
          this.content.translateY = -position
          this.updateStickyState()
        },
      })
      children.push(this.verticalScrollBar)
      super.add(this.verticalScrollBar)

      this.horizontalScrollBar = new ScrollBarRenderable(ctx, {
        ...scrollbarOptions,
        ...horizontalScrollbarOptions,
        arrowOptions: {
          ...scrollbarOptions?.arrowOptions,
          ...horizontalScrollbarOptions?.arrowOptions,
        },
        id: `scroll-box-horizontal-scrollbar-${this.internalId}`,
        orientation: "horizontal",
        onChange: (position) => {
          if (this.isDestroyed) return
          this.content.translateX = -position
          this.updateStickyState()
        },
      })
      children.push(this.horizontalScrollBar)
      this.wrapper.add(this.horizontalScrollBar)

      this.recalculateBarProps()

      if (stickyStart && stickyScroll) {
        this.applyStickyStart(stickyStart)
      }

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
      this.abortConstruction(error, (run) => {
        run(() => this.destroySelf())
        for (let index = children.length - 1; index >= 0; index--) {
          run(() => children[index].destroyRecursively())
        }
      })
    }
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
    // Note: scrollBy doesn't need to set _hasManualScroll here because the scrollbar
    // change will trigger the scrollTop setter which handles it
  }

  public scrollChildIntoView(childId: string): void {
    const child = this.content.findDescendantById(childId)
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
    // Note: scrollTo doesn't need to set _hasManualScroll here because
    // the scrollTop/scrollLeft setters handle it
  }

  private isAtStickyPosition(): boolean {
    if (!this._stickyScroll || !this._stickyStart) {
      return false
    }

    const maxScrollTop = Math.max(0, this.scrollHeight - this.viewport.height)
    const maxScrollLeft = Math.max(0, this.scrollWidth - this.viewport.width)

    switch (this._stickyStart) {
      case "top":
        return this.scrollTop === 0
      case "bottom":
        return this.scrollTop >= maxScrollTop
      case "left":
        return this.scrollLeft === 0
      case "right":
        return this.scrollLeft >= maxScrollLeft
      default:
        return false
    }
  }

  private isAtStickyReengagePoint(
    stickyStart: "bottom" | "top" | "left" | "right",
    maxScrollTop: number,
    maxScrollLeft: number,
  ): boolean {
    switch (stickyStart) {
      case "top":
        return maxScrollTop > 0 && this.scrollTop <= 0
      case "bottom":
        return maxScrollTop > 0 && this.scrollTop >= maxScrollTop - 1
      case "left":
        return maxScrollLeft > 0 && this.scrollLeft <= 0
      case "right":
        return maxScrollLeft > 0 && this.scrollLeft >= maxScrollLeft - 1
    }
  }

  public add(obj: Renderable | VNode<any, any[]>, index?: number): number {
    return this.content.add(obj, index)
  }

  public insertBefore(obj: Renderable | VNode<any, any[]> | unknown, anchor?: Renderable | unknown): number {
    return this.content.insertBefore(obj, anchor)
  }

  public remove(child: BaseRenderable): void {
    // Internal parts (wrapper, scrollbars) are direct children of the root,
    // not of content. Route by actual parentage so destroy() and explicit
    // removals of internals detach them instead of silently no-oping through
    // the content delegation.
    if (child.parent === this) {
      super.remove(child)
      return
    }
    this.content.remove(child)
  }

  public getChildren(): Renderable[] {
    return this.content.getChildren()
  }

  public getRenderable(id: string): Renderable | undefined {
    return this.content.getRenderable(id)
  }

  protected onMouseEvent(event: MouseEvent): void {
    if (event.type === "scroll") {
      let dir = event.scroll?.direction
      if (event.modifiers.shift)
        dir = dir === "up" ? "left" : dir === "down" ? "right" : dir === "right" ? "down" : "up"

      const baseDelta = event.scroll?.delta ?? 0
      const now = Date.now()
      const multiplier = this.scrollAccel.tick(now)
      const scrollAmount = baseDelta * multiplier

      if (dir === "up") {
        this.scrollAccumulatorY -= scrollAmount
        const integerScroll = Math.trunc(this.scrollAccumulatorY)
        if (integerScroll !== 0) {
          this.scrollTop += integerScroll
          this.scrollAccumulatorY -= integerScroll
        }
      } else if (dir === "down") {
        this.scrollAccumulatorY += scrollAmount
        const integerScroll = Math.trunc(this.scrollAccumulatorY)
        if (integerScroll !== 0) {
          this.scrollTop += integerScroll
          this.scrollAccumulatorY -= integerScroll
        }
      } else if (dir === "left") {
        this.scrollAccumulatorX -= scrollAmount
        const integerScroll = Math.trunc(this.scrollAccumulatorX)
        if (integerScroll !== 0) {
          this.scrollLeft += integerScroll
          this.scrollAccumulatorX -= integerScroll
        }
      } else if (dir === "right") {
        this.scrollAccumulatorX += scrollAmount
        const integerScroll = Math.trunc(this.scrollAccumulatorX)
        if (integerScroll !== 0) {
          this.scrollLeft += integerScroll
          this.scrollAccumulatorX -= integerScroll
        }
      }

      this.syncManualScrollState()
    }

    if (event.type === "drag" && event.isDragging) {
      this.updateAutoScroll(event.x, event.y)
    } else if (event.type === "up") {
      this.stopAutoScroll()
    }
  }

  public handleKeyPress(key: KeyEvent): boolean {
    // Let scrollbars handle their own acceleration
    if (this.verticalScrollBar.handleKeyPress(key)) {
      this.scrollAccel.reset()
      this.resetScrollAccumulators()
      this.syncManualScrollState()
      return true
    }
    if (this.horizontalScrollBar.handleKeyPress(key)) {
      this.scrollAccel.reset()
      this.resetScrollAccumulators()
      this.syncManualScrollState()
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

    if (!this.live) {
      this.live = true
    }
  }

  public updateAutoScroll(mouseX: number, mouseY: number): void {
    assertRenderableMutable(this)
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
    assertRenderableMutable(this)
    const wasAutoScrolling = this.isAutoScrolling
    this.isAutoScrolling = false
    this.autoScrollAccumulatorX = 0
    this.autoScrollAccumulatorY = 0

    // Only turn off live if no other features need it
    // For now, auto-scroll is the only feature using live, but this could be extended
    if (wasAutoScrolling && !this.hasOtherLiveReasons()) {
      this.live = false
    }
  }

  private hasOtherLiveReasons(): boolean {
    // Placeholder for future features that might need live mode
    // For now, always return false since auto-scroll is the only user
    return false
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
      const maxScrollLeft = this.scrollWidth - this.viewport.width
      return this.scrollLeft < maxScrollLeft ? 1 : 0
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
      const maxScrollTop = this.scrollHeight - this.viewport.height
      return this.scrollTop < maxScrollTop ? 1 : 0
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

  private recalculateBarProps(): void {
    if (this.isDestroyed) return
    // Wrap entire method to prevent scroll changes from being treated as manual
    const wasApplyingStickyScroll = this._isApplyingStickyScroll
    this._isApplyingStickyScroll = true

    try {
      this.verticalScrollBar.scrollSize = this.content.height
      if (this.isDestroyed) return
      this.verticalScrollBar.viewportSize = this.viewport.height
      if (this.isDestroyed) return
      this.horizontalScrollBar.scrollSize = this.content.width
      if (this.isDestroyed) return
      this.horizontalScrollBar.viewportSize = this.viewport.width
      if (this.isDestroyed) return

      if (this._stickyScroll) {
        const newMaxScrollTop = Math.max(0, this.scrollHeight - this.viewport.height)
        const newMaxScrollLeft = Math.max(0, this.scrollWidth - this.viewport.width)
        const stickyStart = this._stickyStart

        if (stickyStart && !this._hasManualScroll) {
          this.applyStickyStart(stickyStart)
        } else if (
          stickyStart &&
          this._hasManualScroll &&
          this.isAtStickyReengagePoint(stickyStart, newMaxScrollTop, newMaxScrollLeft)
        ) {
          // User scrolled back to the sticky edge during streaming; re-engage sticky.
          this._hasManualScroll = false
          this.applyStickyStart(stickyStart)
        } else if (!this._hasManualScroll) {
          if (this._stickyScrollTop) {
            this.scrollTop = 0
          } else if (this._stickyScrollBottom && newMaxScrollTop > 0) {
            this.scrollTop = newMaxScrollTop
          }
          if (this.isDestroyed) return

          if (this._stickyScrollLeft) {
            this.scrollLeft = 0
          } else if (this._stickyScrollRight && newMaxScrollLeft > 0) {
            this.scrollLeft = newMaxScrollLeft
          }
        }
      }
    } finally {
      this._isApplyingStickyScroll = wasApplyingStickyScroll
    }
  }

  // Setters for reactive properties
  public set padding(value: number | `${number}%` | null | undefined) {
    this.content.padding = value
    this.requestRender()
  }

  public set paddingX(value: number | `${number}%` | null | undefined) {
    this.content.paddingX = value
    this.requestRender()
  }

  public set paddingY(value: number | `${number}%` | null | undefined) {
    this.content.paddingY = value
    this.requestRender()
  }

  public set paddingTop(value: number | `${number}%` | null | undefined) {
    this.content.paddingTop = value
    this.requestRender()
  }

  public set paddingRight(value: number | `${number}%` | null | undefined) {
    this.content.paddingRight = value
    this.requestRender()
  }

  public set paddingBottom(value: number | `${number}%` | null | undefined) {
    this.content.paddingBottom = value
    this.requestRender()
  }

  public set paddingLeft(value: number | `${number}%` | null | undefined) {
    this.content.paddingLeft = value
    this.requestRender()
  }

  public set rootOptions(options: ScrollBoxOptions["rootOptions"]) {
    this.assignOptions(this, options)
    if (!this.isDestroyed) this.requestRender()
  }

  public set wrapperOptions(options: ScrollBoxOptions["wrapperOptions"]) {
    this.assignOptions(this.wrapper, options)
    if (!this.isDestroyed) this.requestRender()
  }

  public set viewportOptions(options: ScrollBoxOptions["viewportOptions"]) {
    this.assignOptions(this.viewport, options)
    if (!this.isDestroyed) this.requestRender()
  }

  public set contentOptions(options: ScrollBoxOptions["contentOptions"]) {
    this.assignOptions(this.content, options)
    if (!this.isDestroyed) this.requestRender()
  }

  public set scrollbarOptions(options: ScrollBoxOptions["scrollbarOptions"]) {
    this.assignOptions(this.verticalScrollBar, options)
    this.assignOptions(this.horizontalScrollBar, options)
    if (!this.isDestroyed) this.requestRender()
  }

  public set verticalScrollbarOptions(options: ScrollBoxOptions["verticalScrollbarOptions"]) {
    this.assignOptions(this.verticalScrollBar, options)
    if (!this.isDestroyed) this.requestRender()
  }

  public set horizontalScrollbarOptions(options: ScrollBoxOptions["horizontalScrollbarOptions"]) {
    this.assignOptions(this.horizontalScrollBar, options)
    if (!this.isDestroyed) this.requestRender()
  }

  public get scrollAcceleration(): ScrollAcceleration {
    return this.scrollAccel
  }

  public set scrollAcceleration(value: ScrollAcceleration) {
    assertRenderableMutable(this)
    this.scrollAccel = value
  }

  get viewportCulling(): boolean {
    return this.content.viewportCulling
  }

  set viewportCulling(value: boolean) {
    this.content.viewportCulling = value
    this.requestRender()
  }

  protected destroySelf(): void {
    const selectionListener = this.selectionListener
    this.selectionListener = undefined
    this.runCleanup((run) => {
      if (selectionListener) run(() => this._ctx.off("selection", selectionListener))
      run(() => super.destroySelf())
    })
  }
}
