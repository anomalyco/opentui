import { getYogaNode } from "./lib/renderable-layout.js"
import type { NativeSession } from "./NativeSession.js"
import { Renderable, RootRenderable, type RenderableOptions } from "./Renderable.js"
import { BoxRenderable } from "./renderables/Box.js"
import { TextRenderable } from "./renderables/Text.js"
import { CodeRenderable } from "./renderables/Code.js"
import { EditBufferRenderable } from "./renderables/EditBufferRenderable.js"
import { TextBufferRenderable } from "./renderables/TextBufferRenderable.js"
import { SliderRenderable } from "./renderables/Slider.js"
import { ImageRenderable, type ImageFit } from "./renderables/Image.js"
import { FrameBufferRenderable } from "./renderables/FrameBuffer.js"
import type { NativeImage } from "./image.js"
import type { OptimizedBuffer } from "./buffer.js"
import type { ImageRenderProtocol } from "./types.js"
import { ArrowRenderable, ScrollBarRenderable } from "./renderables/ScrollBar.js"
import { RendererControlState, type CliRenderer } from "./renderer.js"
import type { StyledText } from "./lib/styled-text.js"
import type { RGBA } from "./lib/RGBA.js"
import type { LocalSelectionBounds } from "./lib/selection.js"
import { Node, type Value, type MeasureFunction, type YogaHost } from "./yoga.js"
import {
  NativeSessionRenderStatus,
  SceneStaging,
  type NativeSceneFrameOptions,
  type NativeSceneFrameRequest,
  type NativeSceneLayout,
  type NativeScenePaint,
  type NativeSceneBoxDetails,
  type NativeSceneTextOptions,
  type NativeSceneSliderOptions,
  type NativeSceneArrowOptions,
  type NativeSceneEditorOptions,
  type ContextEditorViewHandle,
  type ContextTextBufferViewHandle,
  type SceneNodeHandle,
} from "./zig.js"

// Nonconvergent feedback fails before painting instead of retrying indefinitely.
const maxLayoutRounds = 8
const maxHostRequests = 65_536

type PaintContinuation = {
  request: NativeSceneFrameRequest
  currentPaint?: { renderable: Renderable; handle: SceneNodeHandle }
  wait: Promise<void>
  cancelled: boolean
  restart?: boolean
}

// Dormant built-ins retain their registration position without entering the frame iterator.
class NativeLifecyclePasses extends Set<Renderable> {
  private order = new WeakMap<Renderable, number>()
  private nextOrder = 0
  private work?: { pending: { renderable: Renderable; order: number }[]; index: number; order: number }

  override add(renderable: Renderable): this {
    if (!this.order.has(renderable)) this.order.set(renderable, ++this.nextOrder)
    this.refresh(renderable)
    return this
  }

  refresh(renderable: Renderable): void {
    const order = this.order.get(renderable)
    if (order === undefined) return
    const active = renderable._needsLifecyclePass()
    if (active === super.has(renderable)) return
    if (!active) {
      super.delete(renderable)
      return
    }
    super.add(renderable)
    const work = this.work
    if (!work || order <= work.order) return
    let low = work.index
    let high = work.pending.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (work.pending[middle].order < order) low = middle + 1
      else high = middle
    }
    if (work.pending[low]?.order !== order) work.pending.splice(low, 0, { renderable, order })
  }

  override delete(renderable: Renderable): boolean {
    this.order.delete(renderable)
    return super.delete(renderable)
  }

  override clear(): void {
    super.clear()
    this.order = new WeakMap()
  }

  *iteratePending(): IterableIterator<Renderable> {
    if (this.work) throw new Error("Native scene lifecycle pass is already active")
    if (this.size === 0) return
    const work = {
      pending: Array.from(this, (renderable) => ({ renderable, order: this.order.get(renderable)! })),
      index: 0,
      order: 0,
    }
    work.pending.sort((a, b) => a.order - b.order)
    this.work = work
    try {
      while (work.index < work.pending.length) {
        const next = work.pending[work.index++]
        work.order = next.order
        if (this.has(next.renderable) && this.order.get(next.renderable) === next.order) yield next.renderable
      }
    } finally {
      this.work = undefined
    }
  }
}

