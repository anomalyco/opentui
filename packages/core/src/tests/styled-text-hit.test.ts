// Fragment metadata lookups: renderer.getTextMetadataAt and getStyledTextHit on text and tables.
// Every lookup reads the last presented frame, so each case renders before it queries.
import { afterEach, describe, expect, test } from "bun:test"
import { fragmentKeysFor } from "../lib/fragment-keys.js"
import { RGBA } from "../lib/RGBA.js"
import { StyledText } from "../lib/styled-text.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CodeRenderable } from "../renderables/Code.js"
import { TextRenderable } from "../renderables/Text.js"
import { TextNodeRenderable } from "../renderables/TextNode.js"
import { TextTableRenderable } from "../renderables/TextTable.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { TextBufferRenderable } from "../renderables/TextBufferRenderable.js"
import { SyntaxStyle } from "../syntax-style.js"
import { TextBuffer, type TextChunk } from "../text-buffer.js"
import { createTestRenderer, ManualClock, type TestRenderer } from "../testing.js"
import { MockTreeSitterClient } from "../testing/mock-tree-sitter-client.js"
import { RecordingWriteStream } from "../testing/test-streams.js"

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(width = 20, height = 4, options: { useMouse?: boolean } = {}) {
  const result = await createTestRenderer({ width, height, ...options })
  cleanups.push(async () => {
    result.renderer.destroy()
    await result.renderer.closed.catch(() => {})
  })
  return { ...result, registry: fragmentKeysFor(result.renderer.nativeScene.driver.context) }
}

function chunk(text: string, metadata?: unknown, extra: Partial<TextChunk> = {}): TextChunk {
  return metadata === undefined ? { __isChunk: true, text, ...extra } : { __isChunk: true, text, metadata, ...extra }
}

function styled(...chunks: TextChunk[]): StyledText {
  return new StyledText(chunks)
}

/** Metadata ids along one screen row, read through the renderer-level query. */
function rowIds(renderer: TestRenderer, y: number, width = renderer.width): (string | null)[] {
  const ids: (string | null)[] = []
  for (let x = 0; x < width; x++) {
    const value = renderer.getTextMetadataAt(x, y) as { id: string } | undefined
    ids.push(value?.id ?? null)
  }
  return ids
}

function text(renderer: TestRenderer, options: ConstructorParameters<typeof TextRenderable>[1]): TextRenderable {
  const value = new TextRenderable(renderer, { position: "absolute", left: 0, top: 0, ...options })
  renderer.root.add(value)
  return value
}

/** A text view over a caller-visible TextBuffer, like CodeRenderable, for buffer-level APIs. */
class BufferText extends TextBufferRenderable {
  static override readonly nativeIntegration = this.defineNativeIntegration({
    ...TextBufferRenderable.nativeIntegration,
    kind: "text_view",
  })

  get buffer(): TextBuffer {
    return this.textBuffer
  }

  get styles(): SyntaxStyle {
    return this._textBufferSyntaxStyle
  }
}

function bufferText(renderer: TestRenderer, top: number): BufferText {
  const value = new BufferText(renderer, { position: "absolute", left: 0, top, width: 12, height: 1 }, true)
  renderer.root.add(value)
  return value
}

