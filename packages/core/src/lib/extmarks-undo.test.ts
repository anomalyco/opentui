import { ResourceContext } from "../buffer.js"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { EditBuffer } from "../edit-buffer.js"
import { EditorView } from "../editor-view.js"
import type { ExtmarksController } from "./extmarks.js"
import { check, fail, rng } from "../testing/model.js"

let resourceContext: ResourceContext
beforeEach(() => {
  resourceContext = new ResourceContext({ objectCapacity: 65536, renderCellsMax: 1000000 })
})
afterEach(() => resourceContext.destroy())

describe("Extmark history metadata", () => {
  let buffer: EditBuffer
  let view: EditorView
  let extmarks: ExtmarksController

  beforeEach(() => {
    buffer = EditBuffer.create("wcwidth", resourceContext)
    buffer.setText("abc[LINK]def")
    view = EditorView.create(buffer, 40, 10)
    extmarks = view.extmarks
  })

  afterEach(() => {
    view?.destroy()
    buffer?.destroy()
  })

  // Q3: ids are never reused, also across undo.
  it("restores metadata and type membership across undo and redo", () => {
    const stable = extmarks.create({ start: 0, end: 3, metadata: 0 })
    buffer.insertText("X")
    const transient = extmarks.create({ start: 4, end: 10, typeId: 1, metadata: false })

    buffer.undo()
    expect(extmarks.get(transient)).toBeNull()
    expect(extmarks.getMetadataFor(transient)).toBeUndefined()
    expect(extmarks.getAllForTypeId(1)).toEqual([])

    const replacement = extmarks.create({ start: 3, end: 9, typeId: 2, metadata: null })
    expect(replacement).toBe(transient + 1)
    buffer.redo()
    expect(extmarks.getAllForTypeId(1)).toEqual([extmarks.get(transient)!])
    expect(extmarks.getAllForTypeId(2)).toEqual([])
    expect(extmarks.getMetadataFor(transient)).toBe(false)
    expect(extmarks.getMetadataFor(stable)).toBe(0)
    expect(extmarks.getAllForTypeId(0)).toEqual([extmarks.get(stable)!])

    buffer.undo()
    expect(extmarks.getAllForTypeId(1)).toEqual([])
    expect(extmarks.getAllForTypeId(2)).toEqual([extmarks.get(replacement)!])
    expect(extmarks.getMetadataFor(replacement)).toBeNull()
    expect(extmarks.getMetadataFor(stable)).toBe(0)
    expect(extmarks.getAllForTypeId(0)).toEqual([extmarks.get(stable)!])
  })

  // Record 017: undo after a no-op edit, `clear()` or `setText()` puts the marks of the text it restores, and a mark
  // that undo restores keeps its payload. `setText()` drops the history, so nothing keeps the payload.
  it.each<[string, () => void, string, [number, number] | null]>([
    ["Backspace at offset 0", () => (buffer.setCursor(0, 0), buffer.deleteCharBackward()), "hello world", [6, 11]],
    ["buffer clear()", () => buffer.clear(), "hello world", [6, 11]],
    ["setText()", () => buffer.setText("fresh"), "fresh", null],
    ["extmarks clear()", () => extmarks.clear(), "hello world", [6, 11]],
    ["replaceText()", () => buffer.replaceText("fresh"), "Xhello world", [7, 12]],
  ])("X, %s, undo", (_, step, text, range) => {
    buffer.setText("hello world")
    const id = extmarks.create({ start: 6, end: 11, data: "world", metadata: "meta" })
    buffer.setCursor(0, 0)
    buffer.insertText("X")
    step()
    buffer.undo()
    expect(buffer.getText()).toBe(text)
    const mark = extmarks.get(id)
    expect(mark && [mark.start, mark.end, mark.data, extmarks.getMetadataFor(id)]).toEqual(
      range && [...range, "world", "meta"],
    )
    expect((extmarks as any).payloads.size).toBe(range ? 1 : 0)
  })

  // Invariant 5 as a model: a live mark returns the payload it was created with, a dead id reads as absent, marks stay
  // inside the text, and only marks created since the last `setText()` keep a payload. 64 seeds of 40 commands.
  it("keeps payloads for exactly the marks undo can restore (model)", async () => {
    const pick = (random: () => number, n: number) => Math.floor(random() * n)
    const generate = (seed: number) => {
      const random = rng(seed)
      return Array.from({ length: 40 }, () => [pick(random, 10), random(), random()] as const)
    }
    await check(64, generate, async (commands) => {
      buffer.setText("ab\n界 c")
      const created = new Map<number, string>()
      const ids: number[] = []
      for (const [kind, a, b] of commands) {
        const end = buffer.measureText(buffer.getText())
        const [from, to] = [Math.floor(a * (end + 1)), Math.floor(b * (end + 1))].sort((x, y) => x - y)
        if (kind === 0 || kind === 1) {
          const id = extmarks.create({
            start: from,
            end: to,
            virtual: kind === 1,
            data: `d${from}`,
            metadata: from,
          })
          created.set(id, `d${from}`)
          ids.push(id)
        } else if (kind === 2) extmarks.delete(ids[Math.floor(a * ids.length)] ?? 0)
        else if (kind === 3) (buffer.setCursorByOffset(from), buffer.insertText(b < 0.5 ? "x" : "界\n"))
        else if (kind === 4) (buffer.setCursorByOffset(from), buffer.deleteCharBackward())
        else if (kind === 5) buffer.undo()
        else if (kind === 6) buffer.redo()
        else if (kind === 7) b < 0.5 ? buffer.clear() : extmarks.clear()
        else if (kind === 8) buffer.replaceText(b < 0.5 ? "y界" : "")
        else (buffer.setText("ab\n界 c"), created.clear())
        const live = new Set(extmarks.getAll().map((mark) => mark.id))
        const size = buffer.measureText(buffer.getText())
        for (const mark of extmarks.getAll()) {
          if (mark.data !== created.get(mark.id)) fail("payload", `mark ${mark.id} has ${mark.data}`)
          if (!(0 <= mark.start && mark.start <= mark.end && mark.end <= size)) fail("range", JSON.stringify(mark))
        }
        for (const id of ids) {
          if (!live.has(id) && (extmarks.get(id) || extmarks.getMetadataFor(id) !== undefined)) fail("dead", `${id}`)
        }
        const kept = [...(extmarks as any).payloads.keys()]
        if (kept.some((id: number) => !created.has(id))) fail("reset", `payloads ${kept} after setText`)
      }
    })
  })
})
