import { setRenderableProp } from "@opentui/core"
import type { Instance, Props, Type } from "../types/host.js"

// The React reconciler handles children, so these loops skip them.

export function setInitialProperties(instance: Instance, type: Type, props: Props) {
  for (const propKey in props) {
    if (!props.hasOwnProperty(propKey) || propKey === "children") {
      continue
    }

    const propValue = props[propKey]
    if (propValue == null) {
      continue
    }

    setRenderableProp(instance, propKey, propValue, undefined)
  }
}

export function updateProperties(instance: Instance, type: Type, oldProps: Props, newProps: Props) {
  for (const propKey in oldProps) {
    const oldProp = oldProps[propKey]
    if (oldProps.hasOwnProperty(propKey) && oldProp != null && !newProps.hasOwnProperty(propKey)) {
      // A removed prop is omitted, as in Solid: `undefined` restores each setter's default, `null` may not.
      if (propKey !== "children") setRenderableProp(instance, propKey, undefined, oldProp)
    }
  }

  for (const propKey in newProps) {
    const newProp = newProps[propKey]
    const oldProp = oldProps[propKey]

    if (newProps.hasOwnProperty(propKey) && newProp !== oldProp && (newProp != null || oldProp != null)) {
      if (propKey !== "children") setRenderableProp(instance, propKey, newProp, oldProp)
    }
  }
}
