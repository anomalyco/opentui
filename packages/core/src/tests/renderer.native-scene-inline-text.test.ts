import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable } from "../Renderable.js"

import { StyledText } from "../lib/styled-text.js"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { TextNodeRenderable } from "../renderables/TextNode.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

import { NativeStatus, resolveRenderLib } from "../zig.js"

const setups: TestRendererSetup[] = []

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const target = await createTestRenderer({
    width: 20,
    height: 6,
    useMouse: true,
    clock: new ManualClock(),
  })
  setups.push(target)
  return target
}

{
  for (const initiallyClean of [false, true]) {
    test(`native a later lifecycle mutation defers earlier ${initiallyClean ? "clean" : "dirty"} inline text`, async () => {
      const target = await setup()
      const text = new TextRenderable(target.renderer, { selectable: false, height: 1 })
      const child = TextNodeRenderable.fromString("before")
      text.add(child)
      const later = new BoxRenderable(target.renderer, { height: 1 })
      let mutate = !initiallyClean
      later.onLifecyclePass = () => {
        if (mutate) {
          mutate = false
          child.replace("after", 0)
        }
      }
      target.renderer.root.add(text)
      target.renderer.root.add(later)
      await target.renderOnce()
      if (initiallyClean) {
        mutate = true
        await target.renderOnce()
      }
      assert.equal(text.plainText, "before")
      assert.ok(target.captureCharFrame().startsWith("before"))
      assert.equal(text.textNode.isDirty, true)
      await target.renderOnce()
      assert.equal(text.plainText, "after")
    })
  }

  test(`native an earlier lifecycle mutation composes later clean inline text in the same frame`, async () => {
    const target = await setup()
    const earlier = new BoxRenderable(target.renderer, { height: 0 })
    const text = new TextRenderable(target.renderer, { selectable: false, height: 1 })
    const child = TextNodeRenderable.fromString("before")
    text.add(child)
    const later = new BoxRenderable(target.renderer, { height: 1 })
    const observed: string[] = []
    later.onLifecyclePass = () => observed.push(text.plainText)
    let mutate = false
    earlier.onLifecyclePass = () => {
      if (mutate) {
        mutate = false
        child.replace("after", 0)
      }
    }
    target.renderer.root.add(earlier)
    target.renderer.root.add(text)
    target.renderer.root.add(later)
    await target.renderOnce()
    mutate = true
    await target.renderOnce()
    assert.equal(text.plainText, "after")
    assert.deepEqual(observed, ["before", "after"])
  })

  test(`native a lifecycle wrapper saved before children retains composition and binding`, async () => {
    const target = await setup()
    const text = new TextRenderable(target.renderer, { selectable: false })
    const original = text.onLifecyclePass
    let calls = 0
    text.onLifecyclePass = () => {
      calls++
      original?.call(text)
    }
    text.add("wrapped")
    target.renderer.root.add(text)
    await target.renderOnce()
    assert.equal(calls, 1)
    assert.equal(text.plainText, "wrapped")
    await target.renderOnce()
    assert.equal(calls, 2)
  })

  test(`native inline text preserves constructor content precedence and the clear latch`, async () => {
    const target = await setup()
    for (const content of [undefined, "", "manual", new StyledText([])]) {
      const text = new TextRenderable(target.renderer, { selectable: false, content, height: 1 })
      target.renderer.root.add(text)
      const projection = text.content
      text.add("inline")
      await target.renderOnce()
      const manual = content !== undefined && content !== ""
      assert.equal(text.plainText, manual ? (typeof content === "string" ? content : "") : "inline")
      assert.deepEqual(text.content, projection)
      if (content instanceof StyledText) assert.equal(text.content, content)
      text.clear()
      assert.deepEqual(text.getTextChildren(), [])
      assert.equal(text.plainText, "")
      text.add("after clear")
      await target.renderOnce()
      assert.equal(text.plainText, manual ? "" : "after clear")
      text.destroy()
    }
  })

  test(`native assigning empty manual content before the first composition suppresses children`, async () => {
    const target = await setup()
    const text = new TextRenderable(target.renderer, { selectable: false })
    target.renderer.root.add(text)
    text.add("pending")
    text.content = ""
    await target.renderOnce()
    assert.equal(text.plainText, "")
    text.clear()
    text.add("still pending")
    await target.renderOnce()
    assert.equal(text.plainText, "")
  })

  test(`native reassigning the original empty projection latches manual mode without replacing composed text`, async () => {
    const target = await setup()
    const text = new TextRenderable(target.renderer, { selectable: false })
    const projection = text.content
    target.renderer.root.add(text)
    text.add("composed")
    await target.renderOnce()
    assert.equal(text.content, projection)
    text.content = projection
    text.add(" ignored")
    await target.renderOnce()
    assert.equal(text.plainText, "composed")
    assert.equal(text.content, projection)
  })
}

