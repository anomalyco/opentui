#!/usr/bin/env bun
import { BoxRenderable, type CliRenderer, createCliRenderer, CodeRenderable, addDefaultParsers } from "../src/index.js"
import { ScrollBoxRenderable } from "../src/renderables/ScrollBox.js"
import { SyntaxStyle } from "../src/syntax-style.js"
import { parseColor } from "../src/lib/RGBA.js"

const parsers = [
  {
    filetype: "json",
    wasm: "https://github.com/tree-sitter/tree-sitter-json/releases/download/v0.24.8/tree-sitter-json.wasm",
    queries: {
      highlights: [
        "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/json/highlights.scm",
      ],
    },
  },
]
addDefaultParsers(parsers)
let scrollBox: ScrollBoxRenderable | null = null
let renderer: CliRenderer | null = null
let syntaxStyle: SyntaxStyle | null = null
let eventCount = 0

function addEvent(eventType: string, event: object) {
  if (!renderer || !scrollBox || !syntaxStyle) return

  eventCount++

  const eventData = {
    type: eventType,
    timestamp: new Date().toISOString(),
    ...event,
  }

  const eventBox = new BoxRenderable(renderer, {
    id: `event-${eventCount}`,
    width: "auto",
    marginBottom: 1,
    padding: 1,
    backgroundColor: "#1f2937",
  })

  const codeDisplay = new CodeRenderable(renderer, {
    id: `event-code-${eventCount}`,
    content: JSON.stringify(eventData, null, 2),
    filetype: "json",
    conceal: false,
    syntaxStyle,
    bg: "#1f2937",
  })

  eventBox.add(codeDisplay)
  scrollBox.add(eventBox)

  const children = scrollBox.getChildren()
  if (children.length > 50) {
    const oldest = children[0]
    if (oldest) {
      scrollBox.remove(oldest)
      oldest.destroyRecursively()
    }
  }
}

async function main() {
  const usePrepend = process.argv.includes("--prepend")
  const prependInputHandlers = usePrepend
    ? [
        (sequence: string) => {
          addEvent("raw-input-before", { sequence })
          return false
        },
      ]
    : []
  renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
    useKittyKeyboard: { events: true },
    prependInputHandlers,
  })

  renderer.setBackgroundColor("#0D1117")

  const mainContainer = new BoxRenderable(renderer, {
    id: "main-container",
    flexGrow: 1,
    flexDirection: "column",
  })

  renderer.root.add(mainContainer)

  scrollBox = new ScrollBoxRenderable(renderer, {
    id: "event-scroll-box",
    stickyScroll: true,
    stickyStart: "bottom",
    border: true,
    borderColor: "#6BCF7F",
    title: `Keypress Debug${usePrepend ? " (prepend mode)" : ""} (Ctrl+C to exit)`,
    titleAlignment: "center",
    contentOptions: {
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 1,
    },
  })

  mainContainer.add(scrollBox)

  syntaxStyle = SyntaxStyle.fromStyles(
    {
      string: { fg: parseColor("#A5D6FF") },
      number: { fg: parseColor("#79C0FF") },
      boolean: { fg: parseColor("#79C0FF") },
      keyword: { fg: parseColor("#FF7B72") },
      default: { fg: parseColor("#E6EDF3") },
    },
    renderer.nativeScene,
  )

  addEvent("capabilities", renderer.capabilities)

  renderer.addInputHandler((sequence) => {
    addEvent("raw-input-after", { sequence })
    return true
  })

  renderer.keyInput.on("keypress", (event) => {
    addEvent("keypress", event)

    if (event.name === "c" && event.shift) {
      if (renderer) {
        addEvent("capabilities", renderer.capabilities)
      }
    }
  })

  renderer.keyInput.on("keyrelease", (event) => {
    addEvent("keyrelease", event)
  })

  renderer.keyInput.on("paste", (event) => {
    addEvent("paste", event)
  })

  renderer.requestRender()
}

main().catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})
