import { createCliRenderer } from "@opentui/core"
import { createRoot, TimeToFirstDraw, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { createElement, useEffect, useState, type ComponentType } from "react"
import { App as AnimationDemo } from "./animation.js"
import { App as AsciiDemo } from "./ascii.js"
import { App as BasicDemo } from "./basic.js"
import { App as BordersDemo } from "./borders.js"
import { App as BoxDemo } from "./box.js"
import { App as CounterDemo } from "./counter.js"
import { App as DiffDemo } from "./diff.js"
import { ExtendExample } from "./extend-example.js"
import ExternalPluginSlotsDemo from "./external-plugin-slots-demo.js"
import { App as FlushSyncDemo } from "./flush-sync.js"
import { App as KeymapDemo } from "./keymap.js"
import LineNumberDemo from "./line-number.js"
import OpacityDemo from "./opacity.js"
import { App as ScrollDemo } from "./scroll.js"
import { App as TextDemo } from "./text.js"

interface ExampleDefinition {
  name: string
  description: string
  component: ComponentType
}

const EXAMPLES: ExampleDefinition[] = [
  {
    name: "Basic Demo",
    description: "Input form, focus management, and styled text",
    component: BasicDemo,
  },
  {
    name: "Counter Demo",
    description: "State updates and interval-driven re-renders",
    component: CounterDemo,
  },
  {
    name: "Animation Demo",
    description: "Timeline-driven system monitor animation",
    component: AnimationDemo,
  },
  {
    name: "ASCII Font Demo",
    description: "Switch among multiple ASCII font renderers",
    component: AsciiDemo,
  },
  {
    name: "Text Demo",
    description: "Styled text, colors, links, and nested formatting",
    component: TextDemo,
  },
  {
    name: "Box Demo",
    description: "Box layout, spacing, nesting, and alignment",
    component: BoxDemo,
  },
  {
    name: "Borders Demo",
    description: "Single, double, rounded, and heavy borders",
    component: BordersDemo,
  },
  {
    name: "Scroll Demo",
    description: "Scrollable content with custom scrollbar styling",
    component: ScrollDemo,
  },
  {
    name: "Line Number Demo",
    description: "Code with line numbers, signs, and diagnostics",
    component: LineNumberDemo,
  },
  {
    name: "Diff Demo",
    description: "Unified and split diff view with themes",
    component: DiffDemo,
  },
  {
    name: "Opacity Demo",
    description: "Layered opacity blending and animation",
    component: OpacityDemo,
  },
  {
    name: "Flush Sync Demo",
    description: "Compare batched updates vs synchronous flushes",
    component: FlushSyncDemo,
  },
  {
    name: "Keymap Demo",
    description: "Panels plus textareas with global, local, managed bindings, and a centered : prompt",
    component: KeymapDemo,
  },
  {
    name: "Extend Demo",
    description: "Custom renderable registration through extend",
    component: ExtendExample,
  },
  {
    name: "External Plugin Slots Demo",
    description: "Loads .plugin/index.tsx and renders external React slot components",
    component: ExternalPluginSlotsDemo,
  },
]

export const ExamplesIndex = () => {
  const renderer = useRenderer()
  const terminalDimensions = useTerminalDimensions()
  const [selected, setSelected] = useState(-1)

  useEffect(() => {
    renderer.consoleMode = "console-overlay"
  }, [renderer])

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

    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      renderer.destroy()
    }
  })

  if (selected !== -1) {
    const selectedExample = EXAMPLES[selected]
    return selectedExample ? createElement(selectedExample.component) : null
  }

  return (
    <box style={{ height: terminalDimensions.height, backgroundColor: "#001122", padding: 1 }}>
      <box alignItems="center">
        <ascii-font style={{ font: "tiny" }} text="OPENTUI REACT EXAMPLES" />
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
            setSelected(index)
          }}
          options={EXAMPLES.map((example, index) => ({
            name: example.name,
            description: example.description,
            value: index,
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
        Use up/down or j/k to navigate, Shift+up/down or Shift+j/k for fast scroll, Enter to run, Escape to return, ` to
        toggle console, ctrl+c to quit
      </text>
    </box>
  )
}

if (import.meta.main) {
  const renderer = await createCliRenderer()
  createRoot(renderer).render(<ExamplesIndex />)
  await renderer.closed
}

export default ExamplesIndex
