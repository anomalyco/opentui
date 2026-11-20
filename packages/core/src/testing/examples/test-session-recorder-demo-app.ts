import { CliRenderEvents, createCliRenderer, type CliRenderer } from "../../renderer.js"
import { TextRenderable } from "../../renderables/Text.js"
import type { KeyEvent } from "../../lib/KeyHandler.js"

export interface TestSessionRecorderDemoApp {
  text: TextRenderable
  getValue: () => string
  destroy: () => void
}

export function mountTestSessionRecorderDemoApp(renderer: CliRenderer): TestSessionRecorderDemoApp {
  let value = ""
  let submissions = 0

  const text = new TextRenderable(renderer, {
    id: "test-session-recorder-demo",
    left: 0,
    top: 0,
    width: "100%",
    height: 6,
    content: "",
  })

  function update(): void {
    text.content = [
      "Test session recorder demo",
      `Value: ${value || "(empty)"}`,
      `Submitted: ${submissions}`,
      `Size: ${renderer.width}x${renderer.height}`,
      "Type text, Backspace deletes, Enter submits.",
      "Press Ctrl+C to exit.",
    ].join("\n")
    text.requestRender()
  }

  function onKeyPress(key: KeyEvent): void {
    if (key.name === "backspace") {
      value = value.slice(0, -1)
      update()
      return
    }

    if (key.name === "return" || key.name === "linefeed") {
      submissions++
      update()
      return
    }

    if (key.sequence.length === 1 && !key.ctrl && !key.meta) {
      value += key.sequence
      update()
    }
  }

  function onResize(): void {
    update()
  }

  renderer.root.add(text)
  renderer.keyInput.on("keypress", onKeyPress)
  renderer.on(CliRenderEvents.RESIZE, onResize)
  update()

  return {
    text,
    getValue: () => value,
    destroy: () => {
      renderer.keyInput.off("keypress", onKeyPress)
      renderer.off(CliRenderEvents.RESIZE, onResize)
      renderer.root.remove(text.id)
    },
  }
}

if (import.meta.main) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  mountTestSessionRecorderDemoApp(renderer)
  renderer.start()
}
