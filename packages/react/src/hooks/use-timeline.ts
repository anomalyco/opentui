import { engine, Timeline, type TimelineOptions } from "@opentui/core"
import { useEffect, useState } from "react"

export const useTimeline = (options: TimelineOptions = {}) => {
  const [timeline] = useState(() => new Timeline(options))
  const [autoplay] = useState(options.autoplay !== false)

  useEffect(() => {
    if (autoplay) {
      timeline.play()
    }

    engine.register(timeline)

    return () => {
      timeline.pause()
      engine.unregister(timeline)
    }
  }, [autoplay, timeline])

  return timeline
}
