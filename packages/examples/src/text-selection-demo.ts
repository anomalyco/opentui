#!/usr/bin/env bun

import {
  CliRenderer,
  CliRenderEvents,
  createCliRenderer,
  TextRenderable,
  BoxRenderable,
  t,
  green,
  bold,
  italic,
  yellow,
  cyan,
  magenta,
  type KeyEvent,
  type Selection,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let mainContainer: BoxRenderable | null = null
let floatingBox: BoxRenderable | null = null
let leftGroup: BoxRenderable | null = null
let rightGroup: BoxRenderable | null = null
let statusBox: BoxRenderable | null = null
let statusText: TextRenderable | null = null
let selectionStartText: TextRenderable | null = null
let selectionMiddleText: TextRenderable | null = null
let selectionEndText: TextRenderable | null = null
let debugText: TextRenderable | null = null
let allTextRenderables: (TextRenderable | TextRenderable)[] = []

export function run(renderer: CliRenderer): void {
  renderer.setBackgroundColor("#0d1117")

  mainContainer = new BoxRenderable(renderer, {
    id: "mainContainer",
    position: "absolute",
    left: 1,
    top: 1,
    width: 88,
    height: 22,
    backgroundColor: "#161b22",
    zIndex: 1,
    borderColor: "#50565d",
    title: "Text Selection Demo",
    titleAlignment: "center",
    border: true,
  })
  renderer.root.add(mainContainer)

  leftGroup = new BoxRenderable(renderer, {
    id: "leftGroup",
    position: "absolute",
    left: 2,
    top: 2,
    zIndex: 10,
  })
  mainContainer.add(leftGroup)

  const box1 = new BoxRenderable(renderer, {
    id: "box1",
    width: 45,
    height: 7,
    backgroundColor: "#1e2936",
    zIndex: 20,
    borderColor: "#58a6ff",
    title: "Document Section 1",
    flexDirection: "column",
    padding: 1,
    border: true,
  })
  leftGroup.add(box1)

  const text1 = new TextRenderable(renderer, {
    id: "text1",
    content: "This is a paragraph in the first box.",
    zIndex: 21,
    fg: "#f0f6fc",
  })
  box1.add(text1)
  allTextRenderables.push(text1)

  const text2 = new TextRenderable(renderer, {
    id: "text2",
    content: "It contains multiple lines of text",
    zIndex: 21,
    fg: "#f0f6fc",
  })
  box1.add(text2)
  allTextRenderables.push(text2)

  const text3 = new TextRenderable(renderer, {
    id: "text3",
    content: "that can be selected independently.",
    zIndex: 21,
    fg: "#f0f6fc",
  })
  box1.add(text3)
  allTextRenderables.push(text3)

  const text4 = new TextRenderable(renderer, {
    id: "text4",
    content: "世界, 你好世界, 中文, 한글",
    zIndex: 21,
    fg: "#f0f6fc",
  })
  box1.add(text4)
  allTextRenderables.push(text4)

  const nestedBox = new BoxRenderable(renderer, {
    id: "nestedBox",
    left: 2,
    top: 1,
    width: 31,
    height: 4,
    backgroundColor: "#2d1b69",
    zIndex: 25,
    borderColor: "#a371f7",
    borderStyle: "double",
    border: true,
  })
  leftGroup.add(nestedBox)

  const nestedText = new TextRenderable(renderer, {
    id: "nestedText",
    content: t`${yellow("Important:")} ${bold(cyan("Nested content"))} ${italic(green("with styles"))}`,
    width: 27,
    height: 1,
    zIndex: 26,
    selectionBg: "#4a5568",
    selectionFg: "#ffffff",
  })
  nestedBox.add(nestedText)
  allTextRenderables.push(nestedText)

  rightGroup = new BoxRenderable(renderer, {
    id: "rightGroup",
    position: "absolute",
    left: 48,
    top: 2,
    zIndex: 10,
  })
  mainContainer.add(rightGroup)

  const box2 = new BoxRenderable(renderer, {
    id: "box2",
    left: 2,
    top: 0,
    width: 35,
    height: 12,
    backgroundColor: "#1c2128",
    zIndex: 20,
    borderColor: "#f85149",
    title: "Code Example",
    borderStyle: "rounded",
    flexDirection: "column",
    padding: 1,
    border: true,
  })
  rightGroup.add(box2)

  const codeText1 = new TextRenderable(renderer, {
    id: "codeText1",
    content: t`${magenta("function")} ${cyan("handleSelection")}() {`,
    zIndex: 21,
    selectionBg: "#4a5568",
  })
  box2.add(codeText1)
  allTextRenderables.push(codeText1)

  const codeText2 = new TextRenderable(renderer, {
    id: "codeText2",
    content: t`  ${magenta("const")} selected = ${cyan("getSelectedText")}()`,
    zIndex: 21,
    selectionBg: "#4a5568",
  })
  box2.add(codeText2)
  allTextRenderables.push(codeText2)

  const codeText3 = new TextRenderable(renderer, {
    id: "codeText3",
    content: t`  ${yellow("console")}.${green("log")}(selected)`,
    zIndex: 21,
    selectionBg: "#4a5568",
  })
  box2.add(codeText3)
  allTextRenderables.push(codeText3)

  const codeText4 = new TextRenderable(renderer, {
    id: "codeText4",
    content: "}",
    zIndex: 21,
    fg: "#e6edf3",
  })
  box2.add(codeText4)
  allTextRenderables.push(codeText4)

  floatingBox = new BoxRenderable(renderer, {
    id: "floatingBox",
    position: "absolute",
    left: 90,
    top: 11,
    width: 31,
    height: 6,
    backgroundColor: "#1b2f23",
    zIndex: 30,
    borderColor: "#2ea043",
    title: "README",
    borderStyle: "single",
    border: true,
  })
  renderer.root.add(floatingBox)

  const multilineText = new TextRenderable(renderer, {
    id: "multilineText",
    content: t`${bold(cyan("Selection Demo"))}
${green("✓")} Cross-renderable selection
${green("✓")} Nested groups and boxes
${green("✓")} Styled text support`,
    zIndex: 31,
    selectionBg: "#4a5568",
    selectionFg: "#ffffff",
  })
  floatingBox.add(multilineText)
  allTextRenderables.push(multilineText)

  const instructions = new TextRenderable(renderer, {
    id: "instructions",
    content: "Click and drag to select text across any elements. Press 'C' to clear selection.",
    left: 2,
    top: 17,
    zIndex: 2,
    fg: "#f0f6fc",
  })
  mainContainer.add(instructions)
  allTextRenderables.push(instructions)

  statusBox = new BoxRenderable(renderer, {
    id: "statusBox",
    position: "absolute",
    left: 1,
    top: 24,
    width: 88,
    height: 9,
    backgroundColor: "#0d1117",
    zIndex: 1,
    borderColor: "#50565d",
    title: "Selection Status",
    titleAlignment: "left",
    padding: 1,
    border: true,
  })
  renderer.root.add(statusBox)

  statusText = new TextRenderable(renderer, {
    id: "statusText",
    content: "No selection - try selecting across different nested elements",
    zIndex: 2,
    fg: "#f0f6fc",
  })
  statusBox.add(statusText)

  selectionStartText = new TextRenderable(renderer, {
    id: "selectionStartText",
    content: "",
    zIndex: 2,
    fg: "#7dd3fc",
  })
  statusBox.add(selectionStartText)

  selectionMiddleText = new TextRenderable(renderer, {
    id: "selectionMiddleText",
    content: "",
    zIndex: 2,
    fg: "#94a3b8",
  })
  statusBox.add(selectionMiddleText)

  selectionEndText = new TextRenderable(renderer, {
    id: "selectionEndText",
    content: "",
    zIndex: 2,
    fg: "#7dd3fc",
  })
  statusBox.add(selectionEndText)

  debugText = new TextRenderable(renderer, {
    id: "debugText",
    content: "",
    zIndex: 2,
    fg: "#e6edf3",
  })
  statusBox.add(debugText)

  // Listen for selection events
  const selectionHandler = (selection: Selection | null) => {
    if (selection && statusText && debugText && selectionStartText && selectionMiddleText && selectionEndText) {
      const selectedText = selection.getSelectedText()

      // Count how many renderables have selection
      const selectedCount = allTextRenderables.filter((r) => r.hasSelection()).length
      const container = renderer.getSelectionContainer()
      const containerInfo = container ? `Container: ${container.id}` : "Container: none"
      debugText.content = `Selected renderables: ${selectedCount}/${allTextRenderables.length} | ${containerInfo}`

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
  allTextRenderables = []

  mainContainer?.destroyRecursively()
  statusBox?.destroyRecursively()
  floatingBox?.destroyRecursively()

  mainContainer = null
  leftGroup = null
  rightGroup = null
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
  renderer.once(CliRenderEvents.DESTROY, () => destroy(renderer))
  run(renderer)
  setupCommonDemoKeys(renderer)
  renderer.start()
}
