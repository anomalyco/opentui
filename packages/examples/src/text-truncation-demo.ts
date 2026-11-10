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
  cyan,
  yellow,
  magenta,
  type Selection,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let renderer: CliRenderer | null = null
let mainContainer: BoxRenderable | null = null
let header: BoxRenderable | null = null
let headerText: TextRenderable | null = null
let leftColumn: BoxRenderable | null = null
let rightColumn: BoxRenderable | null = null
let footer: BoxRenderable | null = null
let footerText: TextRenderable | null = null
let selectionBox: BoxRenderable | null = null
let selectionStatusText: TextRenderable | null = null
let selectionStartText: TextRenderable | null = null
let selectionMiddleText: TextRenderable | null = null
let selectionEndText: TextRenderable | null = null

// Text elements to demonstrate truncation
let singleLineText1: TextRenderable | null = null
let singleLineText2: TextRenderable | null = null
let singleLineText3: TextRenderable | null = null
let multilineText1: TextRenderable | null = null
let multilineText2: TextRenderable | null = null
let styledText: TextRenderable | null = null

let truncateEnabled = false
let wrapMode: "none" | "char" | "word" = "none"

const allTextElements: TextRenderable[] = []

function createLayout(rendererInstance: CliRenderer): void {
  renderer = rendererInstance
  renderer.setBackgroundColor("#0d1117")

  // Main container
  mainContainer = new BoxRenderable(renderer, {
    id: "mainContainer",
    width: "auto",
    height: "auto",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: "#0d1117",
  })
  renderer.root.add(mainContainer)

  // Header
  header = new BoxRenderable(renderer, {
    id: "header",
    width: "auto",
    height: 3,
    backgroundColor: "#161b22",
    borderStyle: "single",
    borderColor: "#30363d",
    alignItems: "center",
    justifyContent: "center",
    border: true,
  })
  mainContainer.add(header)

  headerText = new TextRenderable(renderer, {
    id: "headerText",
    content: "Text Truncation Demo - Press 'T' to toggle truncation",
    fg: "#58a6ff",
  })
  header.add(headerText)

  // Content area with two columns
  const contentArea = new BoxRenderable(renderer, {
    id: "contentArea",
    width: "auto",
    height: "auto",
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
    padding: 1,
  })
  mainContainer.add(contentArea)

  // Left column
  leftColumn = new BoxRenderable(renderer, {
    id: "leftColumn",
    width: "auto",
    height: "auto",
    flexGrow: 1,
    flexDirection: "column",
    gap: 1,
  })
  contentArea.add(leftColumn)

  // Single line text boxes
  const singleLineBox1 = new BoxRenderable(renderer, {
    id: "singleLineBox1",
    width: "auto",
    height: "auto",
    minHeight: 5,
    backgroundColor: "#161b22",
    borderStyle: "rounded",
    borderColor: "#58a6ff",
    title: "Single Line Text 1",
    padding: 1,
    border: true,
  })
  leftColumn.add(singleLineBox1)

  singleLineText1 = new TextRenderable(renderer, {
    id: "singleLineText1",
    content:
      "This is a very long single line of text that will definitely exceed the width of most terminal windows and should be truncated when truncation is enabled",
    fg: "#c9d1d9",
    wrapMode: wrapMode,
  })
  singleLineBox1.add(singleLineText1)
  allTextElements.push(singleLineText1)

  const singleLineBox2 = new BoxRenderable(renderer, {
    id: "singleLineBox2",
    width: "auto",
    height: "auto",
    minHeight: 5,
    backgroundColor: "#161b22",
    borderStyle: "rounded",
    borderColor: "#3fb950",
    title: "Single Line Text 2",
    padding: 1,
    border: true,
  })
  leftColumn.add(singleLineBox2)

  singleLineText2 = new TextRenderable(renderer, {
    id: "singleLineText2",
    content: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz",
    fg: "#3fb950",
    wrapMode: wrapMode,
  })
  singleLineBox2.add(singleLineText2)
  allTextElements.push(singleLineText2)

  const singleLineBox3 = new BoxRenderable(renderer, {
    id: "singleLineBox3",
    width: "auto",
    height: "auto",
    minHeight: 7,
    backgroundColor: "#161b22",
    borderStyle: "rounded",
    borderColor: "#d29922",
    title: "Single Line Text 3 (Unicode)",
    padding: 1,
    border: true,
  })
  leftColumn.add(singleLineBox3)

  singleLineText3 = new TextRenderable(renderer, {
    id: "singleLineText3",
    content: "🌟 Unicode test: こんにちは世界 Hello World 你好世界 안녕하세요 🚀 More emoji: 🎨🎭🎪🎬🎮🎯",
    fg: "#d29922",
    wrapMode: wrapMode,
  })
  singleLineBox3.add(singleLineText3)
  allTextElements.push(singleLineText3)

  // Right column
  rightColumn = new BoxRenderable(renderer, {
    id: "rightColumn",
    width: "auto",
    height: "auto",
    flexGrow: 1,
    flexDirection: "column",
    gap: 1,
  })
  contentArea.add(rightColumn)

  // Multiline text boxes
  const multilineBox1 = new BoxRenderable(renderer, {
    id: "multilineBox1",
    width: "auto",
    height: "auto",
    flexGrow: 1,
    backgroundColor: "#161b22",
    borderStyle: "rounded",
    borderColor: "#f778ba",
    title: "Multiline Text (Word Wrap)",
    padding: 1,
    border: true,
  })
  rightColumn.add(multilineBox1)

  multilineText1 = new TextRenderable(renderer, {
    id: "multilineText1",
    content: `This is a multiline text block that demonstrates how truncation works with word wrapping enabled. Each line that exceeds the viewport width will be truncated independently. Try resizing the terminal to see how it behaves!`,
    fg: "#f778ba",
    wrapMode: wrapMode,
  })
  multilineBox1.add(multilineText1)
  allTextElements.push(multilineText1)

  const multilineBox2 = new BoxRenderable(renderer, {
    id: "multilineBox2",
    width: "auto",
    height: "auto",
    flexGrow: 1,
    backgroundColor: "#161b22",
    borderStyle: "rounded",
    borderColor: "#bc8cff",
    title: "Multiline Text",
    padding: 1,
    border: true,
  })
  rightColumn.add(multilineBox2)

  multilineText2 = new TextRenderable(renderer, {
    id: "multilineText2",
    content: `Line 1: This is a long line without wrapping
Line 2: Another very long line that will be truncated when enabled
Line 3: Short line
Line 4: Yet another extremely long line with lots of text to demonstrate middle truncation behavior`,
    fg: "#bc8cff",
    wrapMode: wrapMode,
  })
  multilineBox2.add(multilineText2)
  allTextElements.push(multilineText2)

  const styledBox = new BoxRenderable(renderer, {
    id: "styledBox",
    width: "auto",
    height: "auto",
    flexGrow: 1,
    backgroundColor: "#161b22",
    borderStyle: "rounded",
    borderColor: "#ff7b72",
    title: "Styled Text with Truncation",
    padding: 1,
    border: true,
  })
  rightColumn.add(styledBox)

  styledText = new TextRenderable(renderer, {
    id: "styledText",
    content: t`${bold(cyan("Bold Cyan:"))} ${yellow("Yellow text")} ${magenta("and magenta")} ${green("with green parts")} and more styled text that goes on and on`,
    fg: "#c9d1d9",
    wrapMode: wrapMode,
  })
  styledBox.add(styledText)
  allTextElements.push(styledText)

  // Footer
  footer = new BoxRenderable(renderer, {
    id: "footer",
    width: "auto",
    height: 3,
    backgroundColor: "#161b22",
    borderStyle: "single",
    borderColor: "#30363d",
    alignItems: "center",
    justifyContent: "center",
    border: true,
  })
  mainContainer.add(footer)

  footerText = new TextRenderable(renderer, {
    id: "footerText",
    content: "",
    fg: "#8b949e",
  })
  footer.add(footerText)

  selectionBox = new BoxRenderable(renderer, {
    id: "selectionBox",
    width: "auto",
    height: 7,
    backgroundColor: "#0d1117",
    borderStyle: "single",
    borderColor: "#30363d",
    title: "Selection",
    titleAlignment: "left",
    flexDirection: "column",
    gap: 1,
    padding: 1,
    border: true,
  })
  mainContainer.add(selectionBox)

  selectionStatusText = new TextRenderable(renderer, {
    id: "selectionStatusText",
    content: "Select text to see details here",
    fg: "#8b949e",
  })
  selectionBox.add(selectionStatusText)

  selectionStartText = new TextRenderable(renderer, {
    id: "selectionStartText",
    content: "",
    fg: "#7dd3fc",
  })
  selectionBox.add(selectionStartText)

  selectionMiddleText = new TextRenderable(renderer, {
    id: "selectionMiddleText",
    content: "",
    fg: "#94a3b8",
  })
  selectionBox.add(selectionMiddleText)

  selectionEndText = new TextRenderable(renderer, {
    id: "selectionEndText",
    content: "",
    fg: "#7dd3fc",
  })
  selectionBox.add(selectionEndText)

  const selectionHandler = (selection: Selection | null) => {
    if (!selectionStatusText || !selectionStartText || !selectionMiddleText || !selectionEndText) return

    const selectedText = selection?.getSelectedText()
    if (selectedText) {
      const lines = selectedText.split("\n")
      const totalLength = selectedText.length

      if (lines.length > 1) {
        selectionStatusText.content = `Selected ${lines.length} lines (${totalLength} chars):`
        selectionStartText.content = lines[0]
        selectionMiddleText.content = "..."
        selectionEndText.content = lines[lines.length - 1]
      } else if (selectedText.length > 60) {
        selectionStatusText.content = `Selected ${totalLength} chars:`
        selectionStartText.content = selectedText.substring(0, 30)
        selectionMiddleText.content = "..."
        selectionEndText.content = selectedText.substring(selectedText.length - 30)
      } else {
        selectionStatusText.content = `Selected ${totalLength} chars:`
        selectionStartText.content = `"${selectedText}"`
        selectionMiddleText.content = ""
        selectionEndText.content = ""
      }
    } else {
      selectionStatusText.content = "Empty selection"
      selectionStartText.content = ""
      selectionMiddleText.content = ""
      selectionEndText.content = ""
    }
  }
  renderer.on("selection", selectionHandler)
  mainContainer.once("destroyed", () => rendererInstance.off("selection", selectionHandler))

  updateFooterText()
}

