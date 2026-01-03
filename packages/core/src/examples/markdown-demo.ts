import {
  CliRenderer,
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  type ParsedKey,
  ScrollBoxRenderable,
} from "../index"
import { MarkdownRenderable } from "../renderables/Markdown"
import { setupCommonDemoKeys } from "./lib/standalone-keys"
import { parseColor } from "../lib/RGBA"
import { SyntaxStyle } from "../syntax-style"

// Rich markdown example showcasing various features
const markdownContent = `# OpenTUI Markdown Demo

Welcome to the **MarkdownRenderable** showcase! This demonstrates automatic table alignment and syntax highlighting.

## Features

- Automatic **table column alignment** based on content width
- Proper handling of \`inline code\`, **bold**, and *italic* in tables
- Multiple syntax themes to choose from
- Conceal mode hides formatting markers

## Comparison Table

| Feature | Status | Priority | Notes |
|---|---|---|---|
| Table alignment | **Done** | High | Uses \`marked\` parser |
| Conceal mode | *Working* | Medium | Hides \`**\`, \`\`\`, etc. |
| Theme switching | **Done** | Low | 3 themes available |
| Unicode support | 日本語 | High | CJK characters |

## Code Examples

Here's how to use it:

\`\`\`typescript
import { MarkdownRenderable } from "@opentui/core"

const md = new MarkdownRenderable(renderer, {
  content: "# Hello World",
  syntaxStyle: mySyntaxStyle,
  conceal: true, // Hide formatting markers
})
\`\`\`

### API Reference

| Method | Parameters | Returns | Description |
|---|---|---|---|
| \`constructor\` | \`ctx, options\` | \`MarkdownRenderable\` | Create new instance |
| \`clearCache\` | none | \`void\` | Force re-render content |

## Inline Formatting Examples

| Style | Syntax | Rendered |
|---|---|---|
| Bold | \`**text**\` | **bold text** |
| Italic | \`*text*\` | *italic text* |
| Code | \`code\` | \`inline code\` |
| Link | \`[text](url)\` | [OpenTUI](https://github.com) |

## Mixed Content

> **Note**: This blockquote contains **bold** and \`code\` formatting.
> It should render correctly with proper styling.

### Emoji Support

| Emoji | Name | Category |
|---|---|---|
| 🚀 | Rocket | Transport |
| 🎨 | Palette | Art |
| ⚡ | Lightning | Nature |
| 🔥 | Fire | Nature |

---

## Alignment Examples

| Left | Center | Right |
|:---|:---:|---:|
| L1 | C1 | R1 |
| Left aligned | Centered text | Right aligned |
| Short | Medium length | Longer content here |

## Performance

The table alignment uses:
1. AST-based parsing with \`marked\`
2. Caching for repeated content
3. Smart width calculation accounting for concealed chars

---

*Press \`?\` for keybindings*
`

