import { RGBA, SyntaxStyle, RenderableEvents, type DiffRenderable } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"

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
      keyword: { fg: RGBA.fromHex("#FF7B72"), bold: true },
      "keyword.import": { fg: RGBA.fromHex("#FF7B72"), bold: true },
      string: { fg: RGBA.fromHex("#A5D6FF") },
      comment: { fg: RGBA.fromHex("#8B949E"), italic: true },
      number: { fg: RGBA.fromHex("#79C0FF") },
      boolean: { fg: RGBA.fromHex("#79C0FF") },
      constant: { fg: RGBA.fromHex("#79C0FF") },
      function: { fg: RGBA.fromHex("#D2A8FF") },
      "function.call": { fg: RGBA.fromHex("#D2A8FF") },
      constructor: { fg: RGBA.fromHex("#FFA657") },
      type: { fg: RGBA.fromHex("#FFA657") },
      operator: { fg: RGBA.fromHex("#FF7B72") },
      variable: { fg: RGBA.fromHex("#E6EDF3") },
      property: { fg: RGBA.fromHex("#79C0FF") },
      bracket: { fg: RGBA.fromHex("#F0F6FC") },
      punctuation: { fg: RGBA.fromHex("#F0F6FC") },
      default: { fg: RGBA.fromHex("#E6EDF3") },
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
      keyword: { fg: RGBA.fromHex("#F92672"), bold: true },
      "keyword.import": { fg: RGBA.fromHex("#F92672"), bold: true },
      string: { fg: RGBA.fromHex("#E6DB74") },
      comment: { fg: RGBA.fromHex("#75715E"), italic: true },
      number: { fg: RGBA.fromHex("#AE81FF") },
      boolean: { fg: RGBA.fromHex("#AE81FF") },
      constant: { fg: RGBA.fromHex("#AE81FF") },
      function: { fg: RGBA.fromHex("#A6E22E") },
      "function.call": { fg: RGBA.fromHex("#A6E22E") },
      constructor: { fg: RGBA.fromHex("#FD971F") },
      type: { fg: RGBA.fromHex("#66D9EF") },
      operator: { fg: RGBA.fromHex("#F92672") },
      variable: { fg: RGBA.fromHex("#F8F8F2") },
      property: { fg: RGBA.fromHex("#66D9EF") },
      bracket: { fg: RGBA.fromHex("#F8F8F2") },
      punctuation: { fg: RGBA.fromHex("#F8F8F2") },
      default: { fg: RGBA.fromHex("#F8F8F2") },
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
      keyword: { fg: RGBA.fromHex("#FF79C6"), bold: true },
      "keyword.import": { fg: RGBA.fromHex("#FF79C6"), bold: true },
      string: { fg: RGBA.fromHex("#F1FA8C") },
      comment: { fg: RGBA.fromHex("#6272A4"), italic: true },
      number: { fg: RGBA.fromHex("#BD93F9") },
      boolean: { fg: RGBA.fromHex("#BD93F9") },
      constant: { fg: RGBA.fromHex("#BD93F9") },
      function: { fg: RGBA.fromHex("#50FA7B") },
      "function.call": { fg: RGBA.fromHex("#50FA7B") },
      constructor: { fg: RGBA.fromHex("#FFB86C") },
      type: { fg: RGBA.fromHex("#8BE9FD") },
      operator: { fg: RGBA.fromHex("#FF79C6") },
      variable: { fg: RGBA.fromHex("#F8F8F2") },
      property: { fg: RGBA.fromHex("#8BE9FD") },
      bracket: { fg: RGBA.fromHex("#F8F8F2") },
      punctuation: { fg: RGBA.fromHex("#F8F8F2") },
      default: { fg: RGBA.fromHex("#F8F8F2") },
    },
  },
  {
    name: "Solarized Dark",
    backgroundColor: "#002b36",
    borderColor: "#2aa198",
    addedBg: "#1a4032",
    removedBg: "#4d2a30",
    contextBg: "transparent",
    addedSignColor: "#859900",
    removedSignColor: "#dc322f",
    lineNumberFg: "#586e75",
    lineNumberBg: "#073642",
    addedLineNumberBg: "#0d3326",
    removedLineNumberBg: "#3a2026",
    selectionBg: "#073642",
    selectionFg: "#93a1a1",
    syntaxStyle: {
      keyword: { fg: RGBA.fromHex("#859900"), bold: true },
      "keyword.import": { fg: RGBA.fromHex("#859900"), bold: true },
      string: { fg: RGBA.fromHex("#2aa198") },
      comment: { fg: RGBA.fromHex("#586e75"), italic: true },
      number: { fg: RGBA.fromHex("#d33682") },
      boolean: { fg: RGBA.fromHex("#d33682") },
      constant: { fg: RGBA.fromHex("#b58900") },
      function: { fg: RGBA.fromHex("#268bd2") },
      "function.call": { fg: RGBA.fromHex("#268bd2") },
      constructor: { fg: RGBA.fromHex("#cb4b16") },
      type: { fg: RGBA.fromHex("#cb4b16") },
      operator: { fg: RGBA.fromHex("#859900") },
      variable: { fg: RGBA.fromHex("#839496") },
      property: { fg: RGBA.fromHex("#268bd2") },
      bracket: { fg: RGBA.fromHex("#839496") },
      punctuation: { fg: RGBA.fromHex("#839496") },
      default: { fg: RGBA.fromHex("#839496") },
    },
  },
  {
    name: "One Dark",
    backgroundColor: "#282c34",
    borderColor: "#61afef",
    addedBg: "#2d4a2d",
    removedBg: "#4d2d2d",
    contextBg: "transparent",
    addedSignColor: "#98c379",
    removedSignColor: "#e06c75",
    lineNumberFg: "#636d83",
    lineNumberBg: "#21252b",
    addedLineNumberBg: "#1e3a1e",
    removedLineNumberBg: "#3a1e1e",
    selectionBg: "#3E4451",
    selectionFg: "#abb2bf",
    syntaxStyle: {
      keyword: { fg: RGBA.fromHex("#c678dd"), bold: true },
      "keyword.import": { fg: RGBA.fromHex("#c678dd"), bold: true },
      string: { fg: RGBA.fromHex("#98c379") },
      comment: { fg: RGBA.fromHex("#5c6370"), italic: true },
      number: { fg: RGBA.fromHex("#d19a66") },
      boolean: { fg: RGBA.fromHex("#d19a66") },
      constant: { fg: RGBA.fromHex("#d19a66") },
      function: { fg: RGBA.fromHex("#61afef") },
      "function.call": { fg: RGBA.fromHex("#61afef") },
      constructor: { fg: RGBA.fromHex("#e5c07b") },
      type: { fg: RGBA.fromHex("#e5c07b") },
      operator: { fg: RGBA.fromHex("#56b6c2") },
      variable: { fg: RGBA.fromHex("#abb2bf") },
      property: { fg: RGBA.fromHex("#e06c75") },
      bracket: { fg: RGBA.fromHex("#abb2bf") },
      punctuation: { fg: RGBA.fromHex("#abb2bf") },
      default: { fg: RGBA.fromHex("#abb2bf") },
    },
  },
]

