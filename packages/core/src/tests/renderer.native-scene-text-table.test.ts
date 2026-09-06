import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"

import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { TextTableRenderable, type TextTableOptions } from "../renderables/TextTable.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import type { TextChunk } from "../text-buffer.js"

import { getLinkId } from "../utils.js"
import { NativeStatus, resolveRenderLib } from "../zig.js"

const setups: TestRendererSetup[] = []

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

function cell(text: string): TextChunk[] {
  return [{ __isChunk: true, text }]
}

async function setup(options: TextTableOptions = {}) {
  const target = await createTestRenderer({
    width: 36,
    height: 24,
    useMouse: true,
    clock: new ManualClock(),
  })
  setups.push(target)
  const table = new TextTableRenderable(target.renderer, {
    position: "absolute",
    left: 2,
    top: 1,
    width: 30,
    content: [
      [cell("alpha beta"), cell("notes")],
      [cell("delta eta"), cell("tail")],
    ],
    ...options,
  })
  target.renderer.root.add(table)
  const errors: Error[] = []
  let frames = 0
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  target.renderer.on(CliRenderEvents.FRAME, () => frames++)
  return {
    ...target,
    table,
    async renderOnce() {
      const previous = frames
      await target.renderOnce()
      assert.deepEqual(errors, [])
      assert.equal(frames, previous + 1)
    },
  }
}

function snapshot(target: Awaited<ReturnType<typeof setup>>) {
  const { table } = target
  return {
    text: target.captureCharFrame(),
    ...target.renderer.currentRenderBuffer.withBuffers(({ fg, bg, attributes }) => ({
      fg: fg.slice(),
      bg: bg.slice(),
      attributes: Array.from(attributes, (value) => value & 0xff),
      links: Array.from(attributes, (value) => getLinkId(value) !== 0),
    })),
    geometry: [table.x, table.y, table.width, table.height],
    selection: table.getSelection(),
    selected: table.getSelectedText(),
  }
}

test("native TextTable replaces fixed-shape cells atomically without resource churn or info queries", async () => {
  const content = Array.from({ length: 7 }, (_, row) => Array.from({ length: 4 }, (_, col) => cell(`${row}:${col}`)))
  const target = await setup({ content, fg: "#b0c0d0", bg: "#203040", attributes: 2 })
  await target.renderOnce()
  const cells = target.table["_cells"].map((row) => [...row])
  for (const row of cells) for (const value of row) value.textBufferView.setSelection(0, 1)
  const replacement = content.map((row) => row.map(() => cell("\u4e16\u754c e\u0301")))
  replacement[0][0] = content[0][0]
  replacement[0][1] = [{ __isChunk: true, text: "link", link: { url: "https://example.test/changed" } }]
  replacement[0][2] = []
  const lib = resolveRenderLib()
  const calls = [
    spyOn(lib, "createContextTextBuffer"),
    spyOn(lib, "destroyContextTextBuffer"),
    spyOn(lib, "createContextTextBufferView"),
    spyOn(lib, "destroyContextTextBufferView"),
    spyOn(lib, "contextTextBufferGetInfo"),
  ]
  const replace = spyOn(lib, "contextTextBufferReplaceStyledBatch")
  try {
    target.table.content = replacement
    for (const call of calls) assert.equal(call.mock.calls.length, 0)
    assert.equal(replace.mock.calls.length, 1)
  } finally {
    for (const call of calls) call.mockRestore()
    replace.mockRestore()
  }
  for (let row = 0; row < cells.length; row++) {
    for (let col = 0; col < cells[row].length; col++) {
      const value = target.table["_cells"][row][col]
      assert.equal(value, cells[row][col])
      assert.equal(value.textBufferView.hasSelection(), row === 0 && col === 0)
      const info = lib.contextTextBufferGetInfo(
        target.renderer.nativeScene.driver.context,
        value.textBuffer._getSceneHandle(target.renderer.nativeScene),
      )
      assert.equal(value.textBuffer.length, info.textLength)
      assert.equal(value.textBuffer.byteSize, info.byteLength)
    }
  }
  cells[0][0].textBufferView.resetLocalSelection()
  await target.renderOnce()
  const reference = await setup({ content: replacement, fg: "#b0c0d0", bg: "#203040", attributes: 2 })
  await reference.renderOnce()
  const frame = snapshot(target)
  assert.deepEqual(frame, snapshot(reference))
  assert.ok(frame.links.some(Boolean))
})

