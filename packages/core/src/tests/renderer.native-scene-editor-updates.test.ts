import { expect, spyOn, test } from "bun:test"

import { BoxRenderable } from "../renderables/Box.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer } from "../testing/test-renderer.js"

test.each(["up", "down"] as const)(
  "native editor drag auto-scroll %s keeps its update barrier only while active",
  async (direction) => {
    const clock = new ManualClock()
    const { renderer, renderOnce, mockMouse, captureCharFrame } = await createTestRenderer({
      width: 12,
      height: 5,
      clock,
    })
    const editor = new TextareaRenderable(renderer, {
      width: 12,
      height: 5,
      initialValue: Array.from({ length: 30 }, (_, index) => `Line ${index}`).join("\n"),
      scrollSpeed: 10,
    })
    renderer.root.add(editor)
    editor.focus()
    editor.gotoLine(direction === "up" ? 15 : 0)
    await renderOnce()
    const edge = direction === "up" ? 0 : 4
    await mockMouse.pressDown(2, 2)
    await mockMouse.moveTo(2, edge)
    const initialOffset = editor.scrollY
    const initialSelection = editor.getSelectedText()
    const now = spyOn(clock, "now").mockImplementation(() => 0)
    const steps = spyOn(renderer.nativeScene.driver.renderLib, "sceneFrameStep")
    const hooks = spyOn(editor, "_runNativeSceneHook")
    try {
      for (let frame = 0; frame < 2; frame++) {
        steps.mockClear()
        hooks.mockClear()
        now.mockImplementation(() => (frame + 1) * 100)
        await renderOnce()
        expect(hooks.mock.calls.map(([request]) => request.kind)).toEqual([1])
        expect(steps).toHaveBeenCalledTimes(2)
        expect(editor.scrollY).toBe(initialOffset + (direction === "up" ? -1 : 1) * (frame + 1))
      }
      expect(editor.getSelectedText().length).toBeGreaterThan(initialSelection.length)
      expect(captureCharFrame().split("\n")[0].trimEnd()).toBe(`Line ${editor.scrollY}`)

      await mockMouse.moveTo(2, 2)
      const stoppedOffset = editor.scrollY
      steps.mockClear()
      hooks.mockClear()
      now.mockImplementation(() => 300)
      await renderOnce()
      expect(editor.scrollY).toBe(stoppedOffset)
      expect(hooks).not.toHaveBeenCalled()
      expect(steps).toHaveBeenCalledTimes(1)

      await mockMouse.moveTo(2, edge)
      now.mockImplementation(() => 400)
      await renderOnce()
      expect(editor.scrollY).not.toBe(stoppedOffset)

      await mockMouse.release(2, edge)
      const releasedOffset = editor.scrollY
      steps.mockClear()
      hooks.mockClear()
      now.mockImplementation(() => 500)
      await renderOnce()
      expect(editor.scrollY).toBe(releasedOffset)
      expect(hooks).not.toHaveBeenCalled()
      expect(steps).toHaveBeenCalledTimes(1)
    } finally {
      now.mockRestore()
      hooks.mockRestore()
      steps.mockRestore()
      renderer.destroy()
      await renderer.closed
    }
  },
)

test("native editor subclass updates retain order, replacement, and cancellation across drag activity", async () => {
  const clock = new ManualClock()
  const { renderer, renderOnce, mockMouse, captureCharFrame } = await createTestRenderer({
    width: 12,
    height: 4,
    clock,
  })
  const calls: string[] = []
  const failure = new Error("editor update failed")
  const errors: Error[] = []
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  class Editor extends TextareaRenderable {
    protected override onUpdate(deltaTime: number): void {
      calls.push(`editor:${deltaTime}`)
      super.onUpdate(deltaTime)
    }
  }
  const parent = new BoxRenderable(renderer, { width: 12, height: 4 })
  Object.assign(parent, { onUpdate: () => calls.push("parent") })
  const editor = new Editor(renderer, { width: 12, height: 4, initialValue: "hello\neditor\nlines\nscroll\nmore" })
  parent.add(editor)
  renderer.root.add(parent)
  const steps = spyOn(renderer.nativeScene.driver.renderLib, "sceneFrameStep")
  const hooks = spyOn(editor, "_runNativeSceneHook")
  try {
    for (const phase of ["idle", "idle", "drag", "release"]) {
      if (phase === "drag") {
        await mockMouse.pressDown(2, 1)
        await mockMouse.moveTo(2, 3)
      } else if (phase === "release") {
        await mockMouse.release(2, 3)
      }
      calls.length = 0
      hooks.mockClear()
      steps.mockClear()
      await renderOnce()
      expect(calls).toEqual(["parent", "editor:0"])
      expect(hooks.mock.calls.map(([request]) => request.kind)).toEqual([1])
      expect(steps).toHaveBeenCalledTimes(3)
    }
    Object.assign(editor, {
      onUpdate() {
        calls.push("replacement")
        throw failure
      },
    })
    calls.length = 0
    const before = captureCharFrame()
    await renderOnce()
    expect(calls).toEqual(["parent", "replacement"])
    expect(errors).toEqual([failure])
    expect(captureCharFrame()).toBe(before)
    Object.assign(editor, { onUpdate: Editor.prototype["onUpdate"] })
    calls.length = 0
    await renderOnce()
    expect(calls).toEqual(["parent", "editor:0"])
    expect(captureCharFrame()).toBe(before)
  } finally {
    hooks.mockRestore()
    steps.mockRestore()
    renderer.destroy()
    await renderer.closed
  }
})
