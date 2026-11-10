import type { Selection } from "@opentui/core"
import { useEffect } from "react"
import { useEffectEvent } from "./use-event.js"
import { useRenderer } from "./use-renderer.js"

/**
 * Subscribe to text selection events.
 * Fires when the user selects text in the terminal (e.g., via mouse drag).
 *
 * @example
 * useSelectionHandler((selection) => {
 *   const text = selection.getSelectedText()
 *   console.log("Selected:", text)
 * })
 */
export const useSelectionHandler = (handler: (selection: Selection) => void) => {
  const renderer = useRenderer()
  const stableHandler = useEffectEvent(handler)

  useEffect(() => {
    renderer.on("selection", stableHandler)
    return () => {
      renderer.off("selection", stableHandler)
    }
  }, [renderer])
}