test("native TextTable fixed-shape replacements paint in the active self request", async () => {
  const target = await setup({ content: [[cell("before"), cell("kept")]], showBorders: false })
  const { table } = target
  const original = table["_cells"][0][0]
  const render = table["renderSelf"].bind(table)
  let changed = false
  table["renderSelf"] = (buffer) => {
    if (!changed) {
      changed = true
      table.content = [[cell("after"), table.content[0][1]]]
    }
    render(buffer)
  }
  await target.renderOnce()
  assert.equal(table["_cells"][0][0], original)
  assert.ok(target.captureCharFrame().includes("after"))
  assert.ok(target.captureCharFrame().includes("kept"))
  assert.equal(target.captureCharFrame().includes("before"), false)
})

test.each([1, 4097])("native TextTable rejects an invalid final cell atomically with %i chunks", async (count) => {
  const target = await setup({ showBorders: false, wrapMode: "none" })
  await target.renderOnce()
  const { table } = target
  const content = table.content
  const cells = table["_cells"]
  const before = snapshot(target)
  const chunks = Array.from({ length: count }, () => ({ __isChunk: true as const, text: "" }))
  chunks[0].text = "replacement"
  assert.throws(() => {
    table.content = [
      [chunks, cell("prepared")],
      [cell("ready"), [{ __isChunk: true, text: "rejected", attributes: 0x100 }]],
    ]
  }, /base attributes/)
  assert.equal(table.content, content)
  assert.equal(table["_cells"], cells)
  assert.equal(cells[0][0].textBuffer.getPlainText(), "alpha beta")
  await target.renderOnce()
  assert.deepEqual(snapshot(target), before)
  table.content = [[chunks, cell("accepted")], content[1]]
  await target.renderOnce()
  assert.ok(target.captureCharFrame().includes("replacement"))
  assert.ok(target.captureCharFrame().includes("accepted"))
})

test("native TextTable releases every provisional cell after a later view allocation fails", async () => {
  const target = await setup({ showBorders: false })
  await target.renderOnce()
  const content = target.table.content
  const cells = target.table["_cells"]
  const before = snapshot(target)
  const lib = resolveRenderLib()
  const createView = lib.createContextTextBufferView.bind(lib)
  const createBuffer = lib.createContextTextBuffer.bind(lib)
  const createdBuffers: ReturnType<typeof createBuffer>[] = []
  const createdViews: ReturnType<typeof createView>[] = []
  const buffers = spyOn(lib, "createContextTextBuffer").mockImplementation((...args) => {
    const handle = createBuffer(...args)
    createdBuffers.push(handle)
    return handle
  })
  const freedBuffers = spyOn(lib, "destroyContextTextBuffer")
  const freedViews = spyOn(lib, "destroyContextTextBufferView")
  let attempts = 0
  const views = spyOn(lib, "createContextTextBufferView").mockImplementation((...args) => {
    if (++attempts === 2) throw new Error("later view allocation failed")
    const handle = createView(...args)
    createdViews.push(handle)
    return handle
  })
  const replacement = [[cell("first"), cell("second")]]
  try {
    assert.throws(() => {
      target.table.content = replacement
    }, /later view allocation failed/)
    assert.equal(attempts, 2)
    assert.equal(buffers.mock.calls.length, 2)
    assert.deepEqual(
      freedBuffers.mock.calls.map(([, handle]) => handle),
      createdBuffers.reverse(),
    )
    assert.deepEqual(
      freedViews.mock.calls.map(([, handle]) => handle),
      createdViews,
    )
    for (const args of freedBuffers.mock.calls) {
      assert.throws(() => lib.contextTextBufferGetInfo(...args), { status: NativeStatus.StaleHandle })
    }
    for (const args of freedViews.mock.calls) {
      assert.throws(() => lib.contextTextBufferViewGetInfo(...args), { status: NativeStatus.StaleHandle })
    }
    assert.equal(target.table.content, content)
    assert.equal(target.table["_cells"], cells)
  } finally {
    for (const spy of [views, buffers, freedBuffers, freedViews]) spy.mockRestore()
  }
  await target.renderOnce()
  assert.deepEqual(snapshot(target), before)
  target.table.content = replacement
  await target.renderOnce()
  assert.ok(target.captureCharFrame().includes("first"))
  assert.ok(target.captureCharFrame().includes("second"))
})