describe("renderer.getTextMetadataAt", () => {
  test("returns chunk metadata by identity for every drawn cell and nothing elsewhere", async () => {
    const { renderer, renderOnce } = await setup()
    const a = { id: "a" }
    const b = { id: "b" }
    text(renderer, { content: styled(chunk("ab", a), chunk("--"), chunk("cd", b)) })
    await renderOnce()
    expect(renderer.getTextMetadataAt(0, 0)).toBe(a)
    expect(rowIds(renderer, 0, 8)).toEqual(["a", "a", null, null, "b", "b", null, null])
    expect(renderer.getTextMetadataAt(0, 1)).toBeUndefined()
  })

  test("rejects invalid and out-of-range coordinates", async () => {
    const { renderer, renderOnce } = await setup()
    text(renderer, { content: styled(chunk("a", { id: "a" })) })
    await renderOnce()
    for (const [x, y] of [
      [-1, 0],
      [0, -1],
      [0.5, 0],
      [Number.NaN, 0],
      [renderer.width, 0],
      [0, renderer.height],
      [0x8000_0000, 0],
      [0, Number.MAX_SAFE_INTEGER],
    ]) {
      expect(renderer.getTextMetadataAt(x!, y!)).toBeUndefined()
    }
  })

  test("keeps links: a chunk with both link and metadata emits the link and resolves both", async () => {
    const { renderer, renderOnce } = await setup()
    const value = { id: "v" }
    text(renderer, {
      content: styled(chunk("site", value, { link: { url: "https://example.com/x" } }), chunk("plain")),
    })
    await renderOnce()
    expect(renderer.getLinkAt(0, 0)).toBe("https://example.com/x")
    expect(renderer.getTextMetadataAt(0, 0)).toBe(value)
    // Metadata alone never turns into a link.
    text(renderer, { top: 1, content: styled(chunk("data", { id: "d" })) })
    await renderOnce()
    expect(renderer.getLinkAt(0, 1)).toBeNull()
    expect(renderer.getLinkIdAt(0, 1)).toBeGreaterThan(0)
  })

  test("existing URL links behave as before when no chunk carries metadata", async () => {
    const { renderer, renderOnce } = await setup()
    text(renderer, { content: styled(chunk("one", undefined, { link: { url: "https://example.com/same" } })) })
    text(renderer, { top: 1, content: styled(chunk("two", undefined, { link: { url: "https://example.com/same" } })) })
    await renderOnce()
    // Identical URLs keep sharing one interned id.
    expect(renderer.getLinkIdAt(0, 0)).toBe(renderer.getLinkIdAt(0, 1))
    expect(renderer.getTextMetadataAt(0, 0)).toBeUndefined()
  })

  test("follows only presented frames: replaced content answers after it is presented", async () => {
    const { renderer, renderOnce, registry } = await setup()
    const first = { id: "first" }
    const second = { id: "second" }
    const node = text(renderer, { content: styled(chunk("first", first)) })
    await renderOnce()
    node.content = styled(chunk("      "), chunk("second", second))
    // Not presented yet: the old key was released, so the old cells answer nothing.
    expect(renderer.getTextMetadataAt(0, 0)).toBeUndefined()
    expect(renderer.getTextMetadataAt(6, 0)).toBeUndefined()
    await renderOnce()
    expect(renderer.getTextMetadataAt(0, 0)).toBeUndefined()
    expect(renderer.getTextMetadataAt(6, 0)).toBe(second)
    expect(registry.size).toBe(1)
  })
})

