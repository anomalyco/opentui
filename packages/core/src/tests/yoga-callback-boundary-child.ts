import assert from "node:assert/strict"
import Yoga, { type MeasureFunction } from "../yoga.js"
import { FFIRenderLib } from "../zig.js"

const failure = new Error("measure failed")
const config = Yoga.Config.create()
const root = Yoga.Node.create()
const node = Yoga.Node.create(config)
root.insertChild(node, 0)

node.setMeasureFunc(() => {
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

node.setMeasureFunc(() => {
  node.setWidth(99)
  return { width: 1, height: 1 }
})
node.markDirty()
assert.throws(() => root.calculateLayout(), /Cannot mutate Yoga during a callback/)
root.freeRecursive()
config.free()

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
firstNode.free()
firstConfig.free()
first.dispose()
secondNode.markDirty()
secondNode.calculateLayout()
assert.equal(secondNode.getComputedWidth(), 19)
secondNode.free()
secondConfig.free()
second.dispose()

console.log("Yoga callback boundary passed")