function updateFooterText(): void {
  if (!footerText) return

  const truncateStatus = truncateEnabled ? "ENABLED" : "DISABLED"
  const truncateColor = truncateEnabled ? green : yellow
  const wrapColor = wrapMode === "none" ? yellow : cyan
  footerText.content = t`Truncate: ${truncateColor(bold(truncateStatus))} | Wrap: ${wrapColor(bold(wrapMode.toUpperCase()))} | ${cyan("T")}: toggle truncate | ${cyan("W")}: cycle wrap | ${cyan("R")}: resize | ${cyan("C")}: clear selection | ${cyan("Ctrl+C")}: exit`
}

function toggleTruncation(): void {
  truncateEnabled = !truncateEnabled

  for (const text of allTextElements) {
    text.truncate = truncateEnabled
  }

  updateFooterText()
}

function cycleWrapMode(): void {
  if (wrapMode === "none") {
    wrapMode = "char"
  } else if (wrapMode === "char") {
    wrapMode = "word"
  } else {
    wrapMode = "none"
  }

  for (const text of allTextElements) {
    text.wrapMode = wrapMode
  }

  updateFooterText()
}

function toggleColumnSizes(): void {
  if (!leftColumn || !rightColumn) return

  // Swap flex-grow values to change relative sizes
  const leftGrow = leftColumn.flexGrow
  const rightGrow = rightColumn.flexGrow

  if (leftGrow === 1 && rightGrow === 1) {
    // Make left column larger
    leftColumn.flexGrow = 2
    rightColumn.flexGrow = 1
  } else if (leftGrow === 2 && rightGrow === 1) {
    // Make right column larger
    leftColumn.flexGrow = 1
    rightColumn.flexGrow = 2
  } else {
    // Reset to equal
    leftColumn.flexGrow = 1
    rightColumn.flexGrow = 1
  }
}

