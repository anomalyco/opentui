import type { BaseRenderable, Renderable } from "../Renderable.js"
import { InputRenderable, InputRenderableEvents as Input } from "./Input.js"
import { SelectRenderable, SelectRenderableEvents as Select } from "./Select.js"
import { TabSelectRenderable, TabSelectRenderableEvents as TabSelect } from "./TabSelect.js"

const empty: Record<string, unknown> = {}

/**
 * Writes one framework prop to a renderable; `prev` is the value of the previous write. The React and Solid
 * reconcilers call it, so a sequence of writes leaves the same state in both.
 *
 * `focused` focuses or blurs a node that can take focus. `onChange`, `onInput`, `onSubmit`, and `onSelect` replace
 * a listener (remove, then add) where the node emits a matching event. `style` writes its changed keys and writes
 * `undefined` to each key it no longer has. Any other prop, unmapped event props included, is assigned.
 */
export function setRenderableProp(node: BaseRenderable, name: string, value: any, prev: any): void {
  const target = node as unknown as Record<string, unknown>
  let event: string | undefined
  switch (name) {
    case "focused":
      // Text and slot nodes have no focus; a check on methods also accepts a renderable from another Core copy.
      if (value) (node as Renderable).focus?.()
      else (node as Renderable).blur?.()
      return
    case "style": {
      // A read, not an own-key check: a Solid `mergeProps` style is a proxy with no own keys.
      const next = value ?? empty
      const last = prev ?? empty
      for (const key in last) if (next[key] === undefined) target[key] = undefined
      for (const key in next) if (next[key] !== last[key]) target[key] = next[key]
      return
    }
    case "onChange":
      if (node instanceof InputRenderable) event = Input.CHANGE
      else if (node instanceof SelectRenderable) event = Select.SELECTION_CHANGED
      else if (node instanceof TabSelectRenderable) event = TabSelect.SELECTION_CHANGED
      break
    case "onInput":
      if (node instanceof InputRenderable) event = Input.INPUT
      break
    case "onSubmit":
      if (node instanceof InputRenderable) {
        event = Input.ENTER
        break
      }
      // A named store is cheaper than the keyed one below; a Textarea handler often changes on each render.
      target.onSubmit = value
      return
    case "onSelect":
      if (node instanceof SelectRenderable) event = Select.ITEM_SELECTED
      else if (node instanceof TabSelectRenderable) event = TabSelect.ITEM_SELECTED
      break
  }
  if (!event) {
    target[name] = value
    return
  }
  if (prev) node.off(event, prev)
  if (value) node.on(event, value)
}
