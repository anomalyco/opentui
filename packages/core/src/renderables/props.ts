import { isRenderable, type BaseRenderable } from "../Renderable.js"
import { InputRenderable, InputRenderableEvents } from "./Input.js"
import { SelectRenderable, SelectRenderableEvents } from "./Select.js"
import { TabSelectRenderable, TabSelectRenderableEvents } from "./TabSelect.js"

const inputEvents: Record<string, string> = {
  onChange: InputRenderableEvents.CHANGE,
  onInput: InputRenderableEvents.INPUT,
  onSubmit: InputRenderableEvents.ENTER,
}
const selectEvents: Record<string, string> = {
  onChange: SelectRenderableEvents.SELECTION_CHANGED,
  onSelect: SelectRenderableEvents.ITEM_SELECTED,
}
const tabSelectEvents: Record<string, string> = {
  onChange: TabSelectRenderableEvents.SELECTION_CHANGED,
  onSelect: TabSelectRenderableEvents.ITEM_SELECTED,
}

/**
 * Writes one framework prop to a renderable; `prev` is the value of the previous write. The React and Solid
 * reconcilers call it, so a prop sequence leaves the same state in both.
 *
 * `focused` focuses or blurs. `onChange`, `onInput`, `onSubmit`, and `onSelect` replace a listener where the node
 * emits a matching event. `style` writes its changed keys and writes `undefined` to each key it no longer has, which
 * restores the default as an omitted option does. Any other prop, unmapped event props included, is assigned.
 */
export function setRenderableProp(node: BaseRenderable, name: string, value: any, prev: any): void {
  const target = node as unknown as Record<string, unknown>
  switch (name) {
    case "focused":
      if (!isRenderable(node)) return
      if (value) node.focus()
      else node.blur()
      return
    case "style": {
      const next = value ?? {}
      const last = prev ?? {}
      for (const key in last) if (!Object.hasOwn(next, key)) target[key] = undefined
      for (const key in next) if (next[key] !== last[key]) target[key] = next[key]
      return
    }
    case "onChange":
    case "onInput":
    case "onSubmit":
    case "onSelect": {
      const events =
        node instanceof InputRenderable
          ? inputEvents
          : node instanceof SelectRenderable
            ? selectEvents
            : node instanceof TabSelectRenderable
              ? tabSelectEvents
              : undefined
      const event = events?.[name]
      if (!event) break
      if (prev) node.off(event, prev)
      if (value) node.on(event, value)
      return
    }
  }
  target[name] = value
}
