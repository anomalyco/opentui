import { expect, it } from "bun:test"
import { CodeRenderable, SyntaxStyle } from "@opentui/core"
import { ManualClock, MockTreeSitterClient } from "@opentui/core/testing"
import { act, createRef, useState } from "react"
import { useRenderer } from "../src/index.js"
import { testRender } from "../src/test-utils.js"

it("replaces Code callbacks without remounting and cancels pending work on unmount", async () => {
  const client = new MockTreeSitterClient()
  const ref = createRef<CodeRenderable>()
  const events: string[] = []
  let update!: (state: { version: number; visible: boolean }) => void
  let style!: SyntaxStyle
  function App() {
    const renderer = useRenderer()
    style ??= SyntaxStyle.fromStyles({}, renderer.nativeScene!)
    const [state, setState] = useState({ version: 0, visible: true })
    update = setState
    return state.visible ? (
      <code
        ref={ref}
        content="code"
        filetype="typescript"
        syntaxStyle={style}
        treeSitterClient={client}
        onHighlight={(highlights) => {
          events.push(`${state.version}:highlight`)
          return highlights
        }}
        onChunks={(chunks) => {
          events.push(`${state.version}:chunks`)
          return chunks
        }}
      />
    ) : null
  }
  const setup = await testRender(<App />, { width: 16, height: 2, clock: new ManualClock() })
  try {
    const code = ref.current!
    for (const version of [0, 1]) {
      act(() => update({ version, visible: true }))
      await setup.renderOnce()
      expect(code.isHighlighting).toBe(true)
      client.resolveHighlightOnce()
      await code.highlightingDone
      expect(ref.current).toBe(code)
    }
    expect(events).toEqual(["0:highlight", "0:chunks", "1:highlight", "1:chunks"])
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("code")

    act(() => update({ version: 2, visible: true }))
    await setup.renderOnce()
    expect(code.isHighlighting).toBe(true)
    const pending = code.highlightingDone
    act(() => update({ version: 2, visible: false }))
    expect(ref.current).toBeNull()
    expect(code.isDestroyed).toBe(true)
    client.resolveHighlightOnce()
    await pending
    expect(events).toHaveLength(4)
    await setup.renderOnce()
    expect(setup.captureCharFrame().trim()).toBe("")
  } finally {
    act(() => setup.renderer.destroy())
    await setup.renderer.closed
    await client.destroy()
    style.destroy()
  }
})
