import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable } from "./Box.js"
import { EditBufferRenderableEvents, isEditBufferRenderable } from "./EditBufferRenderable.js"
import { InputRenderable } from "./Input.js"
import { TextareaRenderable } from "./Textarea.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"

describe("EditBufferRenderable", () => {
  let renderer: TestRenderer
  let renderOnce: () => Promise<void>

  beforeEach(async () => {
    ;({ renderer, renderOnce } = await createTestRenderer({ width: 40, height: 20 }))
  })

  afterEach(() => {
    renderer.destroy()
  })

  test("brands textarea and input instances", async () => {
    const textarea = new TextareaRenderable(renderer, { width: 20, height: 3 })
    const input = new InputRenderable(renderer, { width: 20 })

    renderer.root.add(textarea)
    renderer.root.add(input)
    await renderOnce()

    expect(isEditBufferRenderable(textarea)).toBe(true)
    expect(isEditBufferRenderable(input)).toBe(true)
  })

  test("does not brand non-editor renderables", async () => {
    const box = new BoxRenderable(renderer, { width: 10, height: 2 })

    renderer.root.add(box)
    await renderOnce()

    expect(isEditBufferRenderable(box)).toBe(false)
    expect(isEditBufferRenderable(null)).toBe(false)
    expect(isEditBufferRenderable(undefined)).toBe(false)
  })

  test("supports currentFocusedRenderable narrowing for editor access", async () => {
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 3,
      initialValue: "hello",
    })

    renderer.root.add(textarea)
    await renderOnce()

    textarea.focus()

    const current = renderer.currentFocusedRenderable
    expect(isEditBufferRenderable(current)).toBe(true)
    if (!isEditBufferRenderable(current)) throw new Error("expected focused editor")

    expect(current.plainText).toBe("hello")
    current.cursorOffset = 2
    expect(current.visualCursor.offset).toBe(2)
  })

  test("stores generic editor traits per instance", async () => {
    const textarea = new TextareaRenderable(renderer, { width: 20, height: 3 })
    const input = new InputRenderable(renderer, { width: 20, value: "name" })

    renderer.root.add(textarea)
    renderer.root.add(input)
    await renderOnce()

    expect(textarea.traits).toEqual({})
    expect(input.traits).toEqual({})

    textarea.traits = {
      capture: ["escape", "navigate"],
      suspend: true,
      status: "PALETTE",
    }

    expect(textarea.traits).toEqual({
      capture: ["escape", "navigate"],
      suspend: true,
      status: "PALETTE",
    })
    expect(input.traits).toEqual({})

    input.traits.status = "FILTER"

    expect(textarea.traits.status).toBe("PALETTE")
    expect(input.traits.status).toBe("FILTER")
  })

  test("emits traits-changed when traits are reassigned", async () => {
    const textarea = new TextareaRenderable(renderer, { width: 20, height: 3 })
    const calls: Array<{ next: unknown; prev: unknown }> = []

    renderer.root.add(textarea)
    await renderOnce()

    textarea.on(EditBufferRenderableEvents.TRAITS_CHANGED, (next, prev) => {
      calls.push({ next, prev })
    })

    textarea.traits = { status: "FILTER" }
    textarea.traits = { status: "FILTER" }
    textarea.traits = { status: "FILTER", suspend: true }

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({
      next: { status: "FILTER" },
      prev: {},
    })
    expect(calls[1]).toEqual({
      next: { status: "FILTER", suspend: true },
      prev: { status: "FILTER" },
    })
  })

  test("clears traits on destroy", async () => {
    const textarea = new TextareaRenderable(renderer, { width: 20, height: 3 })

    renderer.root.add(textarea)
    await renderOnce()

    textarea.traits = {
      capture: ["escape"],
      suspend: true,
      status: "BUSY",
    }

    textarea.destroy()

    expect(textarea.traits).toEqual({})
  })

  test("sets and clears selection through renderable api", async () => {
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 3,
      initialValue: "abcdefg",
    })

    renderer.root.add(textarea)
    await renderOnce()

    textarea.setSelection(2, 4)

    expect(textarea.hasSelection()).toBe(true)
    expect(textarea.getSelection()).toEqual({ start: 2, end: 4 })
    expect(textarea.getSelectedText()).toBe("cd")

    expect(textarea.clearSelection()).toBe(true)
    expect(textarea.hasSelection()).toBe(false)
    expect(textarea.getSelectedText()).toBe("")
    expect(textarea.clearSelection()).toBe(false)
  })

  test("deletes selection through renderable api", async () => {
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 3,
      initialValue: "abcdefg",
    })

    renderer.root.add(textarea)
    await renderOnce()

    textarea.setSelection(2, 4)

    expect(textarea.deleteSelection()).toBe(true)
    expect(textarea.plainText).toBe("abefg")
    expect(textarea.hasSelection()).toBe(false)
    expect(textarea.cursorOffset).toBe(2)
    expect(textarea.deleteSelection()).toBe(false)
  })

  test("keeps explicit selection when selection colors change", async () => {
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 3,
      initialValue: "abcdefg",
    })

    renderer.root.add(textarea)
    await renderOnce()

    textarea.setSelection(2, 4)
    textarea.selectionBg = "#ff0000"
    textarea.selectionFg = "#000000"

    expect(textarea.getSelection()).toEqual({ start: 2, end: 4 })
    expect(textarea.getSelectedText()).toBe("cd")
  })

  test("inherits movement selection behavior from edit buffer renderable", async () => {
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 3,
      initialValue: "abcdefg",
    })

    renderer.root.add(textarea)
    await renderOnce()

    textarea.cursorOffset = 2
    textarea.moveCursorRight({ select: true })

    // Inclusive selection: the anchor cell and the cell under the moved
    // cursor are both selected (Vim v+l).
    expect(textarea.getSelection()).toEqual({ start: 2, end: 4 })
    expect(textarea.getSelectedText()).toBe("cd")
  })

  test("sets cursor through renderable api", async () => {
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 3,
      initialValue: "abc\ndef",
    })

    renderer.root.add(textarea)
    await renderOnce()

    textarea.setCursor(1, 2)

    expect(textarea.logicalCursor.row).toBe(1)
    expect(textarea.logicalCursor.col).toBe(2)
    expect(textarea.cursorOffset).toBe(6)
  })

  test("goes to exact current line boundaries through renderable api", async () => {
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 3,
      initialValue: "abc\ndef",
    })

    renderer.root.add(textarea)
    await renderOnce()

    textarea.setCursor(1, 2)
    textarea.gotoLineStart()
    expect(textarea.logicalCursor.row).toBe(1)
    expect(textarea.logicalCursor.col).toBe(0)

    textarea.gotoLineTextEnd()
    expect(textarea.logicalCursor.row).toBe(1)
    expect(textarea.logicalCursor.col).toBe(3)
  })

  test("reports cursorCharacterOffset for text positions", async () => {
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 3,
      initialValue: "abc\ndef",
    })

    renderer.root.add(textarea)
    await renderOnce()

    textarea.setCursor(0, 1)
    expect(textarea.cursorCharacterOffset).toBe(1)

    textarea.gotoLineTextEnd()
    expect(textarea.cursorCharacterOffset).toBe(2)

    textarea.gotoBufferEnd()
    expect(textarea.cursorCharacterOffset).toBe(6)

    textarea.clear()
    expect(textarea.cursorCharacterOffset).toBeUndefined()
  })

  test("sets inclusive selection through renderable api", async () => {
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 3,
      initialValue: "ab你cd",
    })

    renderer.root.add(textarea)
    await renderOnce()

    textarea.setSelectionInclusive(2, 2)

    expect(textarea.getSelection()).toEqual({ start: 2, end: 4 })
    expect(textarea.getSelectedText()).toBe("你")
  })

  test("setSelectionInclusive does not extend under boundary occupancy", async () => {
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 3,
      initialValue: "ab你cd",
      selectionOccupancy: "boundary",
    })

    renderer.root.add(textarea)
    await renderOnce()

    textarea.setSelectionInclusive(3, 4)

    expect(textarea.getSelection()).toEqual({ start: 2, end: 4 })
    expect(textarea.getSelectedText()).toBe("你")
    textarea.deleteSelection()
    expect(textarea.plainText).toBe("abcd")
  })

  test("setSelectionInclusive uses current text bounds", async () => {
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 3,
      initialValue: "abc",
    })

    renderer.root.add(textarea)
    await renderOnce()

    textarea.setSelection(0, 3)
    textarea.replaceText("abcdefghij")
    textarea.setSelectionInclusive(8, 8)

    expect(textarea.getSelection()).toEqual({ start: 8, end: 9 })
    expect(textarea.getSelectedText()).toBe("i")
    textarea.deleteSelection()
    expect(textarea.plainText).toBe("abcdefghj")

    textarea.setText("abc")
    textarea.setSelectionInclusive(0, 99)
    expect(textarea.getSelection()).toEqual({ start: 0, end: 3 })
    textarea.deleteSelection()
    expect(textarea.plainText).toBe("")
  })

  test("reads selection occupancy from the editor view", async () => {
    const textarea = new TextareaRenderable(renderer, { width: 20, height: 3 })

    renderer.root.add(textarea)
    await renderOnce()

    textarea.editorView.setSelectionOccupancy("boundary")
    expect(textarea.selectionOccupancy).toBe("boundary")

    textarea.selectionOccupancy = "cell"
    expect(textarea.editorView.getSelectionOccupancy()).toBe("cell")

    textarea.selectionOccupancy = undefined
    expect(textarea.selectionOccupancy).toBe("cell")
  })

  test("does not move the cursor when occupancy changes an offset selection", async () => {
    const textarea = new TextareaRenderable(renderer, { width: 20, height: 3, initialValue: "ab你cd" })
    renderer.root.add(textarea)
    await renderOnce()

    textarea.cursorOffset = 4
    textarea.setSelection(0, 2)
    textarea.selectionOccupancy = "boundary"
    expect(textarea.cursorOffset).toBe(4)

    textarea.setSelection(3, 3)
    textarea.selectionOccupancy = "cell"
    expect(textarea.cursorOffset).toBe(4)
  })
})
