import { getYogaNode } from "../lib/renderable-layout.js"
import { ResourceContext } from "../buffer.js"
import assert from "node:assert/strict"
import { EditBuffer } from "../edit-buffer.js"
import { EditorView } from "../editor-view.js"
import { TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import { Renderable } from "../Renderable.js"
import { CodeRenderable } from "../renderables/Code.js"
import { SyntaxStyle } from "../syntax-style.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import Yoga, { YogaError, YogaStatus, type MeasureFunction } from "../yoga.js"
import { FFIRenderLib, NativeStatus, resolveRenderLib } from "../zig.js"

const lib = resolveRenderLib()
const config = Yoga.Config.create()
const root = Yoga.Node.create()
const node = Yoga.Node.create(config)
root.insertChild(node, 0)
assert.throws(() => config.free(), /Yoga nodes are active/)
for (const invalid of [
  () => root.getChild(-1),
  () => root.insertChild(root, 0),
  () => node.setDisplay(0xffffffff as never),
  () => node.setWidth(Infinity),
  () => config.setPointScaleFactor(-1),
  () => root.reset(),
  () => root.setMeasureFunc(() => ({ width: 1, height: 1 })),
  () => node.setDimension(2 as never, 1),
  () => lib.yogaNodeStyleSetPositions(node.ptr, 16, new Uint32Array(4), new Float32Array(4)),
  () => node.setPositions([{ unit: 0.5 as never, value: 1 }, undefined, undefined, undefined]),
  ...[0.5, NaN, Infinity, 0x100000000].map((index) => () => root.insertChild(node, index)),
  ...[0, 3, 5].flatMap((length) => [
    () => lib.yogaNodeStyleSetPositions(node.ptr, 1, new Uint32Array(length), new Float32Array(4)),
    () => lib.yogaNodeStyleSetPositions(node.ptr, 1, new Uint32Array(4), new Float32Array(length)),
  ]),
]) {
  assert.throws(invalid, (error) => error instanceof YogaError && error.status === YogaStatus.InvalidArgument)
}
assert.equal(root.getChild(0), node)
assert.equal(root.getChild(1), null)
assert.equal(root.getChild(0xffffffff), null)
assert.equal(root.hasMeasureFunc(), false)
const failure = new Error("measure failed")
node.setMeasureFunc(() => {
  assert.equal(node.getParent(), root)
  assert.equal(root.getChild(0), node)
  assert.equal(node.hasMeasureFunc(), true)
  throw failure
})
assert.throws(
  () => root.calculateLayout(),
  (error) => error === failure,
)

// A rejected async callback must not escape through Node FFI or later become an
// unhandled rejection that obscures the synchronous callback-contract error.
node.setMeasureFunc((async () => {
  throw failure
}) as unknown as MeasureFunction)
node.markDirty()
assert.throws(() => root.calculateLayout(), /Yoga callbacks must be synchronous/)
await new Promise((resolve) => setTimeout(resolve, 0))

let dirtiedCalls = 0
node.setDirtiedFunc(() => dirtiedCalls++)
for (const mutate of [
  () => root.calculateLayout(),
  () => Yoga.Node.create(config),
  () => node.free(),
  () => root.freeRecursive(),
  () => root.removeChild(node),
  () => node.setWidth(99),
  () => node.setMeasureFunc(() => ({ width: 99, height: 99 })),
  () => node.unsetMeasureFunc(),
  () => node.setDirtiedFunc(() => {}),
  () => node.unsetDirtiedFunc(),
  () => node.reset(),
  () => config.free(),
  () => lib.getYogaHost().dispose(),
  () => lib.yogaNodeFree(node.ptr),
]) {
  let shouldMutate = true
  let measureCalls = 0
  node.setMeasureFunc(() => {
    measureCalls++
    if (shouldMutate) mutate()
    return { width: 1, height: 1 }
  })
  node.markDirty()
  assert.throws(() => root.calculateLayout(), /Cannot mutate Yoga during a callback/)
  assert.equal(node.isFreed(), false)
  assert.equal(root.getChild(0), node)
  shouldMutate = false
  const before = dirtiedCalls
  node.markDirty()
  assert.equal(dirtiedCalls, before + 1)
  root.calculateLayout()
  assert.equal(measureCalls, 2)
  assert.equal(node.getComputedWidth(), 1)
}

node.unsetDirtiedFunc()
node.setMeasureFunc(() => ({ width: 7, height: 3 }))
node.markDirty()
root.calculateLayout()
assert.equal(node.getComputedWidth(), 7)
node.setDirtiedFunc(() => {
  throw failure
})
assert.throws(
  () => node.setWidth(8),
  (error) => error === failure,
)
assert.equal(node.getWidth().value, 8)
root.calculateLayout()
node.setDirtiedFunc(async () => {
  throw failure
})
assert.throws(() => node.markDirty(), /Yoga callbacks must be synchronous/)
await new Promise((resolve) => setTimeout(resolve, 0))
node.unsetDirtiedFunc()
root.freeRecursive()
const rawNode = lib.yogaNodeCreateWithConfig(config.ptr)
assert.throws(
  () => config.free(),
  (error) => error instanceof YogaError && error.status === YogaStatus.Busy,
)
lib.yogaNodeFree(rawNode)
config.free()

const { renderer, renderOnce } = await createTestRenderer({ width: 80, height: 30 })
const standalone = new ResourceContext({ objectCapacity: 4, renderCellsMax: 1 })
try {
  const scene = renderer.nativeScene
  const { context, session } = scene.driver
  for (const owner of [standalone, scene]) {
    const text = TextBuffer.create("unicode", owner)
    text.setText("hello")
    const view = TextBufferView.create(text)
    const edit = EditBuffer.create("unicode", owner)
    const editor = EditorView.create(edit, 20, 10)
    const syntaxStyle = SyntaxStyle.create(scene)
    const renderable = new CodeRenderable(renderer, { content: "hello", alignSelf: "flex-start", syntaxStyle })
    try {
      const nativeNode = getYogaNode(renderable)
      const nodeHandle = nativeNode._getSceneHandle(scene)
      renderer.root.add(renderable)
      if (owner === scene) scene.setTextView(renderable, view._getSceneHandle(scene))
      scene.measureSnapshot(renderable)
      assert.equal(nativeNode.getComputedWidth(), 5)
      const resourceContext = owner.driver.context
      const resourceMutations = [
        () => lib.destroyContextTextBuffer(resourceContext, text._getSceneHandle(owner)),
        () => lib.destroyContextTextBufferView(resourceContext, view._getSceneHandle(owner)),
        () => lib.destroyContextEditBuffer(resourceContext, edit._getSceneHandle(owner)),
        () => lib.destroyContextEditorView(resourceContext, editor._getSceneHandle(owner)),
        () => lib.createContextTextBufferView(resourceContext, text._getSceneHandle(owner)),
        () => lib.createContextTextBuffer(resourceContext),
        () => lib.createContextEditBuffer(resourceContext),
        () => lib.createContextEditorView(resourceContext, edit._getSceneHandle(owner), 20, 10),
      ]
      for (const mutate of [
        () => lib.sceneDestroyNode(context, nodeHandle),
        () => scene.setTextView(renderable, null),
        ...resourceMutations,
        () => text.destroy(),
        () => view.destroy(),
        () => edit.destroy(),
        () => editor.destroy(),
        () => text.setText("replacement"),
        () => text.reset(),
        () => syntaxStyle.destroy(),
        () => lib.destroySession(context, session),
        () => lib.sceneCreateNode(context, session, "custom", 999),
      ]) {
        renderable.setMeasureProvider(() => {
          mutate()
          return { width: 0, height: 0 }
        })
        assert.throws(() => scene.measureSnapshot(renderable), /Cannot mutate Yoga during a callback/)
        assert.doesNotThrow(() => lib.sceneGetLayout(context, nodeHandle))
        assert.equal(text.getPlainText(), "hello")
        assert.equal(view.measureForDimensions(20, 10)?.widthColsMax, 5)
        assert.equal(edit.getText(), "")
        assert.equal(editor.getVirtualLineCount(), 1)
      }
      renderable.setMeasureProvider(() => {
        assert.equal(view.measureForDimensions(20, 10)?.widthColsMax, 5)
        return { width: 0, height: 0 }
      })
      scene.measureSnapshot(renderable)
      assert.equal(nativeNode.getComputedWidth(), 0)
      assert.equal(nativeNode.getComputedHeight(), 0)
      scene.setTextView(renderable, owner === scene ? view._getSceneHandle(scene) : null)
      renderable.invalidateIntrinsicSize()
      scene.measureSnapshot(renderable)
      assert.equal(nativeNode.getComputedWidth(), 0)
      renderable.setMeasureProvider(null)
      assert.equal(nativeNode.hasMeasureFunc(), false)
      renderable.setMeasureProvider(() => {
        const result = view.measureForDimensions(20, 10)!
        return { width: result.widthColsMax, height: result.lineCount }
      })
      scene.measureSnapshot(renderable)
      assert.equal(nativeNode.getComputedWidth(), 5)
      renderable.destroy()
      assert.throws(() => lib.sceneHasMeasure(context, nodeHandle), { status: NativeStatus.StaleHandle })
    } finally {
      renderable.destroy()
      syntaxStyle.destroy()
      view.destroy()
      text.destroy()
      editor.destroy()
      edit.destroy()
    }
  }

  // Separate facades can load the same shared object. Their ordinary public Yoga
  // configs must remain independent even when one facade is disposed.
  const first = new FFIRenderLib()
  const second = new FFIRenderLib()
  const firstConfig = Yoga.Config.create(first)
  const secondConfig = Yoga.Config.create(second)
  const firstNode = Yoga.Node.create(firstConfig)
  const secondNode = Yoga.Node.create(secondConfig)
  firstNode.setMeasureFunc(() => ({ width: 11, height: 2 }))
  secondNode.setMeasureFunc(() => ({ width: 19, height: 4 }))
  firstNode.calculateLayout()
  secondNode.calculateLayout()
  assert.equal(firstNode.getComputedWidth(), 11)
  assert.equal(secondNode.getComputedWidth(), 19)
  assert.throws(() => firstNode.insertChild(secondNode, 0), /different native libraries/)
  assert.throws(() => first.dispose(), /Yoga nodes are active/)

  const firstLegacyPtr = first.yogaNodeCreateForOpenTUI()
  const sharedConfig = first.yogaNodeGetConfig(firstLegacyPtr)
  first.yogaNodeFree(firstLegacyPtr)
  const firstLegacy = Yoga.Node.create(Yoga.Config.fromBorrowedPointer(sharedConfig, first))
  const secondLegacy = Yoga.Node.create(Yoga.Config.fromBorrowedPointer(sharedConfig, second))
  secondLegacy.setMeasureFunc(() => ({ width: 23, height: 5 }))
  assert.throws(() => firstLegacy.setMeasureFunc(() => ({ width: 1, height: 1 })), /owned by another native library/)
  firstLegacy.free()
  firstNode.free()
  firstConfig.free()
  first.dispose()
  secondNode.markDirty()
  secondNode.calculateLayout()
  assert.equal(secondNode.getComputedWidth(), 19)
  secondLegacy.calculateLayout()
  assert.equal(secondLegacy.getComputedWidth(), 23)
  secondLegacy.free()
  secondNode.free()
  secondConfig.free()
  second.dispose()

  class ProjectionRenderable extends Renderable {
    get requestedSize() {
      return [this._width, this._height]
    }
  }
  const projected = new ProjectionRenderable(renderer, { width: 10, height: 5, flexShrink: 1, top: 1, left: 2 })
  const projectedNode = getYogaNode(projected)
  const projectedError = new YogaError("user callback", YogaStatus.Exception)
  const observer = new ProjectionRenderable(renderer, { alignSelf: "flex-start" })
  renderer.root.add(observer)
  const observeProjection = (observe: () => void) => {
    observer.setMeasureProvider(() => {
      assert.equal(scene.hasStagedMutations, false)
      observe()
      throw projectedError
    })
    assert.throws(
      () => lib.sceneMeasureLayout(context, session, getYogaNode(renderer.root)._getSceneHandle(scene)),
      (error) => error === projectedError,
    )
  }
  for (const [property, value, dimension] of [
    ["width", 20, 0],
    ["height", 15, 1],
  ] as const) {
    projected.flexShrink = 1
    const before = projected.requestedSize
    assert.throws(() => {
      projected[property] = Infinity
    }, RangeError)
    assert.deepEqual(projected.requestedSize, before)
    assert.equal(projectedNode.getFlexShrink(), 1)
    projected[property] = value
    observeProjection(() => {
      assert.equal(projected.requestedSize[dimension], value)
      assert.equal(dimension === 0 ? projectedNode.getWidth().value : projectedNode.getHeight().value, value)
      assert.equal(projectedNode.getFlexShrink(), 0)
    })
    assert.equal(projected.requestedSize[dimension], value)
  }
  assert.throws(() => projected.setPosition({ top: 7, left: Infinity }), RangeError)
  assert.deepEqual([projected.top, projected.left], [1, 2])
  assert.deepEqual(
    [projectedNode.getPosition(Yoga.Edge.Top).value, projectedNode.getPosition(Yoga.Edge.Left).value],
    [1, 2],
  )
  projected.setPosition({ top: 3, left: 4 })
  observeProjection(() => {
    assert.deepEqual([projected.top, projected.left], [3, 4])
    assert.deepEqual(
      [projectedNode.getPosition(Yoga.Edge.Top).value, projectedNode.getPosition(Yoga.Edge.Left).value],
      [3, 4],
    )
  })
  assert.deepEqual([projected.top, projected.left], [3, 4])

  const left = new ProjectionRenderable(renderer, { width: 80, height: 20 })
  const right = new ProjectionRenderable(renderer, { width: 80, height: 20 })
  const anchor = new ProjectionRenderable(renderer, { width: 1, height: 1 })
  anchor.id = projected.id = "duplicate"
  right.add(anchor)
  right.add(projected)
  renderer.root.add(left)
  renderer.root.add(right)
  observer.setMeasureProvider(null)
  await renderOnce()
  assert.equal(scene.getLayout(projectedNode).screenY, 24)
  let owner = right
  const observeTopology = () => {
    assert.equal(projected.parent, owner)
    assert.equal(owner.getChildren()[0], projected)
    assert.equal(owner.getRenderable("duplicate"), projected)
  }
  for (const move of [
    () => right.insertBefore(projected, anchor),
    () => {
      owner = left
      left.add(projected)
    },
  ]) {
    move()
    observeProjection(observeTopology)
    assert.equal(projected.parent, owner)
    observer.setMeasureProvider(null)
    await renderOnce()
    assert.equal(scene.getLayout(projectedNode).screenY, owner === right ? 23 : 3)
  }
  assert.throws(() => projected.add(left), { status: NativeStatus.InvalidArgument })
  assert.equal(left.parent, renderer.root)
  assert.equal(projected.parent, left)
  assert.equal(projected.getChildrenCount(), 0)
  left.destroyRecursively()
  right.destroyRecursively()
  observer.destroy()
} finally {
  standalone.destroy()
  renderer.destroy()
  await renderer.closed
}

console.log("Yoga callback boundary passed")
