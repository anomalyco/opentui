import { useEffect } from "react"
import { useEffectEvent } from "./use-event.js"
import { useRenderer } from "./use-renderer.js"

/**
 * Subscribe to terminal window blur events.
 * Fires when the terminal window loses focus.
 *
 * @example
 * useBlur(() => {
 *   console.log("Terminal lost focus")
 * })
 */
export const useBlur = (handler: () => void) => {
  const renderer = useRenderer()
  const stableHandler = useEffectEvent(handler)

  useEffect(() => {
    renderer.on("blur", stableHandler)
    return () => {
      renderer.off("blur", stableHandler)
    }
  }, [renderer])
}