// Theme definitions
const themes = {
  github: {
    name: "GitHub Dark",
    bg: "#0D1117",
    styles: {
      keyword: { fg: parseColor("#FF7B72"), bold: true },
      string: { fg: parseColor("#A5D6FF") },
      comment: { fg: parseColor("#8B949E"), italic: true },
      number: { fg: parseColor("#79C0FF") },
      function: { fg: parseColor("#D2A8FF") },
      type: { fg: parseColor("#FFA657") },
      operator: { fg: parseColor("#FF7B72") },
      variable: { fg: parseColor("#E6EDF3") },
      property: { fg: parseColor("#79C0FF") },
      "punctuation.bracket": { fg: parseColor("#F0F6FC") },
      "punctuation.delimiter": { fg: parseColor("#C9D1D9") },
      "markup.heading": { fg: parseColor("#58A6FF"), bold: true },
      "markup.heading.1": { fg: parseColor("#00FF88"), bold: true, underline: true },
      "markup.heading.2": { fg: parseColor("#00D7FF"), bold: true },
      "markup.heading.3": { fg: parseColor("#FF69B4") },
      "markup.bold": { fg: parseColor("#F0F6FC"), bold: true },
      "markup.strong": { fg: parseColor("#F0F6FC"), bold: true },
      "markup.italic": { fg: parseColor("#F0F6FC"), italic: true },
      "markup.list": { fg: parseColor("#FF7B72") },
      "markup.quote": { fg: parseColor("#8B949E"), italic: true },
      "markup.raw": { fg: parseColor("#A5D6FF"), bg: parseColor("#161B22") },
      "markup.raw.block": { fg: parseColor("#A5D6FF"), bg: parseColor("#161B22") },
      "markup.raw.inline": { fg: parseColor("#A5D6FF"), bg: parseColor("#161B22") },
      "markup.link": { fg: parseColor("#58A6FF"), underline: true },
      "markup.link.label": { fg: parseColor("#A5D6FF"), underline: true },
      "markup.link.url": { fg: parseColor("#58A6FF"), underline: true },
      label: { fg: parseColor("#7EE787") },
      conceal: { fg: parseColor("#6E7681") },
      "punctuation.special": { fg: parseColor("#8B949E") },
      default: { fg: parseColor("#E6EDF3") },
    },
  },
  monokai: {
    name: "Monokai",
    bg: "#272822",
    styles: {
      keyword: { fg: parseColor("#F92672"), bold: true },
      string: { fg: parseColor("#E6DB74") },
      comment: { fg: parseColor("#75715E"), italic: true },
      number: { fg: parseColor("#AE81FF") },
      function: { fg: parseColor("#A6E22E") },
      type: { fg: parseColor("#66D9EF"), italic: true },
      operator: { fg: parseColor("#F92672") },
      variable: { fg: parseColor("#F8F8F2") },
      property: { fg: parseColor("#A6E22E") },
      "punctuation.bracket": { fg: parseColor("#F8F8F2") },
      "punctuation.delimiter": { fg: parseColor("#F8F8F2") },
      "markup.heading": { fg: parseColor("#A6E22E"), bold: true },
      "markup.heading.1": { fg: parseColor("#F92672"), bold: true, underline: true },
      "markup.heading.2": { fg: parseColor("#66D9EF"), bold: true },
      "markup.heading.3": { fg: parseColor("#E6DB74") },
      "markup.bold": { fg: parseColor("#F8F8F2"), bold: true },
      "markup.strong": { fg: parseColor("#F8F8F2"), bold: true },
      "markup.italic": { fg: parseColor("#F8F8F2"), italic: true },
      "markup.list": { fg: parseColor("#F92672") },
      "markup.quote": { fg: parseColor("#75715E"), italic: true },
      "markup.raw": { fg: parseColor("#E6DB74"), bg: parseColor("#3E3D32") },
      "markup.raw.block": { fg: parseColor("#E6DB74"), bg: parseColor("#3E3D32") },
      "markup.raw.inline": { fg: parseColor("#E6DB74"), bg: parseColor("#3E3D32") },
      "markup.link": { fg: parseColor("#66D9EF"), underline: true },
      "markup.link.label": { fg: parseColor("#E6DB74"), underline: true },
      "markup.link.url": { fg: parseColor("#66D9EF"), underline: true },
      label: { fg: parseColor("#A6E22E") },
      conceal: { fg: parseColor("#75715E") },
      "punctuation.special": { fg: parseColor("#75715E") },
      default: { fg: parseColor("#F8F8F2") },
    },
  },
  nord: {
    name: "Nord",
    bg: "#2E3440",
    styles: {
      keyword: { fg: parseColor("#81A1C1"), bold: true },
      string: { fg: parseColor("#A3BE8C") },
      comment: { fg: parseColor("#616E88"), italic: true },
      number: { fg: parseColor("#B48EAD") },
      function: { fg: parseColor("#88C0D0") },
      type: { fg: parseColor("#8FBCBB") },
      operator: { fg: parseColor("#81A1C1") },
      variable: { fg: parseColor("#D8DEE9") },
      property: { fg: parseColor("#88C0D0") },
      "punctuation.bracket": { fg: parseColor("#ECEFF4") },
      "punctuation.delimiter": { fg: parseColor("#D8DEE9") },
      "markup.heading": { fg: parseColor("#88C0D0"), bold: true },
      "markup.heading.1": { fg: parseColor("#8FBCBB"), bold: true, underline: true },
      "markup.heading.2": { fg: parseColor("#81A1C1"), bold: true },
      "markup.heading.3": { fg: parseColor("#B48EAD") },
      "markup.bold": { fg: parseColor("#ECEFF4"), bold: true },
      "markup.strong": { fg: parseColor("#ECEFF4"), bold: true },
      "markup.italic": { fg: parseColor("#ECEFF4"), italic: true },
      "markup.list": { fg: parseColor("#81A1C1") },
      "markup.quote": { fg: parseColor("#616E88"), italic: true },
      "markup.raw": { fg: parseColor("#A3BE8C"), bg: parseColor("#3B4252") },
      "markup.raw.block": { fg: parseColor("#A3BE8C"), bg: parseColor("#3B4252") },
      "markup.raw.inline": { fg: parseColor("#A3BE8C"), bg: parseColor("#3B4252") },
      "markup.link": { fg: parseColor("#88C0D0"), underline: true },
      "markup.link.label": { fg: parseColor("#A3BE8C"), underline: true },
      "markup.link.url": { fg: parseColor("#88C0D0"), underline: true },
      label: { fg: parseColor("#A3BE8C") },
      conceal: { fg: parseColor("#4C566A") },
      "punctuation.special": { fg: parseColor("#616E88") },
      default: { fg: parseColor("#D8DEE9") },
    },
  },
}

