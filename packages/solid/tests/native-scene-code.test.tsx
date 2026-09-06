import { expect, it } from "bun:test"
import { CodeRenderable, SyntaxStyle } from "@opentui/core"
import { ManualClock, MockTreeSitterClient } from "@opentui/core/testing"
import { createSignal, Show } from "solid-js"
import { testRender, useRenderer } from "../index.js"

it("replaces Code callbacks without remounting and cancels pending work on deferred unmount", async () => {
  const client = new MockTreeSitterClient()
  const [version, setVersion] = createSignal(0)
  const [visible, setVisible] = createSignal(true)
  const events: string[] = []
  let code!: CodeRenderable
  let style!: SyntaxStyle
  const handlers = () => {
    const current = version()
    return {
      onHighlight: () => {
        events.push(`${current}:highlight`)
        return undefined
      },
      onChunks: () => {
        events.push(`${current}:chunks`)
        return undefined
      },
    }
  }
  const setup = await testRender(
    () => {
      style = SyntaxStyle.fromStyles({}, useRenderer().nativeScene!)
      return (
        <Show when={visible()}>
          <code
            ref={code}
            content="code"
            filetype="typescript"
            syntaxStyle={style}
            treeSitterClient={client}
            {...handlers()}
          />
        </Show>
      )
    },
    { width: 16, height: 2, clock: new ManualClock() },
  )
  try {
    const original = code
    for (const value of [0, 1]) {
      setVersion(value)
      await setup.renderOnce()
      expect(code.isHighlighting).toBe(true)
      client.resolveHighlightOnce()
      await code.highlightingDone
      expect(code).toBe(original)
    }
    expect(events).toEqual(["0:highlight", "0:chunks", "1:highlight", "1:chunks"])
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("code")

    setVersion(2)
    await setup.renderOnce()
    expect(code.isHighlighting).toBe(true)
    const pending = code.highlightingDone
    setVisible(false)
    expect(code.parent).toBeNull()
    expect(code.isDestroyed).toBe(false)
    await new Promise<void>((resolve) => process.nextTick(resolve))
    expect(code.isDestroyed).toBe(true)
    client.resolveHighlightOnce()
    await pending
    expect(events).toHaveLength(4)
    await setup.renderOnce()
    expect(setup.captureCharFrame().trim()).toBe("")
  } finally {
    setup.renderer.destroy()
    await setup.renderer.closed
    await client.destroy()
    style.destroy()
  }
})