test("native checked inline rejection and failed clear retain ownership and permit explicit retry", async () => {
  const target = await setup()
  const text = new TextRenderable(target.renderer, { selectable: false })
  const child = TextNodeRenderable.fromString("accepted", { link: { url: "https://example.test/accepted" } })
  text.add(child)
  target.renderer.root.add(text)
  await target.renderOnce()
  const before = target.captureSpans()
  const symbols = (
    resolveRenderLib() as unknown as {
      opentui: { symbols: { ot_scene_set_styled_text_with_links(...args: unknown[]): number } }
    }
  ).opentui.symbols
  child.replace("replaced", 0)
  const rejected = spyOn(symbols, "ot_scene_set_styled_text_with_links").mockImplementation(
    () => NativeStatus.OutOfMemory,
  )
  const errors: Error[] = []
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  try {
    await target.renderOnce()
    assert.equal(rejected.mock.calls.length, 1)
    assert.equal(errors.length, 1)
    assert.equal(text.plainText, "accepted")
    assert.deepEqual(target.captureSpans(), before)
    assert.equal(text.textNode.isDirty, true)
    assert.equal(child.isDirty, true)
  } finally {
    rejected.mockRestore()
  }
  const clearFailure = new Error("fixture rejected clear")
  const clear = spyOn(resolveRenderLib(), "sceneSetText").mockImplementation(() => {
    throw clearFailure
  })
  try {
    assert.throws(() => text.clear(), clearFailure)
    assert.equal(child.parent, text.textNode)
    assert.deepEqual(text.getTextChildren(), [child])
    assert.equal(text.plainText, "accepted")
    assert.equal(text.textNode.isDirty, true)
  } finally {
    clear.mockRestore()
  }
  await target.renderOnce()
  assert.equal(text.plainText, "replaced")
  assert.equal(text.textNode.isDirty, false)
  child.link = { url: null as never }
  await target.renderOnce()
  assert.equal(errors.length, 2)
  assert.equal(text.plainText, "replaced")
  assert.equal(text.textNode.isDirty, true)
  child.link = undefined
  await target.renderOnce()
  assert.equal(text.textNode.isDirty, false)
  text.clear()
  assert.equal(child.parent, null)
  assert.equal(text.plainText, "")
})

test("native inline detached dirtiness survives reattachment and retained host nodes survive wrapper destruction", async () => {
  const target = await setup()
  const text = new TextRenderable(target.renderer, { selectable: false })
  const parent = new TextNodeRenderable({})
  const child = TextNodeRenderable.fromString("first")
  parent.add(child)
  text.add(parent)
  target.renderer.root.add(text)
  await target.renderOnce()
  target.renderer.root.remove(text)
  child.replace("detached", 0)
  assert.equal(target.renderer.getLifecyclePasses().has(text), false)
  target.renderer.root.add(text)
  await target.renderOnce()
  assert.equal(text.plainText, "detached")
  text.destroy()
  assert.equal(parent.parent, null)
  assert.equal(child.parent, parent)
  child.replace("retained", 0)
  const next = new TextRenderable(target.renderer, { selectable: false })
  next.add(parent)
  target.renderer.root.add(next)
  await target.renderOnce()
  assert.equal(next.plainText, "retained")
})

test("native inline work is sparse, uses no compatibility resources and detaches children on cleanup", async () => {
  const target = await setup()
  const lib = resolveRenderLib()

  const registered = new Set(Renderable.renderablesByNumber.keys())
  {
    const texts = Array.from({ length: 40 }, () => {
      const text = new TextRenderable(target.renderer, { selectable: false })
      target.renderer.root.add(text)
      return text
    })
    assert.equal(target.renderer.getLifecyclePasses().size, 0)
    const child = TextNodeRenderable.fromString("inline")
    texts[0].add(child)
    assert.deepEqual([...target.renderer.getLifecyclePasses()], [texts[0]])
    await target.renderOnce()
    assert.equal(target.renderer.getLifecyclePasses().size, 0)
    const submitted = spyOn(lib, "sceneSetStyledText")
    const dispatched = spyOn(lib, "sceneGetLayout")
    try {
      await target.renderOnce()
      assert.equal(submitted.mock.calls.length, 0)
      assert.equal(dispatched.mock.calls.length, 0)
    } finally {
      submitted.mockRestore()
      dispatched.mockRestore()
    }
    child.add(" dirty")
    texts[0].destroy()
    assert.equal(child.parent, null)
    assert.deepEqual(texts[0].getTextChildren(), [])
    child.add(" detached")
    assert.equal(target.renderer.getLifecyclePasses().size, 0)
    for (const text of texts) text.destroy()
    assert.deepEqual(new Set(Renderable.renderablesByNumber.keys()), registered)
  }
})