/** Retained built-in scene with sparse owner-thread hooks. */
export class NativeScene {
  readonly lifecyclePasses = new NativeLifecyclePasses()
  private readonly nodes = new Map<number, Renderable>()
  private readonly nativeMethods = new Map(
    [
      Renderable,
      BoxRenderable,
      TextBufferRenderable,
      CodeRenderable,
      EditBufferRenderable,
      SliderRenderable,
      ArrowRenderable,
      ImageRenderable,
      FrameBufferRenderable,
    ].map((type) => {
      const prototype: Renderable = type.prototype
      return [
        prototype,
        { renderSelf: prototype["renderSelf"], onResize: prototype["onResize"], onUpdate: prototype["onUpdate"] },
      ] as const
    }),
  )
  private paintedFrame: NativeSceneFrameRequest | null = null
  private prefixFrame: NativeSceneFrameRequest | null = null
  private cancelPaintYield: ((restart?: boolean) => void) | null = null
  private destroyed = false
  private destroying = false
  private geometryRevision = 0
  // Style and paint setters stage here; native sees them at the next flush boundary.
  private readonly staging = new SceneStaging()
  // Only construction and failed explicit refreshes need deferred discovery.
  private hookScans = new Set<Renderable>()
  private scanningHooks = false
  // The library's Yoga host is stable for this scene's lifetime; hot setters skip the lookup chain.
  private readonly yogaHost: YogaHost

  constructor(
    readonly driver: NativeSession,
    private readonly renderer: Pick<
      CliRenderer,
      "root" | "nextRenderBuffer" | "isDestroyed" | "controlState" | "unregisterLifecyclePass"
    >,
    private readonly paintBudget?: number,
    private readonly workBudget?: number,
  ) {
    this.yogaHost = driver.renderLib.getYogaHost()
  }

  /** @internal Buffer wrappers borrow the active prefix or completed paint ticket. */
  get frame(): NativeSceneFrameRequest | null {
    return this.prefixFrame ?? this.paintedFrame
  }

  /** @internal Accepted geometry mutations invalidate hook-local layout observations. */
  get currentGeometryRevision(): number {
    return this.geometryRevision
  }

  private changeGeometry(): void {
    this.geometryRevision = this.geometryRevision === Number.MAX_SAFE_INTEGER ? 0 : this.geometryRevision + 1
  }

  /** @internal Whether style or paint writes await native acceptance. */
  get hasStagedMutations(): boolean {
    return this.staging.pending
  }

  /** @internal Apply staged style/paint writes. Runs before every native scene call
   * except node creation, moves, and hit tests, which observe no style or paint.
   * Failed flushes retain their unaccepted suffix for retry. */
  flushStaged(): void {
    if (this.destroyed || this.driver.disposed) {
      this.staging.clear()
      this.yogaHost.forgetScene(this)
      return
    }
    if (!this.staging.pending) return
    try {
      this.driver.renderLib.sceneFlush(this.driver.context, this.staging)
    } finally {
      if (!this.staging.pending) this.yogaHost.forgetScene(this)
    }
  }

  /** @internal Keep construction pending until a boundary after derived class fields have run. */
  scheduleHookScan(renderable: Renderable): void {
    if (this.destroyed || this.destroying || this.driver.disposed) return
    this.hookScans.add(renderable)
  }

  /** @internal Restore assignment accessors at attachment, but keep discovery pending:
   * an intermediate constructor can attach before the most-derived fields run. */
  refreshPendingHooks(renderable: Renderable): void {
    if (this.scanningHooks || !this.hookScans.has(renderable)) return
    this.scanningHooks = true
    try {
      renderable._scanNativeSceneHooks()
    } finally {
      this.scanningHooks = false
    }
  }

  /** Scans may publish hooks natively or register lifecycle passes, so this runs
   * before lifecycle passes and native resumes. Reentrant scheduling drains in
   * bounded batches without walking the scene. */
  private drainHookScans(): void {
    if (this.scanningHooks) throw new Error("Native scene hook discovery is already active")
    if (this.hookScans.size === 0) return
    this.scanningHooks = true
    let visits = 0
    try {
      while (this.hookScans.size !== 0) {
        const pending = this.hookScans
        this.hookScans = new Set()
        try {
          for (const renderable of pending) {
            if (this.destroyed || this.destroying || this.driver.disposed) return
            if (++visits > maxHostRequests) throw new Error("Native scene hook discovery work limit exceeded")
            renderable._scanNativeSceneHooks()
            pending.delete(renderable)
          }
        } catch (error) {
          if (!this.destroyed && !this.destroying && !this.driver.disposed) {
            for (const renderable of this.hookScans) pending.add(renderable)
            this.hookScans = pending
          }
          throw error
        }
      }
    } finally {
      this.scanningHooks = false
    }
  }

  /** @internal Detached settlement visits owned controllers, not the render tree. */
  getRenderables(): IterableIterator<Renderable> {
    return this.nodes.values()
  }

  /** @internal Reject stale scene operations before accessing their Context. */
  assertAlive(): void {
    if (this.destroyed || this.driver.disposed) throw new Error("Native scene is destroyed")
  }

  supportsEditing(renderable: Renderable): boolean {
    return renderable instanceof EditBufferRenderable
  }