type ThemeKey = keyof typeof themes
const themeKeys = Object.keys(themes) as ThemeKey[]

let renderer: CliRenderer | null = null
let keyboardHandler: ((key: ParsedKey) => void) | null = null
let parentContainer: BoxRenderable | null = null
let markdownScrollBox: ScrollBoxRenderable | null = null
let markdownDisplay: MarkdownRenderable | null = null
let statusText: TextRenderable | null = null
let syntaxStyle: SyntaxStyle | null = null
let helpModal: BoxRenderable | null = null
let currentThemeIndex = 0
let concealEnabled = true
let showingHelp = false
let streamingMode = false
let streamingTimer: Timer | null = null
let streamPosition = 0
let endlessMode = false

// Streaming speed presets: [minDelay, maxDelay] in milliseconds
const streamSpeeds = [
  { name: "Slowest", min: 200, max: 500 }, // 0: Default
  { name: "Slower", min: 150, max: 350 }, // 1
  { name: "Slow", min: 100, max: 250 }, // 2
  { name: "Medium", min: 70, max: 150 }, // 3
  { name: "Fast", min: 40, max: 100 }, // 4
  { name: "Faster", min: 20, max: 60 }, // 5
  { name: "Fastest", min: 10, max: 50 }, // 6
]
let currentSpeedIndex = 0

function getCurrentTheme() {
  return themes[themeKeys[currentThemeIndex]]
}

function getCurrentSpeed() {
  return streamSpeeds[currentSpeedIndex]
}

function stopStreaming() {
  if (streamingTimer) {
    clearTimeout(streamingTimer)
    streamingTimer = null
  }
  streamingMode = false
  streamPosition = 0
}

