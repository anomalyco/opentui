import { captureRenderSnapshot as snapshot, expectRenderSnapshot } from "./render-snapshot.js"
import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable, RenderableEvents } from "../Renderable.js"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { CodeRenderable } from "../renderables/Code.js"
import { DiffRenderable, type DiffRenderableOptions } from "../renderables/Diff.js"

import { SyntaxStyle } from "../syntax-style.js"

import { ManualClock } from "../testing/manual-clock.js"
import { MockTreeSitterClient } from "../testing/mock-tree-sitter-client.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const setups: TestRendererSetup[] = []
const styles: SyntaxStyle[] = []
const clients: MockTreeSitterClient[] = []

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
  for (const client of clients.splice(0)) await client.destroy()
  for (const style of styles.splice(0)) style.destroy()
})

const patch = `--- a/example.txt
+++ b/example.txt
@@ -1,3 +1,3 @@
 header
-old alpha beta gamma delta epsilon zeta
+new alpha
 tail
@@ -20,2 +20,2 @@
-before
+after
 end`

async function setup() {
  const target = await createTestRenderer({
    width: 64,
    height: 14,
    useMouse: true,
    clock: new ManualClock(),
  })
  setups.push(target)
  const syntaxStyle = SyntaxStyle.fromStyles({ keyword: { fg: "#80c0ff", bold: true } }, target.renderer.nativeScene)
  styles.push(syntaxStyle)
  const client = new MockTreeSitterClient()
  clients.push(client)
  const errors: Error[] = []
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  return {
    ...target,
    syntaxStyle,
    client,
    async renderOnce() {
      const count = target.renderer.getStats().nativeFrameCount
      await target.renderOnce()
      assert.deepEqual(errors, [])
      assert.equal(target.renderer.getStats().nativeFrameCount, count + 1)
    },
  }
}

type Target = Awaited<ReturnType<typeof setup>>

function mount(target: Target, options: Partial<DiffRenderableOptions> = {}) {
  const diff = new DiffRenderable(target.renderer, {
    diff: patch,
    view: "split",
    wrapMode: "none",
    width: "100%",
    height: "100%",
    syntaxStyle: target.syntaxStyle,
    treeSitterClient: target.client,
    addedLineNumberBg: "#204020",
    removedLineNumberBg: "#402020",
    ...options,
  })
  target.renderer.root.add(diff)
  return diff
}

function codes(diff: DiffRenderable): CodeRenderable[] {
  return diff.getChildren().flatMap((side) => side.getChildren().filter((child) => child instanceof CodeRenderable))
}

async function compare(native: Target) {
  await native.renderOnce()
  const frame = snapshot(native)
  expectRenderSnapshot(frame)
  return frame.text
}

test.each(["unified", "split"] as const)(
  "native %s diffs retain source control characters without emitting them",
  async (view) => {
    const target = await setup()
    const content = "before\x00\x07\x08\x0b\x0c\x1b[31m\x7f\u0085\u009bafter"
    const patch = `--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+${content}`
    for (let index = 0; index < 3; index++) {
      const diff = mount(target, { view, diff: patch, filetype: "text" })
      await target.renderOnce()
      assert.ok(target.captureCharFrame().includes("before[31mafter"))
      target.client.resolveAllHighlightOnce()
      await Promise.all(codes(diff).map((code) => code.highlightingDone))
      await target.renderOnce()
      assert.equal(codes(diff).at(-1)!.plainText, view === "unified" ? `old\n${content}` : content)
      assert.ok(target.captureCharFrame().includes("before[31mafter"))
      assert.doesNotMatch(target.captureCharFrame(), /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/)
      diff.destroyRecursively()
    }
  },
)

test.each(["unified", "split"] as const)(
  "native %s Diff invalidates hunk offsets after Code conceals source lines",
  async (view) => {
    const target = await setup()
    target.client.setMockResult({ highlights: [[0, 7, "conceal", { conceal: "", concealLines: "" }]] })
    const diff = mount(target, { diff: patch.replace("header", "hidden"), view, filetype: "text", conceal: true })
    await compare(target)
    const offset = view === "unified" ? 4 : 3
    assert.deepEqual(diff.getHunkRowOffsets(), [0, offset])
    target.client.resolveAllHighlightOnce()
    await Promise.all(codes(diff).map((code) => code.highlightingDone))
    const concealed = await compare(target)
    assert.ok(!concealed.includes("hidden"))
    assert.ok(concealed.includes("2 - old alpha"), concealed)
    assert.deepEqual(diff.getHunkRowOffsets(), [0, offset - 1])
    for (const code of codes(diff)) assert.equal(code.lineInfo.lineSources[0], 1)
  },
)

