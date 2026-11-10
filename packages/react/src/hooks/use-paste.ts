import type { PasteEvent } from "@opentui/core"
import { useEffect } from "react"
import { useAppContext } from "../components/app.js"
import { useEffectEvent } from "./use-event.js"

/**
 * Subscribe to terminal paste events (bracketed paste).
 *
 * @example
 * usePaste((event) => {
 *   console.log("Pasted:", event.text)
 * })
 */
export const usePaste = (handler: (event: PasteEvent) => void) => {
  const { keyHandler } = useAppContext()
  const stableHandler = useEffectEvent(handler)

  useEffect(() => {
    keyHandler?.on("paste", stableHandler)
    return () => {
      keyHandler?.off("paste", stableHandler)
    }
  }, [keyHandler])
}
