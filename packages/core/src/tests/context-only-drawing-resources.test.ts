import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { OptimizedBuffer, ResourceContext, type BufferAccess } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { StyledText } from "../lib/styled-text.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { getLinkId } from "../utils.js"
import { NativeStatus, resolveRenderLib } from "../zig.js"

const resources: { destroy(): void }[] = []
const foreground = RGBA.fromIndex(2, "#00ff00")
const background = RGBA.defaultBackground("#000000")

afterEach(() => {
  for (const resource of resources.splice(0).reverse()) resource.destroy()
})

function standalone() {
  const owner = new ResourceContext({ objectCapacity: 32, renderCellsMax: 64 })
  resources.push(owner)
  return owner
}

function buffer(owner: ResourceContext, width = 6) {
  const target = OptimizedBuffer.create(width, 1, "unicode", { owner })
  resources.push(target)
  return target
}

test("drawing resources require a Context owner and expose no framebuffer pointer", () => {
  const owner = standalone()
  const target = buffer(owner)
  assert.equal("ptr" in target, false)
  for (const invalid of [undefined, resolveRenderLib()]) {
    assert.throws(() => OptimizedBuffer.create(1, 1, "unicode", { owner: invalid as never }), /explicit resource owner/)
  }
  assert.throws(() => target.buffers, /withBuffers/)
  target.drawText("alive", 0, 0, foreground, background)
  assert.equal(new TextDecoder().decode(target.getRealCharBytes()), "alive ")
  owner.destroy()
  assert.throws(() => target.clear(), /destroyed/)
  assert.throws(() => buffer(owner), /destroyed/)
  assert.doesNotThrow(() => target.destroy())
})

test("encoded Unicode publishes tokens and releases through its Context rather than its creating buffer", () => {
  const owner = standalone()
  const source = buffer(owner)
  const target = buffer(owner)
  const foreign = buffer(standalone())
  const encoded = source.encodeUnicode("Ae\u0301\ud83d\udc69\u200d\ud83d\udcbb\u754c")
  assert.deepEqual(Object.keys(encoded), ["data"])
  assert.equal("ptr" in encoded, false)
  assert.deepEqual(
    encoded.data.map(({ width }) => width),
    [1, 1, 2, 2],
  )
  assert.equal(encoded.data[0].char, 65)
  const token = encoded.data[1].char
  assert.ok(token > 0xffffffff)
  assert.throws(() => foreign.freeUnicode(encoded), /same Context/)
  assert.throws(() => foreign.drawChar(token, 0, 0, foreground, background), /same Context/)
  assert.throws(() => target.freeUnicode({ data: encoded.data }), /live/)
  source.destroy()
  let x = 0
  for (const glyph of encoded.data) {
    target.drawChar(glyph.char, x, 0, foreground, background)
    x += glyph.width
  }
  encoded.data.length = 0
  target.freeUnicode(encoded)
  assert.equal(new TextDecoder().decode(target.getRealCharBytes()), "Ae\u0301\ud83d\udc69\u200d\ud83d\udcbb\u754c")
  assert.throws(() => target.freeUnicode(encoded), /live/)
  assert.throws(() => target.drawChar(token, 0, 0, foreground, background), /live/)
  const empty = target.encodeUnicode("")
  assert.deepEqual(empty.data, [])
  target.freeUnicode(empty)
  const abandoned = target.encodeUnicode("e\u0301")
  const copy = buffer(owner)
  copy.drawFrameBuffer(0, 0, target)
  target.destroy()
  assert.equal(new TextDecoder().decode(copy.getRealCharBytes()), "Ae\u0301\ud83d\udc69\u200d\ud83d\udcbb\u754c")
  owner.destroy()
  assert.throws(() => target.freeUnicode(abandoned), /destroyed/)
  assert.throws(() => copy.drawChar(abandoned.data[0].char, 0, 0, foreground, background), /destroyed/)
})

test("Unicode publication and buffer construction failures release provisional handles", () => {
  const owner = standalone()
  const target = buffer(owner)
  const lib = owner.renderLib
  const failure = new Error("publication failed")
  const copy = spyOn(lib, "getContextUnicode").mockImplementation(() => {
    throw failure
  })
  const releaseUnicode = spyOn(lib, "destroyContextUnicode")
  const releaseBuffer = spyOn(lib, "destroyContextBuffer")
  try {
    assert.throws(
      () => target.encodeUnicode("e\u0301"),
      (error) => error === failure,
    )
    assert.equal(releaseUnicode.mock.calls.length, 1)
    copy.mockRestore()
    assert.throws(() => lib.getContextUnicode(...releaseUnicode.mock.calls[0]), { status: NativeStatus.StaleHandle })
    assert.throws(
      () =>
        OptimizedBuffer.create(2, 1, "unicode", {
          owner,
          get id(): string {
            throw failure
          },
        }),
      (error) => error === failure,
    )
    assert.equal(releaseBuffer.mock.calls.length, 1)
    assert.throws(() => lib.contextAcquireBufferLease(...releaseBuffer.mock.calls[0]), {
      status: NativeStatus.StaleHandle,
    })
    const encoded = target.encodeUnicode("e\u0301")
    target.drawChar(encoded.data[0].char, 0, 0, foreground, background)
    target.freeUnicode(encoded)
  } finally {
    copy.mockRestore()
    releaseUnicode.mockRestore()
    releaseBuffer.mockRestore()
  }
})

