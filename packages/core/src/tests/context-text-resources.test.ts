import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const setups: TestRendererSetup[] = []
const resources: { destroy(): void }[] = []

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) resource.destroy()
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const target = await createTestRenderer({ width: 20, height: 6 })
  setups.push(target)
  return target.renderer.nativeScene!
}

test("Context text wrappers remain safely disposable after their renderer closes", async () => {
  const scene = await setup()
  const buffer = TextBuffer.create("unicode", scene)
  const view = TextBufferView.create(buffer)
  resources.push(buffer, view)
  const { renderer } = setups.at(-1)!
  renderer.destroy()
  await renderer.closed
  assert.throws(() => buffer.setText("late"), /destroyed/)
  assert.throws(() => view.getPlainText(), /destroyed/)
  assert.doesNotThrow(() => view.destroy())
  assert.doesNotThrow(() => buffer.destroy())
})

test("Context text construction failures release provisional native resources", async () => {
  const scene = await setup()
  const lib = scene.driver.renderLib
  const failure = new Error("wrapper initialization failed")
  const info = spyOn(lib, "contextTextBufferGetInfo").mockImplementation(() => {
    throw failure
  })
  try {
    assert.throws(
      () => TextBuffer.create("unicode", scene),
      (error) => error === failure,
    )
  } finally {
    info.mockRestore()
  }

  const buffer = TextBuffer.create("unicode", scene)
  resources.push(buffer)
  const owner = buffer._getOwner()
  let ownerCalls = 0
  const getOwner = spyOn(buffer, "_getOwner").mockImplementation(() => {
    if (++ownerCalls === 2) throw failure
    return owner
  })
  try {
    assert.throws(
      () => TextBufferView.create(buffer),
      (error) => error === failure,
    )
  } finally {
    getOwner.mockRestore()
  }
  const view = TextBufferView.create(buffer)
  resources.push(view)
  buffer.setText("survived")
  assert.equal(view.getPlainText(), "survived")
})