describe("TextRenderable.getStyledTextHit", () => {
  test("uses local coordinates and returns a frozen hit", async () => {
    const { renderer, renderOnce } = await setup()
    const value = { id: "v" }
    const node = text(renderer, { left: 3, top: 1, width: 8, height: 1, content: styled(chunk("xy", value)) })
    await renderOnce()
    const hit = node.getStyledTextHit(1, 0)
    expect(hit).toEqual({ metadata: value })
    expect(hit!.metadata).toBe(value)
    expect(Object.isFrozen(hit)).toBe(true)
    expect(node.getStyledTextHit(2, 0)).toBeNull()
    expect(node.getStyledTextHit(-1, 0)).toBeNull()
    expect(node.getStyledTextHit(8, 0)).toBeNull()
    expect(node.getStyledTextHit(0, 1)).toBeNull()
    expect(node.getStyledTextHit(0.5, 0)).toBeNull()
  })

  test("a covering renderable hides the fragment from the covered renderable", async () => {
    const { renderer, renderOnce } = await setup()
    const under = { id: "under" }
    const over = { id: "over" }
    const below = text(renderer, { width: 10, height: 1, content: styled(chunk("underneath", under)) })
    const cover = text(renderer, { left: 2, width: 3, height: 1, zIndex: 1, content: styled(chunk("top", over)) })
    await renderOnce()
    expect(below.getStyledTextHit(0, 0)?.metadata).toBe(under)
    expect(below.getStyledTextHit(2, 0)).toBeNull()
    expect(cover.getStyledTextHit(0, 0)?.metadata).toBe(over)
    expect(renderer.getTextMetadataAt(2, 0)).toBe(over)

    // An opaque box without text also covers: neither text nor the box answers.
    const box = new BoxRenderable(renderer, {
      position: "absolute",
      left: 6,
      top: 0,
      width: 2,
      height: 1,
      zIndex: 2,
      backgroundColor: "#202020",
    })
    renderer.root.add(box)
    await renderOnce()
    expect(below.getStyledTextHit(6, 0)).toBeNull()
    expect(renderer.getTextMetadataAt(6, 0)).toBeUndefined()
  })

  test("clipping by an ancestor and hidden renderables return null", async () => {
    const { renderer, renderOnce } = await setup()
    const value = { id: "v" }
    const clip = new BoxRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      width: 3,
      height: 1,
      overflow: "hidden",
    })
    renderer.root.add(clip)
    const clipped = new TextRenderable(renderer, { width: 10, height: 1, content: styled(chunk("abcdefghij", value)) })
    clip.add(clipped)
    await renderOnce()
    expect(clipped.getStyledTextHit(2, 0)?.metadata).toBe(value)
    expect(clipped.getStyledTextHit(3, 0)).toBeNull()
    expect(renderer.getTextMetadataAt(3, 0)).toBeUndefined()

    clipped.visible = false
    await renderOnce()
    expect(clipped.getStyledTextHit(0, 0)).toBeNull()
    expect(renderer.getTextMetadataAt(0, 0)).toBeUndefined()
  })

  test("a moved renderable answers at its presented position only after the move is presented", async () => {
    const { renderer, renderOnce } = await setup()
    const value = { id: "v" }
    const node = text(renderer, { width: 4, height: 1, content: styled(chunk("move", value)) })
    await renderOnce()
    node.left = 6
    // Not presented: the old screen cells still show the fragment, the new ones do not.
    expect(renderer.getTextMetadataAt(0, 0)).toBe(value)
    expect(renderer.getTextMetadataAt(6, 0)).toBeUndefined()
    await renderOnce()
    expect(renderer.getTextMetadataAt(0, 0)).toBeUndefined()
    expect(node.getStyledTextHit(0, 0)?.metadata).toBe(value)
  })

  test("wrap, alignment, truncation, and scrolling follow what is drawn", async () => {
    const { renderer, renderOnce } = await setup(20, 6)
    const head = { id: "head" }
    const tail = { id: "tail" }
    const wrapped = text(renderer, {
      width: 6,
      height: 2,
      wrapMode: "char",
      content: styled(chunk("abcd", head), chunk("efgh", tail)),
    })
    await renderOnce()
    expect(rowIds(renderer, 0, 6)).toEqual(["head", "head", "head", "head", "tail", "tail"])
    expect(rowIds(renderer, 1, 6)).toEqual(["tail", "tail", null, null, null, null])

    wrapped.wrapMode = "none"
    wrapped.textAlign = "right"
    wrapped.width = 10
    await renderOnce()
    expect(rowIds(renderer, 0, 10)).toEqual([
      null,
      null,
      "head",
      "head",
      "head",
      "head",
      "tail",
      "tail",
      "tail",
      "tail",
    ])

    wrapped.textAlign = "left"
    wrapped.width = 6
    wrapped.truncate = true
    await renderOnce()
    // The ellipsis cells carry no fragment.
    const truncated = rowIds(renderer, 0, 6)
    expect(truncated[0]).toBe("head")
    expect(truncated.filter((id) => id === null).length).toBeGreaterThan(0)
    expect(truncated.at(-1)).toBe("tail")

    wrapped.truncate = false
    wrapped.width = 4
    await renderOnce()
    // Content is 8 columns wide in a 4-column viewport, so the maximum horizontal scroll is 4.
    wrapped.scrollX = 4
    await renderOnce()
    expect(wrapped.scrollX).toBe(4)
    expect(rowIds(renderer, 0, 4)).toEqual(["tail", "tail", "tail", "tail"])
  })

  test("wide glyphs carry the fragment on both cells; a half-clipped glyph shows nothing", async () => {
    const { renderer, renderOnce } = await setup()
    const wide = { id: "wide" }
    text(renderer, { width: 3, height: 1, wrapMode: "none", content: styled(chunk("界界", wide)) })
    await renderOnce()
    expect(rowIds(renderer, 0, 4)).toEqual(["wide", "wide", null, null])
  })

  test("empty chunks are skipped without shifting metadata", async () => {
    const { renderer, renderOnce } = await setup()
    const a = { id: "a" }
    const b = { id: "b" }
    const empty = { id: "empty" }
    const node = text(renderer, {
      content: styled(chunk("", empty), chunk("a", a), chunk("", empty), chunk("b", b), chunk("", empty)),
    })
    await renderOnce()
    expect(rowIds(renderer, 0, 3)).toEqual(["a", "b", null])
    node.content = styled(chunk("", empty))
    await renderOnce()
    expect(rowIds(renderer, 0, 3)).toEqual([null, null, null])
  })

  test("text nodes carry metadata through add, insertBefore, nesting, and recomposition", async () => {
    const { renderer, renderOnce, registry } = await setup()
    const outer = { id: "outer" }
    const inner = { id: "inner" }
    const first = { id: "first" }
    const node = text(renderer, { width: 20, height: 1 })
    const parent = new TextNodeRenderable({ metadata: outer })
    parent.add("ab")
    const child = new TextNodeRenderable({ metadata: inner })
    child.add("cd")
    parent.add(child)
    // A child without its own metadata inherits the parent's.
    const plain = new TextNodeRenderable({})
    plain.add("ef")
    parent.add(plain)
    node.add(parent)
    const head = new TextNodeRenderable({ metadata: first })
    head.add("0")
    node.insertBefore(head, parent)
    node.add(styled(chunk("Z", { id: "styled" })))
    await renderOnce()
    expect(rowIds(renderer, 0, 9)).toEqual([
      "first",
      "outer",
      "outer",
      "inner",
      "inner",
      "outer",
      "outer",
      "styled",
      null,
    ])

    child.metadata = { id: "changed" }
    await renderOnce()
    expect(rowIds(renderer, 0, 5)[3]).toBe("changed")

    node.remove(parent)
    node.remove(head)
    await renderOnce()
    expect(rowIds(renderer, 0, 2)).toEqual(["styled", null])
    node.content = "plain"
    await renderOnce()
    expect(registry.size).toBe(0)
  })

  test("returns null while mouse input is disabled, because no hit grid is presented", async () => {
    const { renderer, renderOnce } = await setup(20, 4, { useMouse: false })
    const value = { id: "v" }
    const node = text(renderer, { content: styled(chunk("text", value)) })
    await renderOnce()
    // The renderer-level query still answers.
    expect(renderer.getTextMetadataAt(0, 0)).toBe(value)
    expect(node.getStyledTextHit(0, 0)).toBeNull()
  })

  test("tab indicators, tab width, and user highlights keep keys", async () => {
    const { renderer, renderOnce } = await setup()
    const value = { id: "v" }
    const node = text(renderer, { content: styled(chunk("a\tb", value)) })
    await renderOnce()
    const before = rowIds(renderer, 0, 8)
    expect(before[0]).toBe("v")
    node.tabIndicator = "→"
    await renderOnce()
    // Indicator glyphs replace tab cells but keep the fragment.
    expect(rowIds(renderer, 0, 8)).toEqual(before)

    // The shared-buffer path: tab width and highlights do not touch keys.
    const buffer = TextBuffer.create("unicode", renderer.nativeScene)
    cleanups.push(() => buffer.destroy())
    buffer.setStyledText(styled(chunk("x\ty", value)))
    const registry = fragmentKeysFor(renderer.nativeScene.driver.context)
    const size = registry.size
    buffer.setTabWidth(8)
    buffer.addHighlightByCharRange({ start: 0, end: 1, styleId: 0 })
    buffer.clearAllHighlights()
    expect(registry.size).toBe(size)
    buffer.setText("plain")
    expect(registry.size).toBe(size - 1)
  })

  test.each(["tab-width", "lower-priority", "clear-all", "clear-line", "higher-priority"] as const)(
    "on a shared buffer, metadata follows the chunk's styling exactly like its link (%s)",
    async (operation) => {
      const { renderer, renderOnce } = await setup(12, 2)
      const value = { id: "v" }
      const node = bufferText(renderer, 0)
      const user = node.styles.registerStyle("user", { fg: RGBA.fromHex("#ff0000") })
      node.buffer.setStyledText(styled(chunk("abc", value, { link: { url: "https://example.com/v" } })))
      await renderOnce()
      expect(renderer.getTextMetadataAt(0, 0)).toBe(value)
      expect(renderer.getLinkAt(0, 0)).toBe("https://example.com/v")
      if (operation === "tab-width") node.buffer.setTabWidth(8)
      if (operation === "lower-priority") node.buffer.addHighlight(0, { start: 0, end: 1, styleId: user, priority: 0 })
      if (operation === "clear-all") node.buffer.clearAllHighlights()
      if (operation === "clear-line") node.buffer.clearLineHighlights(0)
      if (operation === "higher-priority") node.buffer.addHighlight(0, { start: 0, end: 1, styleId: user, priority: 2 })
      await renderOnce()
      // Chunk styles live in the buffer's highlights here. Whatever a highlight edit does to the
      // chunk's style and link, it does to the metadata too, and nothing else.
      const metadata = renderer.getTextMetadataAt(0, 0)
      const link = renderer.getLinkAt(0, 0)
      expect(metadata === undefined).toBe(link === null)
      if (link !== null) expect(metadata).toBe(value)
      if (operation === "tab-width" || operation === "lower-priority") expect(metadata).toBe(value)
    },
  )

  test("the documented pointer recipe resolves hits at fractional positions", async () => {
    const { renderer, renderOnce, mockMouse } = await createTestRenderer({
      width: 12,
      height: 3,
      useMouse: true,
      clock: new ManualClock(),
    })
    cleanups.push(async () => {
      renderer.destroy()
      await renderer.closed.catch(() => {})
    })
    const value = { id: "clicked" }
    let clicked: unknown
    const node = new TextRenderable(renderer, {
      width: 8,
      height: 1,
      content: styled(chunk("abc", value)),
      onMouseDown(event) {
        clicked = this.getStyledTextHit(
          event.x - Math.trunc(this.screenX),
          event.y - Math.trunc(this.screenY),
        )?.metadata
      },
    })
    node.translateX = 0.5
    node.translateY = 0.5
    renderer.root.add(node)
    await renderOnce()
    expect([node.screenX, node.screenY]).toEqual([0.5, 0.5])
    await mockMouse.click(1, 0, 0, { delayMs: 0 })
    expect(clicked).toBe(value)
  })
})

