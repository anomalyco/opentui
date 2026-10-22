import { createCliRenderer } from "@opentui/core"
import { createRoot, flushSync, useKeyboard, useRenderer } from "@opentui/react"
import { useRef, useState } from "react"

/**
 * flushSync forces React to flush updates synchronously, preventing batching.
 * Press 'a' to see batched updates (1 render for 3 setState calls).
 * Press 's' to see flushSync updates (3 separate renders).
 */
export const App = () => {
  const renderer = useRenderer()
  const [a, setA] = useState(0)
  const [b, setB] = useState(0)
  const [c, setC] = useState(0)
  const renderCount = useRef(0)
  const [log, setLog] = useState<string[]>([])

  renderCount.current++

  useKeyboard((key) => {
    if (key.name === "q") renderer.destroy()

    if (key.name === "a") {
      const before = renderCount.current
      // Without flushSync: React batches all 3 into 1 render
      setA((x) => x + 1)
      setB((x) => x + 1)
      setC((x) => x + 1)
      const after = renderCount.current
      setLog((l) => [...l.slice(-4), `batched: renders ${before} -> ${after} (no change yet)`])
    }

    if (key.name === "s") {
      const before = renderCount.current
      // With flushSync: each update triggers a separate render
      flushSync(() => setA((x) => x + 1))
      flushSync(() => setB((x) => x + 1))
      flushSync(() => setC((x) => x + 1))
      const after = renderCount.current
      setLog((l) => [...l.slice(-4), `flushSync: renders ${before} -> ${after} (+3 renders)`])
    }
  })

  return (
    <box style={{ flexDirection: "column", padding: 1 }}>
      <text content="flushSync Demo" style={{ fg: "#FFFF00", attributes: 1 }} />
      <text content="'a' = batched | 's' = flushSync | 'q' = quit" style={{ fg: "#666666" }} />
      <text
        content={`a=${a} b=${b} c=${c}  (renders: ${renderCount.current})`}
        style={{ fg: "#00FF00", marginTop: 1 }}
      />
      <box title="Log" style={{ border: true, marginTop: 1, flexDirection: "column", width: 55 }}>
        {log.map((l, i) => (
          <text key={i} content={l} style={{ fg: l.startsWith("flush") ? "#00FFFF" : "#FF8800" }} />
        ))}
      </box>
    </box>
  )
}

if (import.meta.main) {
  const renderer = await createCliRenderer()
  createRoot(renderer).render(<App />)
}
