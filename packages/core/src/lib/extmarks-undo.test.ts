import { ResourceContext } from "../buffer.js"

let resourceContext: ResourceContext
beforeEach(() => {
  resourceContext = new ResourceContext({ objectCapacity: 65536, renderCellsMax: 1000000 })
})
afterEach(() => resourceContext.destroy())

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { EditBuffer } from "../edit-buffer.js"
import { EditorView } from "../editor-view.js"
import { resolveRenderLib } from "../zig.js"
import type { ExtmarksController } from "./extmarks.js"

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

  it.each(["deleteChar", "deleteCharBackward", "deleteRange", "deleteSelection", "replaceText"] as const)(
    "%s restores deleted metadata and type membership through undo/redo",
    async (method) => {
      buffer.setCursorByOffset(method === "deleteCharBackward" ? 9 : 3)
      const typeId = extmarks.registerType("link")
      const metadata = { url: "https://example.com" }
      const data = { label: "link" }
      const id = extmarks.create({ start: 3, end: 9, virtual: true, typeId, metadata, data, styleId: 1 })
      const mark = { ...extmarks.get(id)! }

      if (method === "deleteRange") buffer.deleteRange(0, 3, 0, 9)
      else if (method === "deleteSelection") {
        view.setSelection(3, 9)
        view.deleteSelectedText()
      } else if (method === "replaceText") buffer.replaceText("replacement")
      else buffer[method]()

      const deletedText = method === "replaceText" ? "replacement" : "abcdef"
      for (let cycle = 0; cycle < 2; cycle++) {
        expect(buffer.getText()).toBe(deletedText)
        expect(extmarks.get(id)).toBeNull()
        expect(extmarks.getMetadataFor(id)).toBeUndefined()
        expect(extmarks.getAllForTypeId(typeId)).toEqual([])

        buffer.undo()
        expect(buffer.getText()).toBe("abc[LINK]def")
        expect(extmarks.get(id)).toEqual(mark)
        expect(extmarks.getMetadataFor(id)).toBe(metadata)
        expect(extmarks.get(id)?.data).toBe(data)
        expect(extmarks.getAllForTypeId(typeId)).toEqual([mark])
        expect(extmarks.getTypeId("link")).toBe(typeId)
        await Promise.resolve()
        expect(buffer.getLineHighlights(0)).toMatchObject([{ start: 3, end: 9, hlRef: id }])

        buffer.redo()
      }
      expect(buffer.getText()).toBe(deletedText)
      expect(extmarks.getAll()).toEqual([])
      expect(extmarks.getMetadataFor(id)).toBeUndefined()
      expect(extmarks.getAllForTypeId(typeId)).toEqual([])
    },
  )

  it.each(["undo", "redo"] as const)("%s leaves metadata and history unchanged on rejection", async (method) => {
    const metadata = { label: "link" }
    const id = extmarks.create({ start: 3, end: 9, typeId: 7, metadata })
    buffer.deleteRange(0, 3, 0, 9)
    if (method === "redo") buffer.undo()
    await Promise.resolve()
    const text = buffer.getText()
    const marks = extmarks.getAll()
    const beforeMetadata = extmarks.getMetadataFor(id)
    const trace: string[] = []
    buffer.on("content-changed", () => trace.push("content"))
    const failure = new Error("rejected history operation")
    const native = spyOn(resolveRenderLib(), "contextEditBufferHistory").mockImplementation(() => {
      throw failure
    })
    try {
      expect(() => buffer[method]()).toThrow(failure)
      expect(buffer.getText()).toBe(text)
      expect(extmarks.getAll()).toEqual(marks)
      expect(extmarks.getAllForTypeId(7)).toEqual(marks)
      expect(extmarks.getMetadataFor(id)).toBe(beforeMetadata)
      await Promise.resolve()
      expect(trace).toEqual([])
    } finally {
      native.mockRestore()
    }
    buffer[method]()
    if (method === "redo") buffer.undo()
    expect(buffer.getText()).toBe("abc[LINK]def")
    expect(extmarks.getMetadataFor(id)).toBe(metadata)
    expect(extmarks.getAllForTypeId(7)).toEqual([extmarks.get(id)!])
  })

  it.each(["undo", "redo"] as const)(
    "%s completes metadata before an accepted callback error escapes",
    async (method) => {
      const metadata = { label: "link" }
      const id = extmarks.create({ start: 3, end: 9, typeId: 7, metadata })
      buffer.deleteRange(0, 3, 0, 9)
      if (method === "redo") buffer.undo()
      await Promise.resolve()
      const trace: string[] = []
      buffer.on("cursor-changed", () => trace.push("cursor"))
      buffer.on("content-changed", () => trace.push("content"))
      const lib = resolveRenderLib()
      const host = lib.getYogaHost()
      const nativeMethod = "contextEditBufferHistory"
      const original = lib[nativeMethod].bind(lib)
      const failure = new Error("accepted history callback")
      const native = spyOn(lib, nativeMethod).mockImplementation((context, handle, redo) =>
        host.runMutation(() => {
          const result = original(context, handle, redo)
          host.invokeCallback(() => {
            throw failure
          })
          return result
        }),
      )
      try {
        expect(() => buffer[method]()).toThrow(failure)
        expect(native).toHaveBeenCalledTimes(1)
        expect(buffer.getText()).toBe(method === "undo" ? "abc[LINK]def" : "abcdef")
        expect(extmarks.getMetadataFor(id)).toBe(method === "undo" ? metadata : undefined)
        expect(extmarks.getAllForTypeId(7)).toEqual(method === "undo" ? [extmarks.get(id)!] : [])
        expect(trace).toEqual([])
        await Promise.resolve()
        expect(trace).toEqual(["cursor"])
        expect(() => host.throwCallbackError()).not.toThrow()
      } finally {
        native.mockRestore()
      }
      buffer[method === "undo" ? "redo" : "undo"]()
      expect(buffer.getText()).toBe(method === "undo" ? "abcdef" : "abc[LINK]def")
      expect(extmarks.getMetadataFor(id)).toBe(method === "undo" ? undefined : metadata)
    },
  )

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
