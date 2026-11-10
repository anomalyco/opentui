import type { AnimationTickCallback, AnimationTickOptions } from "@opentui/core"
import { useEffect } from "react"
import { flushSync } from "../reconciler/renderer.js"
import { useEffectEvent } from "./use-event.js"
import { useRenderer } from "./use-renderer.js"

/** Ticks `callback` at `fps` on the renderer's shared animation clock; an undefined rate pauses it. State updates
 * inside the callback commit synchronously, so they draw in the tick's frame. */
export const useAnimationTick = (
  fps: number | undefined,
  callback: AnimationTickCallback,
  options?: AnimationTickOptions,
) => {
  const renderer = useRenderer()
  const tick = useEffectEvent(callback)
  const tolerance = options?.tolerance

  useEffect(() => {
    if (fps === undefined) return
    return renderer.onAnimationTick(fps, (...args) => flushSync(() => tick(...args)), { tolerance })
  }, [renderer, fps, tolerance])
}
