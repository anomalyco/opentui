import { createCliRenderer, decodePasteBytes } from "@opentui/core"
import {
  createRoot,
  useBlur,
  useFocus,
  useKeyboard,
  useOnResize,
  usePaste,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from "@opentui/react"
import { useState } from "react"

function App() {
  const renderer = useRenderer()
  const [events, setEvents] = useState<string[]>([])
  const [focused, setFocused] = useState(true)

  const { width, height } = useTerminalDimensions()

  const log = (msg: string) => {
    setEvents((prev) => [...prev.slice(-14), msg])
  }

  // useKeyboard
  useKeyboard((key) => {
    if (key.name === "escape") {
      renderer.destroy()
      return
    }
    if (key.name === "c" && key.ctrl) {
      setEvents([])
      return
    }
    if (key.eventType !== "release") {
      log(`[keyboard] ${key.ctrl ? "ctrl+" : ""}${key.option ? "alt+" : ""}${key.name}`)
    }
  })

  // usePaste
  usePaste((event) => {
    const text = decodePasteBytes(event.bytes)
    log(`[paste] "${text.slice(0, 40)}${text.length > 40 ? "..." : ""}"`)
  })

  // useFocus
  useFocus(() => {
    setFocused(true)
    log("[focus] terminal gained focus")
  })

  // useBlur
  useBlur(() => {
    setFocused(false)
    log("[blur] terminal lost focus")
  })

  // useSelectionHandler
  useSelectionHandler((selection) => {
    const text = selection.getSelectedText()
    if (text) {
      log(`[selection] "${text.slice(0, 40)}${text.length > 40 ? "..." : ""}"`)
    }
  })

  // useOnResize
  useOnResize((w, h) => {
    log(`[resize] ${w}x${h}`)
  })

  return (
    <box style={{ flexDirection: "column", padding: 1 }}>
      <box style={{ border: true, borderStyle: "single", borderColor: "#666" }} title="Hooks Demo">
        <box style={{ flexDirection: "column", padding: 1 }}>
          <text fg="#FFFF00">React Hooks Validation</text>
          <text fg="#888">
            {"\n"}
            Terminal: {width}x{height} | Focus: {focused ? "YES" : "NO"}
            {"\n\n"}
            Actions:{"\n"}- Type any key (useKeyboard){"\n"}- Paste text (usePaste){"\n"}- Click away / back (useFocus,
            useBlur){"\n"}- Select text with mouse (useSelectionHandler){"\n"}- Resize terminal (useOnResize,
            useTerminalDimensions){"\n"}- Press Ctrl+C to clear | ESC to exit
          </text>
        </box>
      </box>

      <box
        style={{ border: true, borderStyle: "single", borderColor: "#444", marginTop: 1, flexGrow: 1 }}
        title="Event Log"
      >
        <box style={{ flexDirection: "column", padding: 1 }}>
          {events.length === 0 ? (
            <text fg="#555">No events yet... try something!</text>
          ) : (
            events.map((event, i) => (
              <text key={i} fg={eventColor(event)}>
                {event}
              </text>
            ))
          )}
        </box>
      </box>
    </box>
  )
}

function eventColor(event: string): string {
  if (event.startsWith("[keyboard]")) return "#ffffff"
  if (event.startsWith("[paste]")) return "#51cf66"
  if (event.startsWith("[focus]")) return "#74c0fc"
  if (event.startsWith("[blur]")) return "#ff922b"
  if (event.startsWith("[selection]")) return "#da77f2"
  if (event.startsWith("[resize]")) return "#ffd43b"
  return "#aaaaaa"
}

if (import.meta.main) {
  const renderer = await createCliRenderer()
  createRoot(renderer).render(<App />)
}
