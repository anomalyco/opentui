import { getTimelineEngine, Timeline, type TimelineOptions } from "@opentui/core"
import { useEffect, useState } from "react"
import { useRenderer } from "./use-renderer.js"

export const useTimeline = (options: TimelineOptions = {}) => {
  const renderer = useRenderer()
  const [timeline] = useState(() => new Timeline(options))
  const [autoplay] = useState(options.autoplay !== false)

  useEffect(() => {
    const engine = getTimelineEngine(renderer)
    if (autoplay) {
      timeline.play()
    }

    engine.register(timeline)

    return () => {
      try {
        timeline.pause()
      } finally {
        engine.unregister(timeline)
      }
    }
  }, [autoplay, timeline, renderer])

  return timeline
}
