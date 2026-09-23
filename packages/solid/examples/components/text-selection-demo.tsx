import { Selection } from "@opentui/core"
import { ConsolePosition } from "@opentui/core"
import { render, useRenderer, useSelectionHandler, type TextProps } from "@opentui/solid"
import { createEffect, createSignal, onCleanup, onMount } from "solid-js"

const words = ["Hello", "World", "OpenTUI", "SolidJS", "ReactJS", "TypeScript", "JavaScript", "CSS", "HTML", "JSX"]

export default function TextSelectionDemo() {
  const renderer = useRenderer()

  const [selectedWord, setSelectedWord] = createSignal(0)

  onMount(() => {
    renderer.setBackgroundColor("#0d1117")
    const timer = setInterval(() => {
      setSelectedWord((w) => (w === words.length - 1 ? 0 : w + 1))
    }, 1000)
    onCleanup(() => clearInterval(timer))
  })

  const [statusText, setStatusText] = createSignal("No selection - try selecting across different nested elements")
  const [selectionStartText, setSelectionStartText] = createSignal("")
  const [selectionMiddleText, setSelectionMiddleText] = createSignal("")
  const [selectionEndText, setSelectionEndText] = createSignal("")

  const section1TextStyle: TextProps["style"] = {
    fg: "#f0f6fc",
    zIndex: 21,
    flexShrink: 0,
  }

  const updateSelectionTexts = (selectedText: string) => {
    const lines = selectedText.split("\n")
    const totalLength = selectedText.length

    if (lines.length > 1) {
      setStatusText(`Selected ${lines.length} lines (${totalLength} chars):`)
      setSelectionStartText(lines[0] || "")
      setSelectionMiddleText("...")
      setSelectionEndText(lines[lines.length - 1] || "")
    } else if (selectedText.length > 60) {
      setStatusText(`Selected ${totalLength} chars:`)
      setSelectionStartText(selectedText.substring(0, 30))
      setSelectionMiddleText("...")
      setSelectionEndText(selectedText.substring(selectedText.length - 30))
    } else {
      setStatusText(`Selected ${totalLength} chars:`)
      setSelectionStartText(`"${selectedText}"`)
      setSelectionMiddleText("")
      setSelectionEndText("")
    }
  }

  let selectionRef: Selection | null = null

  const selectionHandler = (selection: Selection) => {
    selectionRef = selection
    const selectedText = selection.getSelectedText()

    if (selectedText) {
      updateSelectionTexts(selectedText)
    }
  }

  useSelectionHandler(selectionHandler)

  const selectedWordText = () => words[selectedWord()]

  createEffect(() => {
    selectedWord()
    if (!selectionRef) return
    updateSelectionTexts(selectionRef.getSelectedText())
  })

  return (
    <>
      <box
        style={{
          position: "absolute",
          left: 1,
          top: 1,
          width: 88,
          height: 22,
          backgroundColor: "#161b22",
          zIndex: 1,
          borderColor: "#50565d",
          titleAlignment: "center",
          border: true,
        }}
        title="Text Selection Demo"
      >
        <box
          style={{
            position: "absolute",
            left: 3,
            top: 3,
            zIndex: 10,
          }}
        >
          <box
            style={{
              width: 45,
              height: 7,
              backgroundColor: "#1e2936",
              zIndex: 20,
              borderColor: "#58a6ff",
              flexDirection: "column",
              padding: 1,
              border: true,
            }}
            title="Document Section 1"
          >
            <text style={section1TextStyle}>This is a paragraph in the first box.</text>
            <text style={section1TextStyle}>dynamic: {selectedWordText()}</text>
            <text style={section1TextStyle}>it contains multiple lines of text</text>
            <text style={section1TextStyle}>世界, 你好世界, 中文, 한글</text>
          </box>
          <box
            style={{
              left: 2,
              top: 1,
              width: 31,
              height: 4,
              backgroundColor: "#2d1b69",
              zIndex: 25,
              borderColor: "#a371f7",
              borderStyle: "double",
              border: true,
            }}
          >
            <text style={{ width: 27, height: 1, zIndex: 26, selectionBg: "#4a5568", selectionFg: "#ffffff" }}>
              <span style={{ fg: "yellow" }}>Important:</span>{" "}
              <span style={{ bold: true, fg: "cyan" }}>Nested content</span>{" "}
              <span style={{ italic: true, fg: "green" }}></span>
            </text>
          </box>
        </box>
        <box
          style={{
            position: "absolute",
            left: 49,
            top: 3,
            zIndex: 10,
          }}
        >
          <box
            style={{
              left: 2,
              top: 0,
              width: 35,
              height: 12,
              backgroundColor: "#1c2128",
              zIndex: 20,
              borderColor: "#f85149",
              borderStyle: "rounded",
              flexDirection: "column",
              padding: 1,
              border: true,
            }}
            title="Code Example"
          >
            <text style={{ fg: "#f0f6fc", zIndex: 21 }}>
              <span style={{ fg: "magenta" }}>function</span> <span style={{ fg: "cyan" }}>handleSelection</span>(){" "}
              {"{"}
            </text>
            <text style={{ fg: "#f0f6fc", zIndex: 21 }}>
              {"  "}
              <span style={{ fg: "magenta" }}>const</span> selected ={" "}
              <span style={{ fg: "cyan" }}>getSelectedText</span>()
            </text>
            <text style={{ fg: "#f0f6fc", zIndex: 21 }}>
              {"  "}
              <span style={{ fg: "yellow" }}>console</span>.<span style={{ fg: "green" }}>log</span>(selected)
            </text>
            <text style={{ fg: "#e6edf3", zIndex: 21 }}>{"}"}</text>
          </box>
        </box>
        <text style={{ left: 2, top: 17, zIndex: 2 }}>
          Click and drag to select text across any elements. Press 'C' to clear selection.
        </text>
      </box>
      <box
        style={{
          position: "absolute",
          left: 90,
          top: 11,
          width: 31,
          height: 6,
          backgroundColor: "#1b2f23",
          zIndex: 30,
          borderColor: "#2ea043",
          borderStyle: "single",
          border: true,
        }}
        title="README"
      >
        <text style={{ fg: "#f0f6fc", zIndex: 31, height: "auto" }}>
          <span style={{ bold: true, fg: "cyan" }}>Selection Demo</span>
          {"\n"}
          <span style={{ fg: "green" }}>✓</span> Cross-renderable selection
          {"\n"}
          <span style={{ fg: "green" }}>✓</span> Nested boxes
          {"\n"}
          <span style={{ fg: "green" }}>✓</span> Styled text support
        </text>
      </box>
      <box
        style={{
          position: "absolute",
          left: 1,
          top: 24,
          width: 88,
          height: 9,
          backgroundColor: "#0d1117",
          zIndex: 1,
          borderColor: "#50565d",
          titleAlignment: "left",
          padding: 1,
          border: true,
        }}
        title="Selection Status"
      >
        <text style={{ fg: "#f0f6fc", zIndex: 2 }}>{statusText()}</text>
        <text style={{ fg: "#7dd3fc", zIndex: 2 }}>{selectionStartText()}</text>
        <text style={{ fg: "#94a3b8", zIndex: 2 }}>{selectionMiddleText()}</text>
        <text style={{ fg: "#7dd3fc", zIndex: 2 }}>{selectionEndText()}</text>
      </box>
    </>
  )
}

if (import.meta.main) {
  render(() => <TextSelectionDemo />, {
    consoleOptions: {
      position: ConsolePosition.BOTTOM,
      maxStoredLogs: 1000,
      sizePercent: 40,
    },
  })
}