  usesNativeLineInfoEvents(renderable: Renderable): boolean {
    return renderable instanceof TextRenderable
  }

  /** @internal Inherited built-in bodies remain native; only actual overrides need host drawing. */
  usesNativeDrawing(renderable: Renderable, renderSelf: unknown): boolean {
    if (renderable instanceof ImageRenderable) {
      return renderSelf === this.nativeMethods.get(ImageRenderable.prototype)!.renderSelf
    }
    if (renderable["buffered"] || renderable instanceof CodeRenderable) return false
    if (renderable instanceof FrameBufferRenderable) {
      return renderSelf === this.nativeMethods.get(FrameBufferRenderable.prototype)!.renderSelf
    }
    const prototype =
      renderable instanceof BoxRenderable
        ? BoxRenderable.prototype
        : renderable instanceof TextRenderable
          ? TextBufferRenderable.prototype
          : renderable instanceof EditBufferRenderable
            ? EditBufferRenderable.prototype
            : renderable instanceof SliderRenderable
              ? SliderRenderable.prototype
              : renderable instanceof ArrowRenderable
                ? ArrowRenderable.prototype
                : Renderable.prototype
    return renderSelf === this.nativeMethods.get(prototype)!.renderSelf
  }

  usesNativeTextController(renderable: Renderable, renderSelf: unknown): boolean {
    return (
      renderable instanceof CodeRenderable &&
      !renderable["buffered"] &&
      renderSelf === this.nativeMethods.get(CodeRenderable.prototype)!.renderSelf
    )
  }

  /** @internal Native text/editor preparation already performs their default viewport resize. */
  usesNativeResize(renderable: Renderable, onResize: unknown): boolean {
    return (
      (renderable instanceof TextBufferRenderable &&
        onResize === this.nativeMethods.get(TextBufferRenderable.prototype)!.onResize) ||
      (renderable instanceof EditBufferRenderable &&
        onResize === this.nativeMethods.get(EditBufferRenderable.prototype)!.onResize)
    )
  }

  hostUpdateFlags(renderable: Renderable, onUpdate: unknown): number {
    if (onUpdate === Renderable.prototype["onUpdate"]) return 0
    if (
      renderable instanceof EditBufferRenderable &&
      onUpdate === this.nativeMethods.get(EditBufferRenderable.prototype)!.onUpdate
    ) {
      // Idle updates still consume their native traversal position without a host call.
      return renderable._needsAutoScrollUpdate ? 1 : 64
    }
    return 1
  }

  skipsPaintHooks(renderable: Renderable): boolean {
    return renderable instanceof TextBufferRenderable || this.supportsEditing(renderable)
  }

  composesBuffer(renderable: Renderable): boolean {
    return this.supportsEditing(renderable) || renderable instanceof ImageRenderable
  }

  /** @internal Scene nodes retain native ownership even when their body is a host hook. */
  createNode(renderable: Renderable, options: RenderableOptions): Node {
    this.driver.renderLib.getYogaHost().assertMutable()
    this.assertAlive()
    if (this.destroying) throw new Error("Native scene is being destroyed")
    if (
      renderable instanceof TextBufferRenderable &&
      !(renderable instanceof TextRenderable) &&
      !(renderable instanceof CodeRenderable)
    ) {
      throw new Error("Native scene does not yet support this text-buffer resource")
    }
    const kind =
      renderable instanceof RootRenderable
        ? "root"
        : renderable instanceof BoxRenderable || renderable instanceof ScrollBarRenderable
          ? "box"
          : renderable instanceof TextRenderable
            ? "text"
            : renderable instanceof SliderRenderable
              ? "slider"
              : renderable instanceof ArrowRenderable
                ? "arrow"
                : this.supportsEditing(renderable)
                  ? "editor"
                  : renderable instanceof CodeRenderable
                    ? "text_view"
                    : renderable instanceof ImageRenderable
                      ? "image"
                      : "custom"
    if (options.enableLayout === false) throw new Error("Native scene requires Yoga layout")
    const handle = this.driver.renderLib.sceneCreateNode(this.driver.context, this.driver.session, kind, renderable.num)
    try {
      const node = Node._createForScene(this, handle)
      this.nodes.set(renderable.num, renderable)
      return node
    } catch (error) {
      try {
        this.driver.renderLib.sceneDestroyNode(this.driver.context, handle)
      } catch {
        // Preserve the construction failure.
      }
      throw error
    }
  }

  /** @internal Native acceptance precedes all wrapper topology changes. */
  moveNode(child: Node, parent: Node | null, index: number): void {
    const handle = child._getSceneHandle(this)
    const parentHandle = parent?._getSceneHandle(this) ?? null
    this.driver.renderLib.sceneMoveNode(this.driver.context, handle, parentHandle, index)
    this.changeGeometry()
  }

