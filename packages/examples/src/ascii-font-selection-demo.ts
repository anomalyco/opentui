#!/usr/bin/env bun

import { CliRenderer, createCliRenderer, BoxRenderable, TextRenderable, RGBA } from "@opentui/core"
import { ASCIIFontRenderable, type KeyEvent, type Selection } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let mainContainer: BoxRenderable | null = null
let fontGroup: BoxRenderable | null = null
let statusBox: BoxRenderable | null = null
let statusText: TextRenderable | null = null
let selectionStartText: TextRenderable | null = null
let selectionMiddleText: TextRenderable | null = null
let selectionEndText: TextRenderable | null = null
let debugText: TextRenderable | null = null
let allFontRenderables: ASCIIFontRenderable[] = []

export function run(renderer: CliRenderer): void {
  renderer.setBackgroundColor("#0d1117")

  mainContainer = new BoxRenderable(renderer, {
    id: "mainContainer",
    position: "absolute",
    left: 1,
    top: 1,
    width: 95,
    height: 30,
    backgroundColor: "#161b22",
    zIndex: 1,
    borderColor: "#50565d",
    title: "ASCII Font Selection Demo",
    titleAlignment: "center",
    border: true,
  })
  renderer.root.add(mainContainer)

  fontGroup = new BoxRenderable(renderer, {
    id: "fontGroup",
    position: "absolute",
    left: 2,
    top: 2,
    zIndex: 10,
  })
  mainContainer.add(fontGroup)

  const tinyFont = new ASCIIFontRenderable(renderer, {
    id: "tinyFont",
    text: "TINY FONT DEMO",
    font: "tiny",
    color: RGBA.fromInts(255, 255, 0, 255),
    backgroundColor: RGBA.fromInts(0, 0, 40, 255),
    selectionBg: "#4a5568",
    selectionFg: "#ffffff",
    zIndex: 20,
  })
  fontGroup.add(tinyFont)
  allFontRenderables.push(tinyFont)

  const blockFont = new ASCIIFontRenderable(renderer, {
    id: "blockFont",
    text: "opentui",
    font: "block",
    color: [RGBA.fromInts(255, 100, 100, 255), RGBA.fromInts(100, 255, 100, 255)],
    backgroundColor: RGBA.fromInts(0, 0, 40, 255),
    selectionBg: "#4a5568",
    selectionFg: "#ffffff",
    zIndex: 20,
  })
  fontGroup.add(blockFont)
  allFontRenderables.push(blockFont)

  const shadeFont = new ASCIIFontRenderable(renderer, {
    id: "shadeFont",
    text: "SHADE",
    font: "shade",
    color: [RGBA.fromInts(255, 200, 100, 255), RGBA.fromInts(100, 150, 200, 255)],
    backgroundColor: RGBA.fromInts(0, 0, 40, 255),
    selectionBg: "#4a5568",
    selectionFg: "#ffffff",
    zIndex: 20,
  })
  fontGroup.add(shadeFont)
  allFontRenderables.push(shadeFont)

  const slickFont = new ASCIIFontRenderable(renderer, {
    id: "slickFont",
    text: "SLICK",
    font: "slick",
    color: [RGBA.fromInts(100, 255, 100, 255), RGBA.fromInts(255, 100, 255, 255)],
    backgroundColor: RGBA.fromInts(0, 0, 40, 255),
    selectionBg: "#4a5568",
    selectionFg: "#ffffff",
    zIndex: 20,
  })
  fontGroup.add(slickFont)
  allFontRenderables.push(slickFont)

  const instructions = new TextRenderable(renderer, {
    id: "ascii-font-instructions",
    content: "Click and drag to select text across any ASCII font elements. Press 'C' to clear selection.",
    left: 2,
    top: 26,
    zIndex: 2,
    fg: "#f0f6fc",
  })
  mainContainer.add(instructions)

  statusBox = new BoxRenderable(renderer, {
    id: "statusBox",
    position: "absolute",
    left: 1,
    top: 32,
    width: 95,
    height: 10,
    backgroundColor: "#0d1117",
    borderColor: "#50565d",
    title: "Selection Status",
    titleAlignment: "left",
    border: true,
  })
  renderer.root.add(statusBox)

  statusText = new TextRenderable(renderer, {
    id: "statusText",
    content: "No selection - try selecting across different ASCII fonts",
    fg: "#f0f6fc",
  })
  statusBox.add(statusText)

  selectionStartText = new TextRenderable(renderer, {
    id: "selectionStartText",
    content: "",
    left: 3,
    zIndex: 2,
    fg: "#7dd3fc",
  })
  statusBox.add(selectionStartText)

  selectionMiddleText = new TextRenderable(renderer, {
    id: "selectionMiddleText",
    content: "",
    left: 3,
    zIndex: 2,
    fg: "#94a3b8",
  })
  statusBox.add(selectionMiddleText)

  selectionEndText = new TextRenderable(renderer, {
    id: "selectionEndText",
    content: "",
    left: 3,
    zIndex: 2,
    fg: "#7dd3fc",
  })
  statusBox.add(selectionEndText)

  debugText = new TextRenderable(renderer, {
    id: "debugText",
    content: "",
    left: 3,
    zIndex: 2,
    fg: "#e6edf3",
  })
  statusBox.add(debugText)

  const selectionHandler = (selection: Selection | null) => {
    if (selection && statusText && debugText && selectionStartText && selectionMiddleText && selectionEndText) {
      const selectedText = selection.getSelectedText()

      const selectedCount = allFontRenderables.filter((r) => r.hasSelection()).length
      const container = renderer.getSelectionContainer()
      const containerInfo = container ? `Container: ${container.id}` : "Container: none"
      debugText.content = `Selected fonts: ${selectedCount}/${allFontRenderables.length} | ${containerInfo}`

      if (selectedText) {
        const lines = selectedText.split("\n")
        const totalLength = selectedText.length

        if (lines.length > 1) {
          statusText.content = `Selected ${lines.length} lines (${totalLength} chars):`
          selectionStartText.content = lines[0]
          selectionMiddleText.content = "..."
          selectionEndText.content = lines[lines.length - 1]
        } else if (selectedText.length > 60) {
          statusText.content = `Selected ${totalLength} chars:`
          selectionStartText.content = selectedText.substring(0, 30)
          selectionMiddleText.content = "..."
          selectionEndText.content = selectedText.substring(selectedText.length - 30)
        } else {
          statusText.content = `Selected ${totalLength} chars:`
          selectionStartText.content = `"${selectedText}"`
          selectionMiddleText.content = ""
          selectionEndText.content = ""
        }
      } else {
        statusText.content = "Empty selection"
        selectionStartText.content = ""
        selectionMiddleText.content = ""
        selectionEndText.content = ""
      }
    }
  }
  renderer.on("selection", selectionHandler)
  mainContainer.once("destroyed", () => renderer.off("selection", selectionHandler))

  const keyHandler = (event: KeyEvent) => {
    const key = event.sequence
    if (key === "c" || key === "C") {
      renderer.clearSelection()
      if (statusText && debugText && selectionStartText && selectionMiddleText && selectionEndText) {
        statusText.content = "Selection cleared"
        selectionStartText.content = ""
        selectionMiddleText.content = ""
        selectionEndText.content = ""
        debugText.content = ""
      }
    }
  }
  renderer.keyInput.on("keypress", keyHandler)
  mainContainer.once("destroyed", () => renderer.keyInput.off("keypress", keyHandler))
}

export function destroy(renderer: CliRenderer): void {
  allFontRenderables = []

  fontGroup?.destroyRecursively()
  mainContainer?.destroyRecursively()
  statusBox?.destroyRecursively()

  fontGroup = null
  mainContainer = null
  statusBox = null
  statusText = null
  selectionStartText = null
  selectionMiddleText = null
  selectionEndText = null
  debugText = null

  renderer.clearSelection()
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    targetFps: 30,
    enableMouseMovement: true,
    exitOnCtrlC: true,
  })
  run(renderer)
  setupCommonDemoKeys(renderer)
}
