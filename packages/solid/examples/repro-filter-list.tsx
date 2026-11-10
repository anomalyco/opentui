import { createSignal, For } from "solid-js"
import { render, useRenderer } from "@opentui/solid"

process.env.DEBUG = "true"

const FilterListTest = () => {
  const renderer = useRenderer()

  renderer.consoleMode = "console-overlay"
  renderer.console.show()

  const [filter, setFilter] = createSignal("")

  const items = ["Apple", "Apple Pie", "Apple Sauce", "Apple key", "Apple fiy", "Grape"]
  /*
   * [ FIXED now ]
   * 1. Type "pie"
   * 2. Most items go away
   * 3. Backspace out
   * 4. ~not all items get added back~
   * */

  const filteredItems = () => {
    const f = filter().toLowerCase()
    return items.filter((item) => item.toLowerCase().includes(f))
  }

  return (
    <box border title="filter list test" flexDirection="column">
      <box border title="search" height={3}>
        <input focused placeholder="Type to filter..." onInput={setFilter} />
      </box>
      <box border title="results" flexDirection="column">
        <For each={filteredItems()}>{(item) => <text>{item}</text>}</For>
      </box>
    </box>
  )
}

render(FilterListTest)
