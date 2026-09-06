import { expect, test } from "bun:test"
import { BoxRenderable, Renderable, RGBA, type OptimizedBuffer, type TextRenderable } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { createSignal } from "solid-js"
import { render } from "../index.js"

for (const form of ["content", "JSX children"]) {
  test(`native renderSelf signal updates with ${form}`, async () => {
    const setup = await createTestRenderer({ width: 4, height: 2, clock: new ManualClock() })
    const [sweepLevel, setSweepLevel] = createSignal(0)
    const inactive = RGBA.fromInts(255, 0, 0)
    const active = RGBA.fromInts(0, 255, 0)
    let text!: TextRenderable
    let foregroundAfterSetter: RGBA | undefined

    class PulseRenderable extends Renderable {
      protected override renderSelf(): void {
        setSweepLevel(1)
        foregroundAfterSetter = text.fg
      }
    }

    try {
      // JSX children bake inherited colors before painting; content uses the live default foreground.
      await render(
        () => (
          <>
            {new PulseRenderable(setup.renderer, { id: "pulse", width: 1, height: 1 })}
            {form === "content" ? (
              <text ref={text} fg={sweepLevel() ? active : inactive} content="tab" />
            ) : (
              <text ref={text} fg={sweepLevel() ? active : inactive}>
                tab
              </text>
            )}
          </>
        ),
        setup.renderer,
      )

      expect(sweepLevel()).toBe(0)
      expect(text.fg.equals(inactive)).toBe(true)
      const frameId = setup.renderer.frameId

      await setup.renderOnce()

      expect(setup.renderer.frameId).toBe(frameId + 1)
      expect(sweepLevel()).toBe(1)
      expect(foregroundAfterSetter).toEqual(active)
      expect(setup.captureSpans().lines[1]?.spans[0]?.text).toBe("tab")
      expect(setup.captureSpans().lines[1]?.spans[0]?.fg).toEqual(form === "content" ? active : inactive)

      await setup.renderOnce()

      expect(setup.renderer.frameId).toBe(frameId + 2)
      expect(setup.captureSpans().lines[1]?.spans[0]?.text).toBe("tab")
      expect(setup.captureSpans().lines[1]?.spans[0]?.fg).toEqual(active)
    } finally {
      setup.renderer.destroy()
      await setup.renderer.closed
    }
  })
}

test(`native inherits custom Box drawing without losing its border or reactive siblings`, async () => {
  const setup = await createTestRenderer({ width: 8, height: 4, clock: new ManualClock() })
  const [content, setContent] = createSignal("before")
  let draws = 0

  class LabelBox extends BoxRenderable {
    protected override renderSelf(buffer: OptimizedBuffer): void {
      super.renderSelf(buffer)
      draws++
      buffer.drawText("label", this.x + 1, this.y + 1, RGBA.fromHex("#ffffff"))
    }
  }
  class InheritedLabelBox extends LabelBox {}

  try {
    const box = new InheritedLabelBox(setup.renderer, { id: "inherited", width: 8, height: 4, border: true })
    await render(
      () => (
        <>
          {box}
          <text position="absolute" left={1} top={2} content={content()} />
        </>
      ),
      setup.renderer,
    )
    await setup.renderOnce()
    expect(
      setup
        .captureCharFrame()
        .split("\n")
        .map((line) => line.trimEnd()),
    ).toEqual([
      "\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2510",
      "\u2502label \u2502",
      "\u2502before\u2502",
      "\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2518",
      "",
    ])
    expect(draws).toBe(1)

    setContent("after")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("\u2502after \u2502")
    expect(draws).toBe(2)
    expect(setup.renderer.hitTest(1, 1)).toBe(box.num)
    setup.renderer.destroy()
    await setup.renderer.closed
    expect(box.isDestroyed).toBe(true)
  } finally {
    setup.renderer.destroy()
    await setup.renderer.closed
  }
})
