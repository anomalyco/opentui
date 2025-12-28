import { createCliRenderer, parseColor, SyntaxStyle } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { useState, useMemo } from "react"

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
  syntaxStyle: Parameters<typeof SyntaxStyle.fromStyles>[0]
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
]

const exampleDiff = `--- a/calculator.ts
+++ b/calculator.ts
@@ -1,17 +1,24 @@
 class Calculator {
-  // Basic math operations 🔢
+  // Basic math operations ➕➗
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
+      throw new Error("Division by zero ❌");
+    }
+    return a / b;
+  }

-  // Status: 👍 working
-  // 日本語コメント
+  // Status: ✅ all tests pass
+  // 中文注释 Chinese comment
 }`

const HelpModal = ({ theme, visible }: { theme: DiffTheme; visible: boolean }) => {
  if (!visible) return null

  return (
    <box
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: 60,
        height: 14,
        marginLeft: -30,
        marginTop: -7,
        border: true,
        borderStyle: "double",
        borderColor: theme.borderColor,
        backgroundColor: theme.backgroundColor,
        padding: 2,
        zIndex: 100,
      }}
      title="Keybindings"
      titleAlignment="center"
    >
      <text
        content={`View Controls:
  V : Toggle view mode (Unified/Split)
  L : Toggle line numbers
  W : Toggle wrap mode (None/Word)

Theme & Display:
  T : Cycle through themes

Other:
  ? : Toggle this help screen
  Ctrl+C : Exit`}
        style={{ fg: "#E6EDF3" }}
      />
    </box>
  )
}

export function App() {
  const [themeIndex, setThemeIndex] = useState(0)
  const [view, setView] = useState<"unified" | "split">("unified")
  const [showLineNumbers, setShowLineNumbers] = useState(true)
  const [wrapMode, setWrapMode] = useState<"none" | "word">("none")
  const [showHelp, setShowHelp] = useState(false)

  const theme = themes[themeIndex]
  const syntaxStyle = useMemo(() => SyntaxStyle.fromStyles(theme.syntaxStyle), [theme])

  useKeyboard((key) => {
    if (key.raw === "?") {
      setShowHelp((prev) => !prev)
      return
    }

    if (showHelp) return

    if (key.name === "v" && !key.ctrl && !key.meta) {
      setView((prev) => (prev === "unified" ? "split" : "unified"))
    } else if (key.name === "l" && !key.ctrl && !key.meta) {
      setShowLineNumbers((prev) => !prev)
    } else if (key.name === "w" && !key.ctrl && !key.meta) {
      setWrapMode((prev) => (prev === "none" ? "word" : "none"))
    } else if (key.name === "t" && !key.ctrl && !key.meta) {
      setThemeIndex((prev) => (prev + 1) % themes.length)
    }
  })

  return (
    <box
      style={{
        padding: 1,
        backgroundColor: theme.backgroundColor,
        zIndex: 10,
      }}
    >
      <box
        title={`Diff Demo - ${theme.name}`}
        titleAlignment="center"
        style={{
          height: 3,
          border: true,
          borderStyle: "double",
          borderColor: theme.borderColor,
          backgroundColor: theme.backgroundColor,
        }}
      >
        <text content="Ctrl+C to exit | Press ? for keybindings" style={{ fg: "#888888" }} />
      </box>

      <diff
        diff={exampleDiff}
        view={view}
        filetype="typescript"
        syntaxStyle={syntaxStyle}
        showLineNumbers={showLineNumbers}
        wrapMode={wrapMode}
        addedBg={theme.addedBg}
        removedBg={theme.removedBg}
        contextBg={theme.contextBg}
        addedSignColor={theme.addedSignColor}
        removedSignColor={theme.removedSignColor}
        lineNumberFg={theme.lineNumberFg}
        lineNumberBg={theme.lineNumberBg}
        addedLineNumberBg={theme.addedLineNumberBg}
        removedLineNumberBg={theme.removedLineNumberBg}
        selectionBg={theme.selectionBg}
        selectionFg={theme.selectionFg}
        style={{
          flexGrow: 1,
          flexShrink: 1,
        }}
      />

      <HelpModal theme={theme} visible={showHelp} />
    </box>
  )
}

const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 60 })
renderer.setBackgroundColor("#0D1117")
createRoot(renderer).render(<App />)