describe("CodeRenderable.getStyledTextHit", () => {
  test("fragments from highlighted chunks resolve on the shared text buffer", async () => {
    const { renderer, renderOnce, registry } = await setup(30, 3)
    const client = new MockTreeSitterClient()
    const syntaxStyle = SyntaxStyle.create(renderer.nativeScene)
    cleanups.push(() => syntaxStyle.destroy())
    cleanups.push(() => client.destroy())
    const token = { id: "token" }
    const code = new CodeRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      width: 30,
      height: 2,
      content: "let x",
      filetype: "typescript",
      syntaxStyle,
      treeSitterClient: client,
      onChunks: (chunks) => chunks.map((value, index) => (index === 0 ? { ...value, metadata: token } : value)),
    })
    renderer.root.add(code)
    await renderOnce()
    client.resolveAllHighlightOnce()
    await code.highlightingDone
    await renderOnce()
    expect(code.getStyledTextHit(0, 0)?.metadata).toBe(token)
    expect(renderer.getTextMetadataAt(0, 0)).toBe(token)
    code.destroy()
    expect(registry.size).toBe(0)
  })
})

describe("TextTableRenderable.getStyledTextHit", () => {
  test("returns the content cell and the cell chunk's metadata; borders return null", async () => {
    const { renderer, renderOnce } = await setup(30, 6)
    const shared = { id: "shared" }
    const own = { id: "own" }
    const table = new TextTableRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      content: [
        [[chunk("aa", shared)], [chunk("bb", own)]],
        [[chunk("cc", shared)], [chunk("dd")]],
      ],
    })
    renderer.root.add(table)
    await renderOnce()
    // Layout (30 wide): "│aa            │bb           │"; the second column starts at x = 16.
    expect(table.getStyledTextHit(1, 1)).toEqual({ metadata: shared, cell: { row: 0, column: 0 } })
    expect(table.getStyledTextHit(16, 1)).toEqual({ metadata: own, cell: { row: 0, column: 1 } })
    expect(table.getStyledTextHit(1, 3)).toEqual({ metadata: shared, cell: { row: 1, column: 0 } })
    expect(table.getStyledTextHit(16, 3)).toBeNull()
    expect(table.getStyledTextHit(0, 0)).toBeNull()
    expect(table.getStyledTextHit(0, 1)).toBeNull()
    expect(table.getStyledTextHit(3, 1)).toBeNull()
    expect(table.getStyledTextHit(15, 1)).toBeNull()
  })

  test("a replaced cell stops answering for its old fragment; other cells keep theirs", async () => {
    const { renderer, renderOnce, registry } = await setup(30, 6)
    const first = { id: "first" }
    const second = { id: "second" }
    const table = new TextTableRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      content: [[[chunk("aa", first)], [chunk("bb", second)]]],
    })
    renderer.root.add(table)
    await renderOnce()
    table.content = [[[chunk("aa")], [chunk("bb", second)]]]
    await renderOnce()
    expect(table.getStyledTextHit(1, 1)).toBeNull()
    expect(table.getStyledTextHit(16, 1)?.metadata).toBe(second)
    table.destroy()
    expect(registry.size).toBe(0)
  })

  test("a text renderable never claims a table's fragment, and the reverse", async () => {
    const { renderer, renderOnce } = await setup(30, 6)
    const value = { id: "same" }
    const table = new TextTableRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      content: [[[chunk("aa", value)]]],
    })
    renderer.root.add(table)
    const label = text(renderer, { left: 10, width: 4, height: 1, content: styled(chunk("aa", value)) })
    await renderOnce()
    expect(label.getStyledTextHit(0, 0)?.metadata).toBe(value)
    expect(table.getStyledTextHit(1, 1)?.metadata).toBe(value)
    // The same value in two owners has two keys.
    const tableKey = renderer.nativeScene.presentedFragmentKey(1, 1)
    const labelKey = renderer.nativeScene.presentedFragmentKey(10, 0)
    expect(tableKey).not.toBe(labelKey)
  })
})

