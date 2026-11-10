import { type CliRenderer, TextRenderable, createCliRenderer } from "@opentui/core"

import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

const DEMO_TEXT_ID = "terminal-title-demo-text"

let text: TextRenderable | null = null
let titleTimers: ReturnType<typeof setTimeout>[] = []

function clearTitleTimers(): void {
  for (const timer of titleTimers) {
    clearTimeout(timer)
  }
  titleTimers = []
}

function resetStandaloneState(): void {
  clearTitleTimers()
  text = null
}

function setDemoTitle(renderer: CliRenderer, title: string): void {
  renderer.setTerminalTitle(title)

  if (text) {
    text.content = [`Current terminal title: ${title}`, "", "Press Escape to return to the examples menu."].join("\n")
  }

  renderer.requestRender()
}

export function run(renderer: CliRenderer): void {
  renderer.start()
  clearTitleTimers()

  text?.destroy()
  text = new TextRenderable(renderer, {
    id: DEMO_TEXT_ID,
    content: "Cycling terminal titles...",
    margin: 2,
  })
  renderer.root.add(text)

  setDemoTitle(renderer, "OpenTUI Test")
  titleTimers.push(setTimeout(() => setDemoTitle(renderer, "Terminal Title Demo"), 2000))
  titleTimers.push(setTimeout(() => setDemoTitle(renderer, "Success!"), 4000))
}

export function destroy(_renderer: CliRenderer): void {
  clearTitleTimers()
  text?.destroy()
  text = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, onDestroy: resetStandaloneState })
  setupCommonDemoKeys(renderer)
  run(renderer)
}
