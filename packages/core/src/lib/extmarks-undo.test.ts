import { ResourceContext } from "../buffer.js"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { EditBuffer } from "../edit-buffer.js"
import { EditorView } from "../editor-view.js"
import type { ExtmarksController } from "./extmarks.js"

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
})
