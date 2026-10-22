import { type InputRenderable, type BoxRenderable, type KeyEvent, TextAttributes } from "@opentui/core"
import { createSignal, createMemo, For, Show, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useRenderer } from "@opentui/solid"

type AutocompleteOption = {
  display: string
  description?: string
}

const SAMPLE_OPTIONS: AutocompleteOption[] = [
  { display: "alice", description: "Alice Johnson" },
  { display: "bob", description: "Bob Smith" },
  { display: "charlie", description: "Charlie Brown" },
  { display: "diana", description: "Diana Prince" },
  { display: "eve", description: "Eve Anderson" },
  { display: "frank", description: "Frank Miller" },
  { display: "grace", description: "Grace Hopper" },
  { display: "henry", description: "Henry Ford" },
  { display: "iris", description: "Iris Chang" },
  { display: "jack", description: "Jack Dorsey" },
  { display: "karen", description: "Karen Walker" },
  { display: "leo", description: "Leo Martinez" },
  { display: "maria", description: "Maria Garcia" },
  { display: "noah", description: "Noah Wilson" },
  { display: "olivia", description: "Olivia Taylor" },
  { display: "peter", description: "Peter Parker" },
  { display: "quinn", description: "Quinn Roberts" },
  { display: "rachel", description: "Rachel Green" },
  { display: "sam", description: "Sam Anderson" },
  { display: "tina", description: "Tina Turner" },
  { display: "uma", description: "Uma Thurman" },
  { display: "victor", description: "Victor Hugo" },
  { display: "wendy", description: "Wendy Williams" },
  { display: "xavier", description: "Xavier Thompson" },
  { display: "yuki", description: "Yuki Tanaka" },
  { display: "zoe", description: "Zoe Chen" },
  { display: "adam", description: "Adam Davis" },
  { display: "bella", description: "Bella Rodriguez" },
  { display: "carlos", description: "Carlos Sanchez" },
  { display: "derek", description: "Derek Lee" },
  { display: "emma", description: "Emma Watson" },
  { display: "felix", description: "Felix White" },
  { display: "gina", description: "Gina Lopez" },
  { display: "harry", description: "Harry Potter" },
  { display: "isla", description: "Isla Fisher" },
  { display: "james", description: "James Bond" },
  { display: "kate", description: "Kate Middleton" },
  { display: "luke", description: "Luke Skywalker" },
  { display: "maya", description: "Maya Angelou" },
  { display: "nick", description: "Nick Fury" },
  { display: "oscar", description: "Oscar Wilde" },
  { display: "paul", description: "Paul McCartney" },
  { display: "queenie", description: "Queenie Goldstein" },
  { display: "ryan", description: "Ryan Reynolds" },
  { display: "sara", description: "Sara Connor" },
  { display: "tony", description: "Tony Stark" },
  { display: "ursula", description: "Ursula Le Guin" },
  { display: "vera", description: "Vera Wang" },
  { display: "will", description: "Will Smith" },
  { display: "xena", description: "Xena Warrior" },
  { display: "yasmin", description: "Yasmin Khan" },
  { display: "zack", description: "Zack Morris" },
  { display: "amber", description: "Amber Heard" },
  { display: "blake", description: "Blake Lively" },
  { display: "chris", description: "Chris Evans" },
  { display: "donna", description: "Donna Noble" },
  { display: "ethan", description: "Ethan Hunt" },
  { display: "fiona", description: "Fiona Apple" },
  { display: "george", description: "George Clooney" },
  { display: "hannah", description: "Hannah Montana" },
  { display: "ivan", description: "Ivan Drago" },
  { display: "julia", description: "Julia Roberts" },
  { display: "keith", description: "Keith Richards" },
  { display: "linda", description: "Linda Hamilton" },
  { display: "mark", description: "Mark Zuckerberg" },
  { display: "nina", description: "Nina Simone" },
  { display: "oliver", description: "Oliver Twist" },
  { display: "penny", description: "Penny Lane" },
  { display: "quincy", description: "Quincy Jones" },
  { display: "rose", description: "Rose Tyler" },
  { display: "steve", description: "Steve Jobs" },
  { display: "tracy", description: "Tracy Chapman" },
  { display: "umar", description: "Umar Johnson" },
  { display: "violet", description: "Violet Baudelaire" },
  { display: "wade", description: "Wade Wilson" },
  { display: "xander", description: "Xander Harris" },
  { display: "yvonne", description: "Yvonne Strahovski" },
  { display: "zeus", description: "Zeus King" },
]