  setViewport(content: Renderable, viewport: Renderable | null): void {
    this.flushStaged()
    this.driver.renderLib.sceneSetViewport(
      this.driver.context,
      getYogaNode(content)._getSceneHandle(this),
      viewport ? getYogaNode(viewport)._getSceneHandle(this) : null,
    )
  }

  setFocus(renderable: Renderable, focused: boolean): void {
    this.flushStaged()
    this.driver.renderLib.sceneSetFocus(this.driver.context, getYogaNode(renderable)._getSceneHandle(this), focused)
  }

  /** @internal The wrapper's existing cleanup walk releases nodes child-first. Staged
   * writes flush first so no entry outlives its handle; a flush failure must not
   * leave the native node alive behind a destroyed wrapper. */
  destroyNode(renderable: Renderable, node: Node): void {
    node.assertMutable()
    const handle = node._getSceneHandle(this)
    let flushFailure: { error: unknown } | undefined
    try {
      this.flushStaged()
    } catch (error) {
      flushFailure = { error }
    }
    try {
      this.driver.renderLib.sceneDestroyNode(this.driver.context, handle)
      this.staging.discard(handle)
      if (!this.staging.pending) this.yogaHost.forgetScene(this)
      this.changeGeometry()
      node._invalidateFromOwner()
      this.nodes.delete(renderable.num)
      this.hookScans.delete(renderable)
      this.renderer.unregisterLifecyclePass(renderable)
    } catch (error) {
      if (flushFailure) {
        throw new AggregateError([flushFailure.error, error], "Native scene flush and node cleanup both failed")
      }
      throw error
    }
    if (flushFailure) throw flushFailure.error
  }

  /** @internal Hook identities publish only after native acceptance. Geometry remains native-owned. */
  setHooks(
    renderable: Renderable,
    flags: number,
    generation: bigint,
    initialWidth: number,
    initialHeight: number,
    hostResize: boolean,
    renderSelf: unknown,
    lineInfo: boolean,
  ): void {
    this.flushStaged()
    // Text/editor bodies skip the generic before/after hooks.
    if (this.skipsPaintHooks(renderable)) flags &= ~24
    if (this.usesNativeTextController(renderable, renderSelf)) flags |= 128
    if (!hostResize && this.skipsPaintHooks(renderable)) {
      flags = (flags & ~2) | (lineInfo && this.usesNativeLineInfoEvents(renderable) ? 2 : 0)
    }
    if (flags & 32) flags |= 16
    this.driver.renderLib.sceneSetHooks(
      this.driver.context,
      getYogaNode(renderable)._getSceneHandle(this),
      flags,
      generation,
      initialWidth,
      initialHeight,
    )
  }

  /** @internal Shared Yoga normalization stages through the checked scene style boundary. */
  setStyle(node: Node, group: number, kind: number, edge: number, unit: number, value: number, flags = 0): void {
    this.yogaHost.assertMutable()
    const handle = node._getSceneHandle(this)
    if (this.staging.styleFull) this.flushStaged()
    if (this.staging.stageStyle(this.driver.context, handle, group, kind, edge, unit, value, flags)) {
      this.yogaHost.stageScene(this)
    }
    this.changeGeometry()
  }

  /** @internal Reads observe every staged write first. */
  getStyle(node: Node, group: number, kind: number, edge: number): Value {
    const handle = node._getSceneHandle(this)
    this.flushStaged()
    return this.driver.renderLib.sceneGetStyle(this.driver.context, handle, group, kind, edge)
  }

  setMeasureFunc(node: Node, measure: MeasureFunction | null): void {
    this.flushStaged()
    this.driver.renderLib.sceneSetMeasure(this.driver.context, node._getSceneHandle(this), measure)
  }

  hasMeasureFunc(node: Node): boolean {
    this.flushStaged()
    return this.driver.renderLib.sceneHasMeasure(this.driver.context, node._getSceneHandle(this))
  }

  markDirty(node: Node): void {
    this.flushStaged()
    this.driver.renderLib.sceneMarkDirty(this.driver.context, node._getSceneHandle(this))
  }

  /** @internal Masked position edges stage as ordinary Yoga position values (group 2, kind 9).
   * Every masked value is validated before the first edge is staged so a rejected edge
   * leaves no partial position behind. */
  setPositions(node: Node, mask: number, units: Uint32Array, values: Float32Array): void {
    if (!Number.isInteger(mask) || mask < 0 || mask > 15)
      throw new RangeError("Scene position mask must use four edges")
    for (let edge = 0; edge < 4; edge++) {
      if ((mask & (1 << edge)) !== 0) SceneStaging.checkStyleValue(2, values[edge])
    }
    for (let edge = 0; edge < 4; edge++) {
      if ((mask & (1 << edge)) === 0) continue
      this.setStyle(node, 2, 9, edge, units[edge], values[edge], 0)
    }
  }

