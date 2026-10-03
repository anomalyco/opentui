import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockInput } from "../../testing/test-renderer.js"
import { createTextareaRenderable } from "./renderable-test-utils.js"
import { TextareaRenderable } from "../Textarea.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMockInput: MockInput

describe("Textarea - Undo/Redo Tests", () => {
  beforeEach(async () => {
    ;({
      renderer: currentRenderer,
      renderOnce,
      mockInput: currentMockInput,
    } = await createTestRenderer({
      width: 80,
      height: 24,
      otherModifiersMode: true,
    }))
  })

  afterEach(() => {
    currentRenderer.destroy()
  })

  describe("Undo/Redo", () => {
    it("should delete multiple selected ranges and restore with undo", async () => {
      const initialText = "Hello World Test"
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: initialText,
        width: 40,
        height: 10,
      })

      editor.focus()

      editor.editBuffer.setCursor(0, 0)
      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }
      // Inclusive selection: each range extends through the cell under the cursor.
      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("Hello ")

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("World Test")
      expect(editor.hasSelection()).toBe(false)

      editor.editBuffer.setCursor(0, 0)
      for (let i = 0; i < 6; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }
      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("World T")

      currentMockInput.pressKey("DELETE")
      expect(editor.plainText).toBe("est")
      expect(editor.hasSelection()).toBe(false)

      editor.editBuffer.setCursor(0, 0)
      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }
      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("est")

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("")
      expect(editor.hasSelection()).toBe(false)

      currentMockInput.pressKey("-", { ctrl: true })
      expect(editor.plainText).toBe("est")

      currentMockInput.pressKey("-", { ctrl: true })
      expect(editor.plainText).toBe("World Test")

      currentMockInput.pressKey("-", { ctrl: true })
      expect(editor.plainText).toBe(initialText)
    })
  })

  // Every step drives the editor through keys or the API and compares it with a reference document. The history
  // mirrors the native rope: undo restores the state before an edit, and redo restores the state that the first undo
  // left. clear replaces the text without an undo point, so redo stays unavailable until the next undo.
  it("should match a reference document across random edits", async () => {
    const tokens = ["a", "Z", " ", "日", "\n"]
    const ops = ["type", "type", "paste", "backspace", "delete", "left", "right", "home", "end", "undo", "redo"]
    type State = { text: string[]; cursor: number }
    const errors = spyOn(console, "error")
    for (let seed = 1; seed <= 200; seed++) {
      let random = seed
      const next = (count: number) => {
        random = (random * 1664525 + 1013904223) >>> 0
        return Math.floor((random / 0x100000000) * count)
      }
      const pick = () => tokens[next(tokens.length)]
      const editor = new TextareaRenderable(currentRenderer, { width: 20, height: 5 })
      currentRenderer.root.add(editor)
      editor.focus()
      let state: State = { text: [], cursor: 0 }
      let restored: State | null = null
      let redo: State[] = []
      const undo: State[] = []
      const edit = (at: number, remove: number, insert: string[] = []) => {
        undo.push(state)
        redo = []
        restored = null
        state = { text: state.text.toSpliced(at, remove, ...insert), cursor: at + insert.length }
      }
      const offset = (index: number) => state.text.slice(0, index).reduce((sum, g) => sum + (g === "日" ? 2 : 1), 0)
      const log: string[] = []
      for (let step = 0; step < 50; step++) {
        const op = [...ops, "replace", "clear"][next(ops.length + 2)]
        log.push(op)
        if (op === "type") {
          const token = pick()
          log.push(JSON.stringify(token))
          if (token === "\n") currentMockInput.pressEnter()
          else currentMockInput.pressKey(token)
          edit(state.cursor, 0, [token])
        } else if (op === "paste") {
          const text = Array.from({ length: 1 + next(3) }, pick)
          log.push(JSON.stringify(text.join("")))
          await currentMockInput.pasteBracketedText(text.join(""))
          edit(state.cursor, 0, text)
        } else if (op === "backspace") {
          currentMockInput.pressBackspace()
          if (state.cursor > 0) edit(state.cursor - 1, 1)
        } else if (op === "delete") {
          currentMockInput.pressKey("DELETE")
          if (state.cursor < state.text.length) edit(state.cursor, 1)
        } else if (op === "left" || op === "right") {
          currentMockInput.pressArrow(op)
          const cursor = state.cursor + (op === "left" ? -1 : 1)
          state = { ...state, cursor: Math.max(0, Math.min(state.text.length, cursor)) }
        } else if (op === "home" || op === "end") {
          currentMockInput.pressKey(op === "home" ? "HOME" : "END")
          state = { ...state, cursor: op === "home" ? 0 : state.text.length }
        } else if (op === "undo") {
          currentMockInput.pressKey("-", { ctrl: true })
          if (undo.length > 0) {
            redo.push(restored ?? state)
            state = restored = undo.pop()!
          }
        } else if (op === "redo") {
          currentMockInput.pressKey(".", { ctrl: true })
          if (redo.length > 0 && restored?.text === state.text) {
            undo.push(restored)
            state = restored = redo.pop()!
          } else expect(editor.editBuffer.redo()).toBeNull()
        } else if (op === "clear") {
          editor.clear()
          state = { text: [], cursor: 0 }
        } else if (state.text.length > 0) {
          // Replacing a selection is two undo steps: delete, then insert.
          const start = next(state.text.length)
          const end = start + 1 + next(state.text.length - start)
          const text = Array.from({ length: next(3) }, pick)
          log.push(`[${start},${end})=${JSON.stringify(text.join(""))}`)
          editor.setSelection(offset(start), offset(end))
          if (text.length === 0) currentMockInput.pressBackspace()
          else await currentMockInput.pasteBracketedText(text.join(""))
          edit(start, end - start)
          if (text.length > 0) edit(start, 0, text)
        }
        const where = `seed ${seed} step ${step}: ${log.slice(-8).join(" ")}`
        expect({
          where,
          text: editor.plainText,
          cursor: editor.cursorOffset,
          canUndo: editor.editBuffer.canUndo(),
          canRedo: editor.editBuffer.canRedo(),
        }).toEqual({
          where,
          text: state.text.join(""),
          cursor: offset(state.cursor),
          canUndo: undo.length > 0,
          canRedo: redo.length > 0 && restored?.text === state.text,
        })
      }
      editor.destroy()
    }
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  describe("History - Undo/Redo", () => {
    it("should clear selection on undo", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      // Type a character first
      currentMockInput.pressKey("A")
      expect(editor.plainText).toBe("AHello World")

      // Undo to get back to original
      editor.undo()
      expect(editor.plainText).toBe("Hello World")

      // Make a selection
      currentMockInput.pressArrow("right", { shift: true })
      expect(editor.hasSelection()).toBe(true)

      // Undo should clear selection (even though there's nothing to undo now)
      editor.undo()
      expect(editor.hasSelection()).toBe(false)
    })
  })
})