test("Context composition clips negative coordinates and retains graphemes links and color intent", () => {
  const owner = standalone()
  const source = buffer(owner, 5)
  const target = buffer(owner, 4)
  const text = TextBuffer.create("unicode", owner)
  const view = TextBufferView.create(text)
  resources.push(text, view)
  text.setStyledText(
    new StyledText([
      {
        __isChunk: true,
        text: "Ae\u0301\u754cB",
        fg: foreground,
        bg: background,
        link: { url: "https://example.test/link" },
      },
    ]),
  )
  view.setViewport(0, 0, 5, 1)
  source.drawTextBuffer(view, 0, 0)
  const before = source.withBuffers(({ attributes, fg, bg }) => ({
    attributes: attributes.slice(1),
    fg: fg.slice(4),
    bg: bg.slice(4),
  }))
  target.drawFrameBuffer(-1, 0, source)
  source.destroy()
  view.destroy()
  text.destroy()
  assert.equal(new TextDecoder().decode(target.getRealCharBytes()), "e\u0301\u754cB")
  target.withBuffers(({ attributes, fg, bg }) => {
    assert.ok(getLinkId(attributes[0]) > 0)
    assert.deepEqual({ attributes, fg, bg }, before)
  })
  const foreign = buffer(standalone())
  assert.throws(() => target.drawFrameBuffer(0, 0, foreign), /same Context/)
  assert.throws(() => target.drawFrameBuffer(0, 0, target), { status: NativeStatus.InvalidArgument })
  assert.throws(() => target.drawChar(0x80000000, 0, 0, foreground, background), {
    status: NativeStatus.InvalidArgument,
  })
  assert.equal(new TextDecoder().decode(target.getRealCharBytes()), "e\u0301\u754cB")
})

test("Context raw-plane scopes remain synchronous and release leases after resize or callback failure", () => {
  const owner = standalone()
  const target = buffer(owner)
  target._withNativePaint(() => {
    target.withBuffers(({ width }) => assert.equal(width, 6))
    target.resize(4, 1)
    target.withBuffers(({ width }) => assert.equal(width, 4))
  })
  let saved: BufferAccess | undefined
  const failure = new Error("paint failed")
  assert.throws(
    () =>
      target.withBuffers((cells) => {
        saved = cells
        cells.char[0] = 65
        assert.throws(() => owner.destroy(), { status: NativeStatus.ContextBusy })
        throw failure
      }),
    (error) => error === failure,
  )
  assert.throws(() => saved!.char, /scope has ended/)
  assert.throws(() => target.withBuffers(() => Promise.resolve()), /synchronous/)
  assert.throws(
    () =>
      target.withBuffers((cells) => {
        target.resize(3, 1)
        assert.equal(cells.char[0], 65)
      }),
    { status: NativeStatus.StaleLease },
  )
  target.withBuffers(({ width, char }) => {
    assert.equal(width, 3)
    assert.equal(char.length, 3)
  })
  owner.destroy()
})

test("Session hooks compose and edit raw planes in the same frame without exposing pointers", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 4, height: 1 })
  const source = OptimizedBuffer.create(4, 1, "unicode", { owner: renderer.nativeScene })
  try {
    source.drawText("ABCD", 0, 0, foreground, background)
    renderer.root.add(
      new BoxRenderable(renderer, {
        width: 4,
        height: 1,
        renderAfter(target) {
          assert.equal("ptr" in target, false)
          target.drawFrameBuffer(-1, 0, source)
          target.drawText("X", 0, 0, foreground)
          target.setCellWithAlphaBlending(2, 0, "Y", foreground, background)
          target.withBuffers(({ char }) => {
            assert.deepEqual(Array.from(char), [88, 67, 89, 32])
          })
          target.buffers.char[3] = 69
        },
      }),
    )
    await renderOnce()
    assert.equal(captureCharFrame(), "XCYE\n")
    assert.throws(() => renderer.nextRenderBuffer.buffers, /withBuffers/)
    assert.throws(() => renderer.nextRenderBuffer.drawText("late", 0, 0, foreground), /active next frame/)
  } finally {
    source.destroy()
    renderer.destroy()
    await renderer.closed
  }
})
