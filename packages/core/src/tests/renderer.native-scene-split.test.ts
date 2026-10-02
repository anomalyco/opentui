import { afterEach, expect, test } from "bun:test"
import { Renderable, RenderableEvents } from "../Renderable.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CodeRenderable } from "../renderables/Code.js"
import { TextRenderable } from "../renderables/Text.js"
import { SyntaxStyle } from "../syntax-style.js"
import { createTestRenderer, MockTreeSitterClient, type TestRenderer } from "../testing.js"

const renderers: TestRenderer[] = []
afterEach(async () => {
  for (const renderer of renderers.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
    width: 24,
    height: 10,
    footerHeight: 3,
    consoleMode: "disabled",
  })
  renderers.push(result.renderer)
  return result
}

test("detached paint retries independently inside a main frame and commits retained rows", async () => {
  const { renderer, renderOnce, captureCharFrame, externalOutput } = await setup()
  const surface = renderer.createScrollbackSurface()
  let fail = true
  const box = new BoxRenderable(surface.renderContext, {
    width: 24,
    height: 2,
    renderBefore() {
      if (fail) throw new Error("detached paint failed")
    },
  })
  box.add(new TextRenderable(surface.renderContext, { content: "detached", height: 1 }))
  surface.root.add(box)
  const footer = new BoxRenderable(renderer, { width: 24, height: 1, renderBefore: () => surface.render() })
  footer.add(new TextRenderable(renderer, { content: "footer", height: 1 }))
  renderer.root.add(footer)
  expect(() => surface.render()).toThrow("detached paint failed")
  expect(() => surface.commitRows(0, 1)).toThrow("requires render()")
  fail = false
  await renderOnce()
  expect(captureCharFrame()).toContain("footer")
  expect(captureCharFrame()).not.toContain("detached")
  surface.commitRows(0, 1)
  surface.commitRows(1, 2)
  expect(externalOutput.takeText()).toContain("detached")
})

test.each(["writer", "geometry", "measurement"] as const)(
  "snapshot %s failure releases provisional nodes",
  async (kind) => {
    const { renderer, externalOutput } = await setup()
    const registered = new Set(Renderable.renderablesByNumber.keys())
    let root: BoxRenderable | undefined
    expect(() =>
      renderer.writeToScrollback(({ renderContext }) => {
        root = new BoxRenderable(renderContext, { width: 12 })
        if (kind === "writer") throw new Error("writer failed")
        if (kind === "geometry") return { root, width: NaN, height: 1 }
        let fail = true
        root.setMeasureProvider(() => {
          if (fail) throw new Error("measurement failed")
          return { width: 12, height: 3 }
        })
        expect(() => renderContext.nativeScene.measureSnapshot(root!)).toThrow("measurement failed")
        fail = false
        root.invalidateIntrinsicSize()
        expect(renderContext.nativeScene.measureSnapshot(root)).toBe(3)
        throw new Error("writer failed")
      }),
    ).toThrow(kind === "geometry" ? "width" : "writer failed")
    expect(root?.isDestroyed).toBe(true)
    expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
    renderer.writeToScrollback(({ renderContext }) => ({
      root: new TextRenderable(renderContext, { content: "next", width: 4, height: 1 }),
    }))
    expect(externalOutput.takeText()).toBe("next")
    expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
  },
)

test("detached destruction waits for active child cleanup", async () => {
  const { renderer, renderOnce } = await setup()
  const registered = new Set(Renderable.renderablesByNumber.keys())
  const surface = renderer.createScrollbackSurface()
  const driver = surface.renderContext.nativeScene.driver
  const child = new TextRenderable(surface.renderContext, { content: "child" })
  surface.root.add(child)
  child.on(RenderableEvents.DESTROYED, () => {
    surface.destroy()
    expect(driver.disposed).toBe(false)
  })
  child.destroy()
  expect(driver.disposed).toBe(true)
  expect(surface.root.isDestroyed).toBe(true)
  expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
  await renderOnce()
})

test("settlement ignores removed code and cancels mounted pending highlights on destruction", async () => {
  const { renderer } = await setup()
  const surface = renderer.createScrollbackSurface()
  const client = new MockTreeSitterClient()
  const style = SyntaxStyle.fromStyles({}, renderer.nativeScene)
  try {
    const code = new CodeRenderable(surface.renderContext, {
      content: "const pending = true",
      filetype: "typescript",
      syntaxStyle: style,
      treeSitterClient: client,
      width: "100%",
    })
    surface.root.add(code)
    surface.render()
    expect(code.isHighlighting).toBe(true)
    surface.root.remove(code)
    await surface.settle(0)
    expect(code.isDestroyed).toBe(false)
    surface.root.add(code)
    const settling = surface.settle(10_000)
    surface.destroy()
    await expect(settling).rejects.toThrow("destroyed")
    client.resolveAllHighlightOnce()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(code.isDestroyed).toBe(true)
  } finally {
    surface.destroy()
    client.resolveAllHighlightOnce()
    await client.destroy()
    style.destroy()
  }
})
