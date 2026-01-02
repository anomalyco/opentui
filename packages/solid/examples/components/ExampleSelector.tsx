import { measureText } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createSignal, Match, onMount, Switch } from "solid-js"
import { Session } from "../session.tsx"
import { SplitModeDemo } from "./animation-demo.tsx"
import AutocompleteDemo from "./autocomplete-demo.tsx"
import { CodeDemo } from "./code-demo.tsx"
import DiffDemo from "./diff-demo.tsx"
import ExtendDemo from "./extend-demo.tsx"
import InputScene from "./input-demo.tsx"
import LineNumberDemo from "./line-number-demo.tsx"
import MouseScene from "./mouse-demo.tsx"
import { ScrollDemo, ScrollDemoIndex } from "./scroll-demo.tsx"
import { CustomScrollAccelDemo } from "./custom-scroll-accel-demo.tsx"
import TabSelectDemo from "./tab-select-demo.tsx"
import TerminalGridDemo from "./terminal-grid-demo.tsx"
import TextSelectionDemo from "./text-selection-demo.tsx"
import TextStyleScene from "./text-style-demo.tsx"
import { TextareaDemo } from "./textarea-demo.tsx"

const EXAMPLES = [
  {
    name: "Terminal Grid Demo",
    description: "2x2 grid of interactive terminals with focus switching",
    scene: "terminal-grid-demo",
  },
  {
    name: "Diff Viewer Demo",
    description: "Unified and split diff view with syntax highlighting",
    scene: "diff-demo",
  },
  {
    name: "Line Numbers Demo",
    description: "Code with line numbers, diff highlights, and diagnostics",
    scene: "line-number-demo",
  },
  {
    name: "Code Syntax Highlighting Demo",
    description: "JavaScript syntax highlighting using TreeSitter with <code> component",
    scene: "code-demo",
  },
  {
    name: "Text Selection Demo",
    description: "Text selection across multiple renderables with mouse drag",
    scene: "text-selection-demo",
  },
  {
    name: "Input Demo",
    description: "Interactive InputElement demo with validation and multiple fields",
    scene: "input-demo",
  },
  {
    name: "Autocomplete Demo",
    description: "@ mention autocomplete with keyboard navigation",
    scene: "autocomplete-demo",
  },
  {
    name: "Textarea Demo",
    description: "Interactive textarea editor with navigation, editing, and text wrapping",
    scene: "textarea-demo",
  },
  {
    name: "Mouse demo",
    description: "Mouse interaction",
    scene: "mouse-demo",
  },
  {
    name: "Text Style Demo",
    description: "Template literals with styled text, colors, and formatting",
    scene: "text-style-scene",
  },
  {
    name: "Animation Demo WIP",
    description: "Keyframs api and split mode demo",
    scene: "split-mode",
  },
  {
    name: "Tab Select Demo",
    description: "Tab selection demo",
    scene: "tab-select-demo",
  },
  {
    name: "Extend Demo",
    description: "Extend demo",
    scene: "extend-demo",
  },
  {
    name: "Scroll Demo",
    description: "Scroll demo",
    scene: "scroll-demo",
  },
  {
    name: "Scroll Demo Index",
    description: "Scroll demo Index",
    scene: "scroll-demo-index",
  },
  {
    name: "Custom Scroll Acceleration Demo",
    description: "Interactive demo showcasing different scroll acceleration modes",
    scene: "custom-scroll-accel-demo",
  },
  {
    name: "Session Scrollbox",
    description: "Live message stream with chunked arrival simulation",
    scene: "session-scrollbox",
  },
]

