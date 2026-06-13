import { CliRenderer, createCliRenderer, TextRenderable, BoxRenderable, type KeyEvent } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import { parseColor } from "@opentui/core"
import { hastToStyledText, type HASTElement } from "@opentui/core"
import { SyntaxStyle } from "@opentui/core"
import exampleHAST from "./assets/hast-example.json" with { type: "json" }

const typedExampleHAST = exampleHAST as HASTElement

let renderer: CliRenderer | null = null
let keyboardHandler: ((key: KeyEvent) => void) | null = null
let parentContainer: BoxRenderable | null = null

export function run(rendererInstance: CliRenderer): void {
  renderer = rendererInstance
  renderer.start()
  renderer.setBackgroundColor("#0D1117")

  parentContainer = new BoxRenderable(renderer, {
    id: "parent-container",
    zIndex: 10,
    padding: 1,
  })
  renderer.root.add(parentContainer)

  const titleBox = new BoxRenderable(renderer, {
    id: "title-box",
    height: 3,
    borderStyle: "double",
    borderColor: "#4ECDC4",
    backgroundColor: "#0D1117",
    title: "HAST to Styled Text Demo",
    titleAlignment: "center",
    border: true,
  })
  parentContainer.add(titleBox)

  const instructionsText = new TextRenderable(renderer, {
    id: "instructions",
    content: "ESC to return | R to re-transform | Demonstrating HAST tree conversion to syntax-highlighted text",
    fg: "#888888",
  })
  titleBox.add(instructionsText)

  const codeBox = new BoxRenderable(renderer, {
    id: "code-box",
    borderStyle: "single",
    borderColor: "#6BCF7F",
    backgroundColor: "#0D1117",
    title: "TypeScript Code",
    titleAlignment: "left",
    paddingLeft: 1,
    border: true,
  })
  parentContainer.add(codeBox)

  const syntaxStyle = SyntaxStyle.fromStyles({
    keyword: { fg: parseColor("#FF6B9D"), bold: true },
    string: { fg: parseColor("#A8E6CF") },
    comment: { fg: parseColor("#888888"), italic: true },
    number: { fg: parseColor("#FFD93D") },
    function: { fg: parseColor("#6BCF7F") },
    type: { fg: parseColor("#4ECDC4") },
    operator: { fg: parseColor("#FF8C94") },
    variable: { fg: parseColor("#C7CEEA") },
    bracket: { fg: parseColor("#FFFFFF") },
    punctuation: { fg: parseColor("#DDDDDD") },
    default: { fg: parseColor("#FFFFFF") },
  })
  const transformStart = performance.now()
  const styledText = hastToStyledText(typedExampleHAST, syntaxStyle)
  const transformEnd = performance.now()
  const transformTime = (transformEnd - transformStart).toFixed(2)

  const codeDisplay = new TextRenderable(renderer, {
    id: "code-display",
    content: styledText,
    bg: "#0D1117",
    selectable: true,
    selectionBg: "#264F78",
    selectionFg: "#FFFFFF",
  })
  codeBox.add(codeDisplay)

  const timingText = new TextRenderable(renderer, {
    id: "timing-display",
    content: `HAST transformation time: ${transformTime}ms (Cache: ${syntaxStyle.getCacheSize()} entries) (Press 'R' to re-transform)`,
    fg: "#A8E6CF",
  })
  parentContainer.add(timingText)

  keyboardHandler = (key: KeyEvent) => {
    if (key.name === "r" || key.name === "R") {
      syntaxStyle.clearCache()

      const retransformStart = performance.now()
      const newStyledText = hastToStyledText(typedExampleHAST, syntaxStyle)
      const retransformEnd = performance.now()
      const newTransformTime = (retransformEnd - retransformStart).toFixed(2)

      codeDisplay.content = newStyledText
      timingText.content = `HAST transformation time: ${newTransformTime}ms (Cache: ${syntaxStyle.getCacheSize()} entries) (Press 'R' to re-transform)`

      console.log(`Style cache entries: ${syntaxStyle.getCacheSize()}`)
    }
  }

  rendererInstance.keyInput.on("keypress", keyboardHandler)
}

export function destroy(rendererInstance: CliRenderer): void {
  if (keyboardHandler) {
    rendererInstance.keyInput.off("keypress", keyboardHandler)
    keyboardHandler = null
  }

  parentContainer?.destroy()
  parentContainer = null

  renderer = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
  })
  run(renderer)
  setupCommonDemoKeys(renderer)
}
