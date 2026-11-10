import { createSignal, Show } from "solid-js"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { t } from "@opentui/core"

process.env.DEBUG = "true"

const EmptyStyledTextTest = () => {
  const renderer = useRenderer()

  renderer.consoleMode = "console-overlay"
  renderer.console.show()

  const [showBox, setShowBox] = createSignal(false)
  const [cont, setCont] = createSignal<string | null>("text")

  useKeyboard((key) => {
    if (key.name === "space") {
      console.log("==== TOGGLING BOX ====")
      setShowBox((s) => !s)
    } else if (key.name === "tab") {
      console.log("==== TOGGLING STYLED CONTENT ====")
      setCont((s) => (s ? null : "text"))
    }
  })

  return (
    <box border title="empty styled text test">
      {/* Only instance where I have found solid creating empty text nodes naturally  */}
      <Show when={showBox()}>
        <box border title="conditional box">
          <text>Box is visible!</text>
        </box>
      </Show>
      <text>Press space to toggle box</text>

      {/* Forced instance of empty styled box. Doesn't work without fixes put in place previously */}
      <text></text>

      {/* Dynamically going null*/}
      <text></text>
    </box>
  )
}

render(EmptyStyledTextTest)