const ExampleSelector = () => {
  const renderer = useRenderer()

  onMount(() => {
    renderer.useConsole = true
    // renderer.console.show();
  })

  const terminalDimensions = useTerminalDimensions()

  const titleText = "OPENTUI EXAMPLES"
  const titleFont = "tiny"
  const { width: titleWidth, height: titleHeight } = measureText({ text: titleText, font: titleFont })

  const [selected, setSelected] = createSignal(-1)

  const handleSelect = (idx: number) => {
    console.log("Selected:", EXAMPLES.at(idx)?.name)
    setSelected(idx)
  }

  useKeyboard((key) => {
    switch (key.name) {
      case "escape":
        setSelected(-1)
        break
      case "`":
        renderer.console.toggle()
        break
      case "t":
        renderer.toggleDebugOverlay()
        break
      case "g":
        if (key.ctrl) {
          renderer.dumpHitGrid()
        }
        break
    }

    switch (key.raw) {
      case "\u0003":
        renderer.stop()
        process.exit(0)
    }
  })

  const selectedScene = () => (selected() === -1 ? "menu" : EXAMPLES.at(selected())?.scene)

  return (
    <Switch>
      <Match when={selectedScene() === "terminal-grid-demo"}>
        <TerminalGridDemo />
      </Match>
      <Match when={selectedScene() === "diff-demo"}>
        <DiffDemo />
      </Match>
      <Match when={selectedScene() === "line-number-demo"}>
        <LineNumberDemo />
      </Match>
      <Match when={selectedScene() === "code-demo"}>
        <CodeDemo />
      </Match>
      <Match when={selectedScene() === "split-mode"}>
        <SplitModeDemo />
      </Match>
      <Match when={selectedScene() === "input-demo"}>
        <InputScene />
      </Match>
      <Match when={selectedScene() === "autocomplete-demo"}>
        <AutocompleteDemo />
      </Match>
      <Match when={selectedScene() === "textarea-demo"}>
        <TextareaDemo />
      </Match>
      <Match when={selectedScene() === "mouse-demo"}>
        <MouseScene />
      </Match>
      <Match when={selectedScene() === "text-style-scene"}>
        <TextStyleScene />
      </Match>
      <Match when={selectedScene() === "text-selection-demo"}>
        <TextSelectionDemo />
      </Match>
      <Match when={selectedScene() === "tab-select-demo"}>
        <TabSelectDemo />
      </Match>
      <Match when={selectedScene() === "extend-demo"}>
        <ExtendDemo />
      </Match>
      <Match when={selectedScene() === "scroll-demo"}>
        <ScrollDemo />
      </Match>
      <Match when={selectedScene() === "scroll-demo-index"}>
        <ScrollDemoIndex />
      </Match>
      <Match when={selectedScene() === "custom-scroll-accel-demo"}>
        <CustomScrollAccelDemo />
      </Match>
      <Match when={selectedScene() === "session-scrollbox"}>
        <Session />
      </Match>
      <Match when={selected() === -1}>
        <box style={{ height: terminalDimensions().height, backgroundColor: "#001122", padding: 1 }}>
          <box alignItems="center">
            <ascii_font
              style={{
                font: titleFont,
              }}
              text={titleText}
            />
          </box>
          <text style={{ fg: "#AAAAAA", marginTop: 1, marginLeft: 1, marginRight: 1 }}>
            Use ↑↓ or j/k to navigate, Shift+↑↓ or Shift+j/k for fast scroll, Enter to run, Escape to return, for
            console, ctrl+c to quit {selected()} {terminalDimensions().height}
          </text>
          <box
            title="Examples"
            style={{
              border: true,
              flexGrow: 1,
              marginTop: 1,
              borderStyle: "single",
              titleAlignment: "center",
              focusedBorderColor: "#00AAFF",
            }}
          >
            <select
              focused
              onSelect={(index) => {
                handleSelect(index)
              }}
              options={EXAMPLES.map((ex, i) => ({
                name: ex.name,
                description: ex.description,
                value: i,
              }))}
              style={{
                height: "100%",
                backgroundColor: "transparent",
                focusedBackgroundColor: "transparent",
                selectedBackgroundColor: "#334455",
                selectedTextColor: "#FFFF00",
                descriptionColor: "#888888",
              }}
              showScrollIndicator
              wrapSelection
              fastScrollStep={5}
            />
          </box>
        </box>
      </Match>
    </Switch>
  )
}

export default ExampleSelector