  /** @internal Paint includes Yoga border widths so border changes commit together. */
  setPaint(renderable: Renderable, paint: NativeScenePaint): void {
    this.yogaHost.assertMutable()
    const node = getYogaNode(renderable)
    const handle = node._getSceneHandle(this)
    if (this.staging.paintFull) this.flushStaged()
    if (this.staging.stagePaint(this.driver.context, handle, paint, node)) this.yogaHost.stageScene(this)
    this.changeGeometry()
  }

  setBackground(renderable: Renderable, color: RGBA): void {
    this.yogaHost.assertMutable()
    const node = getYogaNode(renderable)
    const handle = node._getSceneHandle(this)
    if (this.staging.backgroundFull) this.flushStaged()
    if (this.staging.stageBackground(this.driver.context, handle, color, node)) this.yogaHost.stageScene(this)
  }

  setBoxDetails(renderable: Renderable, details: NativeSceneBoxDetails): void {
    this.flushStaged()
    this.driver.renderLib.sceneSetBoxDetails(
      this.driver.context,
      getYogaNode(renderable)._getSceneHandle(this),
      details,
    )
  }

  /** Native read-modify-writes the node's paint, so staged paint must land first. */
  setBoxBorderStyle(renderable: Renderable, style: NativeScenePaint["borderStyle"], sides: number): void {
    const handle = getYogaNode(renderable)._getSceneHandle(this)
    this.flushStaged()
    this.driver.renderLib.sceneSetBoxBorderStyle(this.driver.context, handle, style, sides)
    this.changeGeometry()
  }

  /** @internal Native copies bytes and styles before the wrapper publishes caller identity. */
  setText(renderable: Renderable, content: string | StyledText): void {
    this.flushStaged()
    const node = getYogaNode(renderable)._getSceneHandle(this)
    if (typeof content === "string") {
      this.driver.renderLib.sceneSetText(this.driver.context, node, this.driver.renderLib.encoder.encode(content))
    } else {
      this.driver.renderLib.sceneSetStyledText(this.driver.context, node, content)
    }
  }

  /** @internal Text options commit together without exposing the node-owned buffer or view. */
  setTextOptions(renderable: Renderable, options: NativeSceneTextOptions): void {
    this.flushStaged()
    this.driver.renderLib.sceneSetTextOptions(
      this.driver.context,
      getYogaNode(renderable)._getSceneHandle(this),
      options,
    )
  }

  /** @internal Native owns slider drawing and thumb geometry; the host retains input callbacks. */
  setSlider(renderable: Renderable, options: NativeSceneSliderOptions): void {
    this.flushStaged()
    this.driver.renderLib.sceneSetSlider(this.driver.context, getYogaNode(renderable)._getSceneHandle(this), options)
  }

  /** @internal Input-time query only, never a per-node frame pass. */
  getSliderThumb(renderable: Renderable): { size: number; start: number } {
    this.flushStaged()
    return this.driver.renderLib.sceneGetSliderThumb(this.driver.context, getYogaNode(renderable)._getSceneHandle(this))
  }

  /** @internal Standard arrow paint commits before its wrapper projection. */
  setArrow(renderable: Renderable, options: NativeSceneArrowOptions): void {
    this.flushStaged()
    this.driver.renderLib.sceneSetArrow(this.driver.context, getYogaNode(renderable)._getSceneHandle(this), options)
  }

  setImage(
    renderable: Renderable,
    image: NativeImage | null,
    fit: ImageFit,
    protocol: ImageRenderProtocol,
    buffer: OptimizedBuffer | null,
  ): void {
    this.flushStaged()
    const { renderLib: lib, context } = this.driver
    lib.sceneSetImage(
      context,
      getYogaNode(renderable)._getSceneHandle(this),
      image?._getContextHandle(lib, context) ?? null,
      fit,
      protocol,
      buffer?._getSceneHandle(this) ?? null,
    )
  }

  setEditorView(renderable: Renderable, view: ContextEditorViewHandle): void {
    this.flushStaged()
    this.driver.renderLib.sceneSetEditorView(this.driver.context, getYogaNode(renderable)._getSceneHandle(this), view)
  }

  setSurface(renderable: Renderable, buffer: OptimizedBuffer | null): void {
    this.flushStaged()
    this.driver.renderLib.sceneSetSurface(
      this.driver.context,
      getYogaNode(renderable)._getSceneHandle(this),
      buffer?._getSceneHandle(this) ?? null,
    )
  }

