import { ResourceContext } from "../buffer.js"
import { spyOn, test, beforeEach, afterEach } from "bun:test"
import assert from "node:assert/strict"
import { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { TextRenderable } from "../renderables/Text.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { NativeSessionRenderStatus, NativeStatus, resolveRenderLib } from "../zig.js"

let resourceContext: ResourceContext
beforeEach(() => {
  resourceContext = new ResourceContext({ objectCapacity: 8, renderCellsMax: 32 })
})
afterEach(() => resourceContext.destroy())

test.each([
  ["combining graphemes", "e\u0301", 1],
  ["ZWJ emoji", "\ud83d\udc69\u200d\ud83d\udcbb", 2],
] as const)("legacy span capture keeps %s in the owning cell's style", (_, text, width) => {
  const buffer = OptimizedBuffer.create(4, 1, "unicode", { owner: resourceContext })
  const foreground = RGBA.fromInts(255, 0, 0)
  const nextForeground = RGBA.fromInts(0, 255, 0)
  try {
    buffer.clear()
    buffer.drawText(text, 0, 0, foreground, undefined, 1)
    buffer.drawText("Z", width, 0, nextForeground, undefined, 2)
    const spans = buffer.getSpanLines()[0].spans
    assert.deepEqual(
      spans.slice(0, 2).map(({ text, width, fg, attributes }) => ({ text, width, fg, attributes })),
      [
        { text, width, fg: foreground, attributes: 1 },
        { text: "Z", width: 1, fg: nextForeground, attributes: 2 },
      ],
    )
  } finally {
    buffer.destroy()
  }
})

test("legacy resolved capture reserves row separators when every cell is pooled", () => {
  const buffer = OptimizedBuffer.create(1, 2, "unicode", { owner: resourceContext })
  try {
    buffer.drawText("e\u0301", 0, 0, RGBA.fromInts(255, 255, 255))
    buffer.drawText("a\u0308", 0, 1, RGBA.fromInts(255, 255, 255))
    assert.equal(new TextDecoder().decode(buffer.getRealCharBytes(true)), "e\u0301\na\u0308\n")
  } finally {
    buffer.destroy()
  }
})

test("span capture preserves independently painted adjacent regional indicators", () => {
  const buffer = OptimizedBuffer.create(3, 1, "unicode", { owner: resourceContext })
  const colors = [RGBA.fromInts(255, 0, 0), RGBA.fromInts(0, 255, 0), RGBA.fromInts(0, 0, 255)]
  const texts = ["\ud83c\uddfa", "\ud83c\uddf8", "Z"]
  try {
    texts.forEach((text, x) => buffer.drawText(text, x, 0, colors[x]))
    assert.deepEqual(
      buffer.getSpanLines()[0].spans.map(({ text, fg, width }) => ({ text, fg, width })),
      texts.map((text, x) => ({ text, fg: colors[x], width: 1 })),
    )
  } finally {
    buffer.destroy()
  }
})

test("native scene spans preserve adjacent regional indicators painted by separate text nodes", async () => {
  const { renderer, renderOnce, captureSpans } = await createTestRenderer({
    width: 3,
    height: 1,
  })
  const colors = [RGBA.fromInts(255, 0, 0), RGBA.fromInts(0, 255, 0), RGBA.fromInts(0, 0, 255)]
  const texts = ["\ud83c\uddfa", "\ud83c\uddf8", "Z"]
  try {
    texts.forEach((content, left) => {
      renderer.root.add(
        new TextRenderable(renderer, {
          selectable: false,
          content,
          fg: colors[left],
          position: "absolute",
          left,
          top: 0,
          width: 1,
          height: 1,
        }),
      )
    })
    await renderOnce()
    assert.deepEqual(
      captureSpans().lines[0].spans.map(({ text, fg, width }) => ({ text, fg, width })),
      texts.map((text, x) => ({ text, fg: colors[x], width: 1 })),
    )
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})

test.each([
  ["CJK", "\u4e16\u754c", 4],
  ["combining graphemes", "e\u0301a\u0308", 2],
  ["ZWJ emoji", "\ud83d\udc69\u200d\ud83d\udcbb", 2],
] as const)("Session framebuffer capture resolves %s and preserves row boundaries", (_, text, width) => {
  const lib = resolveRenderLib()
  const context = lib.createContext({ objectCapacity: 3, renderCellsMax: 8 })
  const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
  const source = lib.createContextBuffer(context, { width, height: 2 })
  try {
    lib.sessionAttachRenderer(context, session, { width, height: 2, remote: true })
    lib.sceneCreateNode(context, session, "root", 1)
    lib.contextDrawBuffer(context, source, null, { operation: "clear", background: RGBA.fromInts(0, 0, 0) })
    lib.contextDrawBuffer(context, source, null, {
      operation: "text",
      text,
      foreground: RGBA.fromInts(255, 255, 255),
    })
    lib.contextDrawBuffer(context, source, null, {
      operation: "text",
      text: "Z",
      y: 1,
      foreground: RGBA.fromInts(255, 255, 255),
    })
    const frame = lib.sceneFrameStep(context, session, null, {
      background: RGBA.fromInts(0, 0, 0),
      useMouse: false,
      excludedHitNum: 0,
      maxLayoutRounds: 8,
      maxHostRequests: 64,
    })
    const buffer = OptimizedBuffer.fromSession(lib, context, session, "next", () => frame)
    try {
      assert.equal(frame.kind, 0)
      lib.contextDrawBuffer(context, session, frame, { operation: "compose", source })
      lib.destroyContextBuffer(context, source)
      assert.equal(new TextDecoder().decode(buffer.getRealCharBytes()), `${text}Z${" ".repeat(width - 1)}`)
      assert.equal(new TextDecoder().decode(buffer.getRealCharBytes(true)), `${text}\nZ${" ".repeat(width - 1)}\n`)
      assert.deepEqual(
        buffer.getSpanLines().map(({ spans }) => ({
          text: spans.map((span) => span.text).join(""),
          width: spans.reduce((total, span) => total + span.width, 0),
        })),
        [
          { text, width },
          { text: `Z${" ".repeat(width - 1)}`, width },
        ],
      )
    } finally {
      buffer.destroy()
      lib.sceneFrameCancel(context, session, frame.frameId)
    }
  } finally {
    lib.sessionCancel(context, session)
    lib.destroyContext(context)
  }
})

test("native text scene capture resolves CJK, combining graphemes, and ZWJ emoji", async () => {
  const { renderer, renderOnce, captureCharFrame, captureSpans } = await createTestRenderer({
    width: 4,
    height: 3,
  })
  try {
    renderer.root.add(
      new TextRenderable(renderer, {
        selectable: false,
        content: "\u4e16\u754c\ne\u0301a\u0308\n\ud83d\udc69\u200d\ud83d\udcbbZ",
        width: 4,
        height: 3,
      }),
    )
    await renderOnce()
    const rows = ["\u4e16\u754c", "e\u0301a\u0308  ", "\ud83d\udc69\u200d\ud83d\udcbbZ "]
    assert.equal(captureCharFrame(), `${rows.join("\n")}\n`)
    assert.deepEqual(
      captureSpans().lines.map(({ spans }) => spans.map((span) => span.text).join("")),
      rows,
    )
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})

test.each(["getRealCharBytes", "getSpanLines"] as const)(
  "Session %s releases its lease on resolution failure",
  (capture) => {
    const lib = resolveRenderLib()
    const context = lib.createContext({ objectCapacity: 2, renderCellsMax: 4 })
    const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
    try {
      lib.sessionAttachRenderer(context, session, { width: 2, height: 1, remote: true })
      const buffer = OptimizedBuffer.fromSession(lib, context, session, "next")
      const failure = new Error("capture failed")
      const write = spyOn(lib, "contextBufferLeaseWriteResolvedChars").mockImplementation(() => {
        throw failure
      })
      try {
        assert.throws(
          () => buffer[capture](),
          (error) => error === failure,
        )
      } finally {
        write.mockRestore()
      }
      buffer.withBuffers(({ width }) => assert.equal(width, 2))
      assert.equal(new TextDecoder().decode(buffer.getRealCharBytes(true)), "  \n")
    } finally {
      lib.destroyContext(context)
    }
  },
)

test("Session span capture rejects storage replaced after sizing and releases the stale lease", () => {
  const lib = resolveRenderLib()
  const context = lib.createContext({ objectCapacity: 2, renderCellsMax: 4 })
  const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
  try {
    lib.sessionAttachRenderer(context, session, { width: 2, height: 1, remote: true })
    const buffer = OptimizedBuffer.fromSession(lib, context, session, "next")
    const getSize = lib.contextBufferLeaseGetRealCharSize.bind(lib)
    const size = spyOn(lib, "contextBufferLeaseGetRealCharSize").mockImplementation((context, lease, lineBreaks) => {
      const result = getSize(context, lease, lineBreaks)
      lib.sessionResizeRenderer(context, session, 4, 1)
      return result
    })
    try {
      assert.throws(() => buffer.getSpanLines(), { status: NativeStatus.StaleLease })
    } finally {
      size.mockRestore()
    }
    assert.equal(new TextDecoder().decode(buffer.getRealCharBytes(true)), "    \n")
  } finally {
    lib.destroyContext(context)
  }
})

test("scene framebuffer wrappers borrow their Session, never a compatibility handle", () => {
  const lib = resolveRenderLib()
  const context = lib.createContext({ objectCapacity: 2, renderCellsMax: 32 })
  const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
  try {
    lib.sessionAttachRenderer(context, session, { width: 4, height: 2, remote: true })
    const buffer = OptimizedBuffer.fromSession(lib, context, session, "next")
    assert.equal(buffer.width, 4)
    assert.equal(buffer.height, 2)
    buffer.withBuffers(({ char, fg, bg }) => {
      assert.deepEqual([buffer.width, buffer.height], [4, 2])
      char.fill(32)
      char[0] = 0x250c
      fg.fill(255)
      bg.fill(0)
    })
    assert.equal(new TextDecoder().decode(buffer.getRealCharBytes(true)), "\u250c   \n    \n")
    assert.equal(buffer.getSpanLines()[0].spans[0].text, "\u250c   ")
    assert.throws(() => buffer.buffers, /withBuffers/)
    assert.throws(() => buffer.clear(), /Session|scene/)
    lib.sessionResizeRenderer(context, session, 8, 3)
    assert.equal(buffer.width, 8)
    assert.equal(buffer.height, 3)
    assert.throws(() => buffer.resize(4, 2), /Session|scene/)
    assert.equal(lib.sessionRender(context, session, true), NativeSessionRenderStatus.Pending)
    assert.throws(() => buffer.getRealCharBytes(), { status: NativeStatus.OutputBusy })
    assert.throws(() => buffer.getSpanLines(), { status: NativeStatus.OutputBusy })
    assert.deepEqual([buffer.width, buffer.height], [8, 3])
    buffer.destroy()
    assert.throws(() => buffer.withBuffers(() => {}), /destroyed/)
    assert.throws(() => buffer.getRealCharBytes(), /destroyed/)
    assert.throws(() => buffer.getSpanLines(), /destroyed/)
    assert.equal(lib.sessionGetRendererState(context, session).width, 8)
  } finally {
    lib.sessionCancel(context, session)
    lib.destroyContext(context)
  }
})