test.each(["destroyRecursively", "destroy"] as const)(
  "native Diff %s cancels deferred rebuilds and late highlights on detached panes",
  async (destroy) => {
    const target = await setup()
    const registered = new Set(Renderable.renderablesByNumber.keys())
    const diff = mount(target, { filetype: "text" })
    await target.renderOnce()
    const panes = codes(diff)
    const sides = diff.getChildren()
    const pending = panes.map((code) => code.highlightingDone)
    assert.ok(panes.every((code) => code.isHighlighting))
    diff.diff = patch.replace("new alpha", "replacement")
    diff.view = "unified"
    assert.equal(sides[1].parent, null)
    diff[destroy]()
    target.client.resolveAllHighlightOnce()
    await Promise.all(pending)
    await target.renderOnce()
    assert.equal(target.captureCharFrame().trim(), "")
    for (const code of panes) {
      assert.equal(code.isDestroyed, true)
      assert.equal(code.isHighlighting, false)
      assert.equal(code.listenerCount("line-info-change"), 0)
    }
    assert.ok(sides.every((side) => side.isDestroyed))
    assert.deepEqual(new Set(Renderable.renderablesByNumber.keys()), registered)
  },
)

test("native Diff releases hidden error views after a cleanup error", async () => {
  const target = await setup()
  const registered = new Set(Renderable.renderablesByNumber.keys())
  const diff = mount(target, { view: "unified", diff: patch.replace("@@ -1,3 +1,3 @@", "@@ -a,b +c,d @@") })
  await target.renderOnce()
  assert.ok(target.captureCharFrame().includes("Error parsing diff"))
  const errors = diff.getChildren()
  const errorCode = errors.find((child) => child instanceof CodeRenderable)!
  const pending = errorCode.highlightingDone
  diff.diff = patch
  await target.renderOnce()
  assert.ok(errors.every((child) => child.parent === null))
  assert.ok(target.captureCharFrame().includes("old alpha"))
  const failure = new Error("error-view cleanup failed")
  errors[0].on(RenderableEvents.DESTROYED, () => {
    throw failure
  })
  assert.throws(
    () => diff.destroyRecursively(),
    (error) => error === failure,
  )
  target.client.resolveAllHighlightOnce()
  await pending
  await target.renderOnce()
  assert.equal(target.captureCharFrame().trim(), "")
  assert.ok(errors.every((child) => child.isDestroyed))
  assert.deepEqual(new Set(Renderable.renderablesByNumber.keys()), registered)
})

test(`native Diff theme replacement invalidates highlights in inactive panes`, async () => {
  const target = await setup()
  target.client.setMockResult({ highlights: [[0, 6, "keyword"]] })
  const diff = mount(target, { filetype: "text" })
  const [left, right] = codes(diff)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<undefined>()
  right.onHighlight = () => {
    entered.resolve()
    return release.promise
  }
  const warnings = spyOn(console, "warn")
  try {
    await target.renderOnce()
    target.client.resolveAllHighlightOnce()
    await entered.promise
    const pending = right.highlightingDone
    diff.view = "unified"
    const replacement = SyntaxStyle.fromStyles({ keyword: { fg: "#00ff00" } }, target.renderer.nativeScene)
    styles.push(replacement)
    diff.syntaxStyle = replacement
    target.syntaxStyle.destroy()
    release.resolve(undefined)
    await pending
    assert.deepEqual(warnings.mock.calls, [])
    assert.equal(left.syntaxStyle, replacement)
    assert.equal(right.syntaxStyle, replacement)
    diff.syntaxStyle = undefined
    assert.notEqual(right.syntaxStyle, replacement)
    assert.equal(left.syntaxStyle, right.syntaxStyle)
    assert.equal(right.syntaxStyle.getStyleCount(), 0)
    await target.renderOnce()
    assert.ok(target.captureCharFrame().includes("old alpha"))
  } finally {
    release.resolve(undefined)
    warnings.mockRestore()
  }
})

test(`native Diff releases fallback themes after cleanup errors without owning supplied themes`, async () => {
  const target = await setup()
  const diff = mount(target, { syntaxStyle: undefined })
  const fallback = codes(diff)[0].syntaxStyle
  styles.push(fallback)
  diff.syntaxStyle = target.syntaxStyle
  await target.renderOnce()
  for (const code of codes(diff)) assert.equal(code.syntaxStyle, target.syntaxStyle)
  const failure = new Error("pane cleanup failed")
  diff.getChildren()[0].on(RenderableEvents.DESTROYED, () => {
    throw failure
  })
  assert.throws(
    () => diff.destroyRecursively(),
    (error) => error === failure,
  )
  assert.throws(() => fallback.getStyleCount(), /destroyed/)
  assert.equal(target.syntaxStyle.getStyleCount(), 1)
  target.syntaxStyle.registerStyle("still-owned-by-caller", {})
})
