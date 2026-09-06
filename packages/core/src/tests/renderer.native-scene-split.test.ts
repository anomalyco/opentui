import { afterEach, expect, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable, RenderableEvents } from "../Renderable.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CodeRenderable } from "../renderables/Code.js"
import { TextRenderable } from "../renderables/Text.js"
import { SyntaxStyle } from "../syntax-style.js"
import { createTestRenderer, MockTreeSitterClient, type TestRenderer } from "../testing.js"
import { NativeStatus } from "../zig.js"

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
  let paints = 0
  const box = new BoxRenderable(surface.renderContext, {
    width: 24,
    height: 2,
    renderBefore() {
      if (fail) throw new Error("detached paint failed")
      paints++
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
  expect(paints).toBeGreaterThan(0)
  const rendered = paints
  surface.commitRows(0, 1)
  surface.commitRows(1, 2)
  expect(paints).toBe(rendered)
  expect(externalOutput.takeText()).toContain("detached")
})

test("snapshot measurement runs lifecycle and Yoga without update, resize, or paint hooks", async () => {
  const { renderer, externalOutput } = await setup()
  const calls: string[] = []
  class Probe extends BoxRenderable {
    protected override onUpdate() {
      calls.push("update")
    }
  }
  renderer.writeToScrollback(({ renderContext }) => {
    const root = new Probe(renderContext, {
      width: 12,
      height: "auto",
      onSizeChange: () => calls.push("resize"),
      renderBefore: () => calls.push("paint"),
    })
    const text = new TextRenderable(renderContext, { content: "before", width: 12 })
    root.add(text)
    text.onLifecyclePass = () => {
      text.content = "one\ntwo"
    }
    renderContext.registerLifecyclePass(text)
    const height = renderContext.nativeScene.measureSnapshot(root)
    expect(height).toBe(2)
    expect(root.parent).toBeNull()
    expect(calls).toEqual([])
    return { root, width: 12, height }
  })
  expect(calls).toEqual(["resize", "update", "paint"])
  expect(externalOutput.takeText()).toBe("one\ntwo")
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
        expect(root.parent).toBeNull()
        fail = false
        root.invalidateIntrinsicSize()
        expect(renderContext.nativeScene.measureSnapshot(root)).toBe(3)
        expect(root.parent).toBeNull()
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

test("detached destruction retains active paint storage then reclaims the Session", async () => {
  const { renderer, renderOnce, captureCharFrame } = await setup()
  renderer.root.add(new TextRenderable(renderer, { content: "parent", height: 1 }))
  const surface = renderer.createScrollbackSurface()
  const driver = surface.renderContext.nativeScene.driver
  let painted = false
  surface.root.add(
    new BoxRenderable(surface.renderContext, {
      width: 1,
      height: 1,
      renderBefore(buffer) {
        buffer.withBuffers(({ char }) => {
          char[0] = 65
          surface.destroy()
          expect(driver.disposed).toBe(false)
          expect(char[0]).toBe(65)
          painted = true
        })
      },
    }),
  )
  try {
    surface.render()
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
  }
  expect(painted).toBe(true)
  expect(driver.disposed).toBe(true)
  assert.throws(() => driver.renderLib.sessionGetState(driver.context, driver.session), {
    status: NativeStatus.StaleHandle,
  })
  await renderOnce()
  expect(captureCharFrame()).toContain("parent")
})

test("detached destruction releases its Session after listener cleanup fails", async () => {
  const { renderer } = await setup()
  const surface = renderer.createScrollbackSurface()
  const driver = surface.renderContext.nativeScene.driver
  surface.renderContext.on("removeListener", () => {
    throw new Error("listener cleanup failed")
  })
  surface.renderContext.on("detached-listener", () => {})
  expect(() => surface.destroy()).toThrow("listener cleanup failed")
  expect(driver.disposed).toBe(true)
  expect(surface.isDestroyed).toBe(true)
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
