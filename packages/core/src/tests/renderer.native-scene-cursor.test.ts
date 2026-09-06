import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { RGBA } from "../lib/RGBA.js"
import { CliRenderer, CliRenderEvents } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { NativeStatus } from "../zig.js"

const renderers: CliRenderer[] = []

afterEach(async () => {
  for (const renderer of renderers.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const target = await createTestRenderer({
    width: 20,
    height: 10,
    clock: new ManualClock(),
  })
  renderers.push(target.renderer)
  return target
}

test("native cursor setters run in checked paint hooks without losing callback order", async () => {
  const { renderer, renderOnce } = await setup()
  const errors: Error[] = []
  const calls: string[] = []
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  renderer.root.add(
    new BoxRenderable(renderer, {
      width: 4,
      height: 2,
      renderBefore() {
        CliRenderer.setCursorPosition(renderer, 2, 3)
        calls.push("before")
      },
      renderAfter() {
        renderer.setCursorStyle({ style: "block", blinking: true })
        calls.push("after")
      },
    }),
  )
  renderer.addPostProcessFn(() => {
    renderer.setCursorColor(RGBA.fromHex("#40c080"))
    calls.push("post")
  })
  await renderOnce()
  assert.deepEqual(errors, [])
  assert.deepEqual(calls, ["before", "after", "post"])
  const cursor = renderer.getCursorState()
  assert.deepEqual([cursor.x, cursor.y, cursor.visible, cursor.style, cursor.blinking], [2, 3, true, "block", true])
  assert.deepEqual(cursor.color, RGBA.fromHex("#40c080"))
})

test("native explicit cursor position survives editor blur and yields to the next focused paint", async () => {
  const { renderer, renderOnce } = await setup()
  const editor = new TextareaRenderable(renderer, { width: 10, height: 2, initialValue: "edit" })
  renderer.root.add(editor)
  editor.focus()
  await renderOnce()
  const focused = renderer.getCursorState()
  editor.blur()
  renderer.setCursorPosition(7, 4)
  await renderOnce()
  const manual = renderer.getCursorState()
  assert.deepEqual([manual.x, manual.y, manual.visible], [7, 4, true])
  editor.focus()
  await renderOnce()
  assert.deepEqual(renderer.getCursorState(), focused)
})

test("native cursor transport preserves integer conversion and rejected partial updates", async () => {
  const { renderer } = await setup()
  renderer.setCursorPosition(3.75, 2.5)
  const accepted = renderer.getCursorState()
  assert.deepEqual([accepted.x, accepted.y], [3, 2])
  const { renderLib, context, session } = renderer.nativeScene.driver
  assert.throws(
    () =>
      renderLib.sessionSetCursor(context, session, {
        position: { x: 65537, y: 1, visible: false },
        style: "line",
        cursor: "pointer",
      }),
    { status: NativeStatus.InvalidArgument },
  )
  assert.deepEqual(renderer.getCursorState(), accepted)
  assert.throws(() => renderer.setCursorPosition(NaN, 1), RangeError)
  assert.deepEqual(renderer.getCursorState(), accepted)
})
