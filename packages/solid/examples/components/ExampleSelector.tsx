import { measureText } from "@opentui/core"
import { TimeToFirstDraw, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createSignal, Match, onMount, Switch } from "solid-js"
import { Session } from "../session.tsx"
import { SplitModeDemo } from "./animation-demo.tsx"
import AutocompleteDemo from "./autocomplete-demo.tsx"
import { CodeDemo } from "./code-demo.tsx"
import DiffDemo from "./diff-demo.tsx"
import ExtendDemo from "./extend-demo.tsx"
import InputScene from "./input-demo.tsx"
import KeymapDemo from "./keymap-demo.tsx"
import LineNumberDemo from "./line-number-demo.tsx"
import MouseScene from "./mouse-demo.tsx"
import PluginSlotsDemo from "./plugin-slots-demo.tsx"
import { ScrollDemo, ScrollDemoIndex } from "./scroll-demo.tsx"
import { CustomScrollAccelDemo } from "./custom-scroll-accel-demo.tsx"
import ExternalPluginSlotsDemo from "./external-plugin-slots-demo.tsx"
import TabSelectDemo from "./tab-select-demo.tsx"
import TextSelectionDemo from "./text-selection-demo.tsx"
import TextStyleScene from "./text-style-demo.tsx"
import { TextareaDemo } from "./textarea-demo.tsx"
import { TextareaMinimalDemo } from "./textarea-minimal-demo.tsx"
import { TextTruncationDemo } from "./text-truncation-demo.tsx"

const EXAMPLES = [
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
    name: "Keymap Demo",
    description: "Global and local bindings with a centered : prompt, ex commands, and a ctrl+x leader extension",
    scene: "keymap-demo",
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
    name: "Textarea Minimal Demo",
    description: "Minimal prompt-style textarea with submit state",
    scene: "textarea-minimal-demo",
  },
  {
    name: "Text Truncation Demo",
    description: "Truncation and wrap mode toggles for varied text blocks",
    scene: "text-truncation-demo",
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
  {
    name: "Plugin Slots Error Demo",
    description: "Trigger plugin crashes and reset boundary state",
    scene: "plugin-slots-demo",
  },
  {
    name: "Plugin Slots External JSX Demo",
    description: "Loads .plugin/index.tsx and renders external JSX slot components",
    scene: "plugin-slots-external-demo",
  },
]

const ExampleSelector = () => {
  const renderer = useRenderer()

  onMount(() => {
    renderer.consoleMode = "console-overlay"
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
      case ".":
        renderer.toggleDebugOverlay()
        break
      case "g":
        if (key.ctrl) {
          renderer.dumpHitGrid()
        }
        break
    }

    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      renderer.destroy()
    }
  })

  const selectedScene = () => (selected() === -1 ? "menu" : EXAMPLES.at(selected())?.scene)

  return (
    <Switch>
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
      <Match when={selectedScene() === "keymap-demo"}>
        <KeymapDemo />
      </Match>
      <Match when={selectedScene() === "autocomplete-demo"}>
        <AutocompleteDemo />
      </Match>
      <Match when={selectedScene() === "textarea-demo"}>
        <TextareaDemo />
      </Match>
      <Match when={selectedScene() === "textarea-minimal-demo"}>
        <TextareaMinimalDemo />
      </Match>
      <Match when={selectedScene() === "text-truncation-demo"}>
        <TextTruncationDemo />
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
      <Match when={selectedScene() === "plugin-slots-demo"}>
        <PluginSlotsDemo />
      </Match>
      <Match when={selectedScene() === "plugin-slots-external-demo"}>
        <ExternalPluginSlotsDemo />
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
          <TimeToFirstDraw />
          <text style={{ fg: "#AAAAAA", marginTop: 1, marginLeft: 1, marginRight: 1 }}>
            Use ↑↓ or j/k to navigate, Shift+↑↓ or Shift+j/k for fast scroll, Enter to run, Escape to return, ` to
            toggle console, . to toggle debug overlay, ctrl+c to quit
          </text>
        </box>
      </Match>
    </Switch>
  )
}

export default ExampleSelector
