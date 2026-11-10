import {
  BoxRenderable,
  type CliRenderer,
  type Renderable,
  type ScrollbackRenderContext,
  type ScrollbackSnapshot,
  type ScrollbackWriter,
} from "@opentui/core"
import { createSignal, type JSX } from "solid-js"
import { RendererContext } from "./elements/index.js"
import { _render as renderInternal, createComponent } from "./reconciler.js"

type DisposeFn = () => void

interface SnapshotRendererBinding {
  renderer: CliRenderer
  getHeight: () => number
  setHeight: (height: number) => void
}

let solidScrollbackRootCounter = 0
const MAX_AUTO_HEIGHT_PASSES = 4

export interface SolidScrollbackWriterOptions {
  width?: number
  height?: number
  rowColumns?: number
  startOnNewLine?: boolean
  trailingNewline?: boolean
}

export type SolidScrollbackNode = (ctx: ScrollbackRenderContext) => JSX.Element

function normalizeSnapshotDimension(value: number | undefined, axis: "width" | "height"): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Number.isFinite(value)) {
    throw new Error(`createScrollbackWriter requires a finite ${axis}`)
  }

  return Math.max(1, Math.trunc(value))
}

function createSnapshotRendererValue(
  renderContext: ScrollbackRenderContext["renderContext"],
  width: number,
  height: number,
  firstLineOffset: number,
): SnapshotRendererBinding {
  const [snapshotWidth] = createSignal(width)
  const [snapshotHeight, setSnapshotHeight] = createSignal(height)
  const renderer = Object.create(renderContext) as CliRenderer
  let offset = firstLineOffset

  Object.defineProperties(renderer, {
    width: {
      get: snapshotWidth,
      enumerable: true,
      configurable: true,
    },
    height: {
      get: snapshotHeight,
      enumerable: true,
      configurable: true,
    },
    claimFirstLineOffset: {
      value: () => {
        const out = offset
        offset = 0
        return out
      },
      enumerable: true,
      configurable: true,
    },
  })

  return {
    renderer,
    getHeight: snapshotHeight,
    setHeight(nextHeight: number): void {
      setSnapshotHeight(nextHeight)
      renderer.emit("resize", snapshotWidth(), nextHeight)
    },
  }
}

function clearLifecyclePasses(renderContext: ScrollbackRenderContext["renderContext"]): void {
  for (const renderable of [...renderContext.getLifecyclePasses()]) {
    renderContext.unregisterLifecyclePass(renderable)
  }
}

function resolveSnapshotHeight(
  renderContext: ScrollbackRenderContext["renderContext"],
  root: Renderable,
  snapshotRenderer: SnapshotRendererBinding,
): number {
  for (let pass = 0; pass < MAX_AUTO_HEIGHT_PASSES; pass++) {
    const measuredHeight = renderContext.nativeScene!.measureSnapshot(root)

    if (measuredHeight === snapshotRenderer.getHeight()) {
      clearLifecyclePasses(renderContext)
      return measuredHeight
    }

    snapshotRenderer.setHeight(measuredHeight)
  }

  // Give up on converging the synthetic height and let the final render rerun
  // lifecycle passes against the last consistent tree state.
  return renderContext.nativeScene!.measureSnapshot(root)
}

export function createScrollbackWriter(
  node: SolidScrollbackNode,
  options: SolidScrollbackWriterOptions = {},
): ScrollbackWriter {
  return (ctx: ScrollbackRenderContext): ScrollbackSnapshot => {
    const width = normalizeSnapshotDimension(options.width, "width") ?? Math.max(1, Math.trunc(ctx.width))
    const height = normalizeSnapshotDimension(options.height, "height")
    const startOnNewLine = options.startOnNewLine ?? true
    const firstLineWidth =
      !startOnNewLine && ctx.tailColumn > 0 && ctx.tailColumn < ctx.width
        ? Math.min(width, ctx.width - ctx.tailColumn)
        : width
    const firstLineOffset = width - firstLineWidth
    const snapshotRenderer = createSnapshotRendererValue(
      ctx.renderContext,
      width,
      height ?? Math.max(1, ctx.renderContext.height),
      firstLineOffset,
    )
    const root = new BoxRenderable(snapshotRenderer.renderer, {
      id: `solid-scrollback-root-${solidScrollbackRootCounter++}`,
      position: "absolute",
      left: 0,
      top: 0,
      width,
      height: height ?? "auto",
      border: false,
      backgroundColor: "transparent",
      shouldFill: false,
      flexDirection: "column",
    })
    Object.defineProperty(snapshotRenderer.renderer, "root", { value: root, enumerable: true, configurable: true })

    let dispose: DisposeFn | undefined
    let disposed = false

    const teardown = () => {
      if (disposed) {
        return
      }

      disposed = true
      dispose?.()
    }

    try {
      dispose = renderInternal(
        () =>
          createComponent(RendererContext.Provider, {
            get value() {
              return snapshotRenderer.renderer
            },
            get children() {
              return node(ctx)
            },
          }),
        root,
      )

      return {
        root,
        width,
        height: height ?? resolveSnapshotHeight(ctx.renderContext, root, snapshotRenderer),
        rowColumns: options.rowColumns,
        startOnNewLine,
        trailingNewline: options.trailingNewline,
        teardown,
      }
    } catch (error) {
      teardown()
      root.destroyRecursively()
      throw error
    }
  }
}

export function writeSolidToScrollback(
  renderer: CliRenderer,
  node: SolidScrollbackNode,
  options: SolidScrollbackWriterOptions = {},
): void {
  renderer.writeToScrollback(createScrollbackWriter(node, options))
}
