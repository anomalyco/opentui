import {
  CliRenderer,
  CliRenderEvents,
  createCliRenderer,
  DiffRenderable,
  BoxRenderable,
  TextRenderable,
  type ParsedKey,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import { parseColor, type RGBA } from "@opentui/core"
import { SyntaxStyle } from "@opentui/core"

interface DiffTheme {
  name: string
  backgroundColor: string
  borderColor: string
  addedBg: string
  removedBg: string
  contextBg: string
  addedSignColor: string
  removedSignColor: string
  lineNumberFg: string
  lineNumberBg: string
  addedLineNumberBg: string
  removedLineNumberBg: string
  selectionBg: string
  selectionFg: string
  syntaxStyle: {
    keyword: { fg: RGBA; bold?: boolean }
    "keyword.import": { fg: RGBA; bold?: boolean }
    string: { fg: RGBA }
    comment: { fg: RGBA; italic?: boolean }
    number: { fg: RGBA }
    boolean: { fg: RGBA }
    constant: { fg: RGBA }
    function: { fg: RGBA }
    "function.call": { fg: RGBA }
    constructor: { fg: RGBA }
    type: { fg: RGBA }
    operator: { fg: RGBA }
    variable: { fg: RGBA }
    property: { fg: RGBA }
    bracket: { fg: RGBA }
    punctuation: { fg: RGBA }
    default: { fg: RGBA }
  }
}

const themes: DiffTheme[] = [
  {
    name: "GitHub Dark",
    backgroundColor: "#0D1117",
    borderColor: "#4ECDC4",
    addedBg: "#1a4d1a",
    removedBg: "#4d1a1a",
    contextBg: "transparent",
    addedSignColor: "#22c55e",
    removedSignColor: "#ef4444",
    lineNumberFg: "#6b7280",
    lineNumberBg: "#161b22",
    addedLineNumberBg: "#0d3a0d",
    removedLineNumberBg: "#3a0d0d",
    selectionBg: "#264F78",
    selectionFg: "#FFFFFF",
    syntaxStyle: {
      keyword: { fg: parseColor("#FF7B72"), bold: true },
      "keyword.import": { fg: parseColor("#FF7B72"), bold: true },
      string: { fg: parseColor("#A5D6FF") },
      comment: { fg: parseColor("#8B949E"), italic: true },
      number: { fg: parseColor("#79C0FF") },
      boolean: { fg: parseColor("#79C0FF") },
      constant: { fg: parseColor("#79C0FF") },
      function: { fg: parseColor("#D2A8FF") },
      "function.call": { fg: parseColor("#D2A8FF") },
      constructor: { fg: parseColor("#FFA657") },
      type: { fg: parseColor("#FFA657") },
      operator: { fg: parseColor("#FF7B72") },
      variable: { fg: parseColor("#E6EDF3") },
      property: { fg: parseColor("#79C0FF") },
      bracket: { fg: parseColor("#F0F6FC") },
      punctuation: { fg: parseColor("#F0F6FC") },
      default: { fg: parseColor("#E6EDF3") },
    },
  },
  {
    name: "Monokai",
    backgroundColor: "#272822",
    borderColor: "#FD971F",
    addedBg: "#2d4a2b",
    removedBg: "#4a2b2b",
    contextBg: "transparent",
    addedSignColor: "#A6E22E",
    removedSignColor: "#F92672",
    lineNumberFg: "#75715E",
    lineNumberBg: "#1e1f1c",
    addedLineNumberBg: "#1e3a1e",
    removedLineNumberBg: "#3a1e1e",
    selectionBg: "#49483E",
    selectionFg: "#F8F8F2",
    syntaxStyle: {
      keyword: { fg: parseColor("#F92672"), bold: true },
      "keyword.import": { fg: parseColor("#F92672"), bold: true },
      string: { fg: parseColor("#E6DB74") },
      comment: { fg: parseColor("#75715E"), italic: true },
      number: { fg: parseColor("#AE81FF") },
      boolean: { fg: parseColor("#AE81FF") },
      constant: { fg: parseColor("#AE81FF") },
      function: { fg: parseColor("#A6E22E") },
      "function.call": { fg: parseColor("#A6E22E") },
      constructor: { fg: parseColor("#FD971F") },
      type: { fg: parseColor("#66D9EF") },
      operator: { fg: parseColor("#F92672") },
      variable: { fg: parseColor("#F8F8F2") },
      property: { fg: parseColor("#66D9EF") },
      bracket: { fg: parseColor("#F8F8F2") },
      punctuation: { fg: parseColor("#F8F8F2") },
      default: { fg: parseColor("#F8F8F2") },
    },
  },
  {
    name: "Dracula",
    backgroundColor: "#282A36",
    borderColor: "#BD93F9",
    addedBg: "#2d4737",
    removedBg: "#4d2d37",
    contextBg: "transparent",
    addedSignColor: "#50FA7B",
    removedSignColor: "#FF5555",
    lineNumberFg: "#6272A4",
    lineNumberBg: "#21222C",
    addedLineNumberBg: "#1f3626",
    removedLineNumberBg: "#3a2328",
    selectionBg: "#44475A",
    selectionFg: "#F8F8F2",
    syntaxStyle: {
      keyword: { fg: parseColor("#FF79C6"), bold: true },
      "keyword.import": { fg: parseColor("#FF79C6"), bold: true },
      string: { fg: parseColor("#F1FA8C") },
      comment: { fg: parseColor("#6272A4"), italic: true },
      number: { fg: parseColor("#BD93F9") },
      boolean: { fg: parseColor("#BD93F9") },
      constant: { fg: parseColor("#BD93F9") },
      function: { fg: parseColor("#50FA7B") },
      "function.call": { fg: parseColor("#50FA7B") },
      constructor: { fg: parseColor("#FFB86C") },
      type: { fg: parseColor("#8BE9FD") },
      operator: { fg: parseColor("#FF79C6") },
      variable: { fg: parseColor("#F8F8F2") },
      property: { fg: parseColor("#8BE9FD") },
      bracket: { fg: parseColor("#F8F8F2") },
      punctuation: { fg: parseColor("#F8F8F2") },
      default: { fg: parseColor("#F8F8F2") },
    },
  },
  {
    name: "Solarized Dark",
    backgroundColor: "#002b36", // base03 - official
    borderColor: "#2aa198", // cyan - official
    addedBg: "#1a4032",
    removedBg: "#4d2a30",
    contextBg: "transparent",
    addedSignColor: "#859900", // green - official
    removedSignColor: "#dc322f", // red - official
    lineNumberFg: "#586e75", // base01 - official
    lineNumberBg: "#073642", // base02 - official
    addedLineNumberBg: "#0d3326",
    removedLineNumberBg: "#3a2026",
    selectionBg: "#073642",
    selectionFg: "#93a1a1",
    syntaxStyle: {
      keyword: { fg: parseColor("#859900"), bold: true }, // green
      "keyword.import": { fg: parseColor("#859900"), bold: true },
      string: { fg: parseColor("#2aa198") }, // cyan
      comment: { fg: parseColor("#586e75"), italic: true }, // base01
      number: { fg: parseColor("#d33682") }, // magenta
      boolean: { fg: parseColor("#d33682") },
      constant: { fg: parseColor("#b58900") }, // yellow
      function: { fg: parseColor("#268bd2") }, // blue
      "function.call": { fg: parseColor("#268bd2") },
      constructor: { fg: parseColor("#cb4b16") }, // orange
      type: { fg: parseColor("#cb4b16") },
      operator: { fg: parseColor("#859900") },
      variable: { fg: parseColor("#839496") }, // base0 - official foreground
      property: { fg: parseColor("#268bd2") },
      bracket: { fg: parseColor("#839496") }, // base0
      punctuation: { fg: parseColor("#839496") },
      default: { fg: parseColor("#839496") }, // base0
    },
  },
  {
    name: "One Dark",
    backgroundColor: "#282c34", // official
    borderColor: "#61afef", // blue - official
    addedBg: "#2d4a2d",
    removedBg: "#4d2d2d",
    contextBg: "transparent",
    addedSignColor: "#98c379", // green - official
    removedSignColor: "#e06c75", // red - official
    lineNumberFg: "#636d83", // gutter - official
    lineNumberBg: "#21252b",
    addedLineNumberBg: "#1e3a1e",
    removedLineNumberBg: "#3a1e1e",
    selectionBg: "#3E4451",
    selectionFg: "#abb2bf",
    syntaxStyle: {
      keyword: { fg: parseColor("#c678dd"), bold: true }, // purple - official
      "keyword.import": { fg: parseColor("#c678dd"), bold: true },
      string: { fg: parseColor("#98c379") }, // green - official
      comment: { fg: parseColor("#5c6370"), italic: true }, // comment - official
      number: { fg: parseColor("#d19a66") }, // orange - official
      boolean: { fg: parseColor("#d19a66") },
      constant: { fg: parseColor("#d19a66") },
      function: { fg: parseColor("#61afef") }, // blue - official
      "function.call": { fg: parseColor("#61afef") },
      constructor: { fg: parseColor("#e5c07b") }, // yellow - official
      type: { fg: parseColor("#e5c07b") },
      operator: { fg: parseColor("#56b6c2") }, // cyan - official
      variable: { fg: parseColor("#abb2bf") }, // foreground - official
      property: { fg: parseColor("#e06c75") }, // red - official
      bracket: { fg: parseColor("#abb2bf") },
      punctuation: { fg: parseColor("#abb2bf") },
      default: { fg: parseColor("#abb2bf") },
    },
  },
]

interface ContentExample {
  name: string
  filetype: "typescript" | "markdown" | "json"
  diff: string
}

const contentExamples: ContentExample[] = [
  {
    name: "TypeScript",
    filetype: "typescript",
    diff: `--- a/calculator.ts
+++ b/calculator.ts
@@ -1,13 +1,20 @@
 class Calculator {
   add(a: number, b: number): number {
     return a + b;
   }
 
-  subtract(a: number, b: number): number {
-    return a - b;
+  subtract(a: number, b: number, c: number = 0): number {
+    return a - b - c;
   }
 
   multiply(a: number, b: number): number {
     return a * b;
   }
+
+  divide(a: number, b: number): number {
+    if (b === 0) {
+      throw new Error("Division by zero");
+    }
+    return a / b;
+  }
 }`,
  },
  {
    name: "Real Session: Text Demo",
    filetype: "typescript",
    diff: `Index: packages/examples/src/index.ts
===================================================================
--- packages/examples/src/index.ts	before
+++ packages/examples/src/index.ts	after
@@ -56,6 +56,7 @@
 import * as terminalDemo from "./terminal.js"
 import * as diffDemo from "./diff-demo.js"
 import * as keypressDebugDemo from "./keypress-debug-demo.js"
+import * as textTruncationDemo from "./text-truncation-demo.js"
 import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
 
 interface Example {
@@ -85,6 +86,12 @@
     destroy: textSelectionExample.destroy,
   },
   {
+    name: "Text Truncation Demo",
+    description: "Middle truncation with ellipsis - toggle with 'T' key and resize to test responsive behavior",
+    run: textTruncationDemo.run,
+    destroy: textTruncationDemo.destroy,
+  },
+  {
     name: "ASCII Font Selection Demo",
     description: "Text selection with ASCII fonts - precise character-level selection across different font types",
     run: asciiFontSelectionExample.run,`,
  },
  {
    name: "Markdown",
    filetype: "markdown",
    diff: `--- a/README.md
+++ b/README.md
@@ -1,12 +1,21 @@
 # Project Name
 
-A simple project description.
+A comprehensive project description with detailed features.
 
 ## Features
 
-- Feature 1
-- Feature 2
+- **Feature 1**: Enhanced with new capabilities
+- **Feature 2**: Now supports multiple formats
+- **Feature 3**: Added real-time synchronization
 
 ## Installation
 
-\`npm install\`
+\`\`\`bash
+npm install
+# or
+yarn install
+\`\`\`
+
+## Usage
+
+See the [documentation](./docs) for detailed usage instructions.`,
  },
  {
    name: "Real Session: Truncate Feature",
    filetype: "typescript",
    diff: `Index: packages/core/src/renderables/TextBufferRenderable.ts
===================================================================
--- packages/core/src/renderables/TextBufferRenderable.ts	before
+++ packages/core/src/renderables/TextBufferRenderable.ts	after
@@ -19,6 +19,7 @@
   wrapMode?: "none" | "char" | "word"
   tabIndicator?: string | number
   tabIndicatorColor?: string | RGBA
+  truncate?: boolean
 }
 
 export abstract class TextBufferRenderable extends Renderable implements LineInfoProvider {
@@ -35,6 +36,7 @@
   protected _tabIndicatorColor?: RGBA
   protected _scrollX: number = 0
   protected _scrollY: number = 0
+  protected _truncate: boolean = false
 
   protected textBuffer: TextBuffer
   protected textBufferView: TextBufferView`,
  },
  {
    name: "Markdown (Conceal Test)",
    filetype: "markdown",
    diff: `--- a/test.md
+++ b/test.md
@@ -1,2 +1,2 @@
-Some text **boldtext**
-Short
+Some text **boldtext**
+More text **formats**`,
  },
  {
    name: "JSON",
    filetype: "json",
    diff: `--- a/config.json
+++ b/config.json
@@ -1,9 +1,15 @@
 {
-  "name": "my-app",
-  "version": "1.0.0",
+  "name": "my-awesome-app",
+  "version": "2.0.0",
   "config": {
-    "port": 3000,
-    "host": "localhost"
+    "port": 8080,
+    "host": "0.0.0.0",
+    "ssl": true,
+    "timeout": 30000
   },
-  "debug": false
+  "debug": true,
+  "features": {
+    "analytics": true,
+    "logging": "verbose"
+  }
 }`,
  },
  {
    name: "Real Session: CJK Wrap Test",
    filetype: "typescript",
    diff: `Index: packages/core/src/renderables/Text.test.ts
===================================================================
--- packages/core/src/renderables/Text.test.ts	before
+++ packages/core/src/renderables/Text.test.ts	after
@@ -1428,6 +1428,37 @@
       const frame = captureFrame()
       expect(frame).toMatchSnapshot()
     })
+
+    it("should render word wrapped text with CJK and English correctly", async () => {
+      resize(60, 10)
+
+      const { text } = await createTextRenderable(currentRenderer, {
+        content: "🌟 Unicode test: こんにちは世界 Hello World 你好世界",
+        wrapMode: "word",
+        width: 35,
+        left: 0,
+        top: 0,
+      })
+
+      await renderOnce()
+
+      const frame = captureFrame()
+      const lines = frame.split("\\n").filter((l) => l.trim().length > 0)
+
+      console.log("Frame:\\n" + frame)
+      console.log("Line 0:", JSON.stringify(lines[0]))
+      console.log("Line 1:", JSON.stringify(lines[1]))
+
+      // Verify no character duplication - each character should appear only once
+      const line0 = lines[0] || ""
+      const line1 = lines[1] || ""
+
+      const line0_ends_with_kai = line0.trimEnd().endsWith("界")
+      const line1_starts_with_kai = line1.trimStart().startsWith("界")
+
+      // "界" should not appear on both lines (would indicate duplication bug)
+      expect(line0_ends_with_kai && line1_starts_with_kai).toBe(false)
+    })
   })
 
   describe("Text Node Dimension Updates", () => {`,
  },
]

const malformedDiff = `--- a/calculator.ts
+++ b/calculator.ts
@@ -a,b +c,d @@
 class Calculator {
   add(a: number, b: number): number {
     return a + b;
   }
 
-  subtract(a: number, b: number): number {
-    return a - b;
+  subtract(a: number, b: number, c: number = 0): number {
+    return a - b - c;
   }
 }`

let renderer: CliRenderer | null = null
let keyboardHandler: ((key: ParsedKey) => void) | null = null
let destroyHandler: (() => void) | null = null
let parentContainer: BoxRenderable | null = null
let diffRenderable: DiffRenderable | null = null
let instructionsText: TextRenderable | null = null
let titleBox: BoxRenderable | null = null
let syntaxStyle: SyntaxStyle | null = null
let helpModal: BoxRenderable | null = null
let currentView: "unified" | "split" = "unified"
let showLineNumbers = true
let currentWrapMode: "none" | "word" = "none"
let currentThemeIndex = 0
let currentContentIndex = 0
let showMalformedDiff = false
let showingHelp = false
let concealEnabled = true

const applyTheme = (themeIndex: number) => {
  const theme = themes[themeIndex]

  if (renderer) {
    renderer.setBackgroundColor(theme.backgroundColor)
  }

  if (titleBox) {
    titleBox.borderColor = theme.borderColor
    titleBox.backgroundColor = theme.backgroundColor
    const contentName = contentExamples[currentContentIndex].name
    titleBox.title = `Diff Demo - ${theme.name} - ${contentName}`
  }

  if (helpModal) {
    helpModal.borderColor = theme.borderColor
    helpModal.backgroundColor = theme.backgroundColor
  }

  if (syntaxStyle) {
    syntaxStyle.destroy()
  }
  syntaxStyle = SyntaxStyle.fromStyles(theme.syntaxStyle, renderer!.nativeScene!)

  if (diffRenderable) {
    diffRenderable.syntaxStyle = syntaxStyle
    diffRenderable.addedBg = theme.addedBg
    diffRenderable.removedBg = theme.removedBg
    diffRenderable.contextBg = theme.contextBg
    diffRenderable.addedSignColor = theme.addedSignColor
    diffRenderable.removedSignColor = theme.removedSignColor
    diffRenderable.lineNumberFg = theme.lineNumberFg
    diffRenderable.lineNumberBg = theme.lineNumberBg
    diffRenderable.addedLineNumberBg = theme.addedLineNumberBg
    diffRenderable.removedLineNumberBg = theme.removedLineNumberBg
    diffRenderable.selectionBg = theme.selectionBg
    diffRenderable.selectionFg = theme.selectionFg
  }
}

export async function run(rendererInstance: CliRenderer): Promise<void> {
  renderer = rendererInstance
  destroyHandler = () => destroy(rendererInstance)
  rendererInstance.once(CliRenderEvents.DESTROY, destroyHandler)
  showingHelp = false
  renderer.start()

  const theme = themes[currentThemeIndex]
  renderer.setBackgroundColor(theme.backgroundColor)

  parentContainer = new BoxRenderable(renderer, {
    id: "parent-container",
    zIndex: 10,
    padding: 1,
  })
  renderer.root.add(parentContainer)

  titleBox = new BoxRenderable(renderer, {
    id: "title-box",
    height: 3,
    borderStyle: "double",
    borderColor: theme.borderColor,
    backgroundColor: theme.backgroundColor,
    title: `Diff Demo - ${theme.name} - ${contentExamples[currentContentIndex].name}`,
    titleAlignment: "center",
    border: true,
  })
  parentContainer.add(titleBox)

  instructionsText = new TextRenderable(renderer, {
    id: "instructions",
    content: "ESC to return | Press ? for keybindings",
    fg: "#888888",
  })
  titleBox.add(instructionsText)

  // Create help modal (hidden by default)
  helpModal = new BoxRenderable(renderer, {
    id: "help-modal",
    position: "absolute",
    left: "10%",
    top: "10%",
    width: "80%",
    height: "80%",
    border: true,
    borderStyle: "double",
    borderColor: theme.borderColor,
    backgroundColor: theme.backgroundColor,
    title: "Keybindings",
    titleAlignment: "center",
    padding: 2,
    zIndex: 100,
    visible: false,
  })

  const helpContent = new TextRenderable(renderer, {
    id: "help-content",
    content: `View Controls:
  V : Toggle view mode (Unified/Split)
  L : Toggle line numbers
  W : Toggle wrap mode (None/Word)
  O : Toggle conceal (hide/show markup)

Theme & Content:
  T : Cycle through themes (5 themes)
  C : Cycle through diff examples (6 examples)
  M : Toggle malformed diff example

Other:
  ? : Toggle this help screen
  ESC : Return to main menu`,
    fg: "#E6EDF3",
  })

  helpModal.add(helpContent)
  renderer.root.add(helpModal)

  syntaxStyle = SyntaxStyle.fromStyles(theme.syntaxStyle, renderer.nativeScene!)

  // Create diff display
  const currentContent = contentExamples[currentContentIndex]
  diffRenderable = new DiffRenderable(renderer, {
    id: "diff-display",
    diff: currentContent.diff,
    view: currentView,
    filetype: currentContent.filetype,
    syntaxStyle,
    showLineNumbers,
    wrapMode: currentWrapMode,
    conceal: concealEnabled,
    addedBg: theme.addedBg,
    removedBg: theme.removedBg,
    contextBg: theme.contextBg,
    addedSignColor: theme.addedSignColor,
    removedSignColor: theme.removedSignColor,
    lineNumberFg: theme.lineNumberFg,
    lineNumberBg: theme.lineNumberBg,
    addedLineNumberBg: theme.addedLineNumberBg,
    removedLineNumberBg: theme.removedLineNumberBg,
    selectionBg: theme.selectionBg,
    selectionFg: theme.selectionFg,
    flexGrow: 1,
    flexShrink: 1,
  })

  parentContainer.add(diffRenderable)

  keyboardHandler = (key: ParsedKey) => {
    // Handle help modal toggle
    if (key.raw === "?" && helpModal) {
      showingHelp = !showingHelp
      helpModal.visible = showingHelp
      return
    }

    // Don't process other keys when help is showing
    if (showingHelp) return

    if (key.name === "v" && !key.ctrl && !key.meta) {
      // Toggle view mode
      currentView = currentView === "unified" ? "split" : "unified"
      if (diffRenderable) {
        diffRenderable.view = currentView
      }
    } else if (key.name === "l" && !key.ctrl && !key.meta) {
      // Toggle line numbers
      showLineNumbers = !showLineNumbers
      if (diffRenderable) {
        diffRenderable.showLineNumbers = showLineNumbers
      }
    } else if (key.name === "w" && !key.ctrl && !key.meta) {
      // Toggle wrap mode
      currentWrapMode = currentWrapMode === "none" ? "word" : "none"
      if (diffRenderable) {
        diffRenderable.wrapMode = currentWrapMode
      }
    } else if (key.name === "t" && !key.ctrl && !key.meta) {
      // Change theme
      currentThemeIndex = (currentThemeIndex + 1) % themes.length
      applyTheme(currentThemeIndex)
    } else if (key.name === "m" && !key.ctrl && !key.meta) {
      // Toggle malformed diff
      showMalformedDiff = !showMalformedDiff
      if (diffRenderable) {
        diffRenderable.diff = showMalformedDiff ? malformedDiff : contentExamples[currentContentIndex].diff
      }
    } else if (key.name === "c" && !key.ctrl && !key.meta) {
      // Cycle through content types
      currentContentIndex = (currentContentIndex + 1) % contentExamples.length
      if (diffRenderable) {
        const currentContent = contentExamples[currentContentIndex]
        diffRenderable.diff = showMalformedDiff ? malformedDiff : currentContent.diff
        diffRenderable.filetype = currentContent.filetype
      }
      if (titleBox) {
        const theme = themes[currentThemeIndex]
        const contentName = contentExamples[currentContentIndex].name
        titleBox.title = `Diff Demo - ${theme.name} - ${contentName}`
      }
    } else if (key.name === "o" && !key.ctrl && !key.meta) {
      // Toggle conceal
      concealEnabled = !concealEnabled
      if (diffRenderable) {
        diffRenderable.conceal = concealEnabled
      }
    }
  }

  rendererInstance.keyInput.on("keypress", keyboardHandler)
}

export function destroy(rendererInstance: CliRenderer): void {
  if (renderer !== rendererInstance) return
  if (destroyHandler) {
    rendererInstance.off(CliRenderEvents.DESTROY, destroyHandler)
    destroyHandler = null
  }
  if (keyboardHandler) {
    rendererInstance.keyInput.off("keypress", keyboardHandler)
    keyboardHandler = null
  }

  parentContainer?.destroyRecursively()
  helpModal?.destroyRecursively()
  syntaxStyle?.destroy()
  parentContainer = null
  diffRenderable = null
  instructionsText = null
  titleBox = null
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
  await run(renderer)
  setupCommonDemoKeys(renderer)
  await renderer.closed
}