  refreshSurface(renderable: Renderable): void {
    if (renderable instanceof FrameBufferRenderable) renderable._refreshNativeSceneSurface()
  }

  setTextView(renderable: Renderable, view: ContextTextBufferViewHandle | null): void {
    this.flushStaged()
    this.driver.renderLib.sceneSetTextView(this.driver.context, getYogaNode(renderable)._getSceneHandle(this), view)
  }

  setTextViewPaint(renderable: Renderable, enabled: boolean): void {
    this.flushStaged()
    this.driver.renderLib.sceneSetTextViewPaint(
      this.driver.context,
      getYogaNode(renderable)._getSceneHandle(this),
      enabled,
    )
  }

  selectTextViewPaint(renderable: Renderable, enabled: boolean): void {
    this.flushStaged()
    const frame = this.frame
    if (!frame) throw new Error("Native text paint selection requires an active frame")
    this.driver.renderLib.sceneSelectTextViewPaint(
      this.driver.context,
      getYogaNode(renderable)._getSceneHandle(this),
      frame,
      enabled,
    )
  }

  setEditorOptions(renderable: Renderable, options: NativeSceneEditorOptions): void {
    this.flushStaged()
    this.driver.renderLib.sceneSetEditorOptions(
      this.driver.context,
      getYogaNode(renderable)._getSceneHandle(this),
      options,
    )
  }

  /** @internal Query native text metrics only when requested, never during JS frame traversal. */
  getText(renderable: Renderable): string {
    this.flushStaged()
    return this.driver.renderLib.sceneGetText(this.driver.context, getYogaNode(renderable)._getSceneHandle(this))
  }

  /** @internal Inherited Text drawing runs at the caller's exact paint position. */
  drawText(renderable: Renderable, buffer: OptimizedBuffer, x: number, y: number): void {
    this.flushStaged()
    const target = buffer._getSceneDrawTarget(this)
    this.driver.renderLib.contextDrawSceneText(
      target.context,
      target.target,
      target.frame,
      getYogaNode(renderable)._getSceneHandle(this),
      x,
      y,
    )
  }

  setTextSelection(
    renderable: Renderable,
    operation: "set" | "update" | "reset",
    bounds: LocalSelectionBounds | null,
    bg?: RGBA,
    fg?: RGBA,
  ): boolean {
    this.flushStaged()
    return this.driver.renderLib.sceneSetTextSelection(
      this.driver.context,
      getYogaNode(renderable)._getSceneHandle(this),
      {
        operation,
        anchorX: bounds?.anchorX ?? 0,
        anchorY: bounds?.anchorY ?? 0,
        focusX: bounds?.focusX ?? 0,
        focusY: bounds?.focusY ?? 0,
        behavior: bounds?.behavior ?? "cell",
        bg,
        fg,
      },
    )
  }

  getTextSelection(renderable: Renderable): { start: number; end: number } | null {
    this.flushStaged()
    return this.driver.renderLib.sceneGetTextSelection(
      this.driver.context,
      getYogaNode(renderable)._getSceneHandle(this),
    )
  }

  getSelectedText(renderable: Renderable): string {
    this.flushStaged()
    return this.driver.renderLib.sceneGetSelectedText(
      this.driver.context,
      getYogaNode(renderable)._getSceneHandle(this),
    )
  }

  /** @internal Line arrays are copied only for explicit line-info queries. */
  getTextLineInfo(renderable: Renderable) {
    this.flushStaged()
    return this.driver.renderLib.sceneGetTextLineInfo(
      this.driver.context,
      getYogaNode(renderable)._getSceneHandle(this),
    )
  }

  /** @internal Scalar metrics do not copy the document or its line arrays. */
  getTextMetrics(renderable: Renderable) {
    this.flushStaged()
    return this.driver.renderLib.sceneGetTextMetrics(this.driver.context, getYogaNode(renderable)._getSceneHandle(this))
  }

  /** @internal Native owns callback-time geometry projections and composes accepted ancestor translations. */
  getLayout(node: Node, rawYoga: boolean | "paint" = false): NativeSceneLayout {
    const handle = node._getSceneHandle(this)
    this.flushStaged()
    return this.driver.renderLib.sceneGetLayout(this.driver.context, handle, rawYoga)
  }