function startStreaming() {
  stopStreaming()
  streamingMode = true
  streamPosition = 0

  if (!markdownDisplay || !markdownScrollBox) return

  // Reset to empty and enable streaming mode
  markdownDisplay.streaming = true
  markdownDisplay.content = ""

  // Enable sticky scroll to bottom for streaming
  markdownScrollBox.stickyScroll = true

  markdownScrollBox.stickyStart = "bottom"

  // Update status
  if (statusText) {
    const theme = getCurrentTheme()
    const speed = getCurrentSpeed()
    const mode = endlessMode ? "ENDLESS" : "NORMAL"
    statusText.content = `Theme: ${theme.name} | Conceal: ${concealEnabled ? "ON" : "OFF"} | Streaming: IN PROGRESS (${speed.name}, ${mode}) | Press X to stop`
  }

  function streamNextChunk() {
    if (!streamingMode || !markdownDisplay) return

    // Random chunk size between 1 and 50 characters
    const chunkSize = Math.floor(Math.random() * 50) + 1

    // Calculate which iteration we're on and position within that iteration
    const positionInCurrentIteration = streamPosition % markdownContent.length
    const nextPositionInIteration = Math.min(positionInCurrentIteration + chunkSize, markdownContent.length)

    // Build content by repeating the markdown as many times as needed
    const fullIterations = Math.floor(streamPosition / markdownContent.length)
    const currentIterationContent = markdownContent.slice(0, nextPositionInIteration)

    // Construct full content: (full iterations of content) + (partial current iteration)
    let fullContent = markdownContent.repeat(fullIterations) + currentIterationContent

    markdownDisplay.content = fullContent
    streamPosition += chunkSize

    // In endless mode, never stop. In normal mode, stop after first iteration
    const shouldContinue = endlessMode || streamPosition < markdownContent.length

    if (shouldContinue) {
      // Random delay based on current speed setting
      const speed = getCurrentSpeed()
      const delayRange = speed.max - speed.min
      const delay = Math.floor(Math.random() * delayRange) + speed.min
      streamingTimer = setTimeout(streamNextChunk, delay)
    } else {
      // Normal mode - streaming complete
      streamingMode = false
      if (statusText) {
        const theme = getCurrentTheme()
        const speed = getCurrentSpeed()
        statusText.content = `Theme: ${theme.name} | Conceal: ${concealEnabled ? "ON" : "OFF"} | Streaming: COMPLETE (${speed.name}) | Press S to restart`
      }
    }
  }

  streamNextChunk()
}