function handleKeyPress(event: any): void {
  const key = event.sequence.toLowerCase()

  switch (key) {
    case "t":
      toggleTruncation()
      break
    case "w":
      cycleWrapMode()
      break
    case "r":
      toggleColumnSizes()
      break
    case "c":
      renderer?.clearSelection()
      if (selectionStatusText && selectionStartText && selectionMiddleText && selectionEndText) {
        selectionStatusText.content = "Selection cleared"
        selectionStartText.content = ""
        selectionMiddleText.content = ""
        selectionEndText.content = ""
      }
      break
  }
}

export function run(rendererInstance: CliRenderer): void {
  createLayout(rendererInstance)
  rendererInstance.keyInput.on("keypress", handleKeyPress)
}

export function destroy(rendererInstance: CliRenderer): void {
  rendererInstance.keyInput.off("keypress", handleKeyPress)

  mainContainer?.destroyRecursively()

  renderer = null
  mainContainer = null
  header = null
  headerText = null
  leftColumn = null
  rightColumn = null
  footer = null
  footerText = null
  selectionBox = null
  selectionStatusText = null
  selectionStartText = null
  selectionMiddleText = null
  selectionEndText = null
  singleLineText1 = null
  singleLineText2 = null
  singleLineText3 = null
  multilineText1 = null
  multilineText2 = null
  styledText = null
  allTextElements.length = 0
  truncateEnabled = false
  wrapMode = "none"
  rendererInstance.clearSelection()
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    targetFps: 30,
    exitOnCtrlC: true,
  })
  renderer.once(CliRenderEvents.DESTROY, () => destroy(renderer))
  run(renderer)
  setupCommonDemoKeys(renderer)
  renderer.start()
}
