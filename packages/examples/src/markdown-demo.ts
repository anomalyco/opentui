import {
  CliRenderer,
  CliRenderEvents,
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  type ParsedKey,
  ScrollBoxRenderable,
} from "@opentui/core"
import { parseColor } from "@opentui/core"
import { getTreeSitterClient } from "@opentui/core"
import { MarkdownRenderable } from "@opentui/core"
import { SyntaxStyle } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

// Rich markdown example showcasing various features
const markdownContent = `# OpenTUI Markdown Demo

Welcome to the **MarkdownRenderable** showcase! This demonstrates automatic table alignment and syntax highlighting.

\`\`\`ts
interface StreamChunk {
  id: string
  index: number
  text: string
}

export function appendMarkdownChunk(buffer: string, chunk: StreamChunk): string {
  const prefix = chunk.index === 0 ? "" : "\\n"
  return buffer + prefix + chunk.text
}

export function renderStreamingPreview(chunks: StreamChunk[]): string {
  let markdown = ""

  for (const chunk of chunks) {
    markdown = appendMarkdownChunk(markdown, chunk)
  }

  return markdown
}
\`\`\`

The fenced block above appears near the top so streaming mode exercises a larger CodeRenderable before the rest of the document arrives.

## Features

- Automatic **table column alignment** based on content width
- Proper handling of \`inline code\`, **bold**, and *italic* in tables
- Multiple syntax themes to choose from
- Conceal mode hides formatting markers
- Top-level document layout for assistant-style prose, tables, quotes, and code fences

## Renderer Stress Cases

### Interleaved Code

Start with a short conclusion before any code appears.

\`\`\`ts
export function parse(input: string) {
  return input.trim().split(/\\s+/)
}
\`\`\`

Then continue with prose immediately after the code block. This should not inherit code styling or indentation.

\`\`\`tsx
<Show when={props.enabled}>
  <markdown content={props.text} streaming />
</Show>
\`\`\`

Final paragraph after a second fence with \`inline code\`, **bold text**, and _emphasis_ mixed together.

### Lists With Code

1. First ordered item with \`inline code\`.
2. Second ordered item before a nested list:
   - Nested bullet with a long phrase that should wrap without swallowing the marker or changing indentation.
   - Nested bullet before fenced code:

     \`\`\`ts
     const nested = true
     \`\`\`

3. Third ordered item after the nested fence.

### Quote, Table, Diff

> Quoted note after the list. It should preserve quote styling while using the renderer's blockquote marker.

| Feature | Stress |
| --- | --- |
| Markdown | prose/code/table interleave |
| Renderer | wrapping and spacing |

\`\`\`diff
- const renderer = oldMarkdown
+ const renderer = experimentalMarkdown
\`\`\`

Final paragraph with [docs](https://opentui.dev) and \`https://example.com/from-code\`.

---

## Comparison Table

| Feature | Status | Priority | Notes |
|---|---|---|---|
| Table alignment | **Done** | High | Uses \`marked\` parser |
| Conceal mode | *Working* | Medium | Hides \`**\`, \`\`\`, etc. |
| Theme switching | **Done** | Low | Multiple themes available |
| Unicode support | 日本語 | High | CJK characters |

After a table, normal prose should resume without being treated as another row or inheriting table spacing. This paragraph intentionally starts right after the comparison grid.

- Follow-up bullet with **bold text** and \`inline code\`.
- Another bullet that wraps with enough text to prove list indentation still works after a table renderable has been emitted.
- Final bullet before the next heading.

This paragraph follows the list and should return to normal prose spacing before the next heading.

1. First ordered follow-up with **emphasis** after the unordered list.
2. Second ordered follow-up with \`inline code\` and enough text to wrap onto another line.
3. Third ordered follow-up before returning to prose.

This paragraph follows the numeric list and should align like ordinary body text.

## Code Examples

Here's how to use it:

\`\`\`typescript
import { MarkdownRenderable } from "@opentui/core"

const md = new MarkdownRenderable(renderer, {
  content: "# Hello World",
  syntaxStyle: mySyntaxStyle,
  fg: "#24292F",
  bg: "#FFFFFF",
  conceal: true, // Hide formatting markers
})
\`\`\`

And a JSON configuration example:

\`\`\`json
{
  "name": "opentui-markdown-demo",
  "theme": "github",
  "features": ["table-alignment", "syntax-highlighting", "conceal-mode"],
  "streaming": {
    "enabled": true,
    "speed": "slowest"
  }
}
\`\`\`

Here's a TSX component example:

\`\`\`tsx
import React from "react"
import { useState } from "react"

interface Props {
  title: string
  count: number
}

export const Counter: React.FC<Props> = ({ title, count: initialCount }) => {
  const [count, setCount] = useState(initialCount)

  return (
    <div className="counter">
      <h1>{title}</h1>
      <p>Count: {count}</p>
      <button onClick={() => setCount(c => c + 1)}>
        Increment
      </button>
    </div>
  )
}
\`\`\`

## Light Theme Fallback Checks

Press \`T\` until **GitHub Light**. These fences intentionally skip syntax
highlighting and should still inherit the theme text color.

Unlabeled fenced block:

\`\`\`
this fence has no language tag
it should stay readable in GitHub Light
\`\`\`

Unsupported parser fallback:

\`\`\`toml
title = "GitHub Light"
status = "fallback text should stay readable"
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
  githubLight: {
    name: "GitHub Light",
    bg: "#FFFFFF",
    styles: {
      keyword: { fg: parseColor("#CF222E"), bold: true },
      string: { fg: parseColor("#0A3069") },
      comment: { fg: parseColor("#6E7781"), italic: true },
      number: { fg: parseColor("#0550AE") },
      function: { fg: parseColor("#8250DF") },
      type: { fg: parseColor("#953800") },
      operator: { fg: parseColor("#CF222E") },
      variable: { fg: parseColor("#24292F") },
      property: { fg: parseColor("#0550AE") },
      "punctuation.bracket": { fg: parseColor("#24292F") },
      "punctuation.delimiter": { fg: parseColor("#57606A") },
      "markup.heading": { fg: parseColor("#0550AE"), bold: true },
      "markup.heading.1": { fg: parseColor("#1A7F37"), bold: true, italic: true, underline: true },
      "markup.heading.2": { fg: parseColor("#0550AE"), bold: true },
      "markup.heading.3": { fg: parseColor("#8250DF") },
      "markup.bold": { fg: parseColor("#24292F"), bold: true },
      "markup.strong": { fg: parseColor("#24292F"), bold: true },
      "markup.italic": { fg: parseColor("#24292F"), italic: true },
      "markup.list": { fg: parseColor("#CF222E") },
      "markup.quote": { fg: parseColor("#6E7781"), italic: true },
      "markup.raw": { fg: parseColor("#24292F"), bg: parseColor("#F6F8FA") },
      "markup.raw.block": { fg: parseColor("#24292F"), bg: parseColor("#F6F8FA") },
      "markup.raw.inline": { fg: parseColor("#24292F"), bg: parseColor("#F6F8FA") },
      "markup.link": { fg: parseColor("#0969DA"), underline: true },
      "markup.link.label": { fg: parseColor("#0A3069"), underline: true },
      "markup.link.url": { fg: parseColor("#0969DA"), underline: true },
      "diff.plus": { fg: parseColor("#1A7F37") },
      "diff.minus": { fg: parseColor("#CF222E") },
      label: { fg: parseColor("#1A7F37") },
      conceal: { fg: parseColor("#6E7781") },
      "punctuation.special": { fg: parseColor("#57606A") },
      default: { fg: parseColor("#24292F") },
    },
  },
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
      "markup.heading.1": { fg: parseColor("#00FF88"), bold: true, italic: true, underline: true },
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
      "diff.plus": { fg: parseColor("#3FB950") },
      "diff.minus": { fg: parseColor("#F85149") },
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
      "markup.heading.1": { fg: parseColor("#F92672"), bold: true, italic: true, underline: true },
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
      "diff.plus": { fg: parseColor("#A6E22E") },
      "diff.minus": { fg: parseColor("#F92672") },
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
      "markup.heading.1": { fg: parseColor("#8FBCBB"), bold: true, italic: true, underline: true },
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
      "diff.plus": { fg: parseColor("#A3BE8C") },
      "diff.minus": { fg: parseColor("#BF616A") },
      label: { fg: parseColor("#A3BE8C") },
      conceal: { fg: parseColor("#4C566A") },
      "punctuation.special": { fg: parseColor("#616E88") },
      default: { fg: parseColor("#D8DEE9") },
    },
  },
}

type ThemeKey = keyof typeof themes
const themeKeys = ["github", "githubLight", "monokai", "nord"] as const satisfies readonly ThemeKey[]

let renderer: CliRenderer | null = null
let keyboardHandler: ((key: ParsedKey) => void) | null = null
let selectionHandler: ((selection: { getSelectedText: () => string }) => void) | null = null
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
let rendererDestroyHandler: (() => void) | null = null

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

const JSON_PARSER_WASM_URL =
  "https://github.com/tree-sitter/tree-sitter-json/releases/download/v0.24.8/tree-sitter-json.wasm"
const JSON_HIGHLIGHTS_QUERY_URL =
  "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/json/highlights.scm"
const DIFF_PARSER_WASM_URL =
  "https://github.com/tree-sitter-grammars/tree-sitter-diff/releases/download/v0.1.0/tree-sitter-diff.wasm"
const DIFF_HIGHLIGHTS_QUERY_URL =
  "https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-diff/master/queries/highlights.scm"

let demoParsersRegistered = false

function registerTreeSitterParsersForDemo(): void {
  if (demoParsersRegistered) return

  const treeSitterClient = getTreeSitterClient()

  treeSitterClient.addFiletypeParser({
    filetype: "json",
    wasm: JSON_PARSER_WASM_URL,
    queries: {
      highlights: [JSON_HIGHLIGHTS_QUERY_URL],
    },
  })

  treeSitterClient.addFiletypeParser({
    filetype: "diff",
    wasm: DIFF_PARSER_WASM_URL,
    queries: {
      highlights: [DIFF_HIGHLIGHTS_QUERY_URL],
    },
  })

  demoParsersRegistered = true
}

function getCurrentTheme() {
  return themes[themeKeys[currentThemeIndex]]
}

function getThemeTextColor(theme: (typeof themes)[ThemeKey]) {
  return theme.styles.default.fg
}

function getThemeMutedTextColor(theme: (typeof themes)[ThemeKey]) {
  return theme.styles.conceal.fg ?? theme.styles.default.fg
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
    if (!streamingMode || !markdownDisplay || markdownDisplay.isDestroyed) return

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
  showingHelp = false

  rendererDestroyHandler = () => {
    stopStreaming()
    markdownDisplay = null
    markdownScrollBox = null
    statusText = null
    parentContainer = null
    helpModal = null
  }
  rendererInstance.on(CliRenderEvents.DESTROY, rendererDestroyHandler)

  renderer.start()
  registerTreeSitterParsersForDemo()

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
  T : Cycle through themes

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
    paddingX: 2,
    paddingY: 1,
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
    fg: getThemeTextColor(theme),
    bg: theme.bg,
    conceal: concealEnabled,
    internalBlockMode: "top-level",
    tableOptions: { style: "grid", widthMode: "content", cellPaddingX: 1 },
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

  const applyTheme = (theme: (typeof themes)[ThemeKey]) => {
    rendererInstance.setBackgroundColor(theme.bg)
    syntaxStyle = SyntaxStyle.fromStyles(theme.styles)

    titleBox.backgroundColor = theme.bg
    instructionsText.fg = getThemeMutedTextColor(theme)
    helpContent.fg = getThemeTextColor(theme)

    if (markdownDisplay) {
      markdownDisplay.syntaxStyle = syntaxStyle
      markdownDisplay.fg = getThemeTextColor(theme)
      markdownDisplay.bg = theme.bg
    }

    if (markdownScrollBox) {
      markdownScrollBox.title = `MarkdownRenderable - ${theme.name}`
      markdownScrollBox.backgroundColor = theme.bg
    }

    if (helpModal) {
      helpModal.backgroundColor = theme.bg
    }

    if (statusText) {
      statusText.fg = getThemeTextColor(theme)
    }
  }

  const updateStatusText = () => {
    if (statusText) {
      const theme = getCurrentTheme()
      const speed = getCurrentSpeed()
      const streamStatus = streamingMode ? "STREAMING" : "NORMAL"
      const endlessStatus = endlessMode ? " [ENDLESS]" : ""
      statusText.content = `Theme: ${theme.name} | Conceal: ${concealEnabled ? "ON" : "OFF"} | Mode: ${streamStatus}${endlessStatus} | Speed: ${speed.name} | Select text to copy | Press T/C/S/E/[/]`
    }
  }

  applyTheme(theme)
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
      applyTheme(getCurrentTheme())

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

  selectionHandler = (selection) => {
    const selectedText = selection.getSelectedText()
    if (!selectedText || !statusText) return

    const copied = rendererInstance.copyToClipboardOSC52(selectedText)
    const lineCount = selectedText.split("\n").length
    const summary = lineCount > 1 ? `${lineCount} lines` : `${selectedText.length} chars`
    statusText.content = copied
      ? `Copied selection to clipboard (${summary})`
      : `Selected ${summary}; clipboard write unavailable`
  }
  rendererInstance.on(CliRenderEvents.SELECTION, selectionHandler)
}

export function destroy(rendererInstance: CliRenderer): void {
  stopStreaming()

  if (rendererDestroyHandler) {
    rendererInstance.off(CliRenderEvents.DESTROY, rendererDestroyHandler)
    rendererDestroyHandler = null
  }

  if (keyboardHandler) {
    rendererInstance.keyInput.off("keypress", keyboardHandler)
    keyboardHandler = null
  }

  if (selectionHandler) {
    rendererInstance.off(CliRenderEvents.SELECTION, selectionHandler)
    selectionHandler = null
  }

  parentContainer?.destroy()
  helpModal?.destroy()
  parentContainer = null
  markdownScrollBox = null
  markdownDisplay = null
  statusText = null
  syntaxStyle = null
  helpModal = null
  showingHelp = false

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
