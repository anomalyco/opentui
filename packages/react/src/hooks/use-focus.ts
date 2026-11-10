import { useEffect } from "react"
import { useEffectEvent } from "./use-event.js"
import { useRenderer } from "./use-renderer.js"

/**
 * Subscribe to terminal window focus events.
 * Fires when the terminal window gains focus.
 *
 * @example
 * useFocus(() => {
 *   console.log("Terminal gained focus")
 * })
 */
export const useFocus = (handler: () => void) => {
  const renderer = useRenderer()
  const stableHandler = useEffectEvent(handler)

  useEffect(() => {
    renderer.on("focus", stableHandler)
    return () => {
      renderer.off("focus", stableHandler)
    }
  }, [renderer])
}