  /** @internal Measure a snapshot using its existing scene root, without preparing a frame. */
  measureSnapshot(root: Renderable): number {
    this.driver.renderLib.getYogaHost().assertMutable()
    this.assertAlive()
    if (this.frame) throw new Error("Cannot measure a snapshot during a native scene frame")
    const owner = this.renderer.root
    getYogaNode(root)._getSceneHandle(this)
    const attached = root.parent === owner
    if (root === owner || (root.parent && !attached)) throw new Error("Snapshot root belongs to another parent")
    if (!attached) owner.add(root)
    try {
      this.drainHookScans()
      this.runLifecyclePasses()
      this.drainHookScans()
      this.assertAlive()
      this.flushStaged()
      this.driver.renderLib.sceneMeasureLayout(
        this.driver.context,
        this.driver.session,
        getYogaNode(owner)._getSceneHandle(this),
      )
      return Math.max(1, Math.trunc(this.getLayout(getYogaNode(root), true).height))
    } finally {
      if (!attached && root.parent === owner) owner.remove(root)
    }
  }

  paint(
    deltaTime: number,
    getPaintOptions: () => Pick<
      NativeSceneFrameOptions,
      "background" | "useMouse" | "excludedHitNum" | "preserveUnwritten"
    >,
  ): void | Promise<void> {
    this.driver.renderLib.getYogaHost().assertMutable()
    this.assertAlive()
    this.renderer.root._setCurrentRenderable(undefined)
    this.drainHookScans()
    this.runLifecyclePasses()

    const continuation = this.advancePaint(deltaTime, getPaintOptions)
    if (continuation) return this.resumePaint(deltaTime, getPaintOptions, continuation)
  }

  private runLifecyclePasses(): void {
    if (this.renderer.root.visible) {
      let visits = 0
      for (const renderable of this.lifecyclePasses.iteratePending()) {
        if (this.destroyed || this.destroying || this.driver.disposed || this.renderer.isDestroyed) return
        if (this.renderer.controlState === RendererControlState.EXPLICIT_SUSPENDED) return
        if (++visits > maxHostRequests) throw new Error("Native scene lifecycle work limit exceeded")
        if (!renderable.isDestroyed) {
          renderable.onLifecyclePass?.call(renderable)
        }
        this.drainHookScans()
      }
    }
  }

  private async resumePaint(
    deltaTime: number,
    getPaintOptions: () => Pick<
      NativeSceneFrameOptions,
      "background" | "useMouse" | "excludedHitNum" | "preserveUnwritten"
    >,
    continuation: PaintContinuation | undefined,
  ): Promise<void> {
    while (continuation) {
      await continuation.wait
      this.cancelPaintYield = null
      if (continuation.restart) {
        this.drainHookScans()
        this.runLifecyclePasses()
        continuation = undefined
      }
      continuation = this.advancePaint(deltaTime, getPaintOptions, continuation)
    }
  }

  private advancePaint(
    deltaTime: number,
    getPaintOptions: () => Pick<
      NativeSceneFrameOptions,
      "background" | "useMouse" | "excludedHitNum" | "preserveUnwritten"
    >,
    continuation?: PaintContinuation,
  ): PaintContinuation | undefined {
    let request: NativeSceneFrameRequest | null = continuation?.request ?? null
    let currentPaint = continuation?.currentPaint
    let yielded = false
    try {
      while (
        !continuation?.cancelled &&
        !this.destroyed &&
        !this.destroying &&
        !this.driver.disposed &&
        !this.renderer.isDestroyed
      ) {
        this.drainHookScans()
        if (this.destroyed || this.destroying || this.driver.disposed || this.renderer.isDestroyed) return
        if (this.renderer.controlState === RendererControlState.EXPLICIT_SUSPENDED) return
        const options = { ...getPaintOptions(), maxLayoutRounds, maxHostRequests }
        if (this.destroyed || this.destroying || this.driver.disposed || this.renderer.isDestroyed) return
        // Lifecycle passes and paint hooks stage writes; native must accept them before it resumes.
        this.flushStaged()
        const geometryRevision = this.geometryRevision
        request = this.driver.renderLib.sceneFrameStep(
          this.driver.context,
          this.driver.session,
          request,
          options,
          this.paintBudget,
          this.workBudget,
        )
        request.geometryRevision = geometryRevision
        if (request.kind === 0) {
          this.paintedFrame = request
          return
        }
        if (request.kind === 6) {
          const wait = Promise.withResolvers<void>()
          const state: PaintContinuation = continuation ?? {
            request,
            currentPaint,
            wait: wait.promise,
            cancelled: false,
          }
          state.request = request
          state.currentPaint = currentPaint
          state.wait = wait.promise
          const cancel = this.driver.scheduler.schedule(wait.resolve)
          this.cancelPaintYield = (restart = false) => {
            state.restart = restart
            if (state.cancelled) return
            state.cancelled = true
            try {
              cancel()
            } finally {
              wait.resolve()
            }
          }
          yielded = true
          return state
        }
        // An entered node finishes self/after even when before destroys it.
        const retained =
          (request.kind === 5 || request.kind === 7) && currentPaint?.renderable.num === request.num
            ? currentPaint
            : undefined
        currentPaint = undefined
        const renderable = retained?.renderable ?? this.nodes.get(request.num)
        if (!renderable || (renderable.isDestroyed && !retained)) continue
        const handle = retained?.handle ?? getYogaNode(renderable)._getSceneHandle(this)
        const root = getYogaNode(this.renderer.root)._getSceneHandle(this)
        const session = this.driver.session
        if (
          request.session.contextId !== session.contextId ||
          request.session.slot !== session.slot ||
          request.session.generation !== session.generation ||
          request.root.contextId !== root.contextId ||
          request.root.slot !== root.slot ||
          request.root.generation !== root.generation ||
          request.node.contextId !== handle.contextId ||
          request.node.slot !== handle.slot ||
          request.node.generation !== handle.generation
        ) {
          throw new Error("Native scene returned a stale host request")
        }
        if (request.kind === 4 || request.kind === 7) currentPaint = { renderable, handle }
        if (request.kind === 4 || request.kind === 5 || request.kind === 7) {
          this.prefixFrame = request
          this.renderer.root._setCurrentRenderable(renderable)
        }
        try {
          renderable._runNativeSceneHook(request, deltaTime, this.renderer.nextRenderBuffer)
          this.renderer.root._setCurrentRenderable(undefined)
        } finally {
          this.prefixFrame = null
        }
      }
    } finally {
      if (!yielded && request && request !== this.paintedFrame && !this.driver.disposed) {
        try {
          this.driver.renderLib.sceneFrameCancel(this.driver.context, this.driver.session, request.frameId)
        } catch {
          // Destruction may have cancelled the attempt already. Preserve the original hook failure.
        }
      }
    }
  }

