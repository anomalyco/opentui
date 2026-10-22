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

  it("restores metadata and type membership when snapshots reuse an extmark ID", () => {
    const stable = extmarks.create({ start: 0, end: 3, metadata: 0 })
    buffer.insertText("X")
    const transient = extmarks.create({ start: 4, end: 10, typeId: 1, metadata: false })

    buffer.undo()
    expect(extmarks.get(transient)).toBeNull()
    expect(extmarks.getMetadataFor(transient)).toBeUndefined()
    expect(extmarks.getAllForTypeId(1)).toEqual([])

    const replacement = extmarks.create({ start: 3, end: 9, typeId: 2, metadata: null })
    expect(replacement).toBe(transient)
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
})
