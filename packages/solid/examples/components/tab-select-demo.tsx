import { createSignal, For, Match, onMount, Switch } from "solid-js"
import { EventEmitter } from "events"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { ConsolePosition } from "@opentui/core"

const Tab = (props: { title: string; active: boolean; index: number }) => {
  return (
    <box
      style={{
        height: 3,
        paddingTop: 1,
        border: props.active && ["bottom"],
        marginLeft: props.index === 0 ? 0 : 1,
        flexGrow: 1,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <text>{props.title}</text>
    </box>
  )
}

const tabs = [
  { title: "Text & Attributes" },
  { title: "Basics" },
  { title: "Borders" },
  { title: "Animation" },
  { title: "Titles" },
  { title: "Interactive" },
]

export default function TabSelectDemo() {
  const renderer = useRenderer()
  const [activeTab, setActiveTab] = createSignal(0)

  onMount(() => {
    renderer.consoleMode = "console-overlay"
    renderer.console.show()
  })

  useKeyboard((key) => {})

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <tab_select
        height={2}
        width="100%"
        options={tabs.map((tab, index) => ({
          name: tab.title,
          value: index,
          description: "",
        }))}
        showDescription={false}
        onChange={(index) => {
          setActiveTab(index)
        }}
        focused
      />
      <Switch>
        <Match when={activeTab() === 0}>
          <text>Tab 1/6 - Use Left/Right arrows to navigate | Press Ctrl+C to exit | D: toggle debug</text>
        </Match>
        <Match when={activeTab() === 1}>
          <text>Tab 2/6 - Use Left/Right arrows to navigate | Press Ctrl+C to exit | D: toggle debug</text>
        </Match>
      </Switch>
    </box>
  )
}

if (import.meta.main) {
  render(TabSelectDemo, {
    consoleOptions: {
      position: ConsolePosition.BOTTOM,
      maxStoredLogs: 1000,
      sizePercent: 40,
    },
  })
}
