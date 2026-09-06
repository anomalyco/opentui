import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { BoxRenderable } from "./Box.js"
import { EditBufferRenderable, EditBufferRenderableEvents, isEditBufferRenderable } from "./EditBufferRenderable.js"
import { InputRenderable } from "./Input.js"
import { TextareaRenderable } from "./Textarea.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { resolveRenderLib } from "../zig.js"
import { TextAttributes } from "../types.js"
import { StyledText } from "../lib/styled-text.js"
import { RGBA } from "../lib/RGBA.js"

describe("EditBufferRenderable", () => {
  let renderer: TestRenderer
  let renderOnce: () => Promise<void>

  beforeEach(async () => {
    ;({ renderer, renderOnce } = await createTestRenderer({ width: 40, height: 20 }))
  })

  afterEach(() => {
    renderer.destroy()
  })

  test("fractional constructor dimensions produce a usable rounded viewport", async () => {
    const editor = new TextareaRenderable(renderer, { width: 0.5, height: 2.5, initialValue: "x" })
    renderer.root.add(editor)
    await renderOnce()
    expect(editor.editorView.getViewport()).toMatchObject({ width: 1, height: 3 })
    expect(renderer.currentRenderBuffer.getSpanLines()[0].spans[0].text.trimEnd()).toBe("x")
  })

  test.each([
    ["wrapMode", "none"],
    ["attributes", TextAttributes.BOLD],
    ["placeholder", "next"],
    ["placeholderColor", RGBA.fromHex("#ff0000")],
  ] as const)("%s rejection retains state and permits a legal retry", async (property, value) => {
    const editor = new TextareaRenderable(renderer, {
      width: 4,
      height: 4,
      initialValue: property.startsWith("placeholder") ? "" : "abcdefghij",
      placeholder: "kept",
    })
    const observer = new BoxRenderable(renderer, { alignSelf: "flex-start" })
    renderer.root.add(editor)
    renderer.root.add(observer)
    await renderOnce()
    const before = editor[property]
    observer.setMeasureProvider(() => {
      Object.assign(editor, { [property]: value })
      return { width: 1, height: 1 }
    })
    expect(() => renderer.nativeScene.measureSnapshot(observer)).toThrow("Cannot mutate Yoga during a callback")
    expect(editor[property]).toEqual(before)
    observer.setMeasureProvider(null)
    Object.assign(editor, { [property]: value })
    await renderOnce()
    if (property === "wrapMode") expect(editor.editorView.getTotalVirtualLineCount()).toBe(1)
    else if (property === "attributes")
      renderer.currentRenderBuffer.withBuffers(({ attributes }) => expect(attributes[0]).toBe(TextAttributes.BOLD))
    else
      expect(renderer.currentRenderBuffer.getSpanLines()[0].spans[0]).toMatchObject(
        property === "placeholder" ? { text: "next" } : { text: "kept", fg: value },
      )
  })

  test("Textarea rejects linked placeholders without poisoning later color updates", async () => {
    const editor = new TextareaRenderable(renderer, { width: 12, height: 2, placeholder: "kept" })
    renderer.root.add(editor)
    const linked = new StyledText([{ __isChunk: true, text: "rejected", link: { url: "https://example.com" } }])
    expect(() => {
      editor.placeholder = linked
    }).toThrow("link")
    const color = RGBA.fromHex("#ff0000")
    editor.placeholderColor = color
    await renderOnce()
    expect(renderer.currentRenderBuffer.getSpanLines()[0].spans[0]).toMatchObject({ text: "kept", fg: color })
  })

  test.each(["input", "textarea"] as const)("%s resets optional attributes to the default", async (kind) => {
    const editor =
      kind === "input"
        ? new InputRenderable(renderer, { value: "text", attributes: undefined })
        : new TextareaRenderable(renderer, { initialValue: "text", attributes: undefined })
    renderer.root.add(editor)
    await renderOnce()
    expect(editor.attributes).toBe(0)
    renderer.currentRenderBuffer.withBuffers(({ attributes }) => expect(attributes[0]).toBe(0))

    for (const value of [undefined, TextAttributes.BOLD, undefined]) {
      editor.attributes = value
      await renderOnce()
      expect(editor.attributes).toBe(value ?? 0)
      expect(editor.plainText).toBe("text")
      renderer.currentRenderBuffer.withBuffers(({ char, attributes }) => {
        expect(char[0]).toBe("t".codePointAt(0)!)
        expect(attributes[0]).toBe(value ?? 0)
      })
    }
  })

  test.each(["setText", "replaceText"] as const)(
    "%s completes invalidation and render requests before an accepted callback error escapes",
    async (method) => {
      const textarea = new TextareaRenderable(renderer, { width: 20, height: "auto", initialValue: "before\nbefore" })
      renderer.root.add(textarea)
      await Promise.resolve()
      await renderOnce()
      expect(textarea.height).toBe(2)
      const host = resolveRenderLib().getYogaHost()
      const failure = new Error("accepted replacement callback")
      const original = textarea.editBuffer[method].bind(textarea.editBuffer)
      const replace = spyOn(textarea.editBuffer, method).mockImplementation((text) => {
        original(text)
        host.invokeCallback(() => {
          throw failure
        })
      })
      const render = spyOn(textarea, "requestRender")
      try {
        expect(() => textarea[method]("after")).toThrow(failure)
        expect(textarea.plainText).toBe("after")
        expect(replace).toHaveBeenCalledTimes(1)
        expect(render).toHaveBeenCalledTimes(1)
        await renderOnce()
        expect(textarea.height).toBe(1)
        expect(new TextDecoder().decode(renderer.currentRenderBuffer.getRealCharBytes(true))).toContain("after")
      } finally {
        render.mockRestore()
        replace.mockRestore()
      }
    },
  )

  test("Textarea initialValue latches accepted text before a callback error escapes", async () => {
    const textarea = new TextareaRenderable(renderer, { width: 20, height: 3 })
    renderer.root.add(textarea)
    await renderOnce()
    const failure = new Error("accepted initial value callback")
    const host = resolveRenderLib().getYogaHost()
    const original = textarea.editBuffer.setText.bind(textarea.editBuffer)
    const replace = spyOn(textarea.editBuffer, "setText").mockImplementation((text) => {
      original(text)
      host.invokeCallback(() => {
        throw failure
      })
    })
    try {
      expect(() => {
        textarea.initialValue = "accepted"
      }).toThrow(failure)
      expect(textarea.plainText).toBe("accepted")
      textarea.initialValue = "ignored"
      expect(textarea.plainText).toBe("accepted")
      expect(replace).toHaveBeenCalledTimes(1)
    } finally {
      replace.mockRestore()
    }
  })

  test("Textarea construction latches accepted initial text before callback failure cleanup", () => {
    const host = resolveRenderLib().getYogaHost()
    const failure = new Error("constructor replacement callback")
    let constructed: EditBufferRenderable | undefined
    const original = EditBufferRenderable.prototype.setText
    const replace = spyOn(EditBufferRenderable.prototype, "setText").mockImplementation(
      function (this: EditBufferRenderable, text) {
        constructed = this
        host.runMutation(() => {
          original.call(this, text)
          host.invokeCallback(() => {
            throw failure
          })
        })
      },
    )
    try {
      expect(() => new TextareaRenderable(renderer, { initialValue: "accepted" })).toThrow(failure)
      expect(Reflect.get(constructed!, "_initialValueSet")).toBe(true)
      expect(constructed?.isDestroyed).toBe(true)
      expect(replace).toHaveBeenCalledTimes(1)
    } finally {
      replace.mockRestore()
    }
  })

  test.each(["", "\u4f60\ntext"])("Textarea initialValue can retry rejection and then latch %j", (text) => {
    const textarea = new TextareaRenderable(renderer, { width: 20, height: 3 })
    renderer.root.add(textarea)
    const original = textarea.editBuffer.setText.bind(textarea.editBuffer)
    const failure = new Error("initial value rejection")
    let reject = true
    const replace = spyOn(textarea.editBuffer, "setText").mockImplementation((text) => {
      if (reject) throw failure
      original(text)
    })
    try {
      expect(() => {
        textarea.initialValue = text
      }).toThrow(failure)
      expect(textarea.plainText).toBe("")
      reject = false
      textarea.initialValue = text
      expect(textarea.plainText).toBe(text)
      textarea.initialValue = "ignored"
      expect(textarea.plainText).toBe(text)
      expect(replace).toHaveBeenCalledTimes(2)
    } finally {
      replace.mockRestore()
    }
  })

  test.each(["setText", "replaceText", "initialValue"] as const)(
    "%s does not commit caller completion on real capacity rejection",
    async (method) => {
      const textarea = new TextareaRenderable(renderer, { width: 20, height: 3 })
      renderer.root.add(textarea)
      textarea.insertText("before")
      // Fill the remaining text registrations through Context-backed edits.
      for (let slot = 1; slot < 255; slot++) textarea.editBuffer.replaceText(slot % 2 === 1 ? "filler" : "before")
      textarea.cursorOffset = 2
      await Promise.resolve()
      const render = spyOn(textarea, "requestRender")
      const dirty = spyOn(textarea, "invalidateIntrinsicSize")
      const trace: string[] = []
      textarea.editBuffer.on("cursor-changed", () => trace.push("cursor"))
      textarea.editBuffer.on("content-changed", () => trace.push("content"))
      try {
        expect(() => {
          if (method === "initialValue") textarea.initialValue = "after"
          else textarea[method]("after")
        }).toThrow("OutOfMemory")
        expect(textarea.plainText).toBe("before")
        expect(textarea.cursorOffset).toBe(2)
        expect(Reflect.get(textarea, "_initialValueSet")).toBe(false)
        expect(textarea.editBuffer.canUndo()).toBe(true)
        expect(dirty).toHaveBeenCalledTimes(0)
        expect(render).toHaveBeenCalledTimes(0)
        expect(trace).toEqual([])
        await Promise.resolve()
        expect(trace).toEqual([])
      } finally {
        dirty.mockRestore()
        render.mockRestore()
        textarea.destroy()
      }
    },
  )

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
    textarea.translateX = 0.5
    textarea.translateY = -0.5
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