export default function DiffDemo() {
  const renderer = useRenderer()
  const styles: SyntaxStyle[] = []
  let diff: DiffRenderable | undefined
  const [currentView, setCurrentView] = createSignal<"unified" | "split">("unified")
  const [showLineNumbers, setShowLineNumbers] = createSignal(true)
  const [currentThemeIndex, setCurrentThemeIndex] = createSignal(0)

  const currentTheme = () => themes[currentThemeIndex()]
  const currentStyle = () =>
    (styles[currentThemeIndex()] ??= SyntaxStyle.fromStyles(currentTheme().syntaxStyle, renderer.nativeScene!))
  onCleanup(() => {
    const release = () => styles.forEach((style) => style.destroy())
    if (diff && !diff.isDestroyed) {
      diff.prependOnceListener(RenderableEvents.DESTROYED, () => queueMicrotask(release))
    } else release()
  })

  const exampleDiff = `--- a/calculator.ts
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
 }`

  useKeyboard((key) => {
    if (key.name === "v" && !key.ctrl && !key.meta) {
      toggleView()
    } else if (key.name === "l" && !key.ctrl && !key.meta) {
      toggleLineNumbers()
    } else if (key.name === "t" && !key.ctrl && !key.meta) {
      toggleTheme()
    }
  })

  const toggleView = () => {
    setCurrentView(currentView() === "unified" ? "split" : "unified")
  }

  const toggleLineNumbers = () => {
    setShowLineNumbers(!showLineNumbers())
  }

  const toggleTheme = () => {
    setCurrentThemeIndex((currentThemeIndex() + 1) % themes.length)
  }

  return (
    <box flexDirection="column" width="100%" height="100%" gap={1} backgroundColor={currentTheme().backgroundColor}>
      <box
        flexDirection="column"
        backgroundColor={currentTheme().backgroundColor}
        padding={1}
        border
        borderColor={currentTheme().borderColor}
        flexShrink={0}
      >
        <text fg={currentTheme().selectionFg}>Diff Demo - Unified & Split View</text>
        <text fg={currentTheme().lineNumberFg}>Theme: {currentTheme().name}</text>
        <text fg={currentTheme().lineNumberFg}>Keybindings:</text>
        <text fg={currentTheme().selectionFg}> V - Toggle view ({currentView().toUpperCase()})</text>
        <text fg={currentTheme().selectionFg}> L - Toggle line numbers ({showLineNumbers() ? "ON" : "OFF"})</text>
        <text fg={currentTheme().selectionFg}>
          {" "}
          T - Cycle theme ({currentThemeIndex() + 1}/{themes.length})
        </text>
      </box>

      <box
        flexGrow={1}
        flexBasis={0}
        border
        borderStyle="single"
        borderColor={currentTheme().borderColor}
        backgroundColor={currentTheme().backgroundColor}
      >
        <diff
          ref={(node) => (diff = node)}
          diff={exampleDiff}
          view={currentView()}
          filetype="typescript"
          syntaxStyle={currentStyle()}
          showLineNumbers={showLineNumbers()}
          addedBg={currentTheme().addedBg}
          removedBg={currentTheme().removedBg}
          contextBg={currentTheme().contextBg}
          addedSignColor={currentTheme().addedSignColor}
          removedSignColor={currentTheme().removedSignColor}
          lineNumberFg={currentTheme().lineNumberFg}
          lineNumberBg={currentTheme().lineNumberBg}
          addedLineNumberBg={currentTheme().addedLineNumberBg}
          removedLineNumberBg={currentTheme().removedLineNumberBg}
          selectionBg={currentTheme().selectionBg}
          selectionFg={currentTheme().selectionFg}
          width="100%"
          height="100%"
        />
      </box>
    </box>
  )
}
