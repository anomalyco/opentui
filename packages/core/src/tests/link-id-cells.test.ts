// Cell link ids follow real drawing: wide glyphs, clipping, truncation, and cached table rasters
// carry ids exactly on the cells they draw. Fragment metadata lookups depend on this.
import { afterEach, describe, expect, test } from "bun:test"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { TextTableRenderable } from "../renderables/TextTable.js"
import { link, StyledText, t } from "../lib/styled-text.js"
import { createTestRenderer, type TestRenderer } from "../testing.js"
import { getLinkId } from "../utils.js"

const renderers: TestRenderer[] = []
afterEach(async () => {
  for (const renderer of renderers.splice(0)) {
    renderer.destroy()
    await renderer.closed.catch(() => {})
  }
})

/** Every cell's link id, read through the public query. */
function linkIdGrid(renderer: TestRenderer): number[][] {
  const rows: number[][] = []
  for (let y = 0; y < renderer.height; y++) {
    const row: number[] = []
    for (let x = 0; x < renderer.width; x++) row.push(renderer.getLinkIdAt(x, y))
    rows.push(row)
  }
  return rows
}

/** Characters of the current render buffer, one string per row. */
function charGrid(renderer: TestRenderer): string[] {
  return renderer.currentRenderBuffer.withBuffers((cells) => {
    const rows: string[] = []
    for (let y = 0; y < renderer.height; y++) {
      let row = ""
      for (let x = 0; x < renderer.width; x++) {
        const char = cells.char[y * renderer.width + x]!
        row += char < 0x80 && char >= 0x20 ? String.fromCharCode(char) : char === 0 ? "\u0000" : "?"
      }
      rows.push(row)
    }
    return rows
  })
}

describe("link ids follow real drawing", () => {
  test("wide glyphs: every drawn cell, including continuations, carries the id; skipped glyphs carry none", async () => {
    const setup = await createTestRenderer({ width: 8, height: 2 })
    renderers.push(setup.renderer)
    const { renderer, renderOnce } = setup
    // Width 5 holds two wide glyphs (4 cells); the third does not fit and is skipped as a whole.
    const text = new TextRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      width: 5,
      height: 1,
      wrapMode: "none",
      content: t`${link("https://example.com/wide")("界界界")}`,
    })
    renderer.root.add(text)
    await renderOnce()
    const ids = linkIdGrid(renderer)[0]!
    const id = ids[0]!
    expect(id).toBeGreaterThan(0)
    expect(ids.slice(0, 4)).toEqual([id, id, id, id])
    // Cell 4 is inside the node but the third wide glyph was not drawn there.
    expect(ids[4]).toBe(0)
  })

  test("clipping: cells outside an overflow-hidden ancestor carry no id", async () => {
    const setup = await createTestRenderer({ width: 12, height: 2 })
    renderers.push(setup.renderer)
    const { renderer, renderOnce } = setup
    const clip = new BoxRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      width: 4,
      height: 1,
      overflow: "hidden",
    })
    clip.add(
      new TextRenderable(renderer, {
        width: 10,
        height: 1,
        wrapMode: "none",
        content: t`${link("https://example.com/clip")("ABCDEFGHIJ")}`,
      }),
    )
    renderer.root.add(clip)
    await renderOnce()
    const ids = linkIdGrid(renderer)[0]!
    const id = ids[0]!
    expect(id).toBeGreaterThan(0)
    expect(ids.slice(0, 4)).toEqual([id, id, id, id])
    expect(ids.slice(4, 10)).toEqual([0, 0, 0, 0, 0, 0])
  })

  test("truncation: ellipsis cells carry no id, prefix and suffix keep theirs", async () => {
    const setup = await createTestRenderer({ width: 12, height: 2 })
    renderers.push(setup.renderer)
    const { renderer, renderOnce } = setup
    const text = new TextRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      width: 9,
      height: 1,
      wrapMode: "none",
      truncate: true,
      content: new StyledText([
        { __isChunk: true, text: "abcdefghi", link: { url: "https://example.com/prefix" } },
        { __isChunk: true, text: "XYZ", link: { url: "https://example.com/suffix" } },
      ]),
    })
    renderer.root.add(text)
    await renderOnce()
    const ids = linkIdGrid(renderer)[0]!.slice(0, 9)
    const chars = charGrid(renderer)[0]!.slice(0, 9)
    expect(chars).toBe("abc...XYZ")
    const prefix = ids[0]!
    const suffix = ids[6]!
    expect(prefix).toBeGreaterThan(0)
    expect(suffix).toBeGreaterThan(0)
    expect(suffix).not.toBe(prefix)
    expect(ids.slice(0, 3)).toEqual([prefix, prefix, prefix])
    // Ellipsis cells carry no link.
    expect(ids.slice(3, 6)).toEqual([0, 0, 0])
    expect(ids.slice(6, 9)).toEqual([suffix, suffix, suffix])
  })

  test("cached table raster: ids survive frames that reuse the raster, and borders carry none", async () => {
    const setup = await createTestRenderer({ width: 20, height: 5 })
    renderers.push(setup.renderer)
    const { renderer, renderOnce } = setup
    const table = new TextTableRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      content: [[[{ __isChunk: true, text: "cell", link: { url: "https://example.com/cell" } }]]],
    })
    renderer.root.add(table)
    await renderOnce()
    const first = linkIdGrid(renderer)
    // A second frame that does not touch the table reuses its cached raster.
    renderer.setBackgroundColor("#101010")
    await renderOnce()
    const second = linkIdGrid(renderer)
    const id = second[1]![1]!
    expect(id).toBeGreaterThan(0)
    expect(second[1]!.slice(1, 5)).toEqual([id, id, id, id])
    expect(second[0]![0]).toBe(0)
    expect(second[1]![0]).toBe(0)
    expect(second).toEqual(first)
  })

  test("raw attributes agree with the query for every cell", async () => {
    const setup = await createTestRenderer({ width: 10, height: 2 })
    renderers.push(setup.renderer)
    const { renderer, renderOnce } = setup
    renderer.root.add(
      new TextRenderable(renderer, {
        position: "absolute",
        left: 1,
        top: 0,
        width: 6,
        height: 1,
        content: t`x${link("https://example.com/raw")("界y")}z`,
      }),
    )
    await renderOnce()
    const query = linkIdGrid(renderer)
    const raw = renderer.currentRenderBuffer.withBuffers((cells) =>
      Array.from({ length: renderer.height }, (_, y) =>
        Array.from({ length: renderer.width }, (_, x) => getLinkId(cells.attributes[y * renderer.width + x]!)),
      ),
    )
    expect(query).toEqual(raw)
  })
})