export async function run(rendererInstance: CliRenderer): Promise<void> {
  renderer = rendererInstance
  renderer.start()

  const theme = getCurrentTheme()
  renderer.setBackgroundColor(theme.bg)

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
    backgroundColor: theme.bg,
    title: "Markdown Demo - Table Alignment + Syntax Highlighting",
    titleAlignment: "center",
    border: true,
  })
  parentContainer.add(titleBox)

  const instructionsText = new TextRenderable(renderer, {
    id: "instructions",
    content: "ESC to return | Press ? for keybindings",
    fg: "#888888",
  })
  titleBox.add(instructionsText)

  // Create help modal (hidden by default)
  helpModal = new BoxRenderable(renderer, {
    id: "help-modal",
    position: "absolute",
    left: "50%",
    top: "50%",
    width: 60,
    height: 20,
    marginLeft: -30,
    marginTop: -10,
    border: true,
    borderStyle: "double",
    borderColor: "#4ECDC4",
    backgroundColor: theme.bg,
    title: "Keybindings",
    titleAlignment: "center",
    padding: 2,
    zIndex: 100,
    visible: false,
  })

  const helpContent = new TextRenderable(renderer, {
    id: "help-content",
    content: `Theme:
  T : Cycle through themes (GitHub/Monokai/Nord)

View Controls:
  C : Toggle concealment (hide **, \`, etc.)

Streaming:
  S : Start/restart streaming simulation
  E : Toggle endless mode (repeats content forever)
  X : Stop streaming (when in endless mode)
  [ : Decrease speed (slower)
  ] : Increase speed (faster)

Other:
  ? : Toggle this help screen
  ESC : Return to main menu`,
    fg: "#E6EDF3",
  })

  helpModal.add(helpContent)
  renderer.root.add(helpModal)

  markdownScrollBox = new ScrollBoxRenderable(renderer, {
    id: "markdown-scroll-box",
    borderStyle: "single",

    borderColor: "#6BCF7F",
    backgroundColor: theme.bg,
    title: `MarkdownRenderable - ${theme.name}`,
    titleAlignment: "left",
    border: true,
    scrollY: true,
    scrollX: false,
    flexGrow: 1,
    flexShrink: 1,
    padding: 2,
  })
  markdownScrollBox.focus()
  parentContainer.add(markdownScrollBox)

  // Create syntax style from current theme
  syntaxStyle = SyntaxStyle.fromStyles(theme.styles)

  // Create markdown display using MarkdownRenderable
  markdownDisplay = new MarkdownRenderable(renderer, {
    id: "markdown-display",
    content: markdownContent,
    syntaxStyle,
    conceal: concealEnabled,
    width: "100%",
  })

  markdownScrollBox.add(markdownDisplay)

  statusText = new TextRenderable(renderer, {
    id: "status-display",
    content: "",
    fg: "#A5D6FF",
    wrapMode: "word",
    flexShrink: 0,
  })
  parentContainer.add(statusText)

  const updateStatusText = () => {
    if (statusText) {
      const theme = getCurrentTheme()
      const speed = getCurrentSpeed()
      const streamStatus = streamingMode ? "STREAMING" : "NORMAL"
      const endlessStatus = endlessMode ? " [ENDLESS]" : ""
      statusText.content = `Theme: ${theme.name} | Conceal: ${concealEnabled ? "ON" : "OFF"} | Mode: ${streamStatus}${endlessStatus} | Speed: ${speed.name} | Press T/C/S/E/[/]`
    }
  }

  updateStatusText()

  keyboardHandler = (key: ParsedKey) => {
    // Handle help modal toggle
    if (key.raw === "?" && helpModal) {
      showingHelp = !showingHelp
      helpModal.visible = showingHelp
      return
    }

    // Don't process other keys when help is showing
    if (showingHelp) return

    if (key.name === "s" && !key.ctrl && !key.meta) {
      // Start/restart streaming simulation
      startStreaming()
    } else if (key.name === "e" && !key.ctrl && !key.meta) {
      // Toggle endless mode
      endlessMode = !endlessMode
      updateStatusText()
    } else if (key.name === "x" && !key.ctrl && !key.meta) {
      // Stop streaming (for endless mode)
      stopStreaming()
      if (markdownDisplay) {
        markdownDisplay.streaming = false
      }
      updateStatusText()
    } else if (key.raw === "[" && !key.ctrl && !key.meta) {
      // Decrease streaming speed (slower)
      if (currentSpeedIndex > 0) {
        currentSpeedIndex--
        updateStatusText()
      }
    } else if (key.raw === "]" && !key.ctrl && !key.meta) {
      // Increase streaming speed (faster)
      if (currentSpeedIndex < streamSpeeds.length - 1) {
        currentSpeedIndex++
        updateStatusText()
      }
    } else if (key.name === "t" && !key.ctrl && !key.meta) {
      // Cycle through themes
      currentThemeIndex = (currentThemeIndex + 1) % themeKeys.length
      const theme = getCurrentTheme()

      // Update background color
      renderer?.setBackgroundColor(theme.bg)

      // Update syntax style
      syntaxStyle = SyntaxStyle.fromStyles(theme.styles)

      if (markdownDisplay) {
        markdownDisplay.syntaxStyle = syntaxStyle
      }

      if (markdownScrollBox) {
        markdownScrollBox.title = `MarkdownRenderable - ${theme.name}`
        markdownScrollBox.backgroundColor = theme.bg
      }

      if (helpModal) {
        helpModal.backgroundColor = theme.bg
      }

      updateStatusText()
    } else if (key.name === "c" && !key.ctrl && !key.meta) {
      // Stop streaming when toggling conceal
      stopStreaming()

      concealEnabled = !concealEnabled
      if (markdownDisplay) {
        markdownDisplay.conceal = concealEnabled
        markdownDisplay.streaming = false
        markdownDisplay.content = markdownContent
      }
      updateStatusText()
    }
  }

  rendererInstance.keyInput.on("keypress", keyboardHandler)
}

export function destroy(rendererInstance: CliRenderer): void {
  stopStreaming()

  if (keyboardHandler) {
    rendererInstance.keyInput.off("keypress", keyboardHandler)
    keyboardHandler = null
  }

  parentContainer?.destroy()
  helpModal?.destroy()
  parentContainer = null
  markdownScrollBox = null
  markdownDisplay = null
  statusText = null
  syntaxStyle = null
  helpModal = null

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