  commit(force = false): NativeSessionRenderStatus {
    const frame = this.paintedFrame
    if (!frame) throw new Error("Native scene has no painted frame")
    const result = this.driver.render(force, frame)
    if (result === NativeSessionRenderStatus.Pending || result === NativeSessionRenderStatus.Presented) {
      this.paintedFrame = null
    }
    return result
  }

  /** @internal Split output uses the same painted ticket and presentation endpoint. */
  commitSplit(
    commits: Parameters<NativeSession["renderSplit"]>[1],
    pinnedRenderOffset: number,
    force: boolean,
  ): ReturnType<NativeSession["renderSplit"]> {
    const frame = this.paintedFrame
    if (!frame) throw new Error("Native scene has no painted frame")
    const result = this.driver.renderSplit(frame, commits, pinnedRenderOffset, force)
    if (result.status === NativeSessionRenderStatus.Pending || result.status === NativeSessionRenderStatus.Presented) {
      this.paintedFrame = null
    }
    return result
  }

  /** @internal Called after active effects and captures unwind, never during synchronous node destruction. */
  cancelFrame(): void {
    this.cancelPaintYield?.()
    const frame = this.paintedFrame
    this.paintedFrame = null
    if (!frame || this.driver.disposed) return
    try {
      this.driver.renderLib.sceneFrameCancel(this.driver.context, this.driver.session, frame.frameId)
    } catch {
      // Session shutdown may have cancelled the draft already. Preserve the original failure.
    }
  }

  /** @internal Wake a parked turn without revoking active synchronous framebuffer scopes. */
  interruptPaint(): void {
    this.cancelPaintYield?.()
  }

  /** @internal An accepted native resize cancels only a parked attempt, not a synchronous hook scope. */
  restartPaint(): void {
    this.cancelPaintYield?.(true)
  }

  hitTest(x: number, y: number): number {
    this.assertAlive()
    const id = this.driver.renderLib.sceneHitTest(this.driver.context, this.driver.session, x, y)
    const renderable = this.nodes.get(id)
    return renderable && !renderable.isDestroyed ? id : 0
  }

  destroy(): void {
    if (this.destroyed || this.destroying) return
    this.driver.renderLib.getYogaHost().assertMutable()
    this.destroying = true
    // Nothing staged can matter to a scene whose every node is about to be released.
    this.staging.clear()
    this.yogaHost.forgetScene(this)
    this.hookScans.clear()
    let failure: { error: unknown } | undefined
    try {
      try {
        this.cancelPaintYield?.()
      } catch (error) {
        failure = { error }
      }
      // Include detached nodes: the scene, not membership in root, owns their handles.
      for (const renderable of this.nodes.values()) {
        try {
          renderable.destroyRecursively()
        } catch (error) {
          failure ??= { error }
        }
      }
      this.destroyed = this.nodes.size === 0
    } finally {
      this.staging.clear()
      this.yogaHost.forgetScene(this)
      this.destroying = false
    }
    if (failure) throw failure.error
  }
}