const AutocompleteDemo = () => {
  const renderer = useRenderer()
  let input: InputRenderable
  let anchor: BoxRenderable

  const [inputValue, setInputValue] = createSignal("")
  const [store, setStore] = createStore({
    visible: false,
    selected: 0,
    index: 0,
    position: { x: 0, y: 0, width: 0 },
  })

  const filter = createMemo(() => {
    if (!store.visible) return ""
    return inputValue().substring(store.index + 1)
  })

  const options = createMemo(() => {
    const filterText = filter().toLowerCase()
    if (!filterText) return SAMPLE_OPTIONS.slice(0, 8)
    return SAMPLE_OPTIONS.filter(
      (opt) => opt.display.toLowerCase().includes(filterText) || opt.description?.toLowerCase().includes(filterText),
    ).slice(0, 8)
  })

  const height = createMemo(() => {
    if (options().length) return Math.min(8, options().length)
    return 1
  })

  function move(direction: -1 | 1) {
    if (!store.visible) return
    if (!options().length) return
    let next = store.selected + direction
    if (next < 0) next = options().length - 1
    if (next >= options().length) next = 0
    setStore("selected", next)
  }

  function select() {
    const selected = options()[store.selected]
    if (!selected) return
    const newValue = inputValue().slice(0, store.index) + "@" + selected.display + " "
    setInputValue(newValue)
    input.value = newValue
    input.gotoBufferEnd()
    hide()
  }

  function show() {
    setStore({
      visible: true,
      selected: 0,
      index: input.editBuffer.getTextRange(0, input.cursorOffset).length,
      position: {
        x: anchor.x,
        y: anchor.y,
        width: anchor.width,
      },
    })
  }

  function hide() {
    setStore("visible", false)
  }

  function handleKeyDown(e: KeyEvent) {
    if (store.visible) {
      if (e.name === "up") {
        e.preventDefault()
        move(-1)
      }
      if (e.name === "down") {
        e.preventDefault()
        move(1)
      }
      if (e.name === "escape") {
        e.preventDefault()
        hide()
      }
      if (e.name === "return") {
        e.preventDefault()
        select()
      }
    } else {
      if (e.name === "@") {
        const last = inputValue().at(-1)
        if (last === " " || last === undefined) {
          show()
        }
      }
    }
  }

  function handleInput(value: string) {
    setInputValue(value)
    if (store.visible && value.length <= store.index) {
      hide()
    }
  }

  onMount(() => {
    renderer.setBackgroundColor("#1a1b26")
    input.focus()
  })

  return (
    <box height="100%" width="100%" flexDirection="column" gap={1} padding={2}>
      <box>
        <text attributes={TextAttributes.BOLD} fg="#7aa2f7">
          Autocomplete Demo
        </text>
        <text attributes={TextAttributes.DIM} fg="#9aa5ce">
          Type @ to trigger autocomplete. Use arrow keys to navigate, Enter to select.
        </text>
      </box>

      <box ref={(r) => (anchor = r)} flexDirection="column">
        <box border borderColor="#3b4261" padding={1}>
          <input
            ref={(r) => (input = r)}
            value={inputValue()}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Type @ to mention someone..."
            cursorColor="#7aa2f7"
            backgroundColor="#1a1b26"
            focusedBackgroundColor="#1a1b26"
          />
        </box>

        {/* Autocomplete popup */}
        <box
          visible={store.visible}
          position="absolute"
          top={store.position.y - height()}
          left={store.position.x}
          width={store.position.width}
          zIndex={100}
          border
          borderColor="#7aa2f7"
        >
          <box backgroundColor="#24283b" height={height()}>
            <For
              each={options()}
              fallback={
                <box paddingLeft={1} paddingRight={1}>
                  <text fg="#9aa5ce">No matching items</text>
                </box>
              }
            >
              {(option, index) => (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={index() === store.selected ? "#7aa2f7" : undefined}
                  flexDirection="row"
                >
                  <text fg={index() === store.selected ? "#1a1b26" : "#c0caf5"}>@{option.display}</text>
                  <Show when={option.description}>
                    <text fg={index() === store.selected ? "#1a1b26" : "#9aa5ce"}> - {option.description}</text>
                  </Show>
                </box>
              )}
            </For>
          </box>
        </box>
      </box>

      <box marginTop={2}>
        <text fg="#9aa5ce">Current input: </text>
        <text fg="#c0caf5">{inputValue() || "(empty)"}</text>
      </box>
    </box>
  )
}

export default AutocompleteDemo
