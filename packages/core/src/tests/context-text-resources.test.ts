import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { OptimizedBuffer, ResourceContext } from "../buffer.js"
import { EditBuffer } from "../edit-buffer.js"
import { EditorView } from "../editor-view.js"
import { RGBA } from "../lib/RGBA.js"
import { StyledText } from "../lib/styled-text.js"
import { SyntaxStyle } from "../syntax-style.js"
import { TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { NativeStatus, resolveRenderLib } from "../zig.js"

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

function standalone() {
  const owner = new ResourceContext({ objectCapacity: 128, renderCellsMax: 1024 })
  resources.push(owner)
  return owner
}

test("standalone Context owns buffers, styles, views, and editor callbacks through teardown", () => {
  const owner = standalone()
  const text = TextBuffer.create("unicode", owner)
  const view = TextBufferView.create(text)
  const edit = EditBuffer.create("unicode", owner)
  const editor = EditorView.create(edit, 8, 1)
  const style = SyntaxStyle.fromStyles({ keyword: { fg: "#ff0000" } }, owner)
  const target = OptimizedBuffer.create(4, 1, "unicode", { owner })
  resources.push(text, view, edit, editor, style, target)
  text.setSyntaxStyle(style)
  text.setText("text")
  text.addHighlight(0, { start: 0, end: 4, styleId: style.getStyleId("keyword")!, priority: 1, hlRef: 7 })
  view.setViewport(0, 0, 4, 1)
  target.drawTextBuffer(view, 0, 0)
  target.withBuffers((cells) => assert.deepEqual(cells.fg.slice(0, 4), RGBA.fromInts(255, 0, 0).buffer))
  edit.setText("editor")
  edit.setSyntaxStyle(style)
  assert.equal(editor._getOwner().scene, owner)
  assert.equal(edit.getText(), "editor")
  owner.destroy()
  for (const access of [
    () => text.getPlainText(),
    () => view.getPlainText(),
    () => edit.setText("late"),
    () => editor.setViewportSize(4, 1),
    () => style.registerStyle("late", {}),
    () => target.clear(RGBA.fromInts(0, 0, 0)),
    () => SyntaxStyle.create(owner),
  ])
    assert.throws(access, /destroyed/)
  for (const resource of [target, style, editor, edit, view, text, owner]) assert.doesNotThrow(() => resource.destroy())
})

test("styled batch keeps its encoded replacement count across the admission callback", () => {
  const owner = standalone()
  const lib = owner.driver.renderLib
  const buffers = [TextBuffer.create("unicode", owner), TextBuffer.create("unicode", owner)]
  const views = buffers.map((buffer) => TextBufferView.create(buffer))
  resources.push(...buffers, ...views)
  const replacements = buffers.map((buffer, index) => ({
    buffer: buffer._getSceneHandle(owner),
    view: views[index]._getSceneHandle(owner),
    text: lib.encodeTextBufferStyledText(new StyledText([{ __isChunk: true, text: "new" }])),
  }))

  lib.contextTextBufferReplaceStyledBatch(owner.driver.context, replacements, () => {
    replacements.pop()
  })

  assert.deepEqual(
    buffers.map((buffer) => buffer.getPlainText()),
    ["new", "new"],
  )
})

test("foreign style attachment rejects without allocating a mirror or changing accepted highlights", async () => {
  const scene = await setup()
  const peer = await setup()
  const style = SyntaxStyle.fromStyles({ keyword: { fg: "#ff0000" } }, scene)
  const previous = SyntaxStyle.fromStyles({ keyword: { fg: "#00ff00" } }, peer)
  const buffer = TextBuffer.create("unicode", peer)
  resources.push(style, previous, buffer)
  buffer.setText("kept")
  buffer.setSyntaxStyle(previous)
  const highlight = { start: 0, end: 4, styleId: previous.getStyleId("keyword")!, priority: 1, hlRef: 7 }
  buffer.addHighlight(0, highlight)
  const createStyle = spyOn(scene.driver.renderLib, "createContextSyntaxStyle")
  try {
    assert.throws(() => buffer.setSyntaxStyle(style), /owner mismatch/)
    assert.equal(createStyle.mock.calls.length, 0)
    assert.equal(buffer.getSyntaxStyle(), previous)
    assert.equal(buffer.getPlainText(), "kept")
    assert.deepEqual(buffer.getLineHighlights(0), [highlight])
  } finally {
    createStyle.mockRestore()
  }
})

test("Context buffer destruction invalidates all dependent views without double freeing", async () => {
  const scene = await setup()
  const buffer = TextBuffer.create("unicode", scene)
  const first = TextBufferView.create(buffer)
  const second = TextBufferView.create(buffer)
  resources.push(buffer, first, second)
  buffer.setText("alive")
  first.destroy()
  assert.equal(second.getPlainText(), "alive")
  buffer.destroy()
  assert.throws(() => first.lineInfo, /destroyed/)
  assert.throws(() => second.lineInfo, /destroyed/)
  assert.throws(() => second.setSelection(0, 1), /destroyed/)
  assert.throws(() => TextBufferView.create(buffer), /destroyed/)
  assert.doesNotThrow(() => second.destroy())
  assert.doesNotThrow(() => buffer.destroy())
})

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

test("Context text replacement rejection preserves accepted text, lengths, and styles", async () => {
  const scene = await setup()
  const buffer = TextBuffer.create("unicode", scene)
  const style = SyntaxStyle.create(scene)
  resources.push(buffer, style)
  buffer.setText("kept\u4e2d")
  buffer.setSyntaxStyle(style)
  const length = buffer.length
  const bytes = buffer.byteSize
  for (const replace of [
    () =>
      scene.driver.renderLib.contextTextBufferSetText(
        scene.driver.context,
        buffer._getSceneHandle(scene),
        Uint8Array.of(0xff),
      ),
    () =>
      scene.driver.renderLib.contextTextBufferAppend(
        scene.driver.context,
        buffer._getSceneHandle(scene),
        Uint8Array.of(0xff),
      ),
    () => buffer.setStyledText(new StyledText([{ __isChunk: true, text: "bad", attributes: 0x100 }])),
    () => buffer.setStyledText(new StyledText({ length: 0 } as never)),
    () => buffer.loadFile("/does-not-exist/opentui-text-resource"),
  ]) {
    assert.throws(replace)
    assert.equal(buffer.getPlainText(), "kept\u4e2d")
    assert.equal(buffer.length, length)
    assert.equal(buffer.byteSize, bytes)
    assert.equal(buffer.getSyntaxStyle(), style)
  }
  const path = fileURLToPath(import.meta.url)
  buffer.loadFile(path)
  assert.equal(buffer.getPlainText(), readFileSync(path, "utf8"))
  assert.equal(buffer.byteSize, Buffer.byteLength(readFileSync(path, "utf8")))
})

test("Context clear retains external highlights while reset clears them", async () => {
  const scene = await setup()
  const buffer = TextBuffer.create("unicode", scene)
  const style = SyntaxStyle.fromStyles({ keyword: { fg: "#ff0000" } }, scene)
  resources.push(buffer, style)
  buffer.setSyntaxStyle(style)
  buffer.setText("text")
  const highlight = { start: 0, end: 2, styleId: style.getStyleId("keyword")!, priority: 1, hlRef: 7 }
  buffer.addHighlight(0, highlight)
  buffer.clear()
  assert.deepEqual(buffer.getLineHighlights(0), [highlight])
  buffer.setText("more")
  assert.deepEqual(buffer.getLineHighlights(0), [highlight])
  buffer.reset()
  assert.equal(buffer.getHighlightCount(), 0)
  assert.deepEqual(buffer.getLineHighlights(0), [])
})

test("Context text construction failures release provisional native resources", async () => {
  const scene = await setup()
  const lib = scene.driver.renderLib
  const failure = new Error("wrapper initialization failed")
  const destroyBuffer = spyOn(lib, "destroyContextTextBuffer")
  try {
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
    assert.equal(destroyBuffer.mock.calls.length, 1)
    const [context, handle] = destroyBuffer.mock.calls[0]
    assert.throws(() => lib.contextTextBufferGetInfo(context, handle), { status: NativeStatus.StaleHandle })
  } finally {
    destroyBuffer.mockRestore()
  }

  const buffer = TextBuffer.create("unicode", scene)
  resources.push(buffer)
  const owner = buffer._getOwner()
  let ownerCalls = 0
  const getOwner = spyOn(buffer, "_getOwner").mockImplementation(() => {
    if (++ownerCalls === 2) throw failure
    return owner
  })
  const destroyView = spyOn(lib, "destroyContextTextBufferView")
  try {
    assert.throws(
      () => TextBufferView.create(buffer),
      (error) => error === failure,
    )
    assert.equal(destroyView.mock.calls.length, 1)
    const [context, handle] = destroyView.mock.calls[0]
    assert.throws(() => lib.contextTextBufferViewGetInfo(context, handle), { status: NativeStatus.StaleHandle })
  } finally {
    getOwner.mockRestore()
    destroyView.mockRestore()
  }
  const view = TextBufferView.create(buffer)
  resources.push(view)
  buffer.setText("survived")
  assert.equal(view.getPlainText(), "survived")
})

test("Context text wrappers publish accepted projections before deferred callback failures", async () => {
  const scene = await setup()
  const buffer = TextBuffer.create("unicode", scene)
  const style = SyntaxStyle.create(scene)
  resources.push(buffer, style)
  const lib = resolveRenderLib()
  const host = lib.getYogaHost()
  const failure = new Error("text callback failed")
  const operations = [
    () => buffer.setText("A\u4e2d\t"),
    () => buffer.append("end"),
    () => buffer.setStyledText(new StyledText([{ __isChunk: true, text: "styled\t" }])),
    () => buffer.setTabWidth(8),
    () => buffer.setStyledText(new StyledText([])),
    () => buffer.clear(),
    () => buffer.reset(),
    () => buffer.loadFile(fileURLToPath(import.meta.url)),
    () => buffer.setSyntaxStyle(style),
  ]
  for (const operation of operations) {
    host.invokeCallback(() => {
      throw failure
    })
    assert.throws(operation, (error) => error === failure)
    const info = lib.contextTextBufferGetInfo(scene.driver.context, buffer._getSceneHandle(scene))
    assert.equal(buffer.length, info.textLength)
    assert.equal(buffer.byteSize, info.byteLength)
    assert.doesNotThrow(() => host.throwCallbackError())
  }
  assert.equal(buffer.getSyntaxStyle(), style)
})

test.each([false, true])(
  "empty StyledText preserves the zero-chunk distinction (empty chunk: %s)",
  async (hasChunk) => {
    const scene = await setup()
    for (const owner of [standalone(), scene]) {
      const buffer = TextBuffer.create("unicode", owner)
      const style = SyntaxStyle.fromStyles({ keyword: { fg: "#ff0000" } }, owner)
      resources.push(buffer, style)
      buffer.setSyntaxStyle(style)
      buffer.setText("text")
      const highlight = { start: 0, end: 2, styleId: style.getStyleId("keyword")!, priority: 1, hlRef: 7 }
      buffer.addHighlight(0, highlight)
      const content = new StyledText(hasChunk ? [{ __isChunk: true, text: "" }] : [])
      const chunks = content.chunks
      let reads = 0
      Object.defineProperty(content, "chunks", {
        get() {
          reads++
          return chunks
        },
      })
      const host = buffer._getOwner().lib.getYogaHost()
      host.invokeCallback(() => assert.throws(() => buffer.setStyledText(content), /during a callback/))
      host.throwCallbackError()
      assert.equal(reads, 0)
      buffer.setStyledText(content)
      assert.equal(reads, 1)
      assert.equal(buffer.getPlainText(), "")
      assert.equal(buffer.length, 0)
      assert.equal(buffer.byteSize, 0)
      assert.deepEqual(buffer.getLineHighlights(0), hasChunk ? [] : [highlight])
      buffer.setText("again")
      assert.deepEqual(buffer.getLineHighlights(0), hasChunk ? [] : [highlight])
      assert.equal(buffer.getHighlightCount(), hasChunk ? 0 : 1)
    }
  },
)

test("explicit syntax style still colors manual highlights after styled and plain replacement", async () => {
  const scene = await setup()
  const red = RGBA.fromInts(255, 0, 0)
  const green = RGBA.fromInts(0, 255, 0)
  const white = RGBA.fromInts(255, 255, 255)
  const frames = []
  for (const owner of [standalone(), scene]) {
    const buffer = TextBuffer.create("unicode", owner)
    const view = TextBufferView.create(buffer)
    const style = SyntaxStyle.fromStyles({ keyword: { fg: red } }, owner)
    const target = OptimizedBuffer.create(4, 1, "unicode", { owner })
    resources.push(buffer, view, style, target)
    view.setViewport(0, 0, 4, 1)
    buffer.setDefaultFg(white)
    buffer.setSyntaxStyle(style)
    const highlight = { start: 0, end: 2, styleId: style.getStyleId("keyword")!, priority: 2, hlRef: 7 }
    const draw = () => {
      target.clear(RGBA.fromInts(0, 0, 0))
      target.drawTextBuffer(view, 0, 0)
      return target.withBuffers((cells) => ({ char: cells.char.slice(), fg: cells.fg.slice() }))
    }
    buffer.setText("text")
    buffer.addHighlight(0, highlight)
    const before = draw()
    assert.deepEqual(before.fg.slice(0, 4), red.buffer)
    buffer.setStyledText(new StyledText([{ __isChunk: true, text: "text", fg: green }]))
    const styled = draw()
    assert.deepEqual(styled.fg.slice(0, 4), green.buffer)
    buffer.setText("text")
    buffer.addHighlight(0, highlight)
    assert.equal(buffer.getSyntaxStyle(), style)
    assert.deepEqual(buffer.getLineHighlights(0), [highlight])
    const after = draw()
    assert.deepEqual(after.fg.slice(0, 4), red.buffer)
    assert.deepEqual(after.fg.slice(12, 16), white.buffer)
    assert.deepEqual(after, before)
    frames.push({ before, styled, after })
  }
  assert.deepEqual(frames[1], frames[0])
})

test("a rejected outer styled write retains nested accepted content and local style IDs", async () => {
  const scene = await setup()
  const peer = await setup()
  const style = SyntaxStyle.fromStyles({ chunk0: { fg: "#ff0000" } }, scene)
  const source = TextBuffer.create("unicode", scene)
  const target = TextBuffer.create("unicode", peer)
  resources.push(style, source, target)
  source.setSyntaxStyle(style)
  assert.throws(() =>
    source.setStyledText(
      new StyledText([
        {
          __isChunk: true,
          get text() {
            source.setStyledText(new StyledText([{ __isChunk: true, text: "inner", fg: RGBA.fromInts(0, 0, 255) }]))
            return "rejected"
          },
          attributes: 0x100,
        },
      ]),
    ),
  )
  assert.equal(source.getPlainText(), "inner")
  assert.equal(style.getStyleCount(), 1)
  assert.throws(() => target.setSyntaxStyle(style), /owner mismatch/)
})

test("explicit theme binding snapshots definitions and preserves highlight IDs across owners", async () => {
  const scene = await setup()
  const peer = await setup()
  const red = RGBA.fromInts(255, 0, 0)
  const green = RGBA.fromInts(0, 255, 0)
  const style = SyntaxStyle.fromStyles({ chunk0: { fg: red } }, scene)
  style.registerStyle("1", { fg: green })
  const previous = SyntaxStyle.fromStyles({ old: { fg: green } }, peer)
  const target = TextBuffer.create("unicode", peer)
  const targetView = TextBufferView.create(target)
  const targetFrame = OptimizedBuffer.create(4, 1, "unicode", { owner: peer })
  resources.push(style, previous, target, targetView, targetFrame)
  target.setSyntaxStyle(previous)
  target.setText("kept")
  targetView.setViewport(0, 0, 4, 1)
  const highlight = { start: 0, end: 4, styleId: previous.getStyleId("old")!, priority: 1, hlRef: 7 }
  target.addHighlight(0, highlight)
  const expected = RGBA.clone(red)
  Object.defineProperty(red, "buffer", {
    get() {
      throw new Error("registered color input must not be read again")
    },
  })
  const definitions = style.getAllStyles()
  const bound = SyntaxStyle.fromStyles(definitions, peer)
  resources.push(bound)
  assert.equal(bound.getStyleId("chunk0"), style.getStyleId("chunk0"))
  assert.equal(bound.getStyleId("1"), style.getStyleId("1"))
  definitions.get("chunk0")!.fg!.buffer.fill(0)
  style.registerStyle("chunk0", { fg: green })
  style.destroy()
  target.setSyntaxStyle(bound)
  assert.equal(target.getPlainText(), "kept")
  assert.deepEqual(target.getLineHighlights(0), [highlight])
  targetFrame.drawTextBuffer(targetView, 0, 0)
  targetFrame.withBuffers((cells) => assert.deepEqual(cells.fg.slice(0, 4), expected.buffer))
})

test("empty styled chunks retain their original style ordinal across shared text buffers", async () => {
  const scene = await setup()
  const red = RGBA.fromInts(255, 0, 0)
  const green = RGBA.fromInts(0, 255, 0)
  const blue = RGBA.fromInts(0, 0, 255)
  for (const owner of [standalone(), scene]) {
    const style = SyntaxStyle.fromStyles({ chunk0: { fg: red }, chunk1: { fg: green } }, owner)
    const producer = TextBuffer.create("unicode", owner)
    const alias = TextBuffer.create("unicode", owner)
    const producerView = TextBufferView.create(producer)
    const aliasView = TextBufferView.create(alias)
    const target = OptimizedBuffer.create(3, 1, "unicode", { owner })
    resources.push(style, producer, alias, producerView, aliasView, target)
    producer.setSyntaxStyle(style)
    alias.setSyntaxStyle(style)
    producerView.setViewport(0, 0, 1, 1)
    aliasView.setViewport(0, 0, 2, 1)
    producer.setStyledText(
      new StyledText([
        { __isChunk: true, text: "a", fg: red },
        { __isChunk: true, text: "b", fg: green },
      ]),
    )
    alias.setText("ab")
    alias.addHighlight(0, { start: 0, end: 1, styleId: style.getStyleId("chunk0")!, priority: 1, hlRef: 7 })
    alias.addHighlight(0, { start: 1, end: 2, styleId: style.getStyleId("chunk1")!, priority: 1, hlRef: 8 })
    const draw = () => {
      target.clear(RGBA.fromInts(0, 0, 0))
      target.drawTextBuffer(producerView, 0, 0)
      target.drawTextBuffer(aliasView, 1, 0)
      return target.withBuffers((cells) => cells.fg.slice())
    }
    assert.deepEqual(draw(), new Uint16Array([...red.buffer, ...red.buffer, ...green.buffer]))
    const frames = []
    for (let attempt = 0; attempt < 2; attempt++) {
      producer.setStyledText(
        new StyledText([
          { __isChunk: true, text: "" },
          { __isChunk: true, text: "x", fg: blue },
        ]),
      )
      frames.push(draw())
    }
    const expected = new Uint16Array([...blue.buffer, ...red.buffer, ...blue.buffer])
    assert.deepEqual(frames, [expected, expected])
  }
})