describe("lifecycle", () => {
  test("a scrollback surface shares the Context but never resolves in the main session", async () => {
    const result = await createTestRenderer({
      width: 20,
      height: 6,
      screenMode: "split-footer",
      footerHeight: 2,
      externalOutputMode: "capture-stdout",
      consoleMode: "disabled",
    })
    cleanups.push(async () => {
      result.renderer.destroy()
      await result.renderer.closed.catch(() => {})
    })
    const { renderer, renderOnce } = result
    const registry = fragmentKeysFor(renderer.nativeScene.driver.context)
    const footer = { id: "footer" }
    const history = { id: "history" }
    text(renderer, { width: 10, height: 1, content: styled(chunk("footer", footer)) })
    await renderOnce()
    const surface = renderer.createScrollbackSurface({ startOnNewLine: true })
    const surfaceText = new TextRenderable(surface.renderContext, {
      width: 10,
      height: 1,
      content: styled(chunk("history", history)),
    })
    surface.root.add(surfaceText)
    surface.render()
    // The surface uses the same registry: it is one Context.
    expect(fragmentKeysFor(surface.renderContext.nativeScene.driver.context)).toBe(registry)
    surface.commitRows(0, surface.height)
    surface.destroy()
    await renderOnce()
    const found: unknown[] = []
    for (let y = 0; y < renderer.height; y++) {
      for (let x = 0; x < renderer.width; x++) {
        const value = renderer.getTextMetadataAt(x, y)
        if (value !== undefined) found.push(value)
      }
    }
    expect(found).toContain(footer)
    expect(found).not.toContain(history)
    expect(surfaceText.getStyledTextHit(0, 0)).toBeNull()
  })

  test.each(["resume", "screen-switch"] as const)(
    "%s clears the presented surface: lookups answer nothing until the next frame",
    async (transition) => {
      const stdout = new RecordingWriteStream(20, 3)
      const result = await createTestRenderer({
        width: 20,
        height: 3,
        useMouse: true,
        screenMode: "main-screen",
        clock: new ManualClock(),
        stdout: stdout as unknown as NodeJS.WriteStream,
        bufferedOutput: "stdout",
      })
      cleanups.push(async () => {
        stdout.release()
        result.renderer.destroy()
        await result.renderer.closed.catch(() => {})
      })
      const { renderer, renderOnce } = result
      await renderer.setupTerminal()
      const value = { id: "before" }
      const node = text(renderer, { content: styled(chunk("ABC", value)) })
      stdout.clear()
      await renderOnce()
      expect(stdout.text()).toContain("ABC")
      expect(renderer.getTextMetadataAt(0, 0)).toBe(value)
      stdout.clear()
      const frameId = renderer.frameId
      if (transition === "resume") {
        await renderer.suspend()
        await renderer.resume()
        expect(stdout.text()).toContain("\x1b[H\x1b[J")
      } else {
        renderer.screenMode = "alternate-screen"
        await renderer.nativeScene.driver.idle()
        expect(stdout.text()).toContain("\x1b[?1049h")
      }
      // The terminal no longer shows the frame, and no new frame was presented yet.
      expect(stdout.text()).not.toContain("ABC")
      expect(renderer.frameId).toBe(frameId)
      expect(renderer.getTextMetadataAt(0, 0)).toBeUndefined()
      expect(node.getStyledTextHit(0, 0)).toBeNull()
      await renderOnce()
      expect(renderer.getTextMetadataAt(0, 0)).toBe(value)
    },
  )

  test("buffers sharing one SyntaxStyle never resolve to each other's metadata", async () => {
    const { renderer, renderOnce } = await setup(12, 3, { useMouse: true })
    const shared = SyntaxStyle.create(renderer.nativeScene)
    cleanups.push(() => shared.destroy())
    const top = { owner: "top" }
    const bottom = { owner: "bottom" }
    const [first, second] = [bufferText(renderer, 0), bufferText(renderer, 1)]

    // Installed while the style is private to the first buffer.
    first.buffer.setSyntaxStyle(shared)
    first.buffer.setStyledText(styled(chunk("TOP", top)))
    await renderOnce()
    expect(renderer.getTextMetadataAt(0, 0)).toBe(top)

    // Chunk styles are named per chunk index in a shared style, so the second install replaces
    // the definitions the first buffer draws with. Its metadata must not take over the first row.
    second.buffer.setSyntaxStyle(shared)
    second.buffer.setStyledText(styled(chunk("BOTTOM", bottom, { link: { url: "https://example.com/b" } })))
    await renderOnce()
    for (let x = 0; x < 6; x++) {
      expect(renderer.getTextMetadataAt(x, 0)).not.toBe(bottom)
      expect(renderer.getTextMetadataAt(x, 1)).not.toBe(top)
    }
    expect(first.getStyledTextHit(0, 0)?.metadata).not.toBe(bottom)
    // Links keep their existing behaviour.
    expect(renderer.getLinkAt(0, 1)).toBe("https://example.com/b")

    // A buffer with a style of its own is unaffected.
    const own = { owner: "own" }
    const third = bufferText(renderer, 2)
    third.buffer.setStyledText(styled(chunk("OWN", own)))
    await renderOnce()
    expect(renderer.getTextMetadataAt(0, 2)).toBe(own)
    expect(third.getStyledTextHit(0, 0)?.metadata).toBe(own)
  })

  test("a suspended terminal presents nothing: lookups answer empty instead of throwing", async () => {
    const result = await createTestRenderer({ width: 20, height: 3, useMouse: true, clock: new ManualClock() })
    cleanups.push(async () => {
      result.renderer.destroy()
      await result.renderer.closed.catch(() => {})
    })
    const { renderer, renderOnce } = result
    await renderer.setupTerminal()
    const value = { id: "v" }
    const node = text(renderer, { content: styled(chunk("abc", value)) })
    await renderOnce()
    expect(node.getStyledTextHit(0, 0)?.metadata).toBe(value)
    await renderer.suspend()
    expect(renderer.getTextMetadataAt(0, 0)).toBeUndefined()
    expect(renderer.getPresentedLinkIdAt(0, 0)).toBe(0)
    expect(node.getStyledTextHit(0, 0)).toBeNull()
    await renderer.resume()
    await renderOnce()
    expect(renderer.getTextMetadataAt(0, 0)).toBe(value)
  })

  test("destroyed renderables, buffers, and renderers answer nothing and never throw", async () => {
    const { renderer, renderOnce, registry } = await setup()
    const value = { id: "v" }
    const node = text(renderer, { content: styled(chunk("text", value)) })
    await renderOnce()
    node.destroy()
    expect(registry.size).toBe(0)
    expect(node.getStyledTextHit(0, 0)).toBeNull()
    expect(renderer.getTextMetadataAt(0, 0)).toBeUndefined()

    const other = text(renderer, { content: styled(chunk("next", value)) })
    await renderOnce()
    renderer.destroy()
    await renderer.closed.catch(() => {})
    expect(renderer.getTextMetadataAt(0, 0)).toBeUndefined()
    expect(other.getStyledTextHit(0, 0)).toBeNull()
  })

  test("metadata rejected by a destination without fragment support throws before installing", async () => {
    const { renderer } = await setup()
    const lib = renderer.nativeScene.driver.renderLib
    expect(() => lib.encodeTextBufferStyledText(styled(chunk("x", { id: 1 })))).toThrow(TypeError)
    // A colour object and other chunk styles still pass through untouched.
    const encoded = lib.encodeTextBufferStyledText(styled(chunk("x", undefined, { fg: RGBA.fromHex("#ff0000") })))
    expect(encoded.keys).toEqual(new Uint32Array([0]))

    // Editor placeholders do not support fragments.
    const textarea = new TextareaRenderable(renderer, { width: 10, height: 1 })
    renderer.root.add(textarea)
    expect(() => {
      textarea.placeholder = styled(chunk("hint", { id: "hint" }))
    }).toThrow(TypeError)
    textarea.placeholder = styled(chunk("hint"))
    expect(fragmentKeysFor(renderer.nativeScene.driver.context).size).toBe(0)
  })
})
