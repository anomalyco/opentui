import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"

import type { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"

import { EmbeddedTerminalRenderable } from "../renderables/EmbeddedTerminal.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CliRenderEvents, MouseEvent, type CliRendererErrorEvent } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const setups: TestRendererSetup[] = []

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const target = await createTestRenderer({
    width: 24,
    height: 8,
    remote: true,
    clock: new ManualClock(),
  })
  setups.push(target)
  const errors: Error[] = []
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  return { ...target, errors }
}

test("native terminal does not invalidate clean or one-row retained frames", async () => {
  const target = await setup()
  const terminal = new EmbeddedTerminalRenderable(target.renderer, { width: 18, height: 4 })
  target.renderer.root.add(terminal)
  terminal.write("first\r\nsecond\r\nthird")
  await target.renderOnce()
  const first = target.captureCharFrame()
  const invalidate = spyOn(target.renderer.nativeScene.driver.renderLib, "contextEmbeddedTerminalInvalidate")
  try {
    await target.renderOnce()
    assert.equal(target.captureCharFrame(), first)
    terminal.write("\x1b[2;1HSECOND")
    await target.renderOnce()
    const changed = first.replace("second", "SECOND")
    assert.equal(target.captureCharFrame(), changed)
    assert.equal(invalidate.mock.calls.length, 0)
    assert.deepEqual(target.errors, [])
  } finally {
    invalidate.mockRestore()
  }
})

test("native terminal restores an overlay when its body replaces itself before super", async () => {
  class OnceTerminal extends EmbeddedTerminalRenderable {
    protected override renderSelf(buffer: OptimizedBuffer): void {
      this.renderSelf = super.renderSelf
      super.renderSelf(buffer)
      buffer.drawText("overlay!", 0, 0, RGBA.fromHex("#ffffff"))
    }
  }
  const target = await setup()
  const terminal = new OnceTerminal(target.renderer, { width: 18, height: 4 })
  target.renderer.root.add(terminal)
  terminal.write("original")
  await target.renderOnce()
  assert.equal(terminal.screen().text, "overlay!")
  await target.renderOnce()
  assert.equal(target.captureCharFrame().trim(), "original")
  assert.deepEqual(target.errors, [])
})

test("native terminal restores an overlay after hiding in before skips composition", async () => {
  const target = await setup()
  const terminal = new EmbeddedTerminalRenderable(target.renderer, { width: 18, height: 4 })
  target.renderer.root.add(terminal)
  terminal.write("original")
  await target.renderOnce()
  const original = target.captureCharFrame()
  terminal.renderBefore = (buffer) => {
    buffer.drawText("overlay!", 0, 0, RGBA.fromHex("#ffffff"))
    terminal.renderBefore = undefined
    terminal.visible = false
  }
  await target.renderOnce()
  assert.equal(terminal.screen().text, "overlay!")
  terminal.visible = true
  await target.renderOnce()
  assert.equal(target.captureCharFrame(), original)
  assert.deepEqual(target.errors, [])
})

test("native terminal restores overlays installed during resize", async () => {
  const target = await setup()
  const terminal = new EmbeddedTerminalRenderable(target.renderer, { width: 18, height: 4 })
  target.renderer.root.add(terminal)
  terminal.write("original")
  await target.renderOnce()
  terminal.onTerminalResize = () => {
    terminal.renderAfter = (buffer) => buffer.drawText("overlay", 0, 0, RGBA.fromHex("#ffffff"))
  }
  terminal.width = 17
  await target.renderOnce()
  assert.ok(terminal.screen().text.startsWith("overlay"))
  terminal.onTerminalResize = undefined
  terminal.visible = false
  terminal.renderAfter = undefined
  await target.renderOnce()
  terminal.visible = true
  await target.renderOnce()
  assert.equal(terminal.screen().text, "original")
  const sibling = new BoxRenderable(target.renderer, { width: 1, height: 1 })
  sibling["onUpdate"] = () => {
    terminal.renderBefore = (buffer) => {
      buffer.drawText("before", 0, 0, RGBA.fromHex("#ffffff"))
      terminal.renderBefore = undefined
    }
  }
  target.renderer.root.add(sibling)
  await target.renderOnce()
  assert.equal(terminal.screen().text, "original")
  assert.deepEqual(target.errors, [])
})

test("native terminal mouse focus may destroy its controller", async () => {
  const target = await setup()
  const output: string[] = []
  const terminal = new EmbeddedTerminalRenderable(target.renderer, {
    width: 18,
    height: 4,
    onData(bytes) {
      const data = new TextDecoder().decode(bytes)
      output.push(data)
      if (data === "\x1b[I") terminal.destroy()
    },
  })
  target.renderer.root.add(terminal)
  terminal.write("\x1b[?1004h\x1b[?1000h\x1b[?1006h")
  await target.renderOnce()
  assert.doesNotThrow(() =>
    terminal.processMouseEvent(
      new MouseEvent(terminal, {
        type: "down",
        button: 0,
        x: 1,
        y: 1,
        modifiers: { shift: false, alt: false, ctrl: false },
      }),
    ),
  )
  assert.equal(terminal.isDestroyed, true)
  assert.equal(terminal.focused, false)
  assert.deepEqual(output, ["\x1b[I", "\x1b[O"])
  await target.renderOnce()
  assert.deepEqual(target.errors, [])
})
